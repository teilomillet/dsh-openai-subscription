import assert from 'node:assert/strict';
// Added locally on 2026-10-07 to verify the DeepSeek Harness raw Responses extension.
import test from 'node:test';
import { runHarnessResponse, streamResponse } from '../dist/responses.js';
import { createKeychainEncryption } from '../../../keychain.mjs';

const request = () => ({ model: 'test-model', input: [{ role: 'user', content: 'test' }], store: false, stream: true });
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const completion = { id: 'resp_test', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] };
function fakeStream(frames) {
  return new Response(new ReadableStream({ start(controller) {
    for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('harness response uses only public Responses endpoint, preserves raw events, and requires completion', async t => {
  const raw = [event({ type: 'response.output_text.delta', delta: 'ok' }), event({ type: 'response.completed', response: completion })].join('');
  const received = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer TEST_ONLY');
    assert.equal(init.headers['user-agent'], 'deepseek-test');
    assert.deepEqual(JSON.parse(init.body), request());
    return fakeStream([raw.slice(0, 43), raw.slice(43, 44), raw.slice(44)]);
  });
  const result = await runHarnessResponse('TEST_ONLY', request(), { headers: { 'user-agent': 'deepseek-test' }, onEvent: item => received.push(item) }, new AbortController().signal);
  assert.deepEqual(result, completion);
  assert.equal(received.length, 2);
});

test('invalid transport contract and credential-overriding headers fail before network', async t => {
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw Error('unexpected'); });
  for (const body of [{ ...request(), store: true }, { ...request(), stream: false }, { ...request(), input: 'bad' }]) {
    await assert.rejects(runHarnessResponse('TEST_ONLY', body, {}, new AbortController().signal), { code: 'invalid_request' });
  }
  await assert.rejects(runHarnessResponse('TEST_ONLY', request(), { headers: { authorization: 'Bearer override' } }, new AbortController().signal), { code: 'invalid_request' });
  assert.equal(fetched, false);
});

test('partial, failed, malformed completion and oversized streams never return success', async t => {
  const cases = [
    [[event({ type: 'response.output_text.delta', delta: 'partial' })], 'stream_interrupted'],
    [[event({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } })], 'subscription_sharing_usage_limit_exceeded'],
    [[event({ type: 'response.completed', response: { status: 'incomplete' } })], 'invalid_stream'],
    [['data: ' + 'x'.repeat(4 * 1024 * 1024 + 1)], 'invalid_stream'],
  ];
  for (const [frames, code] of cases) {
    t.mock.method(globalThis, 'fetch', async () => fakeStream(frames));
    await assert.rejects(runHarnessResponse('TEST_ONLY', request(), {}, new AbortController().signal), { code });
    t.mock.restoreAll();
  }
});

test('keychain-backed AES-GCM encrypts without plaintext and rejects tampering or missing key', async () => {
  const key = Buffer.alloc(32, 8).toString('base64');
  const operations = [];
  const encryption = createKeychainEncryption('/test/auth', { keyLoader: async create => { operations.push(create); return { ok: true, key }; } });
  const ciphertext = await encryption.encrypt('PRIVATE_TEST_TOKEN');
  assert.equal(Buffer.from(ciphertext).includes(Buffer.from('PRIVATE_TEST_TOKEN')), false);
  assert.equal(await encryption.decrypt(ciphertext), 'PRIVATE_TEST_TOKEN');
  assert.deepEqual(operations, [true]);
  const damaged = Buffer.from(ciphertext); damaged[damaged.length - 1] ^= 1;
  await assert.rejects(encryption.decrypt(damaged));
  const missing = createKeychainEncryption('/test/auth', { keyLoader: async create => { assert.equal(create, false); return { ok: false }; } });
  await assert.rejects(missing.decrypt(ciphertext), /Keychain/);
});


test('SDK text helper preserves deltas when terminal completed output is empty', async t => {
  t.mock.method(globalThis, 'fetch', async () => fakeStream([
    event({ type: 'response.output_text.delta', delta: 'Hello, ' }),
    event({ type: 'response.output_text.delta', delta: 'world!' }),
    event({ type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [] } }),
  ]));
  const deltas = [];
  const result = await streamResponse('TEST_ONLY', { model: 'test-model', input: 'test', onDelta: text => deltas.push(text) }, new AbortController().signal);
  assert.deepEqual(result, { text: 'Hello, world!' });
  assert.deepEqual(deltas, ['Hello, ', 'world!']);
});
