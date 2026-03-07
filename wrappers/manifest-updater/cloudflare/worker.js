/**
 * Cloudflare Worker — apex-manifest-updater
 *
 * Intercepts manifest responses, injects content steering tags
 * using the WASM module, and returns the modified manifest.
 *
 * Environment variables (wrangler.toml [vars]):
 *   STEERING_URI  — Edge steering server base URI
 *   MAIN_STEERING_URL — apex-main-steering base URL for /session/init
 */
import init, { update_manifest } from '../../pkg/apex_manifest_updater.js';

let initialized = false;

export default {
  async fetch(request, env, ctx) {
    if (!initialized) {
      await init();
      initialized = true;
    }

    // Fetch the origin manifest
    const originResponse = await fetch(request);
    const contentType = originResponse.headers.get('content-type') || '';

    // Only process manifest responses
    const isManifest =
      contentType.includes('mpegurl') ||
      contentType.includes('dash+xml') ||
      request.url.endsWith('.m3u8') ||
      request.url.endsWith('.mpd');

    if (!isManifest) {
      return originResponse;
    }

    const manifest = await originResponse.text();

    // Get ManifestUpdateRequest from apex-main-steering or from request header
    const requestJson = request.headers.get('X-Manifest-Update-Request')
      || await fetchManifestUpdateRequest(request, env);

    if (!requestJson) {
      return new Response(manifest, { headers: originResponse.headers });
    }

    try {
      const modified = update_manifest(manifest, requestJson);
      return new Response(modified, {
        status: originResponse.status,
        headers: originResponse.headers,
      });
    } catch (e) {
      console.error('apex-manifest-updater error:', e);
      return new Response(manifest, { headers: originResponse.headers });
    }
  },
};

async function fetchManifestUpdateRequest(request, env) {
  if (!env.MAIN_STEERING_URL) return null;

  const url = new URL(request.url);
  const cdns = url.searchParams.get('cdns');
  if (!cdns) return null;

  const params = new URLSearchParams({
    cdns,
    steering_uri: env.STEERING_URI || '',
    region: url.searchParams.get('region') || '',
  });

  try {
    const res = await fetch(`${env.MAIN_STEERING_URL}/session/init?${params}`);
    if (res.ok) return await res.text();
  } catch (e) {
    console.error('Failed to fetch ManifestUpdateRequest:', e);
  }
  return null;
}
