#!/usr/bin/env node

try {
  const { main } = await import('./api-runtime.mjs');
  process.exitCode = await main();
} catch {
  console.error('Server failed: unexpected_error');
  process.exitCode = 1;
}
