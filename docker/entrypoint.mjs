import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createGuardian } from './guardian.mjs';
import { startHomeGateLease } from './homegate-lease.mjs';

// PID 1 owns the single install: light HTTP guardian + Telegram worker stay
// active; Next starts on demand. No Docker socket or extra container is needed.
const token = randomBytes(32).toString('hex');
const port = Number(process.env.PORT || 3000);
const webPort = 3001;
const controlPort = 3002;
const idleSeconds = Number(process.env.STASH_WEB_IDLE_SECONDS || Math.min(300, (Number(process.env.HOMEGATE_IDLE_MINUTES) || 5) * 60));
if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) throw new Error('Invalid web idle timeout');
const children = new Set();
let web;
let worker;
let retry;
let closing = false;
let lease;
mkdirSync('/tmp/next-cache', { recursive: true });
const workDir = path.join(process.env.HOMEGATE_STATE_DIR || process.env.DATA_DIR || '/data', 'tmp');
mkdirSync(workDir, { recursive: true });

function log(level, event, summary, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, summary, ...fields });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}
function launch(args, cwd, extra = {}) {
  const child = spawn(process.execPath, args, {
    cwd, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, STASH_CONTROL_PORT: String(controlPort), STASH_CONTROL_TOKEN: token, ...extra },
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.on('error', () => log('error', 'process_spawn_failed', 'Avvio processo fallito'));
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 6000);
  try { await exited; } finally { clearTimeout(deadline); }
}
async function waitReady(url, child, headers = {}) {
  const deadline = Date.now() + 75_000;
  while (!closing && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch { /* Child is still starting. */ }
    await delay(100);
  }
  throw new Error('Process readiness failed');
}
function startWorker() {
  if (closing) return;
  worker = launch(['/app/service/main.js'], '/app', { TMPDIR: workDir });
  worker.once('exit', (code, signal) => {
    if (closing) return;
    log('warn', 'worker_restarting', 'Worker Telegram terminato; riavvio automatico', { code, signal });
    retry = setTimeout(startWorker, 5000);
  });
}
const guardian = createGuardian({
  webPort, idleMs: idleSeconds * 1000, token, log,
  async startWeb() {
    web = launch(['server.js'], '/app/web', { PORT: String(webPort), HOSTNAME: '127.0.0.1' });
    const child = web;
    child.once('exit', () => guardian.webExited());
    try { await waitReady(`http://127.0.0.1:${webPort}/health`, child); }
    catch (error) { await stop(child); throw error; }
  },
  async stopWeb() { const child = web; web = undefined; await stop(child); },
  async isWebBusy() {
    const response = await fetch(`http://127.0.0.1:${webPort}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('Web work state unavailable');
    return (await response.json()).busy !== false;
  },
  async health() {
    try {
      const response = await fetch(`http://127.0.0.1:${controlPort}/health`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) throw new Error('Worker unavailable');
      return { ...await response.json(), homegate: { lease: lease?.status() ?? 'disabled' } };
    } catch { return { status: 'error', bot: { state: 'starting' } }; }
  },
});
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  clearTimeout(retry);
  lease?.close();
  log('info', 'container_stopping', 'Arresto del container', { signal });
  const force = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(1);
  }, 7500);
  try {
    await Promise.all([guardian.close(), stop(worker)]);
    clearTimeout(force);
    log('info', 'container_stopped', 'Container arrestato');
    process.exit(0);
  } catch { process.exit(1); }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
log('info', 'container_starting', 'Avvio Stash con Telegram sempre attivo', { node: process.version, uid: process.getuid?.(), idle_seconds: idleSeconds });
startWorker();
try {
  await waitReady(`http://127.0.0.1:${controlPort}/health`, worker, { authorization: `Bearer ${token}` });
  await guardian.ensureWeb();
  await new Promise((resolve, reject) => {
    guardian.server.once('error', reject);
    guardian.server.listen(port, '0.0.0.0', resolve);
  });
  lease = startHomeGateLease({ token, log });
} catch {
  log('error', 'container_start_failed', 'Readiness iniziale non raggiunta');
  await shutdown('startup-failed');
}
