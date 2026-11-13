// Docker hosts: where WhatsOnMyNet reads container states. Best a socket proxy (read-only, only containers allowed),
// e.g. tecnativa/docker-socket-proxy with CONTAINERS=1 - or the local socket mounted read-only.
import { HttpError, line } from '../lib/http.js';
import { validDockerUrl, dockerInfo, dockerError } from './services.js';

export function createDockerHosts(db) {
  const get = (id) => db.prepare('SELECT * FROM docker_hosts WHERE id=?').get(id) || null;

  function clean(input) {
    const name = line(input.name, 80);
    const url = line(input.url, 300).replace(/\/+$/, '');
    if (!name) throw new HttpError(400, 'err.nameRequired');
    if (!validDockerUrl(url)) throw new HttpError(400, 'err.dockerUrl');
    return { name, url };
  }

  return {
    get,
    list() {
      return db.prepare(`SELECT h.*, (SELECT COUNT(*) FROM monitors m WHERE m.docker_host_id=h.id) monitors FROM docker_hosts h ORDER BY h.name`).all();
    },
    create(input) {
      const v = clean(input);
      const id = db.prepare('INSERT INTO docker_hosts(name,url,created_at) VALUES(?,?,?)').run(v.name, v.url, new Date().toISOString()).lastInsertRowid;
      return get(id);
    },
    update(id, input) {
      if (!get(id)) throw new HttpError(404, 'err.notFound');
      const v = clean(input);
      db.prepare('UPDATE docker_hosts SET name=?, url=? WHERE id=?').run(v.name, v.url, id);
      return get(id);
    },
    remove(id) {
      if (!get(id)) throw new HttpError(404, 'err.notFound');
      if (db.prepare('SELECT 1 FROM monitors WHERE docker_host_id=?').get(id)) throw new HttpError(409, 'err.dockerInUse');
      db.prepare('DELETE FROM docker_hosts WHERE id=?').run(id);
    },
    /** Version and container list - throws HttpError 502 with a readable reason */
    async info(id) {
      const h = get(id);
      if (!h) throw new HttpError(404, 'err.notFound');
      try { return await dockerInfo(h.url); } catch (e) { throw new HttpError(502, 'err.dockerFailed', dockerError(e)); }
    },
  };
}
