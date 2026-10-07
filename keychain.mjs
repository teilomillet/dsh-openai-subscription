import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { stateDirectory } from './paths.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const unavailable = () => new Error('Secure macOS Keychain storage is unavailable. Unlock your Keychain and try again.');

// Only pipes carry key material. Child diagnostics are deliberately not exposed.
async function child(executable, args, input = '', options = {}) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let output = Buffer.alloc(0);
    const timeout = setTimeout(() => { process.kill(); reject(unavailable()); }, 60_000);
    process.stdout.on('data', bytes => {
      output = Buffer.concat([output, bytes]);
      if (output.length > 8192) { process.kill(); reject(unavailable()); }
    });
    process.stderr.resume();
    process.on('error', () => { clearTimeout(timeout); reject(unavailable()); });
    process.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(unavailable());
      else resolvePromise(output.toString('utf8'));
    });
    process.stdin.on('error', () => {});
    process.stdin.end(input);
  });
}

let build;
export async function prepareKeychainHelper() {
  if (process.platform !== 'darwin') throw unavailable();
  if (!build) build = (async () => {
    const directory = join(stateDirectory, 'bin');
    const binary = join(directory, 'keychain-helper');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await access(binary); return binary; } catch {}
    const temporary = `${binary}.${process.pid}.tmp`;
    try {
      await child('/usr/bin/xcrun', ['swiftc', join(root, 'keychain-helper.swift'), '-o', temporary], '', {
        env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(directory, 'module-cache') },
      });
      await chmod(temporary, 0o700);
      await rename(temporary, binary);
      return binary;
    } finally { await rm(temporary, { force: true }); }
  })().catch(error => { build = undefined; throw error; });
  return build;
}

export function createKeychainEncryption(storageDir, { keyLoader } = {}) {
  const account = createHash('sha256').update(resolve(storageDir)).digest('hex');
  let keyPromise;
  async function key(create) {
    if (!keyPromise) keyPromise = (async () => {
      const value = keyLoader ? await keyLoader(create) : JSON.parse(await child(await prepareKeychainHelper(), [], JSON.stringify({
        operation: create ? 'get-or-create' : 'get',
        service: 'org.deepseek-harness.local-subscription-test', account,
      })));
      if (!value?.ok || typeof value.key !== 'string') throw unavailable();
      const bytes = Buffer.from(value.key, 'base64');
      if (bytes.length !== 32 || bytes.toString('base64') !== value.key) throw unavailable();
      return bytes;
    })().catch(error => { keyPromise = undefined; throw error; });
    return keyPromise;
  }
  return {
    id: 'macos-keychain-aes256gcm-v1',
    async isAvailable() { return process.platform === 'darwin' || Boolean(keyLoader); },
    async encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', await key(true), iv);
      cipher.setAAD(Buffer.from('deepseek-harness-auth-v1'));
      const payload = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), payload]);
    },
    async decrypt(ciphertext) {
      const bytes = Buffer.from(ciphertext);
      if (bytes.length < 29 || bytes[0] !== 1) throw unavailable();
      const decipher = createDecipheriv('aes-256-gcm', await key(false), bytes.subarray(1, 13));
      decipher.setAAD(Buffer.from('deepseek-harness-auth-v1'));
      decipher.setAuthTag(bytes.subarray(13, 29));
      return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8');
    },
  };
}

export async function openAuthorizationBrowser(url) {
  const result = JSON.parse(await child(await prepareKeychainHelper(), [], JSON.stringify({ operation: "open-browser", url })));
  if (result.ok !== true) throw new Error("The browser could not be opened.");
}
