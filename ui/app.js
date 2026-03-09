import { $ } from './modules/events.js';
import { toggleSection } from './modules/sections.js';
import { cdns, renderCdns, addCdn, removeCdn, handleCdnFieldChange } from './modules/cdn-config.js';
import { initCdnIndicator } from './modules/cdn-indicator.js';
import { applyAndPlay } from './modules/player.js';
import { setPriorities, excludePathway, clearOverrides, registerFleet, deregisterFleet, updateContracts } from './modules/controls.js';
import { checkHealth, refreshStatus, startAutoRefresh } from './modules/status.js';

// ── Event Delegation ─────────────────────────────────────────
// Instead of inline onclick handlers, we use data-action attributes
// and a single delegated listener per panel.

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  switch (action) {
    case 'toggle-section':
      toggleSection(target);
      break;
    case 'add-cdn':
      addCdn();
      break;
    case 'remove-cdn':
      removeCdn(parseInt(target.dataset.idx));
      break;
    case 'apply-and-play':
      applyAndPlay();
      break;
    case 'set-priorities':
      setPriorities();
      break;
    case 'exclude-pathway':
      excludePathway();
      break;
    case 'clear-overrides':
      clearOverrides();
      break;
    case 'register-fleet':
      registerFleet();
      break;
    case 'deregister-fleet':
      deregisterFleet(target.dataset.id);
      break;
    case 'update-contracts':
      updateContracts();
      break;
    case 'refresh-status':
      refreshStatus();
      break;
  }
});

// CDN config field changes via delegation
document.getElementById('cdn-list').addEventListener('change', (e) => {
  if (e.target.dataset.field) {
    handleCdnFieldChange(e.target);
  }
});

// Protocol change updates default manifest path
$('cfg-proto').addEventListener('change', () => {
  const proto = $('cfg-proto').value;
  const current = $('cfg-manifest-path').value;
  if (current === 'master.m3u8' || current === 'manifest.mpd') {
    $('cfg-manifest-path').value = proto === 'hls' ? 'master.m3u8' : 'manifest.mpd';
  }
});

// ── Init ─────────────────────────────────────────────────────

renderCdns();
initCdnIndicator();
checkHealth();
refreshStatus();
startAutoRefresh();
