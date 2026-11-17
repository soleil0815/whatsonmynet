// A small JSON-RPC 2.0 client over WebSocket (RFC 6455), for APIs that only speak WebSocket (TrueNAS from version 26:
// its REST API is gone). Built on https.request with the TLS rules of the host - the same pinned certificate as
// every other request of WhatsOnMyNet; Node's own WebSocket cannot be given those. Text frames only, client frames
// masked, server frames up to 16 MB, ping answered. Read-only use: the caller decides which methods it calls.
import https from 'node:https';
import crypto from 'node:crypto';

const MAX = 16 * 1024 * 1024;

/** One WebSocket frame from the client (always masked) */
function frame(opcode, payload) {
  const data = Buffer.from(payload);
  const len = data.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  const mask = crypto.randomBytes(4);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, out]);
}

/**
 * Opens the connection. url: https://… (the path of the WebSocket endpoint); tls: options of tlsOptions(host).
 * Resolves { call(method, params) → result, close() }. A call rejects on a JSON-RPC error, a closed socket or after
 * timeoutMs.
 */
export function wsRpc(url, tls, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const u = new URL(url);
    let req;
    try {
      req = https.request(u, { method: 'GET', agent: false, timeout: timeoutMs, ...tls,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
    } catch (e) { reject(e); return; }
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs * 2);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.on('response', (res) => {
      clearTimeout(deadline);
      res.resume();
      reject(new Error(res.statusCode === 404 ? 'no WebSocket API at this address (404)' : `WebSocket refused (HTTP ${res.statusCode})`));
    });
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(deadline);
      const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) { socket.destroy(); reject(new Error('not a WebSocket answer')); return; }
      let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
      let parts = []; let partsLen = 0;
      let nextId = 1; let closed = null;
      const waiting = new Map();
      const fail = (e) => { closed = closed || e; for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(closed); } waiting.clear(); };
      const onMessage = (text) => {
        let m; try { m = JSON.parse(text); } catch { return; }
        if (m === null || typeof m !== 'object' || m.id === undefined || !waiting.has(m.id)) return; // notifications, events
        const w = waiting.get(m.id); waiting.delete(m.id); clearTimeout(w.timer);
        if (m.error) w.reject(Object.assign(new Error(String(m.error.data?.reason || m.error.message || 'error').slice(0, 300)), { rpc: m.error }));
        else w.resolve(m.result);
      };
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) return;
          const fin = buf[0] & 0x80; const op = buf[0] & 0x0f; const masked = buf[1] & 0x80;
          let len = buf[1] & 0x7f; let at = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
          else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX)) { socket.destroy(); fail(new Error('message too large')); return; } len = Number(big); at = 10; }
          if (len > MAX) { socket.destroy(); fail(new Error('message too large')); return; }
          const mlen = masked ? 4 : 0;
          if (buf.length < at + mlen + len) return;
          let payload = buf.subarray(at + mlen, at + mlen + len);
          if (masked) { const mk = buf.subarray(at, at + 4); payload = Buffer.from(payload.map((b, i) => b ^ mk[i & 3])); }
          buf = buf.subarray(at + mlen + len);
          if (op === 8) { socket.end(frame(8, '')); fail(new Error('connection closed by the server')); return; }
          if (op === 9) { socket.write(frame(10, payload)); continue; }
          if (op === 10) continue;
          if (op === 1 || op === 2 || op === 0) {
            parts.push(Buffer.from(payload)); partsLen += payload.length;
            if (partsLen > MAX) { socket.destroy(); fail(new Error('message too large')); return; }
            if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; partsLen = 0; onMessage(text); }
          }
        }
      });
      socket.on('close', () => fail(new Error('connection closed')));
      socket.on('error', (e) => fail(e));
      resolve({
        call(method, params = []) {
          if (closed) return Promise.reject(closed);
          const id = nextId++;
          return new Promise((ok, no) => {
            const timer = setTimeout(() => { waiting.delete(id); no(new Error(`${method}: timeout`)); }, timeoutMs);
            waiting.set(id, { resolve: ok, reject: no, timer });
            socket.write(frame(1, JSON.stringify({ jsonrpc: '2.0', id, method, params })));
          });
        },
        close() { if (!closed) { closed = new Error('closed'); try { socket.end(frame(8, '')); } catch { /* gone */ } } socket.destroy(); },
      });
    });
    req.end();
  });
}
