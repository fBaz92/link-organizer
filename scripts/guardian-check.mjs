// Exercise the guardian through real HTTP with a disposable web process adapter.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createGuardian } from '../docker/guardian.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(message);
}
// Reserve an unused port, then release it for repeated fixture restarts.
const reservation = createServer();
const webPort = await listen(reservation);
await close(reservation);
let web;
let starts = 0;
let stops = 0;
let busy = false;
let releaseResponse;
let failNextStart = false;
const guardian = createGuardian({
  port: 0,
  webPort,
  idleMs: 120,
  token: 'fixture-private-token',
  isWebBusy: async () => busy,
  log() {},
  async startWeb() {
    starts++;
    if (failNextStart) { failNextStart = false; throw new Error('Fixture startup failure'); }
    await delay(40); // Concurrent requests must share this startup.
    web = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      if (request.url === '/slow') await new Promise(resolve => { releaseResponse = resolve; });
      response.writeHead(200, { 'content-type': 'application/json', 'x-fixture': 'web' });
      response.end(JSON.stringify({ method: request.method, url: request.url, body }));
    });
    await new Promise((resolve, reject) => {
      web.once('error', reject);
      web.listen(webPort, '127.0.0.1', resolve);
    });
  },
  async stopWeb() {
    stops++;
    await close(web);
  },
});
const port = await listen(guardian.server);
const base = `http://127.0.0.1:${port}`;
const state = async () => (await (await fetch(`${base}/health`)).json()).web.state;
try {
  const malformedReply = await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let reply = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('Malformed target response timed out')));
    socket.on('error', reject);
    socket.on('data', chunk => { reply += chunk; });
    socket.on('end', () => resolve(reply));
    socket.on('connect', () => socket.end('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
  });
  assert.match(malformedReply, /^HTTP\/1\.1 400 /, 'Malformed URL must return400');
  assert.equal(await state(), 'sleeping', 'Malformed target must leave guardian alive and asleep');
  await guardian.ensureWeb();
  assert.equal(await state(), 'running');
  const startCount = starts;
  // Health polling must leave the web idle timer untouched.
  await until(async () => await state() === 'sleeping', 'Health probes kept web awake');
  assert.equal(stops, 1);
  const unauthorizedLease = await fetch(`${base}/_stash/lease`);
  assert.equal(unauthorizedLease.status, 404);
  const lease = await fetch(`${base}/_stash/lease`, {
    headers: { authorization: 'Bearer fixture-private-token' },
  });
  assert.equal(lease.status, 200);
  await lease.body.cancel();
  assert.equal(await state(), 'sleeping', 'Telegram lease must not wake Next');
  const replies = await Promise.all(Array.from({ length: 8 }, (_, index) => fetch(`${base}/echo?q=${index}`, {
    method: 'POST', body: `payload-${index}`, headers: { 'content-type': 'text/plain' },
  }).then(async response => {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-fixture'), 'web');
    return response.json();
  })));
  assert.equal(starts, startCount + 1, 'Concurrent wake requests started multiple web processes');
  replies.forEach((reply, index) => assert.deepEqual(reply, {
    method: 'POST', url: `/echo?q=${index}`, body: `payload-${index}`,
  }));
  busy = true;
  await delay(400);
  assert.equal(await state(), 'running', 'Background work was stopped while busy');
  busy = false;
  await until(async () => await state() === 'sleeping', 'Web did not sleep after background work');
  const slowRequest = fetch(`${base}/slow`).then(response => response.json());
  await until(() => Boolean(releaseResponse), 'Slow request never reached web');
  await delay(400);
  assert.equal(await state(), 'running', 'Active HTTP request was stopped');
  releaseResponse();
  assert.equal((await slowRequest).url, '/slow');
  await until(async () => await state() === 'sleeping', 'Web did not sleep after HTTP request');
  // A disconnected browser must not terminate work still executing in Next.
  releaseResponse = undefined;
  busy = true;
  const cancellation = new AbortController();
  const cancelledRequest = fetch(`${base}/slow`, { signal: cancellation.signal })
    .then(() => assert.fail('Cancelled request unexpectedly completed'), error => {
      assert.equal(error.name, 'AbortError');
    });
  await until(() => Boolean(releaseResponse), 'Cancellable request never reached web');
  cancellation.abort();
  await cancelledRequest;
  await until(() => guardian.status().active === 0, 'Cancelled request still counted as active');
  await delay(400);
  assert.equal(await state(), 'running', 'Client cancellation stopped unfinished background work');
  releaseResponse();
  busy = false;
  await until(async () => await state() === 'sleeping', 'Web did not sleep after cancelled work finished');
  failNextStart = true;
  assert.equal((await fetch(`${base}/echo`)).status, 503, 'Startup failure must reach the caller');
  const recovered = await fetch(`${base}/echo`);
  assert.equal(recovered.status, 200, 'A later request must retry failed startup');
  assert.equal(await state(), 'running');
  console.log('PASS: guardian health, idle sleep, concurrent wake, POST forwarding, busy work, active requests, cancellation and malformed HTTP');
} finally {
  releaseResponse?.();
  await guardian.close();
}

// A wake deadline returns control before HomeGate times out. The original
// mutation must never be replayed after the caller has received a failure.
const timeoutReservation = createServer();
const timeoutWebPort = await listen(timeoutReservation);
await close(timeoutReservation);
const forwardedMethods = [];
const slowWeb = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  forwardedMethods.push({ method: request.method, body });
  response.end('warm');
});
const timeoutGuardian = createGuardian({
  port: 0,
  webPort: timeoutWebPort,
  idleMs: 10_000,
  wakeTimeoutMs: 30,
  async startWeb() {
    await delay(100);
    await new Promise((resolve, reject) => {
      slowWeb.once('error', reject);
      slowWeb.listen(timeoutWebPort, '127.0.0.1', resolve);
    });
  },
  async stopWeb() { await close(slowWeb); },
});
const timeoutPort = await listen(timeoutGuardian.server);
try {
  const failedMutation = await fetch(`http://127.0.0.1:${timeoutPort}/mutate`, {
    method: 'POST', body: 'do-not-replay',
  });
  assert.equal(failedMutation.status, 503, 'Wake deadline must return503');
  await failedMutation.text();
  assert.deepEqual(forwardedMethods, [], 'Timed-out mutation reached the web fixture');
  await until(() => timeoutGuardian.status().state === 'running', 'Slow startup never recovered');
  assert.deepEqual(forwardedMethods, [], 'Timed-out mutation was replayed after startup');
  const warmReply = await fetch(`http://127.0.0.1:${timeoutPort}/ready`);
  assert.equal(warmReply.status, 200);
  assert.equal(await warmReply.text(), 'warm');
  assert.deepEqual(forwardedMethods, [{ method: 'GET', body: '' }]);
  console.log('PASS: wake deadline returns503, startup recovers, timed-out POST is never replayed');
} finally {
  await timeoutGuardian.close();
}
