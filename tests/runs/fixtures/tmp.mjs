import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created = [];

/** A throwaway `gtm/` root for one test. Cleaned up on process exit. */
export function tmpGtmDir(label = 'runs') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  created.push(dir);
  return path.join(dir, 'gtm');
}

process.on('exit', () => {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
