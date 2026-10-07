import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { SubscriptionAdapter, cachedModels } from '../index.mjs';

const model = 'test-subscription-model';
const models = [{ provider: 'openai-subscription', id: model, name: 'Test model', inputModalities: ['text'] }];
const options = { provider: 'openai-subscription', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello.' }] }] };
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

test('missing login advertises no models and returns AUTH without a request', async () => {
  let calls = 0;
  const adapter = new SubscriptionAdapter({ client: { runHarnessResponse: () => { calls++; } }, loadModels: async () => [] });
  assert.deepEqual(await adapter.listModels(), []);
  const chunks = await collect(adapter.stream(options));
  assert.equal(calls, 0);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason.failure.code, 'AUTH');
});

test('native attribution reaches authenticated request, terminal response is validated', async () => {
  let captured;
  const adapter = new SubscriptionAdapter({ loadModels: async () => models, client: { runHarnessResponse: async (body, transport) => {
    captured = { body, transport };
    return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello.' }] }] };
  } } });
  const chunks = await collect(adapter.stream(options));
  assert.match(captured.transport.headers['user-agent'], /^deepseek-harness\//);
  assert.equal(captured.body.store, false);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Hello.'), true);
  assert.equal(adapter.providerRetryPolicy().maxRetries, 0);
  assert.equal(Array.isArray(adapter.providerRetryPolicy().retryableCodes), true);
  assert.equal(typeof adapter.providerRetryPolicy().retryableCodes.includes('RATE_LIMIT'), 'boolean');
  assert.ok(adapter.providerRetryPolicy().initialDelayMs > 0);
  assert.ok(adapter.providerRetryPolicy().maxDelayMs >= adapter.providerRetryPolicy().initialDelayMs);
});

test('incomplete client result cannot emit successful partial text', async () => {
  const adapter = new SubscriptionAdapter({ loadModels: async () => models, client: { runHarnessResponse: async () => ({ status: 'incomplete', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Partial' }] }] }) } });
  const chunks = await collect(adapter.stream(options));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason.kind, 'error');
  assert.equal(chunks[0].reason.failure.code, 'INCOMPLETE_RESPONSE');
});

test('live subscription stream shape uses finalized items when terminal output is empty', async () => {
  const item = { type: 'message', id: 'msg_live_shape', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  const adapter = new SubscriptionAdapter({ loadModels: async () => models, client: { runHarnessResponse: async (_body, { onEvent }) => {
    onEvent({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    onEvent({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' });
    onEvent({ type: 'response.output_item.done', output_index: 0, item });
    onEvent({ type: 'response.completed', response: { status: 'completed', output: [] } });
    return { status: 'completed', output: [] };
  } } });
  const chunks = await collect(adapter.stream(options));
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'OK'), true);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(chunks.at(-1).replayState.response.output[0].id, item.id);
});

test('abort reaches the in-flight auth client and settles as aborted', async () => {
  const controller = new AbortController();
  const adapter = new SubscriptionAdapter({ loadModels: async () => models, client: { runHarnessResponse: async (_body, { signal }) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    signal.throwIfAborted();
  } } });
  const chunks = await collect(adapter.stream({ ...options, signal: controller.signal }));
  assert.equal(chunks.at(-1).reason.kind, 'aborted');
});

test('arbitrary exceptions cannot leak authorization headers or tokens', async () => {
  const secret = 'Bearer test-secret-token';
  const adapter = new SubscriptionAdapter({ loadModels: async () => models, client: { runHarnessResponse: async () => { throw new Error(secret); } } });
  const chunks = await collect(adapter.stream(options));
  assert.equal(JSON.stringify(chunks).includes(secret), false);
  assert.equal(chunks.at(-1).reason.kind, 'error');
});

test('real authentication and subscription error codes retain clear failure boundaries', async () => {
  const cases = [
    ['sign_in_required', 'AUTH'], ['sharing_not_enabled', 'AUTH'],
    ['subscription_sharing_usage_limit_exceeded', 'QUOTA'],
    ['subscription_sharing_unsupported_capability', 'UNSUPPORTED_OPTION'],
  ];
  for (const [code, expected] of cases) {
    const adapter = new SubscriptionAdapter({ loadModels: async () => models, client: { runHarnessResponse: async () => {
      throw Object.assign(new Error('Bearer hidden-token'), { code });
    } } });
    const chunks = await collect(adapter.stream(options));
    assert.equal(chunks.at(-1).reason.failure.code, expected);
    assert.equal(JSON.stringify(chunks).includes('hidden-token'), false);
  }
});

test('cache missing before login is empty; valid account listing advertises text only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-provider-test-'));
  const path = join(directory, 'models.json');
  try {
    assert.deepEqual(await cachedModels(path), []);
    await writeFile(path, JSON.stringify({ models: [{ slug: model, displayName: 'My account model' }] }));
    assert.deepEqual(await cachedModels(path), [{ provider: 'openai-subscription', id: model, name: 'My account model', inputModalities: ['text'] }]);
    assert.deepEqual(await cachedModels(pathToFileURL(path)), await cachedModels(path));
    await writeFile(path, 'invalid catalog; not a credential');
    await assert.rejects(cachedModels(path), { code: 'INVALID_MODEL_CATALOG' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('profile-verified reasoning levels survive the real Harness call boundary and exact wire request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-effort-test-'));
  const path = join(directory, 'models.json');
  const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  const captured = [];
  const ctx = new Context();
  try {
    await writeFile(path, JSON.stringify({ models: [{ slug: model, displayName: 'Verified model', reasoningEfforts: efforts }] }));
    const adapter = new SubscriptionAdapter({ loadModels: () => cachedModels(path), client: { runHarnessResponse: async body => {
      captured.push(body);
      return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] };
    } } });
    await ctx.plugin(LlmRuntime);
    ctx.llm.registerAdapter(['openai-subscription'], adapter);
    const info = await ctx.llm.resolveModelInfo('openai-subscription', model);
    assert.deepEqual(info.reasoning.efforts, [
      { id: 'none', name: 'None' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' },
      { id: 'xhigh', name: 'Extra high' }, { id: 'max', name: 'Max' },
    ]);
    assert.equal(Object.hasOwn(info.reasoning, 'defaultEffort'), false);
    const providerDefault = await ctx.llm.resolveCallConfig({ provider: 'openai-subscription', model });
    assert.equal(Object.hasOwn(providerDefault, 'reasoningEffort'), false);
    for (const reasoningEffort of efforts) {
      const config = await ctx.llm.resolveCallConfig({ provider: 'openai-subscription', model, reasoningEffort });
      const chunks = await collect(ctx.llm.stream({ ...options, ...config }));
      assert.equal(chunks.at(-1).reason.kind, 'stop');
      assert.deepEqual(captured.at(-1).reasoning, { effort: reasoningEffort });
    }
    await assert.rejects(ctx.llm.resolveCallConfig({ provider: 'openai-subscription', model, reasoningEffort: 'minimal' }), { code: 'UNSUPPORTED_REASONING_EFFORT' });
    const count = captured.length;
    const rejected = await collect(ctx.llm.stream({ ...options, reasoningEffort: 'minimal' }));
    assert.equal(rejected.at(-1).reason.failure.code, 'UNSUPPORTED_REASONING_EFFORT');
    assert.equal(captured.length, count);
  } finally {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown models have no invented reasoning levels and malformed effort metadata is refused', async () => {
  const adapter = new SubscriptionAdapter({ loadModels: async () => models, client: {} });
  assert.equal((await adapter.resolveModel('openai-subscription', model)).reasoning, undefined);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-effort-cache-test-'));
  const path = join(directory, 'models.json');
  try {
    for (const reasoningEfforts of [[], ['high', 'high'], ['minimal'], [['low']], 'high']) {
      await writeFile(path, JSON.stringify({ models: [{ slug: model, displayName: 'Test', reasoningEfforts }] }));
      await assert.rejects(cachedModels(path), { code: 'INVALID_MODEL_CATALOG' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
