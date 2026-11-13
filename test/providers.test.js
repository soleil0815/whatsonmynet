// Notification services beyond mail/Telegram/webhook: right request per service, secrets never leave the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { memoryDb } from './helpers.js';
import { createChannels } from '../src/monitor/notify.js';
import { setProviderApiForTests, cleanProviderConfig } from '../src/monitor/providers.js';

function capture() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      if (req.url.includes('fail')) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"message":"bad token"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('notification services: request shape, stored secrets, readable errors', async () => {
  const cap = await capture();
  try {
    setProviderApiForTests('pushover', cap.url);
    setProviderApiForTests('callmebot', cap.url);
    const db = memoryDb();
    const ch = createChannels(db, { send: async () => {} });
    const down = { kind: 'down', monitor: { id: 1, name: 'NAS', target: '10.0.0.5' }, message: 'timeout', at: '2026-11-13T08:00:00Z' };
    const last = () => cap.seen[cap.seen.length - 1];

    // ntfy: JSON publish with topic, title and high priority for "down"
    const ntfy = ch.create({ name: 'Handy', type: 'ntfy', language: 'de', config: { server: `${cap.url}/`, topic: 'womn-test', token: 'tk_secret123' } });
    assert.deepEqual(ntfy.config, { server: cap.url, topic: 'womn-test', token: { set: true } }, 'token never goes back to the browser');
    await ch.notifyIds([ntfy.id], down);
    assert.equal(last().body.topic, 'womn-test');
    assert.equal(last().body.priority, 4);
    assert.match(last().body.message, /^NAS ist nicht erreichbar - timeout/);
    assert.equal(last().headers.authorization, 'Bearer tk_secret123');

    // Gotify: token in its header, editing without a new token keeps the old one
    const gotify = ch.create({ name: 'Gotify', type: 'gotify', config: { server: cap.url, token: 'Aabcdef12345' } });
    ch.update(gotify.id, { name: 'Gotify 2', config: { server: cap.url, token: '' } });
    await ch.test(gotify.id);
    assert.equal(last().url, '/message');
    assert.equal(last().headers['x-gotify-key'], 'Aabcdef12345');

    // Matrix: PUT into the room with the access token
    const mx = ch.create({ name: 'Matrix', type: 'matrix', config: { server: cap.url, room: '!abcdef:matrix.org', token: 'syt_abcdefghijk' } });
    await ch.test(mx.id);
    assert.equal(last().method, 'PUT');
    assert.match(last().url, /^\/_matrix\/client\/v3\/rooms\/!abcdef%3Amatrix.org\/send\/m.room.message\/womn\d+/);
    assert.equal(last().body.msgtype, 'm.text');

    // Pushover and Signal
    const po = ch.create({ name: 'Pushover', type: 'pushover', config: { user: 'u'.repeat(30), token: 'a'.repeat(30) } });
    await ch.notifyIds([po.id], down);
    assert.deepEqual([last().url, last().body.user, last().body.priority, last().body.title], ['/1/messages.json', 'u'.repeat(30), 1, 'WhatsOnMyNet']);
    const sig = ch.create({ name: 'Signal', type: 'signal', config: { server: cap.url, number: '+4917600000000', recipients: '+4915100000000, +4915200000000' } });
    await ch.test(sig.id);
    assert.deepEqual(last().body.recipients, ['+4915100000000', '+4915200000000']);

    // WhatsApp (CallMeBot): GET with the text in the query
    const wa = ch.create({ name: 'WhatsApp', type: 'whatsapp', config: { phone: '+4917600000000', apikey: '123456' } });
    await ch.test(wa.id);
    assert.equal(last().method, 'GET');
    assert.match(last().url, /^\/whatsapp\.php\?phone=%2B4917600000000&text=/);

    // Webhook addresses of chat services are checked against the service, so a typo shows at once
    assert.throws(() => ch.create({ name: 'x', type: 'discord', config: { url: 'https://example.com/hook' } }), /err.chField.url/);
    assert.throws(() => ch.create({ name: 'x', type: 'matrix', config: { server: cap.url, room: 'general', token: 'syt_abcdefghijk' } }), /err.chField.room/);
    assert.throws(() => ch.create({ name: 'x', type: 'ntfy', config: { topic: 'a b' } }), /err.chField.topic/);
    assert.equal(cleanProviderConfig('ntfy', { topic: 'womn' }).config.server, 'https://ntfy.sh', 'default server');
    assert.equal(cleanProviderConfig('slack', { url: 'https://hooks.slack.com/services/T0/B0/x\r\nX: 1' }).bad, 'url', 'no header injection');

    // A refused token: the reason of the service is shown, the secret never
    const bad = ch.create({ name: 'Bad', type: 'homeassistant', config: { server: `${cap.url}/fail`, service: 'mobile_app_x', token: 'secret-token-abcdefghij' } });
    await assert.rejects(ch.test(bad.id), (e) => e.code === 'err.channelFailed' && /401 - bad token/.test(e.detail) && !e.detail.includes('secret-token'));

    // All in one list for the browser - no secret in it
    const json = JSON.stringify(ch.list());
    for (const s of ['tk_secret123', 'Aabcdef12345', 'syt_abcdefghijk', 'a'.repeat(30), '123456', 'secret-token']) assert.ok(!json.includes(s), `${s} stays on the server`);
  } finally { cap.srv.close(); }
});
