// Emergency access from the Docker host (see README, "Locked out?"):
//   docker compose exec whatsonmynet womn-admin list
//   docker compose exec whatsonmynet womn-admin reset <user>     → new random password, account active, admin, 2FA off
//   docker compose exec whatsonmynet womn-admin create <user>    → new administrator with a random password
//   docker compose exec whatsonmynet womn-admin loadtest         → how many messages a second this server takes
import { paths, config } from './config.js';
import { openDatabase, verifyKey } from './db.js';
import { initMasterKey, randomToken } from './lib/crypto.js';
import { createUsers } from './auth/users.js';

const [cmd, name] = process.argv.slice(2);
if (cmd === 'loadtest') {
  // a file of its own next to the data - the database of the program is not opened
  const { loadTest } = await import('./loadtest.js');
  await loadTest({ dataDir: config.dataDir });
  process.exit(0);
}
initMasterKey();
const db = openDatabase(paths.db);
verifyKey(db);
const users = createUsers(db);

function out(s) { process.stdout.write(`${s}\n`); }

try {
  if (cmd === 'list') {
    for (const u of users.list()) out(`${u.username.padEnd(24)} ${u.role.padEnd(7)} ${u.active ? 'active' : 'inactive'}`);
  } else if (cmd === 'reset' && name) {
    const u = db.prepare('SELECT id FROM users WHERE username=?').get(name);
    if (!u) { out(`User "${name}" not found.`); process.exit(1); }
    const pw = randomToken(12);
    users.setPassword(u.id, pw);
    users.disableTotp(u.id);
    db.prepare("UPDATE users SET active=1, role='admin' WHERE id=?").run(u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    out(`New password for ${name}: ${pw}\nChange it after signing in (menu at the bottom left → My account).`);
  } else if (cmd === 'create' && name) {
    const pw = randomToken(12);
    users.create({ username: name, password: pw, role: 'admin' });
    out(`Administrator ${name} created. Password: ${pw}`);
  } else {
    out('Usage: womn-admin list | reset <user> | create <user> | loadtest');
    process.exit(2);
  }
} catch (e) {
  out(`Error: ${e.code || e.message}`);
  process.exit(1);
} finally {
  db.close();
}
