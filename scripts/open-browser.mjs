import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Open a loopback URL in the OS default browser. This is best-effort: a
 * missing launcher (common on minimal/headless Linux) must never crash the
 * foreground process that owns the API lifecycle.
 */
export function openBrowser(url, { spawnProcess = spawn, currentPlatform = platform() } = {}) {
  const [command, args] =
    currentPlatform === 'darwin'
      ? ['open', [url]]
      : currentPlatform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];

  let reported = false;
  const printFallback = () => {
    if (reported) return;
    reported = true;
    console.log(`Open ${url} in your browser.`);
  };

  try {
    const launcher = spawnProcess(command, args, {
      stdio: 'ignore',
      detached: true,
    });
    // `spawn()` reports ENOENT asynchronously. Register before `unref()` so
    // an absent launcher cannot become an unhandled EventEmitter error.
    launcher.once('error', printFallback);
    launcher.unref();
  } catch {
    printFallback();
  }
}
