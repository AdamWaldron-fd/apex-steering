/**
 * Fastly Compute — apex-manifest-updater
 *
 * Intercepts manifest responses, injects content steering tags
 * using the WASM module, and returns the modified manifest.
 *
 * Config store keys:
 *   steering_uri       — Edge steering server base URI
 *   main_steering_url  — apex-main-steering base URL for /session/init
 */
import { update_manifest } from '../../pkg/apex_manifest_updater.js';

addEventListener('fetch', (event) => event.respondWith(handleRequest(event)));

async function handleRequest(event) {
  const request = event.request;

  // Fetch from origin backend
  const originResponse = await fetch(request, { backend: 'origin' });
  const contentType = originResponse.headers.get('content-type') || '';

  const isManifest =
    contentType.includes('mpegurl') ||
    contentType.includes('dash+xml') ||
    request.url.endsWith('.m3u8') ||
    request.url.endsWith('.mpd');

  if (!isManifest) {
    return originResponse;
  }

  const manifest = await originResponse.text();

  // Get ManifestUpdateRequest from header or subrequest
  const requestJson = request.headers.get('X-Manifest-Update-Request')
    || await fetchManifestUpdateRequest(request);

  if (!requestJson) {
    return new Response(manifest, {
      status: originResponse.status,
      headers: originResponse.headers,
    });
  }

  try {
    const modified = update_manifest(manifest, requestJson);
    return new Response(modified, {
      status: originResponse.status,
      headers: originResponse.headers,
    });
  } catch (e) {
    console.error('apex-manifest-updater error:', e);
    return new Response(manifest, {
      status: originResponse.status,
      headers: originResponse.headers,
    });
  }
}

async function fetchManifestUpdateRequest(request) {
  const config = new ConfigStore('apex_steering');
  const mainSteeringUrl = config.get('main_steering_url');
  const steeringUri = config.get('steering_uri');
  if (!mainSteeringUrl) return null;

  const url = new URL(request.url);
  const cdns = url.searchParams.get('cdns');
  if (!cdns) return null;

  const params = new URLSearchParams({
    cdns,
    steering_uri: steeringUri || '',
    region: url.searchParams.get('region') || '',
  });

  try {
    const res = await fetch(`${mainSteeringUrl}/session/init?${params}`, {
      backend: 'steering',
    });
    if (res.ok) return await res.text();
  } catch (e) {
    console.error('Failed to fetch ManifestUpdateRequest:', e);
  }
  return null;
}
