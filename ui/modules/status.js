import { $, escHtml } from './events.js';

const API = '';

export async function checkHealth() {
  try {
    const resp = await fetch(`${API}/api/health`);
    const data = await resp.json();
    $('dot-main').className = data.main_steering ? 'dot up' : 'dot down';
    $('dot-edge').className = data.edge_steering ? 'dot up' : 'dot down';
  } catch {
    $('dot-main').className = 'dot down';
    $('dot-edge').className = 'dot down';
  }
}

export async function refreshStatus() {
  try {
    const resp = await fetch(`${API}/api/status`);
    const data = await resp.json();
    $('gen-display').textContent = `gen: ${data.generation}`;
    $('out-status').className = 'ok';
    $('out-status').textContent = JSON.stringify(data, null, 2);

    const fleet = data.fleet || [];
    $('fleet-list').innerHTML = fleet.length === 0
      ? '<span style="color:var(--muted);font-size:10px">No fleet instances</span>'
      : fleet.map(f => `
        <div class="fleet-row">
          <span>${escHtml(f.platform)} / ${escHtml(f.region || 'global')}</span>
          <span>
            <span class="dot ${f.healthy ? 'up' : 'down'}"></span>
            <button class="btn-s btn-danger" data-action="deregister-fleet" data-id="${escHtml(f.id)}" style="margin-left:4px">&times;</button>
          </span>
        </div>
      `).join('');
  } catch {
    $('out-status').className = 'err';
    $('out-status').textContent = 'Failed to fetch status';
  }
}

export function startAutoRefresh() {
  setInterval(() => {
    if ($('auto-refresh').checked) {
      refreshStatus();
      checkHealth();
    }
  }, 5000);
}
