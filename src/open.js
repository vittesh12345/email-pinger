import { spawn } from 'node:child_process';

/** Open a URL in the user's default browser. Best effort; never throws. */
export function openBrowser(url) {
  if (process.env.PINGER_NO_OPEN) return;
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser available (headless machine) */
  }
}
