import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

/** Git short hash, read once at startup. Tries git CLI first, falls back to reading .git files directly. */
export const BOT_VERSION = (() => {
  // Try git CLI first
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch { /* git not available */ }

  // Fall back to reading .git/HEAD directly
  try {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    // Walk up from src/ to find .git/
    for (let dir = srcDir; dir !== '/'; dir = dirname(dir)) {
      try {
        const head = readFileSync(resolve(dir, '.git', 'HEAD'), 'utf-8').trim();
        if (head.startsWith('ref: ')) {
          const ref = head.slice(5);
          const hash = readFileSync(resolve(dir, '.git', ref), 'utf-8').trim();
          return hash.slice(0, 7);
        }
        // Detached HEAD — hash directly in HEAD
        return head.slice(0, 7);
      } catch { /* no .git here, keep walking up */ }
    }
  } catch { /* give up */ }

  return 'unknown';
})();
