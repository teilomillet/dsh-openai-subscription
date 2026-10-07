import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatGPT, ChatGPTError } from './vendor/siwc-local/dist/index.js';
import { createKeychainEncryption, openAuthorizationBrowser } from './keychain.mjs';
import { documentedCapabilities, enrichDocumentedCapabilities } from './capabilities.mjs';
import { stateDirectory } from './paths.mjs';
export { stateDirectory } from './paths.mjs';

export const authDirectory = join(stateDirectory, 'auth');
export const modelsFile = join(stateDirectory, 'models.json');
export const modelOverridesFile = join(stateDirectory, 'model-overrides.json');

export function createClient({ storageDir = authDirectory } = {}) {
  return createChatGPT({
    appName: 'DeepSeek Harness (local subscription test)',
    appId: 'deepseek-harness-local-test',
    redirectPort: 0,
    storageDir,
    sendHostId: true,
    credentialEncryption: createKeychainEncryption(storageDir),
    openBrowser: openAuthorizationBrowser,
  });
}

const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

function verifiedModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value.slug) ||
      typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 120 || /[\u0000-\u001f]/.test(value.displayName) ||
      !Array.isArray(value.reasoningEfforts) || !value.reasoningEfforts.length || value.reasoningEfforts.length > REASONING_EFFORTS.size ||
      !value.reasoningEfforts.every(effort => REASONING_EFFORTS.has(effort)) ||
      new Set(value.reasoningEfforts).size !== value.reasoningEfforts.length ||
      typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt)) ||
      new Date(value.verifiedAt).toISOString() !== value.verifiedAt) return undefined;
  const verifiedEfforts = Array.isArray(value.verifiedEfforts) && value.verifiedEfforts.every(effort => value.reasoningEfforts.includes(effort))
    ? [...new Set(value.verifiedEfforts)] : undefined;
  return { slug: value.slug, displayName: value.displayName, reasoningEfforts: [...value.reasoningEfforts], verifiedAt: value.verifiedAt,
    ...(verifiedEfforts ? { verifiedEfforts } : {}) };
}

/** The server catalog is discovery evidence; successful explicit probes can verify omitted models. */
export function mergeModelCatalog(serverModels, profileId, overrides) {
  const models = serverModels.map(model => ({ ...model }));
  if (typeof profileId !== 'string' || !profileId || !overrides || typeof overrides !== 'object' ||
      Array.isArray(overrides) || overrides.profileId !== profileId || !Array.isArray(overrides.models) || overrides.models.length > 100) return models;
  const entries = new Map(models.map(model => [model.slug, model]));
  for (const candidate of overrides.models) {
    const verified = verifiedModel(candidate);
    if (!verified) continue;
    const existing = entries.get(verified.slug);
    if (existing) {
      existing.reasoningEfforts = [...new Set([...(existing.reasoningEfforts ?? []), ...verified.reasoningEfforts])];
      existing.verifiedAt = existing.verifiedAt && existing.verifiedAt > verified.verifiedAt ? existing.verifiedAt : verified.verifiedAt;
      if (verified.verifiedEfforts) existing.verifiedEfforts = [...new Set([...(existing.verifiedEfforts ?? []), ...verified.verifiedEfforts])];
    } else {
      models.push(verified);
      entries.set(verified.slug, verified);
    }
  }
  return models;
}

async function readMetadata(filename) {
  try {
    if ((await stat(filename)).size > 64 * 1024) return undefined;
    const bytes = await readFile(filename);
    if (bytes.byteLength > 64 * 1024) return undefined;
    return JSON.parse(bytes.toString('utf8'));
  } catch { return undefined; }
}

async function writeMetadata(filename, value) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

function assertProfile(session, profileId) {
  if (!profileId || session.profileId !== profileId || session.status !== 'connected' || !session.sharing) {
    throw new ChatGPTError('connection_changed', 'The selected ChatGPT profile changed during model discovery. Try again.');
  }
}

async function saveCatalog(client, profileId, models, stateDir) {
  assertProfile(await client.getSession(), profileId);
  await writeMetadata(join(stateDir, 'models.json'), { models, profileId, savedAt: new Date().toISOString() });
  return models;
}

export async function cacheModels(client, { stateDir = stateDirectory } = {}) {
  const before = await client.getSession();
  const serverModels = await client.listModels();
  assertProfile(await client.getSession(), before.profileId);
  const overrides = await readMetadata(join(stateDir, 'model-overrides.json'));
  const models = enrichDocumentedCapabilities(mergeModelCatalog(serverModels, before.profileId, overrides));
  return saveCatalog(client, before.profileId, models, stateDir);
}

function completedText(response, doneItems) {
  const output = Array.isArray(response.output) && response.output.length ? response.output : [...doneItems.values()];
  let text = '';
  for (const item of output) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === 'refusal') throw new ChatGPTError('probe_refused', 'The model access check was refused.');
      if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
    }
  }
  return text;
}

/** Connect a user and verify a catalog-omitted model without treating documentation as entitlement. */
export async function connect(client, { stateDir = stateDirectory } = {}) {
  let session = await client.getSession();
  if (session.status !== 'connected' || !session.sharing) session = await client.signIn();
  if (!session.sharing) throw new ChatGPTError('sharing_not_enabled', 'Enable this app to use your ChatGPT plan before continuing.');
  const profileId = session.profileId;
  assertProfile(session, profileId);
  const [overrides, cached] = await Promise.all([
    readMetadata(join(stateDir, 'model-overrides.json')), readMetadata(join(stateDir, 'models.json')),
  ]);
  const serverModels = await client.listModels();
  assertProfile(await client.getSession(), profileId);
  let models = enrichDocumentedCapabilities(mergeModelCatalog(serverModels, profileId, overrides));
  const capability = documentedCapabilities['gpt-6.1-sol'];
  const verification = { model: capability.slug, status: 'catalog', testedReasoningEfforts: [], documentedReasoningEfforts: [...capability.reasoningEfforts] };
  if (!serverModels.some(model => model.slug === capability.slug)) {
    const fromOverrides = mergeModelCatalog([], profileId, overrides).find(model => model.slug === capability.slug);
    const fromCache = mergeModelCatalog([], profileId, cached).find(model => model.slug === capability.slug);
    const previous = fromOverrides ?? fromCache;
    if (previous) {
      verification.status = 'cached';
      verification.testedReasoningEfforts = previous.verifiedEfforts ?? [];
      if (!fromOverrides) {
        const current = mergeModelCatalog([], profileId, overrides);
        await writeMetadata(join(stateDir, 'model-overrides.json'), { profileId, models: [...current, previous] });
        models = enrichDocumentedCapabilities(mergeModelCatalog(serverModels, profileId, { profileId, models: [...current, previous] }));
      }
    } else {
      try {
        const doneItems = new Map();
        const response = await client.runHarnessResponse({
          model: capability.slug, input: [{ role: 'user', content: 'Reply exactly OK.' }],
          reasoning: { effort: 'low' }, store: false, stream: true,
        }, { signal: AbortSignal.timeout(60_000), onEvent(event) {
          if (event.type === 'response.output_item.done' && event.item?.type === 'message') {
            doneItems.set(event.item.id ?? event.output_index ?? doneItems.size, event.item);
          }
        } });
        if (response?.status !== 'completed' || completedText(response, doneItems).trim() !== 'OK') {
          throw new ChatGPTError('probe_unconfirmed', 'The model access check did not return the expected completed response.');
        }
        assertProfile(await client.getSession(), profileId);
        const verified = { slug: capability.slug, displayName: capability.displayName,
          reasoningEfforts: [...capability.reasoningEfforts], verifiedEfforts: ['low'], verifiedAt: new Date().toISOString(),
          evidence: { inference: 'response.completed with OK', testedEffort: 'low', documentedEffortsSource: capability.source } };
        const current = mergeModelCatalog([], profileId, overrides).filter(model => model.slug !== capability.slug);
        const updated = { profileId, models: [...current, verified] };
        await writeMetadata(join(stateDir, 'model-overrides.json'), updated);
        models = enrichDocumentedCapabilities(mergeModelCatalog(serverModels, profileId, updated));
        verification.status = 'verified';
        verification.testedReasoningEfforts = ['low'];
      } catch (error) {
        assertProfile(await client.getSession(), profileId);
        if (error instanceof ChatGPTError && error.code === 'connection_changed') throw error;
        verification.status = 'unavailable';
        verification.errorCode = error instanceof ChatGPTError ? error.code : 'probe_failed';
      }
    }
  }
  await saveCatalog(client, profileId, models, stateDir);
  return { session: await client.getSession(), models, verification };
}

export function safeFailure(error) {
  if (error instanceof ChatGPTError) return `${error.code}: ${error.message}`;
  return 'The operation could not be completed securely. Check your connection and macOS Keychain.';
}

async function main() {
  const command = process.argv[2] ?? 'status';
  if (!['login', 'status', 'models', 'logout'].includes(command)) {
    console.error('Usage: node auth.mjs login|status|models|logout');
    process.exitCode = 2;
    return;
  }
  const client = createClient();
  try {
    if (command === 'login') {
      console.log('Continue with ChatGPT in your browser and enable this app to use your ChatGPT plan.');
      console.log(JSON.stringify(await connect(client), null, 2));
    } else if (command === 'status') {
      console.log(JSON.stringify(await client.getSession(), null, 2));
    } else if (command === 'models') {
      console.log(JSON.stringify(await cacheModels(client), null, 2));
    } else {
      // Stop advertising the old account's model catalog even if remote revocation fails.
      await rm(modelsFile, { force: true });
      await client.disconnect();
      console.log('Signed out. Registration and installation identity remain saved for reuse.');
    }
  } catch (error) {
    console.error(safeFailure(error));
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
