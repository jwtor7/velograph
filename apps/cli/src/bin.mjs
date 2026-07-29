#!/usr/bin/env node

try {
  const { main } = await import('./cli-runtime.mjs');
  process.exitCode = await main(process.argv.slice(2));
} catch {
  // Keep package resolution, native dependency loading, and runtime
  // evaluation inside this value-free boundary.
  console.error('Command failed: unexpected_error');
  process.exitCode = 1;
}
