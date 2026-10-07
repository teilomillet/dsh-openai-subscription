import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeModelCatalog } from '../auth.mjs';

const at = '2026-10-07T15:00:00.000Z';
const verified = (extra = {}) => ({ slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', reasoningEfforts: ['low', 'medium'], verifiedAt: at, ...extra });
const server = () => [{ slug: 'gpt-6-sol', displayName: 'GPT-6 Sol' }, { slug: 'gpt-6-astra', displayName: 'GPT-6 Astra' }];

test('verified model absent from server catalog appends once and preserves ordering', () => {
  const original = server();
  const models = mergeModelCatalog(original, 'profile-a', { profileId: 'profile-a', models: [verified(), verified({ reasoningEfforts: ['high'] })] });
  assert.deepEqual(models.map(item => item.slug), ['gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol']);
  assert.deepEqual(models[2].reasoningEfforts, ['low', 'medium', 'high']);
  assert.deepEqual(original, server());
});

test('existing server entry is enriched without changing its label or duplicating it', () => {
  const models = mergeModelCatalog(server(), 'profile-a', { profileId: 'profile-a', models: [verified({ slug: 'gpt-6-sol', displayName: 'Alternate label' })] });
  assert.equal(models.length, 2);
  assert.equal(models[0].displayName, 'GPT-6 Sol');
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'medium']);
});

test('overrides cannot advertise a model for a mismatched or unidentified profile', () => {
  for (const profileId of ['profile-b', '', undefined]) {
    assert.deepEqual(mergeModelCatalog(server(), profileId, { profileId: 'profile-a', models: [verified()] }), server());
  }
});

test('invalid verification metadata never advertises a model or copies unknown fields', () => {
  const invalid = [
    verified({ slug: 'bad\nslug' }), verified({ displayName: '' }), verified({ verifiedAt: 'invalid' }),
    verified({ reasoningEfforts: [] }), verified({ reasoningEfforts: ['invented'] }), verified({ reasoningEfforts: ['ultra'] }), verified({ reasoningEfforts: ['minimal'] }),
    verified({ reasoningEfforts: ['low', 'low'] }), verified({ verifiedAt: null }),
  ];
  assert.deepEqual(mergeModelCatalog(server(), 'profile-a', { profileId: 'profile-a', models: invalid }), server());
  const models = mergeModelCatalog([], 'profile-a', { profileId: 'profile-a', models: [verified({ extra: 'not copied' })] });
  assert.equal(Object.hasOwn(models[0], 'extra'), false);
  assert.deepEqual(mergeModelCatalog(server(), 'profile-a', { profileId: 'profile-a', models: {} }), server());
});


test('documented none effort survives the profile-bound metadata merge', () => {
  const models = mergeModelCatalog([], 'profile-a', { profileId: 'profile-a', models: [verified({ slug: 'gpt-5.6-sol', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] })] });
  assert.deepEqual(models[0].reasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});
