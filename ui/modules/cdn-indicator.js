import { $, escHtml } from './events.js';
import { logSteering } from './events.js';
import { cdns } from './cdn-config.js';

const cdnSegmentCounts = {};
let activeCdnId = null;
let lastSwitchTime = null;

export function detectCdnFromUrl(url) {
  for (const cdn of cdns) {
    if (!cdn.enabled) continue;
    if (url.includes(cdn.base_url.replace(/\/+$/, '')) || url.includes(`/test/${cdn.id.replace('cdn-', 'cdn')}/`)) {
      return cdn.id;
    }
  }
  const match = url.match(/\/test\/cdn([a-z])\//);
  if (match) {
    const letter = match[1];
    const found = cdns.find(c => c.id === `cdn-${letter}`);
    if (found) return found.id;
  }
  return null;
}

export function updateCdnIndicator(cdnId) {
  if (!cdnId) return;
  cdnSegmentCounts[cdnId] = (cdnSegmentCounts[cdnId] || 0) + 1;

  if (cdnId !== activeCdnId) {
    const prev = activeCdnId;
    activeCdnId = cdnId;
    lastSwitchTime = Date.now();
    if (prev) {
      logSteering(`CDN switch: ${prev} → ${cdnId}`, 'ok');
    }
  }
  renderCdnIndicator();
}

export function renderCdnIndicator() {
  const enabledCdns = cdns.filter(c => c.enabled);
  const nodesEl = $('cdn-nodes');
  const svgEl = $('routing-svg');
  const statsEl = $('cdn-indicator-stats');

  nodesEl.innerHTML = enabledCdns.map(cdn => {
    const isActive = cdn.id === activeCdnId;
    const count = cdnSegmentCounts[cdn.id] || 0;
    const cls = isActive ? 'active' : (activeCdnId && !isActive ? 'stale' : '');
    return `<div class="cdn-node ${cls}" data-cdn="${cdn.id}">
      <span class="cdn-dot"></span>
      <span>${escHtml(cdn.id)}</span>
      ${count > 0 ? `<span style="font-size:9px;color:var(--muted);font-weight:400">${count}</span>` : ''}
    </div>`;
  }).join('');

  requestAnimationFrame(() => {
    const container = $('routing-lines');
    const containerRect = container.getBoundingClientRect();
    const nodes = nodesEl.querySelectorAll('.cdn-node');
    const clientEl = container.nextElementSibling;
    const clientRect = clientEl.querySelector('.client-device').getBoundingClientRect();
    const clientY = clientRect.top + clientRect.height / 2 - containerRect.top;
    const clientX = containerRect.width;

    let paths = '';
    nodes.forEach(node => {
      const nodeRect = node.getBoundingClientRect();
      const nodeY = nodeRect.top + nodeRect.height / 2 - containerRect.top;
      const isActive = node.classList.contains('active');
      const cx1 = containerRect.width * 0.4;
      const cx2 = containerRect.width * 0.6;
      paths += `<path class="routing-line ${isActive ? 'active' : ''}" d="M0,${nodeY} C${cx1},${nodeY} ${cx2},${clientY} ${clientX},${clientY}" />`;
    });
    svgEl.innerHTML = paths;
  });

  const total = Object.values(cdnSegmentCounts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    statsEl.innerHTML = enabledCdns
      .filter(cdn => cdnSegmentCounts[cdn.id] > 0)
      .map(cdn => {
        const pct = Math.round((cdnSegmentCounts[cdn.id] / total) * 100);
        const color = cdn.id === activeCdnId ? 'var(--green)' : 'var(--muted)';
        return `<span><span class="stat-dot" style="background:${color}"></span>${cdn.id}: ${pct}%</span>`;
      }).join('');
  }
}

export function initCdnIndicator() {
  activeCdnId = null;
  Object.keys(cdnSegmentCounts).forEach(k => delete cdnSegmentCounts[k]);
  renderCdnIndicator();
}
