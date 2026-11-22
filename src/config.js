import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
export const PORT = Number(process.env.PINGER_PORT || 4317);
export const APP_NAME = 'Pinger';

/**
 * Personal data (mail cache, tokens, transcripts) lives in the per-user data directory,
 * never inside the app folder — so zipping the app folder to share it can't leak anything.
 */
export function dataDir() {
  if (process.env.PINGER_DATA_DIR) return path.resolve(process.env.PINGER_DATA_DIR);
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'pinger');
}

const SHARED_CONFIG_FILE = path.join(APP_ROOT, 'pinger.config.json');
const SHARED_DEFAULTS = { microsoftClientId: '', microsoftTenant: 'common' };

/**
 * Shared config travels with the app folder. It holds only non-secret values that everyone
 * you give the app to can reuse — currently the Microsoft app (client) ID used for Outlook sign-in.
 */
export function readSharedConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(SHARED_CONFIG_FILE, 'utf8'));
    return { ...SHARED_DEFAULTS, ...raw };
  } catch {
    return { ...SHARED_DEFAULTS };
  }
}

export function writeSharedConfig(patch) {
  const next = { ...readSharedConfig(), ...patch };
  fs.writeFileSync(SHARED_CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}
