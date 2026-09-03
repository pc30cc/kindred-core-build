/** Kills the postgrest/express/proxy processes started by setupFullStack.ts. */
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_FILE = path.join(__dirname, '.runtime.json');

export default async function globalTeardown() {
  if (!existsSync(RUNTIME_FILE)) return;
  const runtime = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8'));
  for (const [name, pid] of Object.entries(runtime.pids || {})) {
    try {
      process.kill(-(pid as number), 'SIGTERM');
    } catch {
      try { process.kill(pid as number, 'SIGTERM'); } catch { /* already gone */ }
    }
    // eslint-disable-next-line no-console
    console.log(`[e2e-harness] stopped ${name} (pid ${pid})`);
  }
  unlinkSync(RUNTIME_FILE);
}
