import { defineConfig, configDefaults } from 'vitest/config';

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
  test: {
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
