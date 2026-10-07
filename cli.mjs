#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, connect, cacheModels, modelsFile, safeFailure } from './auth.mjs';
import { realpath, rm } from 'node:fs/promises';

const root = dirname(fileURLToPath(import.meta.url));
const HELP = `DSH OpenAI subscription add-on (macOS)

  dsh-openai connect [--profile web]  Install into DSH and sign in
  dsh-openai login                   Sign in to an already installed add-on
  dsh-openai status                  Show connection status
  dsh-openai models                  Refresh the model catalog
  dsh-openai logout                  Disconnect this add-on

Requires Node 22+, DSH 0.2.1-alpha.1, pnpm, and macOS Command Line Tools.
Credentials stay in local encrypted storage backed by macOS Keychain.
`;

export function parseArguments(args) {
  const command = args[0] ?? 'connect';
  if (command === '--help' || command === '-h') return { command: 'help' };
  if (!['connect', 'login', 'status', 'models', 'logout'].includes(command)) throw new Error(HELP);
  let profile = 'web';
  if (args.length > 1) {
    if (command !== 'connect' || args.length !== 3 || args[1] !== '--profile' || !/^[a-z][a-z0-9-]{0,63}$/.test(args[2])) {
      throw new Error(HELP);
    }
    profile = args[2];
  }
  return { command, profile };
}

export async function runDsh(args) {
  return new Promise((resolveExit, reject) => {
    const child = spawn('dsh', args, { stdio: 'inherit', shell: false });
    child.once('error', error => reject(new Error(error.code === 'ENOENT'
      ? 'Install DSH first: npm install -g @deepseek-ai/dsh@0.2.1-alpha.1'
      : 'Could not start DSH.')));
    child.once('exit', (code, signal) => code === 0 ? resolveExit() : reject(new Error(`DSH installation failed${signal ? ` (${signal})` : ` (exit ${code})`}.`)));
  });
}

export async function main(args = process.argv.slice(2)) {
  const { command, profile } = parseArguments(args);
  if (command === 'help') { console.log(HELP); return; }
  if (process.platform !== 'darwin') throw new Error('This release requires macOS Keychain. Windows and Linux are not supported yet.');
  if (command === 'connect') await runDsh(['plugin', '--profile', profile, 'add', `file:${root}`]);
  const client = createClient();
  if (command === 'connect' || command === 'login') {
    console.log('Continue with ChatGPT in your browser and allow this add-on to use your plan.');
    const result = await connect(client);
    console.log(`Connected. ${result.models.length} OpenAI model(s) available.`);
    if (result.verification.status === 'unavailable') console.log('GPT-6.1 Sol could not be verified for this account; discovered models remain available.');
    console.log(command === 'connect' && profile !== 'web'
      ? `The provider is installed in the ${profile} profile. Select provider openai-subscription and an available model in that profile's configuration.`
      : 'Run dsh web, then choose an OpenAI subscription model in the model menu. Restart DSH if it is already running.');
  } else if (command === 'status') {
    const session = await client.getSession();
    console.log(session.status === 'connected' && session.sharing ? 'Connected; ChatGPT plan usage enabled.' : 'Disconnected. Run dsh-openai connect.');
  } else if (command === 'models') {
    for (const model of await cacheModels(client)) console.log(`${model.slug} — ${model.displayName}`);
  } else {
    await rm(modelsFile, { force: true });
    await client.disconnect();
    console.log('Signed out.');
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(error.name === 'ChatGPTError' ? safeFailure(error) : error.message); process.exitCode = 1; }
}
