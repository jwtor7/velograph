import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimePackage } from '../../../scripts/build-runtime-package.mjs';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '..', '..');

await buildRuntimePackage({
  repositoryRoot,
  packageRoot,
  entryPoint: join(packageRoot, 'src', 'main.ts'),
  launcher: join(packageRoot, 'src', 'bin.mjs'),
  executableName: 'velograph-api.mjs',
  runtimeName: 'api-runtime.mjs',
  metafileName: 'api-runtime.meta.json',
  webDirectory: join(repositoryRoot, 'apps', 'web', 'dist'),
});
