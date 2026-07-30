import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimePackage } from '../../../scripts/build-runtime-package.mjs';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '..', '..');

await buildRuntimePackage({
  repositoryRoot,
  packageRoot,
  entryPoint: join(packageRoot, 'src', 'index.ts'),
  alias: {
    '@velograph/api': join(repositoryRoot, 'apps', 'api', 'src', 'index.ts'),
  },
  launcher: join(packageRoot, 'src', 'bin.mjs'),
  executableName: 'velograph-import.mjs',
  runtimeName: 'cli-runtime.mjs',
  metafileName: 'cli-runtime.meta.json',
});
