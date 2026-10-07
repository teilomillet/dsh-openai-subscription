import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LlmAdapter, LlmError, attributionHeaders, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { createClient } from '../auth.mjs';
import { stateDirectory } from '../paths.mjs';
import { BoundaryError, PROVIDER, buildRequest, completedResponse, createOutputCollector, responseChunks } from './wire.mjs';

export const name = 'openai-subscription-local';
export const inject = ['llm'];
const EFFORT_NAMES = { none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export async function cachedModels(cachePath = join(stateDirectory, 'models.json')) {
  let document;
  try { document = JSON.parse(await readFile(cachePath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new LlmError('The saved subscription model catalog is invalid. Run the login setup again.', 'INVALID_MODEL_CATALOG');
  }
  if (!Array.isArray(document.models) || document.models.some(model =>
    !model || typeof model !== 'object' || Array.isArray(model)
    || typeof model.slug !== 'string' || !model.slug || typeof model.displayName !== 'string' || !model.displayName
    || (model.reasoningEfforts !== undefined && (!Array.isArray(model.reasoningEfforts)
      || model.reasoningEfforts.length === 0
      || model.reasoningEfforts.some(effort => typeof effort !== 'string' || !Object.hasOwn(EFFORT_NAMES, effort))
      || new Set(model.reasoningEfforts).size !== model.reasoningEfforts.length)))) {
    throw new LlmError('The saved subscription model catalog is invalid. Run the login setup again.', 'INVALID_MODEL_CATALOG');
  }
  return document.models.map(model => ({
    provider: PROVIDER, id: model.slug, name: model.displayName, inputModalities: ['text'],
    ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: [...model.reasoningEfforts] }),
  }));
}

function safeFailure(error, signal) {
  if (signal?.aborted || error?.code === 'cancelled' || error?.name === 'AbortError') {
    return { kind: 'aborted', failure: { code: 'ABORTED', message: 'The subscription request was cancelled.' } };
  }
  if (error instanceof BoundaryError || error instanceof LlmError) {
    return { kind: 'error', failure: { code: error.code, message: error.message } };
  }
  // Network/auth exceptions are not echoed: some libraries include request
  // bodies or headers. The auth client owns richer, secret-free diagnostics.
  const code = error?.code;
  if (['reauth_required', 'not_connected', 'login_required', 'sign_in_required', 'missing_credentials', 'invalid_grant', 'sharing_required', 'sharing_not_enabled'].includes(code)) {
    return { kind: 'error', failure: { code: 'AUTH', message: 'Connect your ChatGPT account using the local login setup, then restart Harness.' } };
  }
  if (['rate_limit_exceeded', 'rate_limit'].includes(code)) {
    return { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'The subscription provider asked this request to wait.' } };
  }
  if (['usage_limit_reached', 'usage_not_included', 'insufficient_quota', 'subscription_sharing_usage_limit_exceeded'].includes(code)) {
    return { kind: 'error', failure: { code: 'QUOTA', message: 'This request exceeds the available subscription allowance.' } };
  }
  if (code === 'subscription_sharing_unsupported_capability' || code === 'subscription_sharing_route_not_supported') {
    return { kind: 'error', failure: { code: 'UNSUPPORTED_OPTION', message: 'The ChatGPT subscription route does not support a capability in this request.' } };
  }
  if (error?.status === 401 || ['chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context', 'subscription_sharing_user_not_eligible'].includes(code)) {
    return { kind: 'error', failure: { code: 'AUTH', message: 'The selected ChatGPT connection or subscription permissions do not authorize this request.' } };
  }
  if (error?.status === 403) {
    return { kind: 'error', failure: { code: 'PERMISSION', message: 'A ChatGPT account, app or region policy prevented this request.' } };
  }
  if (error?.status === 429) {
    return { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'The subscription provider asked this request to wait.' } };
  }
  return { kind: 'error', failure: { code: 'SUBSCRIPTION_REQUEST_FAILED', message: 'The subscription request failed or ended before completion. Check the local login status and retry.' } };
}

export class SubscriptionAdapter extends LlmAdapter {
  constructor({ client, loadModels = cachedModels } = {}) {
    super();
    this.client = client ?? createClient();
    this.loadModels = loadModels;
  }
  providerInfo(provider) { return { id: provider, name: 'OpenAI subscription (ChatGPT)' }; }
  // Keep the smoke-test adapter bounded; a failed request is not retried five times.
  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'openai-subscription'); }
  listModels() { return this.loadModels(); }
  async resolveModel(provider, model, signal) {
    signal?.throwIfAborted();
    const models = await this.loadModels();
    signal?.throwIfAborted();
    if (!models.length) throw new LlmError('Connect your ChatGPT account using the local login setup, then restart Harness.', 'AUTH');
    const selected = models.find(candidate => candidate.id === model);
    if (!selected) throw new LlmError('Select a model returned by your subscription account.', 'UNKNOWN_MODEL');
    const { reasoningEfforts, ...metadata } = selected;
    return {
      ...metadata, provider, systemPromptUpdate: 'in-history',
      ...(reasoningEfforts === undefined ? {} : { reasoning: {
        efforts: reasoningEfforts.map(id => ({ id, name: EFFORT_NAMES[id] })),
      } }),
    };
  }
  async *stream(options) {
    try {
      options.signal?.throwIfAborted();
      const model = await this.resolveModel(options.provider, options.model, options.signal);
      if (options.reasoningEffort !== undefined && !model.reasoning?.efforts.some(effort => effort.id === options.reasoningEffort)) {
        throw new LlmError('Select a reasoning effort verified for this subscription model.', 'UNSUPPORTED_REASONING_EFFORT');
      }
      const body = buildRequest(options);
      const collector = createOutputCollector();
      const response = await this.client.runHarnessResponse(body, { signal: options.signal, headers: attributionHeaders(), onEvent: collector.onEvent });
      options.signal?.throwIfAborted();
      const result = completedResponse(collector.complete(response), options.model, (options.tools ?? []).map(tool => tool.name));
      // Publish only a validated terminal response. This intentionally buffers
      // token deltas; the setup supports cancellation while the request runs.
      yield* responseChunks(result);
    } catch (error) {
      yield { type: 'finish', reason: safeFailure(error, options.signal) };
    }
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new SubscriptionAdapter());
}
