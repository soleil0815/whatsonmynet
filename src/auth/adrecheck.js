// Users from Active Directory get their role at sign-in. Someone disabled in AD or taken out of the WhatsOnMyNet
// groups would otherwise keep working with an open session until it runs out (hours, up to days). So every
// 15 minutes the users with an open session are looked up again (without password): gone, disabled or in no group
// any more → signed out; another group → the new role at once. When the domain controller cannot be reached nothing
// changes (an outage of the DC must not throw everybody out).
import { log } from '../lib/log.js';

export const RECHECK_MIN = 15;

export async function recheckDirectoryUsers({ db, directory, users }) {
  if (!directory.enabled()) return { checked: 0, signedOut: 0 };
  const rows = db.prepare("SELECT DISTINCT u.id, u.username, u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.source='ldap'").all();
  let signedOut = 0;
  for (const u of rows) {
    let info = null;
    try {
      info = await directory.verify(u.username, '', { checkPassword: false });
    } catch (e) {
      if (e.status !== 401) { log.warn(`Directory check of signed-in users skipped: ${e.detail || e.message}`); return { checked: 0, signedOut }; }
    }
    if (!info?.role) {
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
      db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), u.username, 'logout.ad', info ? 'in no WhatsOnMyNet group any more' : 'not found or disabled in the directory');
      log.info(`Directory user "${u.username}" signed out: ${info ? 'in no WhatsOnMyNet group any more' : 'not found or disabled'}`);
      signedOut++;
    } else if (info.role !== u.role) {
      users.upsertDirectory(info);
      // The last active admin keeps the role (upsertDirectory warns) - only a real change is logged
      const now = db.prepare('SELECT role FROM users WHERE id=?').get(u.id)?.role;
      if (now !== u.role) log.info(`Directory user "${u.username}": role now ${now} (was ${u.role})`);
    }
  }
  return { checked: rows.length, signedOut };
}
