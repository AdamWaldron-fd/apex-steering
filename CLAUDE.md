# apex-steering

Monorepo for the apex content steering system. Three components in one workspace:

- `packages/main-steering/` — Node.js/Hono, **control plane** with direct authority over edge fleet
- `crates/edge-steering/` — Rust WASM, stateless edge steering (QoE + master overrides via `/control`)
- `crates/manifest-updater/` — Rust WASM, HLS/DASH manifest transformer
- `e2e/` — Cross-system E2E tests + manual sandbox

Main-steering pushes `ControlCommand` to edge-steering fleet via `POST /control`.
Commands are region-scoped (target one region) or global (null region).
Edge uses a monotonic generation counter to reject stale commands.

## Build & Test

```bash
npm run bootstrap          # Full build: WASM + npm install + TypeScript
npm test                   # All tests (main-steering unit + E2E)
cargo test --workspace     # Rust unit + integration tests only
npm run dev                # Start all services + sandbox dashboard
```

## Monorepo Layout

- **Cargo workspace** at root — both Rust crates share dependencies (`serde`, `base64`, `wasm-bindgen`)
- **npm workspaces** — `packages/main-steering` and `e2e` share hoisted dev deps
- **Shared `tsconfig.base.json`** — Extended by each package's local `tsconfig.json`
- WASM builds output to `crates/*/pkg-node/` (nodejs target) and `crates/*/pkg/` (bundler target)
- Main-steering builds to `packages/main-steering/dist/`

## Key Paths

| What | Where |
|------|-------|
| Edge steering Rust source | `crates/edge-steering/src/` |
| Manifest updater Rust source | `crates/manifest-updater/src/` |
| Main-steering TypeScript source | `packages/main-steering/src/` |
| Main-steering unit tests | `packages/main-steering/src/__tests__/` |
| E2E test suites | `e2e/src/tests/` |
| E2E test helpers (API client, types) | `e2e/src/helpers/api.ts` |
| E2E global setup (server lifecycle) | `e2e/src/helpers/global-setup.ts` |
| WASM bridge (manifest-updater) | `e2e/src/helpers/manifest-bridge.ts` |
| Sample fixtures | `e2e/fixtures/` |
| Sandbox dashboard | `ui/index.html` |
| Test content (fake CDN origins) | `test/cdna/`, `test/cdnb/`, `test/cdnc/` |
| Documentation + roadmap | `docs/` |
| CDN edge wrappers | `wrappers/edge-steering/`, `wrappers/manifest-updater/` |

## Wire Protocol

Session state is encoded as URL-safe base64 (no padding) in the `_ss` query parameter.
Both `manifest-updater` and `edge-steering` produce byte-identical encodings — verified
by `wire-compat.test.ts`.

`SessionState` fields: `priorities`, `throughput_map`, `min_bitrate`, `max_bitrate`,
`duration`, `position`, `timestamp`, `override_gen`.

Override commands use a monotonic `generation` counter. Stale commands (generation <=
current) are rejected by edge-steering.

## Main-Steering Architecture

- **`server.ts`** — Entry point, default CDN providers, port config (`--port` flag)
- **`app.ts`** — Hono route handlers: `/health`, `/session/init`, `/priorities`, `/exclude`, `/clear`, `/fleet/register`, `/fleet/:id`, `/status`, `/providers` (sandbox hot-swap), `/contracts` (sandbox hot-swap)
- **`state.ts`** — `AppState` class with generation counter, `setCdnRegistry()` for sandbox hot-swap
- **`cdn.ts`** — `CdnProvider`, `CdnRegistry` (pathway IDs, base URLs, pricing, regions)
- **`contracts.ts`** — `CommitTracker` for contract volume commitments
- **`priority.ts`** — CDN scoring engine (contract weight + COGS + availability)
- **`cogs.ts`** — Cost of Goods Sold optimization
- **`fleet.ts`** — `EdgeFleet` registry (region-scoped edge instances)
- **`propagation.ts`** — Fan-out `ControlCommand` to edge fleet via `POST /control`
- **`sessions.ts`** — `buildManifestUpdateRequest()` for new sessions
- **`types.ts`** — Wire-compatible JSON types shared with edge-steering

## Edge-Steering Architecture (Rust)

- **`lib.rs`** — WASM entry points: `handle_steering_request`, `apply_control_command`, `encode_initial_state`, `reset_initial_state`
- **`types.rs`** / `state.rs` — `SessionState`, `SteeringRequest`, parsing, encoding
- **`policy.rs`** — Priority calculation with QoE demotion logic
- **`control.rs`** — Override state management with generation counters
- **`response.rs`** — Build `SteeringResponse` with `RELOAD-URI` (DASH returns both `PATHWAY-PRIORITY` and `SERVICE-LOCATION-PRIORITY` for backward compat)

## Manifest-Updater Architecture (Rust)

- **`lib.rs`** — WASM entry points: `update_manifest`, `update_hls`, `update_dash`, `encode_state`
- **`hls/mod.rs`** — HLS transform: inject `#EXT-X-CONTENT-STEERING`, clone media renditions with per-pathway GROUP-ID suffixing, clone variants per pathway with updated group references (AUDIO, SUBTITLES, VIDEO, CLOSED-CAPTIONS)
- **`dash/mod.rs`** — DASH transform: inject `<ContentSteering>`, add `<BaseURL serviceLocation="...">` per pathway
- **`encode.rs`** — Session state base64url encoding
- **`types.rs`** — `ManifestUpdateRequest`, `SessionState`, `PathwayMapping`

## Conventions

- Tests use `beforeEach` to reset edge state and clear main overrides
- E2E test files run sequentially (`fileParallelism: false` in vitest config) — shared server state
- Within each E2E file, tests also run sequentially (`sequence.concurrent: false`)
- E2E `beforeEach` should reset edge AFTER clearing main (otherwise main.clear propagates a high generation to edge, making subsequent low-generation direct commands stale)
- Main-steering's generation counter accumulates across E2E test suites (never resets without server restart)
- Main-steering tests are fully isolated (no shared state)
- Rust tests are fully isolated (pure functions, no shared state)
- WASM builds use `opt-level = "s"` + LTO for size optimization
- All base64 encoding is URL-safe with no padding (`base64::URL_SAFE_NO_PAD`)
- Edge-steering gracefully handles invalid `_ss` (falls back to stored initial state instead of erroring)
- Manifest-updater returns empty string for empty input, returns input unchanged for unknown format
- HLS manifest-updater: `PATHWAY-ID` is only valid on `#EXT-X-STREAM-INF`, NOT on `#EXT-X-MEDIA` (RFC 8216bis). Rendition groups are associated with pathways through per-pathway GROUP-ID suffixing (e.g., `audio` → `audio_cdn-a`)
- DASH steering responses include both `PATHWAY-PRIORITY` and `SERVICE-LOCATION-PRIORITY` for backward compatibility (CTA-5004 spec uses `PATHWAY-PRIORITY`; `SERVICE-LOCATION-PRIORITY` is from an early draft)

## Ports

| Service | Default | Flag/Env |
|---------|---------|----------|
| main-steering | 4444 | `--port` flag, `MAIN_PORT` env |
| edge-steering | 3077 | `--port` flag, `EDGE_PORT` env |
| sandbox | 5555 | `SANDBOX_PORT` env |
