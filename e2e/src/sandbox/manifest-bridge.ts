import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let wasm: {
  update_manifest: (manifest: string, requestJson: string) => string;
  update_hls: (manifest: string, requestJson: string) => string;
  update_dash: (manifest: string, requestJson: string) => string;
  encode_state: (stateJson: string) => string;
};

try {
  wasm = require("../../../crates/manifest-updater/pkg-node/apex_manifest_updater.js");
} catch (e) {
  console.error(
    "Failed to load apex-manifest-updater WASM. Run `npm run bootstrap` first.",
  );
  throw e;
}

export function updateManifest(manifest: string, requestJson: string): string {
  return wasm.update_manifest(manifest, requestJson);
}

export function encodeState(stateJson: string): string {
  return wasm.encode_state(stateJson);
}
