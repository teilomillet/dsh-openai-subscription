// Modified locally on 2026-10-07 to add the DeepSeek Harness raw Responses extension.
// Original OpenAI DevKit license and notices remain applicable.
import { apiError, ChatGPTError, fetchRemote, isObject, jsonResponse } from "./errors.js";
import type { StreamResponseOptions, HarnessResponseOptions } from "./types.js";

export async function streamResponse(
  accessToken: string,
  options: StreamResponseOptions,
  signal: AbortSignal,
): Promise<{ text: string }> {
  const input = typeof options.input === "string" ? [{ role: "user", content: options.input }] : options.input;
  if (!Array.isArray(input) || input.some((message) =>
    !isObject(message) || !["user", "assistant", "developer"].includes(String(message.role)) || typeof message.content !== "string"
  )) {
    throw new ChatGPTError("invalid_request", "Use text messages with user, assistant, or developer roles. Put system guidance in instructions.");
  }
  let streamedText = "";
  const response = await runHarnessResponse(accessToken, {
    model: options.model,
    input: input.map((message) => ({ role: message.role, content: message.content })),
    ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
    store: false,
    stream: true,
  }, { onEvent: (event) => {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      streamedText += event.delta;
      options.onDelta?.(event.delta);
    }
  } }, signal);
  const output = Array.isArray(response.output) ? response.output : [];
  const text = output.filter(isObject).flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter(isObject).filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text).join("");
  return { text: streamedText || text };
}

/** Raw Responses transport for the local harness, with credentials retained inside authenticated(). */
export async function runHarnessResponse(
  accessToken: string,
  body: Record<string, unknown>,
  options: HarnessResponseOptions,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (body.store !== false || body.stream !== true || !Array.isArray(body.input) ||
      typeof body.model !== "string" || !body.model.trim()) {
    throw new ChatGPTError("invalid_request", "Use a model, input array, store=false, and stream=true for ChatGPT plan usage.");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (!["openai-beta", "x-client-request-id", "user-agent", "originator"].includes(name.toLowerCase()) || typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new ChatGPTError("invalid_request", "Unsupported request header.");
    }
    headers[name.toLowerCase()] = value;
  }
  const response = await fetchRemote("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { ...headers, authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body), signal,
  }, 180_000);
  const requestId = response.headers.get("x-request-id");
  if (!response.ok) throw apiError(await jsonResponse(response), response.status, requestId);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  // The direct route can return valid SSE without Content-Type. In that case,
  // validate the events below and still require response.completed for success.
  if (!response.body || (contentType && contentType !== "text/event-stream")) {
    await response.body?.cancel();
    throw new ChatGPTError("invalid_stream", "ChatGPT did not return the expected response stream.", true, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let dataLines: string[] = [];
  let eventSize = 0;
  let completed: Record<string, unknown> | undefined;
  let textSize = 0;

  const dispatch = () => {
    const data = dataLines.join("\n");
    dataLines = [];
    eventSize = 0;
    if (!data || data === "[DONE]") return;
    let event: unknown;
    try { event = JSON.parse(data) as unknown; }
    catch { throw new ChatGPTError("invalid_stream", "The response stream contained an invalid event. Try again.", true); }
    if (!isObject(event)) return;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      textSize += event.delta.length;
      if (textSize > 16 * 1024 * 1024) throw new ChatGPTError("response_too_large", "The response was too large. Try a smaller request.");
    } else if (event.type === "response.failed" || event.type === "error") {
      const result = isObject(event.response) ? event.response : event;
      throw apiError(result, response.status, requestId);
    } else if (event.type === "response.incomplete") {
      throw new ChatGPTError("response_incomplete", "ChatGPT stopped before completing the response. You can keep the partial text or try again.", true);
    } else if (event.type === "response.completed") {
      if (!isObject(event.response) || event.response.status !== "completed") {
        throw new ChatGPTError("invalid_stream", "The completion event did not contain a completed response.");
      }
      completed = event.response;
    }
    options.onEvent?.(event);
  };

  const line = (value: string) => {
    if (value === "") { dispatch(); return; }
    if (value.startsWith("data:")) {
      const content = value.slice(5).replace(/^ /, "");
      eventSize += content.length;
      if (eventSize > 4 * 1024 * 1024) throw new ChatGPTError("invalid_stream", "ChatGPT returned an oversized stream event.");
      dataLines.push(content);
    }
  };

  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      // Accept LF, CRLF, and CR, including a CRLF split across network chunks.
      let consumed = 0;
      for (let index = 0; index < pending.length; index += 1) {
        const character = pending[index];
        if (character !== "\n" && character !== "\r") continue;
        if (character === "\r" && index === pending.length - 1 && !chunk.done) break;
        line(pending.slice(consumed, index));
        if (character === "\r" && pending[index + 1] === "\n") index += 1;
        consumed = index + 1;
      }
      pending = pending.slice(consumed);
      if (pending.length > 4 * 1024 * 1024) throw new ChatGPTError("invalid_stream", "ChatGPT returned an oversized stream event.");
      if (chunk.done) {
        if (pending) line(pending);
        dispatch();
        break;
      }
      if (completed) break;
    }
    if (!completed) throw new ChatGPTError("stream_interrupted", "The response ended before completion. You can keep the partial text or try again.", true);
    return completed;
  } catch (error) {
    if (signal.aborted) throw new ChatGPTError("cancelled", "The response was cancelled.");
    if (error instanceof ChatGPTError) throw error;
    throw new ChatGPTError("stream_interrupted", "The connection was interrupted. You can keep the partial text or try again.", true);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
