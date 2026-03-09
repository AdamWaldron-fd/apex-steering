import { $, logEvent } from './events.js';

const API = '';

export async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const body = opts.body;
  logEvent(`${method} ${path}`);
  try {
    const resp = await fetch(`${API}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!resp.ok) {
      logEvent(`Error ${resp.status}: ${text}`, 'err');
      return { ok: false, status: resp.status, data };
    }
    return { ok: true, status: resp.status, data };
  } catch (e) {
    logEvent(`Network error: ${e.message}`, 'err');
    return { ok: false, status: 0, data: e.message };
  }
}

export function show(elId, result) {
  const el = $(elId);
  el.className = result.ok ? 'ok' : 'err';
  el.textContent = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
}
