// Shared state-dir helpers: where dsh-rc keeps its secrets and small JSON files,
// and the 0600/0700 file conventions used for all of them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultStateDir(env = process.env) {
  if (env.DSH_RC_STATE_DIR) return env.DSH_RC_STATE_DIR;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, 'dsh-rc');
  return path.join(os.homedir(), '.local', 'state', 'dsh-rc');
}

export function ensureStateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function writeSecret(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
