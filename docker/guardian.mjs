import { createServer, request as httpRequest } from 'node:http';

/** Owns web availability behind one HTTP interface, including concurrent wake,
 * streaming requests and safe idle stop. Process creation is the adapter. */
export function createGuardian({ webPort, idleMs, startWeb, stopWeb,
  isWebBusy = async () => false, log = () => {}, token, wakeTimeoutMs = 25_000,
  health = async () => ({ status: 'ok' }) }) {
  let state = 'sleeping';
  let waking;
  let stopping;
  let closing = false;
  let active = 0;
  let lastActivity = Date.now();
  const connections = new Set();

  async function ensureWeb() {
    if (closing) throw new Error('Container stopping');
    if (stopping) await stopping;
    if (state === 'running') return;
    if (!waking) {
      state = 'starting';
      waking = Promise.resolve().then(startWeb).then(() => {
        state = 'running';
        lastActivity = Date.now();
        log('info', 'web_awake', 'Webapp pronta');
      }).catch(error => {
        state = 'sleeping';
        throw error;
      }).finally(() => { waking = undefined; });
    }
    await waking;
  }

  async function sleepWeb() {
    if (state !== 'running' || active || closing) return;
    state = 'stopping';
    stopping = Promise.resolve().then(stopWeb).then(() => {
      state = 'sleeping';
      log('info', 'web_sleeping', 'Webapp a riposo; Telegram resta disponibile');
    }).finally(() => { stopping = undefined; });
    await stopping;
  }

  let checking = false;
  const timer = setInterval(async () => {
    if (checking || closing || state !== 'running' || active || Date.now() - lastActivity < idleMs) return;
    checking = true;
    try {
      if (!await isWebBusy() && !active && Date.now() - lastActivity >= idleMs) await sleepWeb();
    } catch {
      // Uncertainty about work in progress must never cause an idle stop.
      lastActivity = Date.now();
    } finally { checking = false; }
  }, Math.max(25, Math.min(1000, idleMs / 4)));
  timer.unref();

  const server = createServer(async (incoming, outgoing) => {
    let pathname;
    try { pathname = new URL(incoming.url, 'http://localhost').pathname; }
    catch { outgoing.writeHead(400); outgoing.end(); return; }
    if (pathname === '/health') {
      try {
        const result = await health();
        outgoing.writeHead(result.status === 'ok' ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        outgoing.end(JSON.stringify({ ...result, web: { state } }));
      } catch {
        outgoing.writeHead(503, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ status: 'error', web: { state } }));
      }
      return;
    }
    if (pathname.startsWith('/_stash/')) {
      if (pathname !== '/_stash/lease' || !token || incoming.headers.authorization !== `Bearer ${token}`) {
        outgoing.writeHead(404); outgoing.end(); return;
      }
      outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      outgoing.write(': Telegram receiver active\n\n');
      const heartbeat = setInterval(() => outgoing.write(': active\n\n'), 15_000);
      outgoing.on('close', () => clearInterval(heartbeat));
      return;
    }
    active++;
    lastActivity = Date.now();
    let released = false;
    function release() {
      if (released) return;
      released = true; active--; lastActivity = Date.now();
    }
    outgoing.once('close', release);
    outgoing.once('finish', release);
    try {
      let timeout;
      try {
        await Promise.race([ensureWeb(), new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Web wake timed out')), wakeTimeoutMs);
        })]);
      } finally { clearTimeout(timeout); }
      if (outgoing.destroyed || closing) return;
      const headers = { ...incoming.headers };
      // The private worker token is never accepted from public requests.
      delete headers['x-stash-control-token'];
      const upstream = httpRequest({ hostname: '127.0.0.1', port: webPort,
        path: incoming.url, method: incoming.method, headers }, response => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.on('error', () => outgoing.destroy());
        response.pipe(outgoing);
      });
      upstream.on('error', () => {
        if (!outgoing.headersSent) {
          outgoing.writeHead(503, { 'retry-after': '1' }); outgoing.end('Webapp unavailable');
        } else outgoing.destroy();
      });
      outgoing.once('close', () => upstream.destroy());
      incoming.once('aborted', () => upstream.destroy());
      incoming.pipe(upstream);
    } catch {
      if (!outgoing.headersSent) { outgoing.writeHead(503, { 'retry-after': '1' }); outgoing.end('Webapp unavailable'); }
    }
  });
  server.on('connection', socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
  });
  return {
    server, ensureWeb, webExited() { if (state === 'running') state = 'sleeping'; }, status: () => ({ state, active }),
    async close() {
      closing = true; clearInterval(timer);
      for (const socket of connections) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await waking?.catch(() => {});
      await stopping?.catch(() => {});
      if (state === 'running') await stopWeb();
      state = 'sleeping';
    },
  };
}
