#!/usr/bin/env node
import { main } from './index.ts';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch {
  // The executable boundary never exposes native stacks, local paths, or
  // imported values. Command handlers provide narrower stable codes where
  // recovery guidance is available.
  console.error('Command failed: unexpected_error');
  process.exitCode = 1;
}
