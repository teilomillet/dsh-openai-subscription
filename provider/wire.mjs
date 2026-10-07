// The public Responses boundary. This module has no credential access.
export const PROVIDER = 'openai-subscription';
export const TOOL_NAMESPACE = 'deepseek';

export class BoundaryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function reject(code, message) { throw new BoundaryError(code, message); }
function textBlocks(content, { allowReasoning = false, allowToolUpdates = false } = {}) {
  const text = [];
  for (const block of content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (allowReasoning && block.type === 'reasoning') continue;
    else if (allowToolUpdates && ['tool-addition', 'tool-removal'].includes(block.type)) continue;
    else reject('UNSUPPORTED_CONTENT', 'This local subscription provider accepts text and function tools only.');
  }
  return text.join('\n');
}

function toolName(name, namespace) {
  if (namespace !== undefined && namespace !== TOOL_NAMESPACE) {
    reject('UNSUPPORTED_TOOL_NAMESPACE', 'The response called a tool outside the Harness namespace.');
  }
  // A dot in an ordinary tool name is never taken as permission to strip a prefix.
  const normalized = namespace === TOOL_NAMESPACE && name?.startsWith(`${TOOL_NAMESPACE}.`)
    ? name.slice(TOOL_NAMESPACE.length + 1) : name;
  if (typeof normalized !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
    reject('INVALID_TOOL_CALL', 'The response contained an invalid Harness function name.');
  }
  return normalized;
}

function historyTool(block) {
  const name = toolName(block.name);
  if (typeof block.id !== 'string' || !block.id || typeof block.arguments !== 'string') {
    reject('INVALID_TOOL_CALL', 'The conversation contains an invalid function call.');
  }
  return { type: 'function_call', call_id: block.id, name, namespace: TOOL_NAMESPACE, arguments: block.arguments };
}

function replayFor(message, model) {
  const replay = message.source?.replayState?.response;
  if (message.source?.provider !== PROVIDER || message.source?.model !== model
      || replay?.version !== 1 || replay.model !== model || !Array.isArray(replay.output)) return undefined;
  // Compaction or a rewrite may have changed the visible message. Replaying its
  // old native output would silently restore removed or edited information.
  if (JSON.stringify(replay.content) !== JSON.stringify(message.content)) return undefined;
  return replay.output.map(item => safeOutputItem(item));
}

export function buildRequest(options) {
  if (options.provider !== PROVIDER) reject('UNKNOWN_PROVIDER', 'The subscription adapter received another provider route.');
  if (typeof options.model !== 'string' || !options.model) reject('UNKNOWN_MODEL', 'Select a subscription model first.');
  if (options.stop?.length) reject('UNSUPPORTED_OPTION', 'Stop sequences are not supported by this subscription provider.');
  const input = [];
  for (const message of options.messages ?? []) {
    if (message.role === 'assistant') {
      const replay = replayFor(message, options.model);
      if (replay) { input.push(...replay); continue; }
      let pending = [];
      const flush = () => {
        if (pending.length) input.push({ role: 'assistant', content: pending.join('\n') });
        pending = [];
      };
      for (const block of message.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') pending.push(block.text);
        else if (block.type === 'tool-call') { flush(); input.push(historyTool(block)); }
        else if (block.type !== 'reasoning') reject('UNSUPPORTED_CONTENT', 'This local subscription provider accepts text and function tools only.');
      }
      flush();
    } else if (message.role === 'tool') {
      const callId = message.toolCallId ?? message.source?.callId;
      if (typeof callId !== 'string' || !callId) reject('INVALID_TOOL_RESULT', 'A tool result is missing its function-call identity.');
      input.push({ type: 'function_call_output', call_id: callId, output: textBlocks(message.content) });
    } else if (['system', 'developer', 'user'].includes(message.role)) {
      const content = textBlocks(message.content, { allowToolUpdates: message.role === 'developer' });
      if (content) input.push({ role: message.role === 'system' ? 'developer' : message.role, content });
    } else reject('UNSUPPORTED_CONTENT', 'The conversation contains an unsupported message role.');
  }
  const names = new Set();
  const functions = (options.tools ?? []).map(tool => {
    const name = toolName(tool.name);
    if (names.has(name)) reject('INVALID_TOOLS', 'The Harness tool list contains a duplicate function name.');
    names.add(name);
    return { type: 'function', name, description: tool.description, parameters: structuredClone(tool.parameters), strict: false };
  });
  const body = {
    model: options.model, input, store: false, stream: true,
    include: ['reasoning.encrypted_content'],
  };
  if (typeof options.system === 'string' && options.system) body.instructions = options.system;
  if (functions.length) body.tools = [{ type: 'namespace', name: TOOL_NAMESPACE, description: 'Tools executed by DeepSeek Harness in this session.', tools: functions }];
  if (options.reasoningEffort !== undefined) body.reasoning = { effort: options.reasoningEffort };
  // Subscription Responses does not support temperature, top_p, output caps,
  // or arbitrary metadata. Harness defaults for these never reach the wire.
  return body;
}

function safeOutputItem(item) {
  if (!item || typeof item !== 'object') reject('INVALID_RESPONSE', 'The response contained an invalid output item.');
  const id = typeof item.id === 'string' ? { id: item.id } : {};
  if (item.type === 'reasoning') {
    const summary = (item.summary ?? []).map(part => {
      if (part.type !== 'summary_text' || typeof part.text !== 'string') reject('INVALID_RESPONSE', 'The response contained invalid reasoning summary data.');
      return { type: 'summary_text', text: part.text };
    });
    return { type: 'reasoning', ...id, summary, ...(typeof item.encrypted_content === 'string' ? { encrypted_content: item.encrypted_content } : {}) };
  }
  if (item.type === 'function_call') {
    const name = toolName(item.name, item.namespace);
    if (typeof item.call_id !== 'string' || !item.call_id || typeof item.arguments !== 'string') {
      reject('INVALID_TOOL_CALL', 'The response contained an invalid function call.');
    }
    return { type: 'function_call', ...id, call_id: item.call_id, name, namespace: TOOL_NAMESPACE, arguments: item.arguments };
  }
  if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
    const content = item.content.map(part => {
      if (part.type === 'output_text' && typeof part.text === 'string') return { type: 'output_text', text: part.text, annotations: [] };
      if (part.type === 'refusal' && typeof part.refusal === 'string') return { type: 'refusal', refusal: part.refusal };
      reject('UNSUPPORTED_CONTENT', 'The response contained unsupported assistant content.');
    });
    return { type: 'message', ...id, role: 'assistant', status: 'completed', content };
  }
  reject('UNSUPPORTED_CONTENT', 'The response contained an unsupported output type.');
}

export function responseUsage(raw) {
  if (raw === undefined) return undefined;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  if (!integer(raw.input_tokens) || !integer(raw.output_tokens)) reject('INVALID_USAGE', 'The response contained invalid token accounting.');
  const cached = raw.input_tokens_details?.cached_tokens ?? 0;
  const written = raw.input_tokens_details?.cache_write_tokens ?? raw.input_tokens_details?.cache_creation_tokens ?? 0;
  if (!integer(cached) || !integer(written) || cached + written > raw.input_tokens) reject('INVALID_USAGE', 'The response contained inconsistent cache accounting.');
  const usage = { inputTokens: raw.input_tokens - cached - written, outputTokens: raw.output_tokens, cacheReadTokens: cached };
  if (written) usage.cacheWriteTokens = written;
  const total = raw.input_tokens + raw.output_tokens;
  if (raw.total_tokens === undefined || raw.total_tokens === total) usage.totalTokens = total;
  const reasoning = raw.output_tokens_details?.reasoning_tokens;
  if (integer(reasoning) && reasoning <= raw.output_tokens) usage.reasoningTokens = reasoning;
  return usage;
}

// Subscription streams can publish finalized items separately and send an empty
// output array in their completed snapshot. Only output_item.done is retained:
// added items and text deltas are evidence of progress, never completion.
export function createOutputCollector() {
  const added = new Map();
  const finished = new Map();
  const indexFor = event => {
    if (!Number.isSafeInteger(event.output_index) || event.output_index < 0) {
      reject('INVALID_STREAM', 'The response stream contained an invalid output index.');
    }
    return event.output_index;
  };
  return {
    onEvent(event) {
      if (event.type === 'response.output_item.added') {
        const index = indexFor(event);
        if (added.has(index)) reject('INVALID_STREAM', 'The response stream repeated an output item.');
        added.set(index, event.item?.id);
      } else if (event.type === 'response.output_item.done') {
        const index = indexFor(event);
        if (finished.has(index)) reject('INVALID_STREAM', 'The response stream repeated a finalized output item.');
        const item = safeOutputItem(event.item);
        if (added.has(index) && added.get(index) !== undefined && item.id !== added.get(index)) {
          reject('INVALID_STREAM', 'The response stream changed an output item identity.');
        }
        finished.set(index, item);
      }
    },
    complete(response) {
      if (response?.status !== 'completed' || !Array.isArray(response.output)) {
        reject('INCOMPLETE_RESPONSE', 'The subscription response did not complete.');
      }
      if (response.output.length) {
        // The terminal snapshot is authoritative, including encrypted reasoning
        // that some transports add only there. Reject contradictory identities.
        for (const [index, item] of finished) {
          const terminal = response.output[index];
          if (!terminal || (item.id !== undefined && terminal.id !== item.id)) {
            reject('INVALID_STREAM', 'The finalized stream and completed response disagree.');
          }
        }
        return response;
      }
      for (const index of added.keys()) {
        if (!finished.has(index)) reject('INCOMPLETE_RESPONSE', 'A response output item did not finish.');
      }
      const indices = [...finished.keys()].sort((left, right) => left - right);
      if (indices.some((index, position) => index !== position)) {
        reject('INVALID_STREAM', 'The response stream omitted an output item.');
      }
      return { ...response, output: indices.map(index => finished.get(index)) };
    },
  };
}

export function completedResponse(response, model, toolNames = []) {
  if (response?.status !== 'completed' || !Array.isArray(response.output)) {
    reject('INCOMPLETE_RESPONSE', 'The subscription response did not complete.');
  }
  const output = response.output.map(safeOutputItem);
  const content = [];
  for (const item of output) {
    if (item.type === 'reasoning') {
      const text = item.summary.map(part => part.text).join('\n');
      if (text) content.push({ type: 'reasoning', text });
    } else if (item.type === 'function_call') {
      if (!toolNames.includes(item.name)) reject('UNKNOWN_TOOL', 'The response called a function that this Harness request did not offer.');
      content.push({ type: 'tool-call', id: item.call_id, name: item.name, arguments: item.arguments });
    } else {
      for (const part of item.content) {
        const text = part.type === 'output_text' ? part.text : part.refusal;
        if (text) content.push({ type: 'text', text });
      }
    }
  }
  if (!content.some(block => block.type === 'text' || block.type === 'tool-call')) {
    reject('EMPTY_RESPONSE', 'The subscription response completed without an answer or a tool call.');
  }
  return {
    content,
    usage: responseUsage(response.usage),
    reason: { kind: content.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' },
    replayState: { response: { version: 1, model, output, content: structuredClone(content) } },
  };
}

export function* responseChunks(result) {
  for (const [index, block] of result.content.entries()) {
    yield { type: 'block-start', index, blockType: block.type };
    if (block.type === 'text') yield { type: 'text-delta', index, text: block.text };
    else if (block.type === 'reasoning') yield { type: 'reasoning-delta', index, text: block.text };
    else yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index, block };
  }
  if (result.usage) yield { type: 'usage', usage: result.usage };
  yield { type: 'finish', reason: result.reason, replayState: result.replayState };
}
