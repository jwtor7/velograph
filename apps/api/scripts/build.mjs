import { chmod, copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(apiRoot, '..', '..');
const outputDirectory = join(apiRoot, 'dist');
const outputFile = join(outputDirectory, 'velograph-api.mjs');
const runtimeFile = join(outputDirectory, 'api-runtime.mjs');
const migrationOutput = join(apiRoot, 'migrations');

await rm(outputDirectory, { recursive: true, force: true });
await rm(migrationOutput, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  absWorkingDir: repositoryRoot,
  entryPoints: [join(apiRoot, 'src', 'main.ts')],
  outfile: runtimeFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  external: ['better-sqlite3', 'fflate'],
  legalComments: 'none',
  sourcemap: false,
});
await copyFile(join(apiRoot, 'src', 'bin.mjs'), outputFile);
await chmod(outputFile, 0o755);
await cp(join(repositoryRoot, 'packages', 'db', 'migrations'), migrationOutput, {
  recursive: true,
});
