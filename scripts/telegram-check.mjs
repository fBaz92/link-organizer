// Exercise the released bundle against a local Telegram HTTP fixture.
// No real credentials or external Telegram requests are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const staging = await mkdtemp(path.join(tmpdir(), 'stash-telegram-check-'));
let child;
let logs = '';
const linkCount = 205;
const urls = Array.from({ length: linkCount }, (_, index) => `https://1.1.1.1/fixture/${index + 1}.pdf`);
const updates = [...urls, '/stat'].map((text, index) => ({
  update_id: index + 1,
  message: { message_id: index + 1, date: 1, chat: { id: 1, type: 'private' },
    from: { id: 1, is_bot: false, first_name: 'Test' }, text,
    ...(text === '/stat' ? { entities: [{ type: 'bot_command', offset: 0, length: 5 }] } : {}),
  },
}));
const batches = [];
const confirmations = [];
let statReply = false;
let rateLimitedPayload;
let rateLimitRetries = 0;
let prematureStart = false;
const methods = new Set();
const server = createServer(async (request, response) => {
  const method = request.url.split('/').at(-1);
  methods.add(method);
  let body = '';
  for await (const chunk of request) body += chunk;
  let result = true;
  if (method === 'getMe') {
    await delay(100);
    prematureStart = logs.includes('\"event\":\"bot_started\"');
    result = { id: 123, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' };
  }
  if (method === 'getUpdates') {
    const payload = JSON.parse(body || '{}');
    result = updates.filter(update => update.update_id >= (payload.offset ?? 0))
      .slice(0, Math.min(payload.limit ?? 100, 100));
    if (result.length) batches.push({ offset: payload.offset ?? 0, count: result.length });
    else await delay(100);
  }
  if (method === 'sendMessage') {
    const payload = JSON.parse(body);
    assert.equal(payload.chat_id, 1);
    if (!rateLimitedPayload) {
      rateLimitedPayload = body;
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests',
        parameters: { retry_after: 1 } }));
      return;
    }
    if (confirmations.length === 0 && body === rateLimitedPayload) rateLimitRetries++;
    if (payload.text.includes('<b>Archiviato</b>')) confirmations.push(payload.text);
    if (payload.text.includes('Statistiche archivio')) {
      statReply = payload.text.includes(`Totale: <b>${linkCount}</b>`);
    }
    result = { message_id: confirmations.length + 1000, date: 1,
      chat: { id: 1, type: 'private' }, text: payload.text };
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, result }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const hook = path.join(staging, 'transport.cjs');
await writeFile(hook, `const https = require('node:https'); const http = require('node:http');
global.fetch = async () => { throw new Error('Unexpected outbound fetch'); };
https.request = function(options, callback) {
  if (options.hostname !== 'api.telegram.org') throw new Error('Unexpected outbound request');
  return http.request({...options, agent:false, protocol:'http:', hostname:'127.0.0.1', host:'127.0.0.1', port:${port}}, callback);
};`);
try {
  child = spawn(process.execPath, ['--require', hook, process.env.STASH_BUNDLE_PATH || path.join(root, 'dist/main.js')], {
    cwd: staging,
    env: { ...process.env, BOT_TOKEN: '123:packaging-check', TELEGRAM_ALLOWED_USER_IDS: '1',
      HOMEGATE_STATE_DIR: staging, HOMEGATE_CONFIG_DIR: staging, STASH_VIEWER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  const deadline = Date.now() + 20_000;
  while ((!statReply || confirmations.length < linkCount) && child.exitCode === null && Date.now() < deadline) await delay(50);
  assert(statReply, `Bundled bot did not answer /stat. Methods: ${[...methods]}\n${logs}`);
  assert.equal(confirmations.length, linkCount, `Missing link confirmations\n${logs.slice(-5000)}`);
  assert.equal(rateLimitRetries, 1, '429 response must retry the same sendMessage once');
  assert.deepEqual(batches.map(batch => batch.count), [100, 100, 6], 'Backlog must span three offset-aware batches');
  assert.deepEqual(batches.slice(1).map(batch => batch.offset), [101, 201]);
  const db = new DatabaseSync(path.join(staging, 'stash.db'), { readOnly: true });
  try {
    const storedUrls = db.prepare('SELECT url FROM items ORDER BY url').all().map(row => row.url);
    assert.deepEqual(storedUrls, [...urls].sort(), 'Every backlog link must be stored exactly once');
  } finally { db.close(); }
  for (const method of ['setMyCommands', 'getMe', 'deleteWebhook', 'getUpdates', 'sendMessage']) {
    assert(methods.has(method), `Missing Telegram call: ${method}`);
  }
  assert.equal(prematureStart, false, 'bot_started was logged before Telegram initialization');
  child.kill('SIGTERM');
  const exit = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(exit, 0, `Unclean shutdown\n${logs}`);
  console.log('PASS: released Telegram bundle stores205 links in three batches, confirms205, retries429, answers /stat and shuts down');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  }
  await new Promise(resolve => server.close(resolve));
  await rm(staging, { recursive: true, force: true });
}
