/**
 * Akamai EdgeWorkers — apex-manifest-updater
 *
 * Uses responseProvider to intercept manifest responses,
 * inject content steering tags via the WASM module.
 *
 * Property Manager variables:
 *   PMUSER_STEERING_URI       — Edge steering server base URI
 *   PMUSER_MAIN_STEERING_URL  — apex-main-steering base URL
 */
import { httpRequest } from 'http-request';
import { createResponse } from 'create-response';
import { update_manifest } from '../../pkg-node/apex_manifest_updater.js';

export async function responseProvider(request) {
  const url = request.url || request.path;
  const isManifest = url.endsWith('.m3u8') || url.endsWith('.mpd');

  if (!isManifest) {
    // Pass through non-manifest requests
    const origin = await httpRequest(`${request.scheme}://${request.host}${request.path}`);
    return createResponse(origin.status, origin.getHeaders(), origin.body);
  }

  // Fetch origin manifest
  const originUrl = `${request.scheme}://${request.host}${request.path}`;
  const originResponse = await httpRequest(originUrl);
  const manifest = await originResponse.text();

  // Get ManifestUpdateRequest
  const requestJson = request.getHeader('X-Manifest-Update-Request')
    ? request.getHeader('X-Manifest-Update-Request')[0]
    : await fetchManifestUpdateRequest(request);

  if (!requestJson) {
    return createResponse(200, { 'Content-Type': originResponse.getHeader('Content-Type') || ['application/octet-stream'] }, manifest);
  }

  try {
    const modified = update_manifest(manifest, requestJson);
    return createResponse(200, { 'Content-Type': originResponse.getHeader('Content-Type') || ['application/octet-stream'] }, modified);
  } catch (e) {
    return createResponse(200, { 'Content-Type': originResponse.getHeader('Content-Type') || ['application/octet-stream'] }, manifest);
  }
}

async function fetchManifestUpdateRequest(request) {
  const mainSteeringUrl = request.getVariable('PMUSER_MAIN_STEERING_URL');
  const steeringUri = request.getVariable('PMUSER_STEERING_URI');
  if (!mainSteeringUrl) return null;

  const url = new URL(request.url || `${request.scheme}://${request.host}${request.path}`);
  const cdns = url.searchParams.get('cdns');
  if (!cdns) return null;

  const params = new URLSearchParams({
    cdns,
    steering_uri: steeringUri || '',
    region: url.searchParams.get('region') || '',
  });

  try {
    const res = await httpRequest(`${mainSteeringUrl}/session/init?${params}`);
    if (res.status === 200) return await res.text();
  } catch (e) {
    // Fall through
  }
  return null;
}
