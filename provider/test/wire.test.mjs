import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, completedResponse, createOutputCollector, responseChunks, responseUsage } from '../wire.mjs';

const model = 'test-subscription-model';
const tool = { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const options = extra => ({ provider: 'openai-subscription', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the file.' }] }], ...extra });
const response = output => ({ status: 'completed', output });
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', namespace: 'deepseek', name: 'read_file', arguments: '{"path":"notes.txt"}' };

test('public request uses list input, privacy settings and namespaced functions', () => {
  const source = options({ system: 'Follow the user.', tools: [{ ...tool, deferLoading: true }], temperature: 0, maxTokens: 100, top_p: 0.2, metadata: { forbidden: true } });
  const before = structuredClone(source);
  const body = buildRequest(source);
  assert.deepEqual(body.input, [{ role: 'user', content: 'Read the file.' }]);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, 'Follow the user.');
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.equal(body.tools[0].type, 'namespace');
  assert.equal(body.tools[0].name, 'deepseek');
  assert.deepEqual(body.tools[0].tools, [{ type: 'function', ...tool, strict: false }]);
  for (const key of ['temperature', 'top_p', 'max_output_tokens', 'metadata']) assert.equal(key in body, false);
  assert.deepEqual(source, before);
});

test('system changes and developer text remain in order, current tool declarations are complete', () => {
  const body = buildRequest(options({ messages: [
    { role: 'system', content: [{ type: 'text', text: 'First instructions.' }] },
    { role: 'user', content: [{ type: 'text', text: 'First task.' }] },
    { role: 'system', content: [{ type: 'text', text: 'Replacement instructions.' }] },
    { role: 'developer', content: [{ type: 'tool-addition', toolName: tool.name }, { type: 'text', text: 'Use this tool.' }] },
  ], tools: [tool] }));
  assert.deepEqual(body.input.map(item => [item.role, item.content]), [
    ['developer', 'First instructions.'], ['user', 'First task.'], ['developer', 'Replacement instructions.'], ['developer', 'Use this tool.'],
  ]);
  assert.equal(body.tools[0].tools.length, 1);
});

test('function call and result retain their correlation through the next request', () => {
  const converted = completedResponse(response([call]), model, [tool.name]);
  assert.deepEqual(converted.content, [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: call.arguments }]);
  const body = buildRequest(options({ tools: [tool], messages: [
    { role: 'assistant', content: converted.content, source: { provider: 'openai-subscription', model, replayState: converted.replayState } },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'File contents.' }] },
  ] }));
  assert.deepEqual(body.input[0], call);
  assert.deepEqual(body.input[1], { type: 'function_call_output', call_id: 'call_1', output: 'File contents.' });
  assert.equal(converted.reason.kind, 'tool-calls');
});

test('encrypted reasoning survives same-model replay without exposing raw payload as visible text', () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-model-reasoning', summary: [{ type: 'summary_text', text: 'I will inspect the file.' }] };
  const converted = completedResponse(response([reasoning, call]), model, [tool.name]);
  const body = buildRequest(options({ messages: [{ role: 'assistant', content: converted.content, source: { provider: 'openai-subscription', model, replayState: converted.replayState } }] }));
  assert.deepEqual(body.input[0], reasoning);
  assert.equal(JSON.stringify(converted.content).includes('encrypted-model-reasoning'), false);
});

test('edited or cross-model history cannot restore old native replay data', () => {
  const converted = completedResponse(response([{ type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'Original', annotations: [] }] }]), model);
  const history = { role: 'assistant', content: [{ type: 'text', text: 'Edited' }], source: { provider: 'openai-subscription', model, replayState: converted.replayState } };
  assert.deepEqual(buildRequest(options({ messages: [history] })).input, [{ role: 'assistant', content: 'Edited' }]);
  history.content = converted.content;
  history.source.model = 'another-model';
  assert.deepEqual(buildRequest(options({ messages: [history] })).input, [{ role: 'assistant', content: 'Original' }]);
});

test('only explicit deepseek namespace permits prefix normalization', () => {
  const explicit = completedResponse(response([{ ...call, name: 'deepseek.read_file' }]), model, [tool.name]);
  assert.equal(explicit.content[0].name, tool.name);
  assert.throws(() => completedResponse(response([{ ...call, namespace: undefined, name: 'deepseek.read_file' }]), model, [tool.name]), { code: 'INVALID_TOOL_CALL' });
  assert.throws(() => completedResponse(response([{ ...call, namespace: 'foreign' }]), model, [tool.name]), { code: 'UNSUPPORTED_TOOL_NAMESPACE' });
  assert.throws(() => completedResponse(response([call]), model, []), { code: 'UNKNOWN_TOOL' });
});

test('missing completion, incomplete, empty and unsupported output never become a successful finish', () => {
  for (const raw of [{}, { status: 'incomplete', output: [] }, { status: 'failed', output: [] }]) {
    assert.throws(() => completedResponse(raw, model), { code: 'INCOMPLETE_RESPONSE' });
  }
  assert.throws(() => completedResponse(response([]), model), { code: 'EMPTY_RESPONSE' });
  assert.throws(() => completedResponse(response([{ type: 'web_search_call' }]), model), { code: 'UNSUPPORTED_CONTENT' });
});

test('cached input is disjoint and total includes aggregate prompt plus output', () => {
  assert.deepEqual(responseUsage({ input_tokens: 100, output_tokens: 15, total_tokens: 115, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 10 } }), {
    inputTokens: 40, outputTokens: 15, cacheReadTokens: 60, totalTokens: 115, reasoningTokens: 10,
  });
  assert.throws(() => responseUsage({ input_tokens: 20, output_tokens: 1, input_tokens_details: { cached_tokens: 30 } }), { code: 'INVALID_USAGE' });
  assert.deepEqual(responseUsage({ input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 } }), {
    inputTokens: 50, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 30, totalTokens: 105,
  });
});

test('empty completed snapshot is reconstructed only from finalized, ordered output items', () => {
  const collector = createOutputCollector();
  collector.onEvent({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1' } });
  collector.onEvent({ type: 'response.output_text.delta', output_index: 0, delta: 'Partial text must not become an answer.' });
  collector.onEvent({ type: 'response.output_item.done', output_index: 0, item: call });
  const final = collector.complete(response([]));
  const converted = completedResponse(final, model, [tool.name]);
  assert.equal(converted.content[0].id, call.call_id);
  assert.equal(converted.reason.kind, 'tool-calls');
  assert.throws(() => collector.complete({ status: 'incomplete', output: [] }), { code: 'INCOMPLETE_RESPONSE' });
});

test('a delta or unfinished added item cannot turn an empty snapshot into success', () => {
  const collector = createOutputCollector();
  collector.onEvent({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1' } });
  collector.onEvent({ type: 'response.output_text.delta', output_index: 0, delta: 'Partial' });
  assert.throws(() => collector.complete(response([])), { code: 'INCOMPLETE_RESPONSE' });
  const noItems = createOutputCollector();
  noItems.onEvent({ type: 'response.output_text.delta', output_index: 0, delta: 'Partial' });
  assert.throws(() => completedResponse(noItems.complete(response([])), model), { code: 'EMPTY_RESPONSE' });
});

test('contradictory terminal identities and missing indices fail explicitly', () => {
  const collector = createOutputCollector();
  collector.onEvent({ type: 'response.output_item.done', output_index: 0, item: call });
  assert.throws(() => collector.complete(response([{ ...call, id: 'fc_other' }])), { code: 'INVALID_STREAM' });
  const gap = createOutputCollector();
  gap.onEvent({ type: 'response.output_item.done', output_index: 1, item: call });
  assert.throws(() => gap.complete(response([])), { code: 'INVALID_STREAM' });
});

test('block assembly protocol emits usage before exactly one terminal finish', () => {
  const converted = completedResponse({ ...response([call]), usage: { input_tokens: 5, output_tokens: 3 } }, model, [tool.name]);
  const chunks = [...responseChunks(converted)];
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'tool-call-delta', 'block-end', 'usage', 'finish']);
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1);
});

test('unsupported images and stop controls fail clearly rather than changing the request silently', () => {
  assert.throws(() => buildRequest(options({ stop: ['END'] })), { code: 'UNSUPPORTED_OPTION' });
  assert.throws(() => buildRequest(options({ messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }] })), { code: 'UNSUPPORTED_CONTENT' });
  assert.throws(() => buildRequest(options({ messages: [{ role: 'tool', content: [{ type: 'text', text: 'Uncorrelated' }] }] })), { code: 'INVALID_TOOL_RESULT' });
});
