import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cacheModels, connect } from '../auth.mjs';

const connected = (profileId = 'profile-a') => ({ status: 'connected', sharing: true, profileId });
const model = { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' };
const doneMessage = { id: 'message_test', type: 'message', content: [{ type: 'output_text', text: 'OK' }] };
const complete = { status: 'completed', output: [doneMessage] };
async function directory(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-openai-connect-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}
function fakeClient({ discovered = [], initial = connected(), result = complete, probe } = {}) {
  const counts = { signIn: 0, probe: 0 };
  let session = initial;
  return {
    counts,
    setSession(value) { session = value; },
    async getSession() { return session; },
    async signIn() { counts.signIn++; session = connected(); return session; },
    async listModels() { return discovered; },
    async runHarnessResponse(body, options) {
      counts.probe++;
      assert.equal(body.model, 'gpt-6.1-sol');
      assert.deepEqual(body.reasoning, { effort: 'low' });
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal(Array.isArray(body.input), true);
      assert.equal(options.signal instanceof AbortSignal, true);
      return probe ? probe(body, options) : result;
    },
  };
}

test('reuse sharing connection; enrich discovered capabilities without testing undocumented account access', async t => {
  const stateDir = await directory(t);
  const client = fakeClient({ discovered: [model, { slug: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' }] });
  const receipt = await connect(client, { stateDir });
  assert.equal(client.counts.signIn, 0);
  assert.equal(client.counts.probe, 0);
  assert.equal(receipt.verification.status, 'catalog');
  assert.deepEqual(receipt.verification.testedReasoningEfforts, []);
  assert.deepEqual(receipt.models[0].reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(receipt.models[1].reasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(receipt.models[0].verifiedAt, undefined);
});

test('new account probes omitted GPT6.1 once; collects completed item events and separates tested from documented', async t => {
  const stateDir = await directory(t);
  const client = fakeClient({ initial: { status: 'disconnected', sharing: false }, probe(_body, options) {
    options.onEvent({ type: 'response.output_item.done', output_index: 0, item: doneMessage });
    return { status: 'completed', output: [] };
  } });
  const receipt = await connect(client, { stateDir });
  assert.equal(client.counts.signIn, 1);
  assert.equal(client.counts.probe, 1);
  assert.equal(receipt.verification.status, 'verified');
  assert.deepEqual(receipt.verification.testedReasoningEfforts, ['low']);
  assert.deepEqual(receipt.verification.documentedReasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  const overrides = JSON.parse(await readFile(join(stateDir, 'model-overrides.json'), 'utf8'));
  assert.equal(overrides.profileId, 'profile-a');
  assert.deepEqual(overrides.models[0].verifiedEfforts, ['low']);
  assert.equal(receipt.models[0].slug, model.slug);
  await connect(client, { stateDir });
  assert.equal(client.counts.probe, 1);
});

test('same-profile verified cached model skips probe and remains available after startup cache refresh', async t => {
  const stateDir = await directory(t);
  const verified = { ...model, reasoningEfforts: ['low'], verifiedEfforts: ['low'], verifiedAt: '2026-10-07T15:00:00.000Z' };
  await writeFile(join(stateDir, 'models.json'), JSON.stringify({ profileId: 'profile-a', models: [verified] }));
  const client = fakeClient();
  const receipt = await connect(client, { stateDir });
  assert.equal(receipt.verification.status, 'cached');
  assert.equal(client.counts.probe, 0);
  const refreshed = await cacheModels(client, { stateDir });
  assert.equal(refreshed[0].slug, model.slug);
  assert.deepEqual(refreshed[0].reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('refused, failed, incomplete and empty probes never advertise an omitted model or retry', async t => {
  for (const result of [
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] },
    { status: 'failed', output: [] }, { status: 'incomplete', output: [] }, { status: 'completed', output: [] },
  ]) {
    const stateDir = await directory(t);
    const client = fakeClient({ result });
    const receipt = await connect(client, { stateDir });
    assert.equal(receipt.verification.status, 'unavailable');
    assert.equal(client.counts.probe, 1);
    assert.deepEqual(receipt.models, []);
    await assert.rejects(readFile(join(stateDir, 'model-overrides.json')), { code: 'ENOENT' });
  }
});

test('foreign-profile verification never skips a fresh account probe', async t => {
  const stateDir = await directory(t);
  await writeFile(join(stateDir, 'model-overrides.json'), JSON.stringify({ profileId: 'profile-b', models: [{ ...model, reasoningEfforts: ['low'], verifiedAt: '2026-10-07T15:00:00.000Z' }] }));
  const client = fakeClient();
  const receipt = await connect(client, { stateDir });
  assert.equal(client.counts.probe, 1);
  assert.equal(receipt.verification.status, 'verified');
  assert.equal(JSON.parse(await readFile(join(stateDir, 'model-overrides.json'), 'utf8')).profileId, 'profile-a');
});

test('profile change during successful probe rejects before writing metadata', async t => {
  const stateDir = await directory(t);
  const client = fakeClient({ probe() { client.setSession(connected('profile-b')); return complete; } });
  await assert.rejects(connect(client, { stateDir }), { code: 'connection_changed' });
  await assert.rejects(readFile(join(stateDir, 'models.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(stateDir, 'model-overrides.json')), { code: 'ENOENT' });
});

test('fresh discovery enriches only exact known slugs and never introduces absent models', async t => {
  const stateDir = await directory(t);
  const client = fakeClient({ discovered: [{ slug: 'gpt-6-astra', displayName: 'GPT-6 Astra' }, { slug: 'gpt-6.1-sol-custom', displayName: 'Custom' }] });
  const models = await cacheModels(client, { stateDir });
  assert.deepEqual(models.map(item => item.slug), ['gpt-6-astra', 'gpt-6.1-sol-custom']);
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(models[1].reasoningEfforts, undefined);
  assert.equal(client.counts.probe, 0);
});
