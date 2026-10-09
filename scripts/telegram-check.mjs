// Exercise the released bundle against a local Telegram HTTP fixture.
// No real credentials or external Telegram requests are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const staging = await mkdtemp(path.join(tmpdir(), 'stash-telegram-check-'));
let child;
let logs = '';
let delivered = false;
let replied = false;
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
    if (!delivered) {
      delivered = true;
      result = [{ update_id: 1, message: {
        message_id: 1, date: 1, chat: { id: 1, type: 'private' },
        from: { id: 1, is_bot: false, first_name: 'Test' },
        text: '/stat', entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      } }];
    } else { await delay(100); result = []; }
  }
  if (method === 'sendMessage') {
    const payload = JSON.parse(body);
    replied = payload.chat_id === 1 && typeof payload.text === 'string' && payload.text.length > 0;
    result = { message_id: 2, date: 1, chat: { id: 1, type: 'private' }, text: payload.text };
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, result }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const hook = path.join(staging, 'transport.cjs');
await writeFile(hook, `const https = require('node:https'); const http = require('node:http');
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
  const deadline = Date.now() + 10_000;
  while (!replied && child.exitCode === null && Date.now() < deadline) await delay(50);
  assert(replied, `Bundled bot did not answer /stat. Methods: ${[...methods]}\n${logs}`);
  for (const method of ['setMyCommands', 'getMe', 'deleteWebhook', 'getUpdates', 'sendMessage']) {
    assert(methods.has(method), `Missing Telegram call: ${method}`);
  }
  assert.equal(prematureStart, false, 'bot_started was logged before Telegram initialization');
  child.kill('SIGTERM');
  const exit = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(exit, 0, `Unclean shutdown\n${logs}`);
  console.log('PASS: released Telegram bundle registers, polls, answers /stat and shuts down');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  }
  await new Promise(resolve => server.close(resolve));
  await rm(staging, { recursive: true, force: true });
}
