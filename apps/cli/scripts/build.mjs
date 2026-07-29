import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(cliRoot, '..', '..');
const outputDirectory = join(cliRoot, 'dist');
const outputFile = join(outputDirectory, 'velograph-import.mjs');
const migrationOutput = join(cliRoot, 'migrations');

await rm(outputDirectory, { recursive: true, force: true });
await rm(migrationOutput, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  absWorkingDir: repositoryRoot,
  entryPoints: [join(cliRoot, 'src', 'bin.ts')],
  outfile: outputFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  external: ['better-sqlite3'],
  legalComments: 'none',
  sourcemap: false,
});
await chmod(outputFile, 0o755);
await cp(join(repositoryRoot, 'packages', 'db', 'migrations'), migrationOutput, {
  recursive: true,
});
