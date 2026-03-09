import { $ } from './events.js';
import { logEvent } from './events.js';
import { api, show } from './api.js';

export async function setPriorities() {
  const body = {
    priorities: $('ctl-prio').value.split(',').map(s => s.trim()).filter(Boolean),
  };
  const region = $('ctl-prio-region').value.trim();
  if (region) body.region = region;
  const ttl = parseInt($('ctl-prio-ttl').value);
  if (!isNaN(ttl)) body.ttl_override = ttl;
  const r = await api('/api/priorities', { method: 'POST', body });
  show('out-prio', r);
}

export async function excludePathway() {
  const body = { pathway: $('ctl-excl').value.trim() };
  const region = $('ctl-excl-region').value.trim();
  if (region) body.region = region;
  const r = await api('/api/exclude', { method: 'POST', body });
  show('out-excl', r);
}

export async function clearOverrides() {
  const r = await api('/api/clear', { method: 'POST', body: {} });
  show('out-excl', r);
}

export async function registerFleet() {
  const body = {
    platform: $('fleet-platform').value,
    control_url: $('fleet-url').value,
    region: $('fleet-region').value || undefined,
  };
  const r = await api('/api/fleet/register', { method: 'POST', body });
  if (r.ok) {
    logEvent(`Fleet registered: ${r.data.id}`, 'ok');
    // Dynamic import to avoid circular dependency
    const { refreshStatus } = await import('./status.js');
    refreshStatus();
  }
}

export async function deregisterFleet(id) {
  const r = await api(`/api/fleet/${id}`, { method: 'DELETE' });
  if (r.ok) {
    logEvent(`Fleet removed: ${id}`, 'ok');
    const { refreshStatus } = await import('./status.js');
    refreshStatus();
  }
}

export async function updateContracts() {
  let body;
  try { body = JSON.parse($('ctl-contracts').value); } catch (e) {
    show('out-contracts', { ok: false, data: `Invalid JSON: ${e.message}` });
    return;
  }
  const r = await api('/api/sandbox/contracts', { method: 'POST', body });
  show('out-contracts', r);
}
