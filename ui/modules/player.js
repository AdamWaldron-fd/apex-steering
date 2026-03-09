import { $, logEvent } from './events.js';
import { logSteering } from './events.js';
import { api } from './api.js';
import { cdns } from './cdn-config.js';
import { detectCdnFromUrl, updateCdnIndicator, initCdnIndicator } from './cdn-indicator.js';

let hlsPlayer = null;
let dashPlayer = null;
let currentManifestBlob = null;

function destroyPlayer() {
  if (hlsPlayer) { hlsPlayer.destroy(); hlsPlayer = null; }
  if (dashPlayer) { dashPlayer.reset(); dashPlayer = null; }
  if (currentManifestBlob) { URL.revokeObjectURL(currentManifestBlob); currentManifestBlob = null; }
  $('video').removeAttribute('src');
  $('video').load();
}

async function applyConfig() {
  const r = await api('/api/sandbox/providers', { method: 'POST', body: cdns });
  if (r.ok) logEvent('Providers updated', 'ok');
  return r.ok;
}

async function initSession() {
  const proto = $('cfg-proto').value;
  const cdnIds = cdns.filter(c => c.enabled).map(c => c.id).join(',');
  const steeringUri = `${location.origin}/api/steer/${proto}`;
  const qs = new URLSearchParams({
    cdns: cdnIds,
    steering_uri: steeringUri,
    region: $('cfg-region').value,
    min_bitrate: $('cfg-min-br').value,
    max_bitrate: $('cfg-max-br').value,
    duration: $('cfg-duration').value,
  });
  const r = await api(`/api/session/init?${qs}`);
  if (r.ok) {
    $('session-state-preview').textContent = JSON.stringify(r.data, null, 2);
    logEvent('Session initialized', 'ok');
  }
  return r;
}

export async function applyAndPlay() {
  destroyPlayer();
  initCdnIndicator();
  $('player-overlay').classList.remove('hidden');
  $('player-overlay').textContent = 'Configuring...';

  if (!(await applyConfig())) {
    $('player-overlay').textContent = 'Failed to apply providers';
    return;
  }

  $('player-overlay').textContent = 'Initializing session...';
  const sessionResult = await initSession();
  if (!sessionResult.ok) {
    $('player-overlay').textContent = 'Failed to initialize session';
    return;
  }

  const proto = $('cfg-proto').value;
  const manifestPath = $('cfg-manifest-path').value || (proto === 'hls' ? 'master.m3u8' : 'manifest.mpd');
  const primaryCdn = cdns.find(c => c.enabled);
  if (!primaryCdn) {
    $('player-overlay').textContent = 'No enabled CDNs';
    return;
  }

  $('player-overlay').textContent = 'Loading manifest...';
  const base = primaryCdn.base_url.replace(/\/+$/, '');
  const manifestUrl = `${base}/${manifestPath}`;
  let sourceManifest;
  try {
    const resp = await fetch(manifestUrl);
    if (!resp.ok) {
      $('player-overlay').textContent = `404: ${manifestPath} not found — check the manifest path and ensure content is in test/ dirs`;
      return;
    }
    sourceManifest = await resp.text();
  } catch (e) {
    $('player-overlay').textContent = `Error loading manifest: ${e.message}`;
    return;
  }

  $('player-overlay').textContent = 'Transforming manifest...';
  const transformResult = await api('/api/manifest', {
    method: 'POST',
    body: { manifest: sourceManifest, request_json: sessionResult.data },
  });
  if (!transformResult.ok) {
    $('player-overlay').textContent = 'Failed to transform manifest';
    return;
  }

  const transformedManifest = transformResult.data;
  $('manifest-preview').textContent = typeof transformedManifest === 'string'
    ? transformedManifest
    : JSON.stringify(transformedManifest, null, 2);

  const mimeType = proto === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml';
  const blob = new Blob([transformedManifest], { type: mimeType });
  currentManifestBlob = URL.createObjectURL(blob);

  const video = $('video');

  if (proto === 'hls') {
    startHlsPlayer(video);
  } else {
    startDashPlayer(video);
  }

  logEvent(`Playing via ${proto.toUpperCase()}`, 'ok');
}

function startHlsPlayer(video) {
  if (Hls.isSupported()) {
    hlsPlayer = new Hls({ debug: false, enableWorker: true });

    hlsPlayer.on(Hls.Events.STEERING_MANIFEST_LOADED, (event, data) => {
      logSteering(`Steering response: ${JSON.stringify(data)}`, 'ok');
    });
    hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
      logSteering(`HLS error: ${data.type} - ${data.details}`, 'err');
    });
    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
      logSteering('HLS manifest parsed', 'ok');
      $('player-overlay').classList.add('hidden');
      video.play().catch(() => {});
    });
    hlsPlayer.on(Hls.Events.LEVEL_SWITCHING, (event, data) => {
      logSteering(`Switching to level ${data.level}`, 'info');
    });
    hlsPlayer.on(Hls.Events.FRAG_LOADED, (event, data) => {
      const url = data.frag?.url || data.frag?.relurl || '';
      const cdnId = detectCdnFromUrl(url);
      if (cdnId) updateCdnIndicator(cdnId);
    });

    hlsPlayer.loadSource(currentManifestBlob);
    hlsPlayer.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = currentManifestBlob;
    video.addEventListener('loadedmetadata', () => {
      $('player-overlay').classList.add('hidden');
      video.play().catch(() => {});
    }, { once: true });
  } else {
    $('player-overlay').textContent = 'HLS not supported in this browser';
  }
}

function startDashPlayer(video) {
  dashPlayer = dashjs.MediaPlayer().create();
  dashPlayer.updateSettings({
    debug: { logLevel: dashjs.Debug.LOG_LEVEL_NONE },
    streaming: { applyContentSteering: true },
  });
  dashPlayer.on('error', (e) => {
    logSteering(`DASH error: ${e.error?.message || JSON.stringify(e)}`, 'err');
  });
  dashPlayer.on('playbackStarted', () => {
    $('player-overlay').classList.add('hidden');
  });
  dashPlayer.on('qualityChangeRendered', (e) => {
    logSteering(`Quality changed: ${e.mediaType} -> ${e.newQuality}`, 'info');
  });
  dashPlayer.on('fragmentLoadingCompleted', (e) => {
    const url = e.request?.url || '';
    const cdnId = detectCdnFromUrl(url);
    if (cdnId) updateCdnIndicator(cdnId);
  });
  dashPlayer.on(dashjs.MediaPlayer.events.CONTENT_STEERING_REQUEST_COMPLETED, (e) => {
    const data = e.currentSteeringResponseData || e;
    logSteering(`DASH steering response: ${JSON.stringify(data)}`, 'ok');
  });
  dashPlayer.initialize(video, currentManifestBlob, true);
}
