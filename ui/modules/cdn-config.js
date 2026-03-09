import { $, escHtml } from './events.js';

export let cdns = [
  {
    id: 'cdn-a',
    name: 'CDN Alpha',
    base_url: `${location.origin}/test/cdna/`,
    regions: ['us-east', 'us-west'],
    pricing: { cost_per_gb: 0.04, burst_cost_per_gb: 0.08, currency: 'USD' },
    weight: 0.6,
    enabled: true,
  },
  {
    id: 'cdn-b',
    name: 'CDN Beta',
    base_url: `${location.origin}/test/cdnb/`,
    regions: ['us-east', 'eu-west'],
    pricing: { cost_per_gb: 0.05, burst_cost_per_gb: 0.10, currency: 'USD' },
    weight: 0.4,
    enabled: true,
  },
  {
    id: 'cdn-c',
    name: 'CDN Gamma',
    base_url: `${location.origin}/test/cdnc/`,
    regions: ['eu-west', 'ap-east'],
    pricing: { cost_per_gb: 0.06, burst_cost_per_gb: 0.12, currency: 'USD' },
    weight: 0.3,
    enabled: true,
  },
];

export function renderCdns() {
  const container = $('cdn-list');
  container.innerHTML = cdns.map((cdn, i) => `
    <div class="cdn-card" data-idx="${i}">
      <div class="cdn-header">
        <span class="cdn-id">${escHtml(cdn.id)}</span>
        <button class="cdn-remove" data-action="remove-cdn" data-idx="${i}" title="Remove">&times;</button>
      </div>
      <label>Name</label>
      <input data-field="name" data-idx="${i}" value="${escHtml(cdn.name)}" />
      <label>Base URL</label>
      <input data-field="base_url" data-idx="${i}" value="${escHtml(cdn.base_url)}" />
      <div class="row">
        <div><label>$/GB</label><input data-field="cost_per_gb" data-idx="${i}" type="number" step="0.01" value="${cdn.pricing.cost_per_gb}" /></div>
        <div><label>Weight</label><input data-field="weight" data-idx="${i}" type="number" step="0.1" min="0" max="1" value="${cdn.weight}" /></div>
      </div>
      <div class="row">
        <div><label>Regions</label><input data-field="regions" data-idx="${i}" value="${cdn.regions.join(',')}" /></div>
        <div style="flex:0 0 60px"><label>On</label><input data-field="enabled" data-idx="${i}" type="checkbox" ${cdn.enabled ? 'checked' : ''} /></div>
      </div>
    </div>
  `).join('');
}

export function addCdn() {
  const n = cdns.length + 1;
  cdns.push({
    id: `cdn-${String.fromCharCode(96 + n)}`,
    name: `CDN ${n}`,
    base_url: `${location.origin}/test/cdn${String.fromCharCode(96 + n)}/`,
    regions: [],
    pricing: { cost_per_gb: 0.05, burst_cost_per_gb: 0.10, currency: 'USD' },
    weight: 0.3,
    enabled: true,
  });
  renderCdns();
}

export function removeCdn(idx) {
  cdns.splice(idx, 1);
  renderCdns();
}

export function handleCdnFieldChange(el) {
  const idx = parseInt(el.dataset.idx);
  const field = el.dataset.field;
  if (!field || isNaN(idx)) return;

  switch (field) {
    case 'name':
      cdns[idx].name = el.value;
      break;
    case 'base_url':
      cdns[idx].base_url = el.value;
      break;
    case 'cost_per_gb':
      cdns[idx].pricing.cost_per_gb = +el.value;
      break;
    case 'weight':
      cdns[idx].weight = +el.value;
      break;
    case 'regions':
      cdns[idx].regions = el.value.split(',').map(s => s.trim()).filter(Boolean);
      break;
    case 'enabled':
      cdns[idx].enabled = el.checked;
      break;
  }
}
