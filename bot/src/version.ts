import { execSync } from 'node:child_process';

/** Git short hash + dirty flag, read once at startup */
export const BOT_VERSION = (() => {
  try {
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    const dirty = execSync('git diff --quiet HEAD 2>/dev/null; echo $?', { encoding: 'utf-8' }).trim() === '1';
    return dirty ? `${hash}-dirty` : hash;
  } catch {
    return 'unknown';
  }
})();
