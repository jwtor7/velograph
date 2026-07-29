import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Without this config, vitest's default glob walks `.claude/worktrees/`, which
 * agent harnesses populate with FULL nested copies of this repository — every
 * test then gets collected twice and the reported count silently depends on
 * whether an agent happens to be running. See .gitignore.
 *
 * `configDefaults.exclude` is spread rather than replaced: setting `exclude`
 * overrides vitest's defaults outright, which would drop node_modules/dist.
 */
export default defineConfig({
  resolve: {
    alias: {
      // The published API package intentionally contains only built runtime
      // artifacts. Monorepo tests resolve the CLI's API import to source
      // explicitly instead of adding a broken source export to that package.
      '@velograph/api': fileURLToPath(new URL('./apps/api/src/index.ts', import.meta.url)),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
