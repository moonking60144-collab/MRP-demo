/**
 * Deploy-status check — does deploy.sh hold the deploying lock right now?
 *
 * deploy.sh writes the current epoch seconds to /tmp/funda-mrp-deploying.lock
 * on start and removes the file via a trap on exit. The API uses this to tell
 * the dashboard "server is updating, hold off on starting a new run."
 *
 * Stale-lock guard: if the file's contents are older than MAX_DEPLOY_AGE_SEC,
 * treat it as stale (deploy crashed without cleanup) and return false. Without
 * this, a single failed deploy would block all runs forever.
 */
import { promises as fs } from 'node:fs';

const LOCK_PATH = process.env.DEPLOY_LOCK_PATH || '/tmp/funda-mrp-deploying.lock';
const MAX_DEPLOY_AGE_SEC = 15 * 60; // 15 min — a real deploy never takes this long

export async function isDeploying(): Promise<boolean> {
  try {
    const contents = (await fs.readFile(LOCK_PATH, 'utf8')).trim();
    const startedAt = parseInt(contents, 10);
    if (Number.isNaN(startedAt)) return false;
    const ageSec = Math.floor(Date.now() / 1000) - startedAt;
    return ageSec >= 0 && ageSec < MAX_DEPLOY_AGE_SEC;
  } catch {
    return false;
  }
}
