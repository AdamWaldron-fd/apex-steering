import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Load manifest-updater WASM module (nodejs target).
// Expects: ../apex-manifest-updater/pkg-node/ to exist (run `npm run bootstrap` first).
let wasm: {
  update_manifest: (manifest: string, requestJson: string) => string;
  update_hls: (manifest: string, requestJson: string) => string;
  update_dash: (manifest: string, requestJson: string) => string;
  encode_state: (stateJson: string) => string;
};

try {
  wasm = require("../../../crates/manifest-updater/pkg-node/apex_manifest_updater.js");
} catch (e) {
  throw new Error(
    "Failed to load apex-manifest-updater WASM. Run `npm run bootstrap` first.\n" +
      String(e),
  );
}

/** Transform a manifest (auto-detects HLS vs DASH). This is the production entry point. */
export function updateManifest(manifest: string, requestJson: string): string {
  return wasm.update_manifest(manifest, requestJson);
}

/** Encode SessionState to URL-safe base64 (no padding). Same as edge-steering's encoding. */
export function encodeState(stateJson: string): string {
  return wasm.encode_state(stateJson);
}

/** HLS-only transform. */
export function updateHls(manifest: string, requestJson: string): string {
  return wasm.update_hls(manifest, requestJson);
}

/** DASH-only transform. */
export function updateDash(manifest: string, requestJson: string): string {
  return wasm.update_dash(manifest, requestJson);
}
