// Calls to the server. Writing calls carry the header that protects against requests from other sites.
export class ApiError extends Error {
  /** field: the input a validation error belongs to (if the server names one), detail: the value it refers to */
  constructor(status, code, message, { field, detail } = {}) {
    super(message || code); this.status = status; this.code = code;
    if (typeof field === 'string' && field) this.field = field;
    if (detail !== undefined && detail !== null) this.detail = detail;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = { method, headers: { Accept: 'application/json', ...headers }, credentials: 'same-origin' };
  if (method !== 'GET') opts.headers['X-WOMN-Request'] = '1';
  if (raw !== undefined) { opts.headers['Content-Type'] = 'application/octet-stream'; opts.body = raw; }
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(`/api${path}`, opts); } catch {
    throw new ApiError(0, 'network', null);
  }
  let data = null;
  try { data = await res.json(); } catch { /* no JSON */ }
  if (!res.ok) {
    if (res.status === 401 && path !== '/login' && path !== '/me/password') onUnauthorized();
    throw new ApiError(res.status, data?.error?.code || 'err', data?.error?.message, { field: data?.error?.field, detail: data?.error?.detail });
  }
  return data;
}

export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const put = (p, body = {}) => api(p, { method: 'PUT', body });
export const patch = (p, body = {}) => api(p, { method: 'PATCH', body });
export const del = (p) => api(p, { method: 'DELETE' });
