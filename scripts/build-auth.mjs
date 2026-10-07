import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'vendor/siwc-local/tsconfig.json')], { stdio: 'inherit' });
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

// Preserve the DevKit license's modification notices in redistributed builds.
const notice = '// Modified locally on 2026-10-07 to add the DeepSeek Harness raw Responses extension.';
for (const module of ['index', 'responses', 'types']) {
  for (const extension of ['js', 'd.ts']) {
    const filename = join(root, 'vendor/siwc-local/dist', `${module}.${extension}`);
    const contents = await readFile(filename, 'utf8');
    const added = !contents.startsWith(notice + '\n');
    if (added) await writeFile(filename, notice + '\n' + contents);
    const mapFile = filename + '.map';
    const map = JSON.parse(await readFile(mapFile, 'utf8'));
    if (added) map.mappings = ';' + map.mappings;
    map.x_local_modification = notice.slice(3);
    await writeFile(mapFile, JSON.stringify(map));
  }
}
