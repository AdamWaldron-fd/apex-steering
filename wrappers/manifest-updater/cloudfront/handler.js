/**
 * CloudFront Lambda@Edge — apex-manifest-updater
 *
 * Origin-response trigger that intercepts manifest responses,
 * injects content steering tags via the WASM module.
 *
 * Environment variables (Lambda configuration):
 *   STEERING_URI       — Edge steering server base URI
 *   MAIN_STEERING_URL  — apex-main-steering base URL
 */
const { update_manifest } = require('../../pkg-node/apex_manifest_updater.js');
const https = require('https');

exports.handler = async (event) => {
  const response = event.Records[0].cf.response;
  const request = event.Records[0].cf.request;

  const uri = request.uri || '';
  const isManifest = uri.endsWith('.m3u8') || uri.endsWith('.mpd');

  if (!isManifest) {
    return response;
  }

  // Get the manifest body from the origin response
  const manifest = response.body || '';
  if (!manifest) return response;

  // Get ManifestUpdateRequest from header or subrequest
  const requestJson = getHeader(request, 'x-manifest-update-request')
    || await fetchManifestUpdateRequest(request);

  if (!requestJson) {
    return response;
  }

  try {
    const modified = update_manifest(manifest, requestJson);
    response.body = modified;
    response.bodyEncoding = 'text';
  } catch (e) {
    console.error('apex-manifest-updater error:', e);
  }

  return response;
};

function getHeader(request, name) {
  const headers = request.headers || {};
  const header = headers[name.toLowerCase()];
  return header && header.length > 0 ? header[0].value : null;
}

function fetchManifestUpdateRequest(request) {
  const mainSteeringUrl = process.env.MAIN_STEERING_URL;
  const steeringUri = process.env.STEERING_URI;
  if (!mainSteeringUrl) return Promise.resolve(null);

  const qs = request.querystring || '';
  const params = new URLSearchParams(qs);
  const cdns = params.get('cdns');
  if (!cdns) return Promise.resolve(null);

  const initParams = new URLSearchParams({
    cdns,
    steering_uri: steeringUri || '',
    region: params.get('region') || '',
  });

  const url = `${mainSteeringUrl}/session/init?${initParams}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}
