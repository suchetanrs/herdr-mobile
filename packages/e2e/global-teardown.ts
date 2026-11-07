import fs from 'node:fs';
import { CONV_DIR, readState, removeTerminal, STATE_FILE, stopInstance } from './lib/env.js';

export default async function globalTeardown(): Promise<void> {
  await stopInstance();
  try {
    const s = readState();
    removeTerminal(s.shell);
    removeTerminal(s.conv);
    removeTerminal(s.ask);
    removeTerminal(s.hist);
    removeTerminal(s.app);
  } catch {}
  fs.rmSync(STATE_FILE, { force: true });
  fs.rmSync(CONV_DIR, { recursive: true, force: true });
}
