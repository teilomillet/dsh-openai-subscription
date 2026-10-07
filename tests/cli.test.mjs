import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArguments } from '../cli.mjs';

test('npm-style symlink executable prints help without touching authentication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-openai-cli-'));
  try {
    const binary = join(directory, 'dsh-openai');
    await symlink(fileURLToPath(new URL('../cli.mjs', import.meta.url)), binary);
    const result = spawnSync(process.execPath, [binary, '--help'], {
      encoding: 'utf8', env: { ...process.env, DSH_HOME: join(directory, 'fresh-home') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dsh-openai connect/);
    assert.match(result.stdout, /DSH 0\.2\.1-alpha\.1/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('profile selection rejects path traversal and arbitrary command flags', () => {
  assert.deepEqual(parseArguments(['connect', '--profile', 'headless']), { command: 'connect', profile: 'headless' });
  for (const args of [['connect', '--profile', '../web'], ['connect', '--profile', '--global'], ['login', '--profile', 'web'], ['logout', '--force']]) {
    assert.throws(() => parseArguments(args));
  }
});
