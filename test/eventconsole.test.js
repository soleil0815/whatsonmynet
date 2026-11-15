// The event console part of the rules: counting ("5 in 10 minutes", per sender), regular expressions (checked before
// saving, a slow one switches its rule off), open events (one per sender and key, acknowledged, closed by the
// counter-message, by hand or after a while).
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { createEventRules, cleanOptions } from '../src/eventrules.js';
import { checkRegexStatic, checkRegexTime } from '../src/lib/saferegex.js';
import { eventText } from '../src/monitor/notify.js';

function setup() {
  const db = memoryDb();
  const sent = []; let fail = false;
  const channels = { notifyIds: async (ids, ev) => { if (fail) return []; sent.push(ev); return ['T']; } };
  let t = Date.parse('2026-11-15T10:00:00Z');
  const now = () => new Date(t);
  const rules = createEventRules({ db, channels, now });
  const chan = Number(db.prepare("INSERT INTO channels(name,type,config,language,is_default,enabled,created_at) VALUES('T','email','x','de',0,1,'x')").run().lastInsertRowid);
  const event = (x = {}) => {
    const r = { at: now().toISOString(), kind: 'syslog', source_ip: '10.0.0.5', device_id: null, severity: 4, facility: 1, host: 'sw01', app: 'PORT', oid: '', text: 'x', event_id: null, channel: '', account: '', ...x };
    r.id = Number(db.prepare('INSERT INTO events_in(at,kind,source_ip,device_id,severity,facility,host,app,oid,text,event_id,channel,account) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.at, r.kind, r.source_ip, r.device_id, r.severity, r.facility, r.host, r.app, r.oid, r.text, r.event_id, r.channel, r.account).lastInsertRowid);
    return r;
  };
  const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
  return { db, rules, chan, event, sent, tick, later: (ms) => { t += ms; }, failing: (v) => { fail = v; } };
}

test('regular expressions: the dangerous shapes are refused, a slow one does not get through the trial', async () => {
  for (const ok of ['Port (\\d+) link down', '^Failed password for (\\S+) from', 'a{2,}b', '(ab){3}', 'error|fail']) assert.equal(checkRegexStatic(ok), ok);
  for (const bad of ['(a+)+$', '(\\s*\\w+)*x', '(down|up)+', '(\\w)\\1', '(?<x>a)\\k<x>', '([a-z]+)*']) assert.throws(() => checkRegexStatic(bad), (e) => e.code === 'err.regexUnsafe', bad);
  assert.throws(() => checkRegexStatic('(unclosed'), (e) => e.code === 'err.regexInvalid');
  assert.throws(() => checkRegexStatic('x'.repeat(301)), (e) => e.code === 'err.regexLong');
  // passes the shape check, backtracks without end: stopped by the time limit of the separate thread
  await assert.rejects(checkRegexTime('^(\\w+\\s?)+$'), (e) => e.code === 'err.regexSlow');
  assert.ok((await checkRegexTime('Port (\\d+) link down', ['Port 7 link down'])) < 20);
});

test('counting: from 3 in 10 minutes per sender - one notification with all; fewer are dropped silently', async () => {
  const { db, rules, chan, event, sent, tick, later } = setup();
  rules.create({ name: 'SSH', match: { regex: 'Failed password for (\\S+) from' }, channels: [chan], count: { n: 3, minutes: 10, perSender: true } });
  rules.start();
  try {
    const fail = (ip) => rules.onEvent(event({ source_ip: ip, host: ip === '10.0.0.7' ? 'srv07' : 'srv08', app: 'sshd', text: 'Failed password for root from 1.2.3.4 port 22' }));
    fail('10.0.0.7'); fail('10.0.0.7'); fail('10.0.0.8'); later(60000);
    rules.onEvent(event({ app: 'sshd', text: 'Accepted password for max' }));
    await tick();
    assert.equal(sent.length, 0, 'not yet 3 from one sender');
    fail('10.0.0.7'); await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].count, 3);
    assert.equal(eventText(sent[0], 'de'), '📋 SSH: 3 Treffer in 10 Min. - srv07');
    assert.equal(sent[0].events.length, 3);
    // counting starts again: the next ones need 3 again; the lonely one of srv08 runs out of its window
    fail('10.0.0.7'); await tick();
    assert.equal(sent.length, 1);
    later(11 * 60000); await rules.flush();
    assert.equal(sent.length, 1, 'fewer than 3 in the window: nothing');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM event_rule_hits WHERE held=1').get().n, 0);
    assert.equal(rules.list()[0].counting, 0);
  } finally { rules.stop(); }
});

test('open events: one per sender and port, counted up instead of notified again, closed by "link up" with all-clear', async () => {
  const { db, rules, chan, event, sent, tick, later } = setup();
  const r = rules.create({ name: 'Ports', match: { regex: 'Port (\\d+) link down' }, channels: [chan],
    state: { open: true, closeRegex: 'Port (\\d+) link up', notifyClose: true } });
  rules.start();
  try {
    rules.onEvent(event({ text: 'Port 7 link down' }));
    rules.onEvent(event({ text: 'Port 7 link down' }));
    rules.onEvent(event({ text: 'Port 9 link down' }));
    rules.onEvent(event({ source_ip: '10.0.0.6', host: 'sw02', text: 'Port 7 link down' }));
    await tick();
    assert.equal(sent.length, 3, 'port 7 again: no second notification');
    let open = rules.openEvents();
    assert.deepEqual(open.map((o) => [o.source_ip, o.key, o.count, o.state]).sort(), [['10.0.0.5', '7', 2, 'open'], ['10.0.0.5', '9', 1, 'open'], ['10.0.0.6', '7', 1, 'open']]);
    assert.equal(rules.openCount(), 3);
    assert.equal(rules.list()[0].openEvents, 3);
    // acknowledged: still open, a new "down" still only counts
    const p9 = open.find((o) => o.key === '9');
    rules.ack(p9.id, 'testadmin');
    rules.onEvent(event({ text: 'Port 9 link down' })); await tick();
    assert.equal(sent.length, 3);
    assert.deepEqual(rules.openEvents().filter((o) => o.key === '9').map((o) => [o.state, o.count, o.ack_by]), [['ack', 2, 'testadmin']]);
    // the counter-message closes only its port on its switch - with an all-clear
    rules.onEvent(event({ severity: 6, text: 'Port 7 link up' })); await tick();
    assert.equal(sent.length, 4);
    assert.equal(eventText(sent[3], 'de'), '✅ Ports: wieder in Ordnung - sw01 (7)');
    open = rules.openEvents();
    assert.deepEqual(open.map((o) => [o.source_ip, o.key]).sort(), [['10.0.0.5', '9'], ['10.0.0.6', '7']]);
    // down again after up: a new event, notified again
    rules.onEvent(event({ text: 'Port 7 link down' })); await tick();
    assert.equal(sent.length, 5);
    // by hand
    rules.close(open.find((o) => o.key === '9').id, 'testadmin');
    assert.throws(() => rules.close(open.find((o) => o.key === '9').id, 'testadmin'), /err.notFound/);
    assert.ok(rules.openEvents({ all: true }).some((o) => o.closed_how === 'user'));
    // switched off: open events of the rule close
    rules.update(r.id, { enabled: false });
    assert.equal(rules.openCount(), 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM event_open WHERE closed_how='rule'").get().n, 2);
  } finally { rules.stop(); }
});

test('open events close by themselves after hours without news; words and ids as counter-message', async () => {
  const { rules, chan, event, sent, tick, later } = setup();
  rules.create({ name: 'USV', match: { eventIds: '', words: 'on battery' }, channels: [chan], state: { open: true, closeWords: 'on line, back on mains', expireHours: 2 } });
  rules.create({ name: 'Dienst', match: { eventIds: '7034' }, channels: [chan], state: { open: true, closeIds: '7036' } });
  rules.start();
  try {
    rules.onEvent(event({ text: 'UPS on battery' }));
    rules.onEvent(event({ source_ip: '10.0.0.9', text: 'UPS on battery' }));
    rules.onEvent(event({ source_ip: '10.0.0.20', event_id: 7034, text: 'Dienst beendet' }));
    await tick();
    assert.equal(rules.openCount(), 3);
    rules.onEvent(event({ text: 'UPS back on mains' }));
    rules.onEvent(event({ source_ip: '10.0.0.20', event_id: 7036, text: 'Dienst läuft' }));
    await tick();
    assert.deepEqual(rules.openEvents().map((o) => o.source_ip), ['10.0.0.9']);
    later(3 * 3600000); await rules.flush();
    assert.equal(rules.openCount(), 0);
    assert.ok(rules.openEvents({ all: true }).some((o) => o.closed_how === 'expired'));
    assert.equal(sent.length, 3, 'no all-clear unless asked for');
  } finally { rules.stop(); }
});

test('a rule whose expression is slow on a message is switched off, with the reason', async () => {
  const { db, rules, chan, event } = setup();
  // passes the shape check; its time trial (checkTimes) would refuse it - here it is saved without one
  const r = rules.create({ name: 'Slow', match: { regex: '^\\w*\\w*\\w*\\w*x$' }, channels: [chan] });
  rules.start();
  try {
    rules.onEvent(event({ text: `${'a'.repeat(160)}!` }));
    const x = rules.get(r.id);
    assert.equal(x.enabled, false);
    assert.match(x.disabled_reason, /^regex slow/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM event_rule_hits').get().n, 0);
  } finally { rules.stop(); }
});

test('options: limits and defaults', () => {
  assert.deepEqual(cleanOptions({}), { count: { n: 1, minutes: 10, perSender: false }, state: { open: false, closeWords: [], closeIds: '', closeRegex: '', expireHours: 0, notifyClose: false } });
  assert.throws(() => cleanOptions({ count: { n: 0 } }), (e) => e.code === 'err.ruleOption' && e.field === 'count_n');
  assert.throws(() => cleanOptions({ count: { minutes: 2000 } }), (e) => e.field === 'count_minutes');
  assert.throws(() => cleanOptions({ state: { closeRegex: '(a+)+' } }), (e) => e.code === 'err.regexUnsafe' && e.field === 'closeRegex');
  assert.equal(cleanOptions({ state: { closeIds: '7036 7040-7045' } }).state.closeIds, '7036, 7040-7045');
});
