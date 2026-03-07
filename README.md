# apex-steering

Monorepo for the **apex content steering** system — CDN load balancing, cost optimization, and real-time traffic steering for HLS and DASH video streams.

## Architecture

```
                          ┌───────────────────────────┐
                          │    manifest-updater        │
                          │    (Rust → WASM)           │
                          │                           │
                          │  - Injects steering tags   │
                          │  - Clones HLS pathways     │
                          │  - Adds DASH BaseURLs      │
                          │  - Encodes _ss state       │
                          │  (build-time transform)    │
                          └─────────────▲─────────────┘
                                        │
                              ManifestUpdateRequest
                                        │
┌──────────────────────────┐            │            ┌──────────────────────────┐
│  main-steering           │            │            │  edge-steering           │
│  (Node.js / Hono)        │────────────┘            │  (Rust → WASM)           │
│                          │                         │                          │
│  - Session init          │   POST /control         │  - Decodes _ss state     │
│  - CDN priorities        │ ──────────────────────▶ │  - QoE-based routing     │
│  - Contract/COGS mgmt    │   (ControlCommand)      │  - RELOAD-URI chain      │
│  - Fleet management      │ ──────────────────────▶ │  - Override execution    │
│  - Region-scoped control │   per region or global   │  - Generation counter    │
│  (control plane)         │                         │  (edge / data plane)     │
└──────────────────────────┘                         └──────────────────────────┘
    packages/main-steering                               crates/edge-steering
```

Main-steering has **direct, granular control** over the edge-steering fleet:

- **`POST /priorities`** — Force a specific CDN ordering (e.g., promote cdn-b over cdn-a). Can target a single region or all regions globally. Supports optional TTL override for custom poll intervals.
- **`POST /exclude`** — Remove a CDN pathway entirely (disaster recovery). Region-scoped — exclude cdn-a in `us-east` without affecting `eu-west`.
- **`POST /clear`** — Reset all overrides, restoring the original contract-weighted priorities.

Every command is pushed in real-time to all registered edge fleet members via `POST /control`. Commands include a monotonic generation counter — edge-steering silently rejects stale commands, ensuring consistency even with out-of-order delivery.

### Data Flow

1. **Session init** — Origin calls main-steering `/session/init` with CDNs, region, bitrate bounds, and a steering URI. Returns a `ManifestUpdateRequest` with session state and pathway mappings sorted by contract weight.

2. **Manifest transformation** — Origin passes the `ManifestUpdateRequest` and the raw HLS/DASH manifest through the manifest-updater WASM module. The updater injects content-steering tags (`#EXT-X-CONTENT-STEERING` for HLS, `<ContentSteering>` for DASH), clones variants per pathway, and encodes session state into a URL-safe base64 `_ss` parameter in the steering URI.

3. **Edge steering** — Player periodically polls the steering URI. Edge-steering decodes `_ss`, evaluates QoE signals (throughput, current pathway), applies any active overrides from main-steering, and returns `PATHWAY-PRIORITY` (HLS) or `SERVICE-LOCATION-PRIORITY` (DASH) with a `TTL` and `RELOAD-URI`.

4. **Override propagation** — Operators issue commands through main-steering (`POST /priorities`, `POST /exclude`, `POST /clear`). Main-steering fans these out as `ControlCommand` JSON to all registered edge fleet members via `POST /control`. Commands can target a specific region (e.g., only `us-east` edges) or apply globally (`null` region). Edge-steering enforces ordering via a monotonic generation counter — stale commands are silently rejected.

### Control Granularity

| Scope | Example | Effect |
|-------|---------|--------|
| **Global** | `POST /priorities { region: null, priorities: ["cdn-b", "cdn-a"] }` | All edge instances worldwide reorder CDNs |
| **Regional** | `POST /exclude { pathway: "cdn-a", region: "us-east" }` | Only `us-east` edges drop cdn-a; `eu-west` unaffected |
| **Per-CDN** | `POST /exclude { pathway: "cdn-b" }` | Specific CDN removed from rotation |
| **TTL override** | `POST /priorities { ..., ttl_override: 30 }` | Edge returns custom poll interval instead of default 300s |

## Repository Structure

```
apex-steering/
├── crates/
│   ├── edge-steering/         Rust WASM — stateless edge steering server
│   └── manifest-updater/      Rust WASM — HLS/DASH manifest transformer
├── packages/
│   └── main-steering/         Node.js — control plane server
├── e2e/                       Cross-system E2E test suite
│   ├── src/tests/             10 test suites (155 tests)
│   ├── src/sandbox/           Manual testing sandbox server
│   └── fixtures/              Sample HLS/DASH manifests
├── ui/                        Sandbox dashboard (HTML)
├── wrappers/                  CDN edge platform deploy wrappers
│   ├── edge-steering/         Akamai, Cloudflare, CloudFront, Fastly
│   └── manifest-updater/      Akamai, Cloudflare, CloudFront, Fastly
└── scripts/                   Build and dev tooling
```

## Prerequisites

- **Node.js** >= 18
- **Rust** toolchain with `cargo` and `wasm-pack`

## Quick Start

```bash
# Build everything (WASM + TypeScript) and install dependencies
npm run bootstrap

# Run all tests
npm test

# Start all services for development
npm run dev
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run bootstrap` | Build WASM, install deps, compile TypeScript |
| `npm run build` | Build WASM crates + main-steering TypeScript |
| `npm run build:wasm` | Build both WASM crates only |
| `npm run build:main` | Build main-steering TypeScript only |
| `npm test` | Run main-steering unit tests + E2E tests |
| `npm run test:main` | Run main-steering unit tests (206 tests) |
| `npm run test:e2e` | Run cross-system E2E tests (155 tests) |
| `npm run dev` | Start main-steering + edge-steering + sandbox |
| `npm run sandbox` | Start sandbox dashboard only |

## Components

### crates/edge-steering

Stateless edge steering server compiled to WebAssembly. Deployed at CDN edge (Akamai, Cloudflare, CloudFront, Fastly). Receives real-time control commands from main-steering.

- Decodes session state from `_ss` URL parameter
- QoE-driven pathway demotion (degrades → switch CDN, TTL 10s)
- Executes master override commands (`set_priorities`, `exclude_pathway`, `clear_overrides`)
- Generation counter rejects stale or out-of-order commands
- HLS (`PATHWAY-PRIORITY`) and DASH (`SERVICE-LOCATION-PRIORITY`) support
- ~200 KB WASM binary, 97 unit tests + 12 integration tests

### crates/manifest-updater

HLS/DASH manifest transformer compiled to WebAssembly. Runs at origin or CDN edge.

- Injects `#EXT-X-CONTENT-STEERING` (HLS) or `<ContentSteering>` (DASH)
- Clones HLS variants per pathway, adds DASH BaseURL elements
- Encodes session state to URL-safe base64 `_ss` parameter
- Wire-compatible encoding with edge-steering
- 20 unit tests + 7 integration tests

### packages/main-steering

Control plane server (Node.js + Hono). Has direct, granular authority over the edge fleet.

- Session initialization with contract-weighted CDN priorities
- COGS optimization (cost per GB)
- Edge fleet registry with per-region membership
- Granular override control: reorder CDNs, exclude pathways, set custom TTLs — globally or per-region
- Real-time command propagation to all registered edge instances via `POST /control`
- 206 unit/integration tests

### e2e/

Cross-system E2E test suite validating the full pipeline across all three components.

| Suite | Tests | Coverage |
|-------|-------|----------|
| wire-compat | 16 | Encoding identity between WASM modules |
| hls-session | 34 | Full HLS session lifecycle |
| dash-session | 25 | Full DASH session lifecycle |
| contracts | 10 | Contract-driven priority verification |
| multi-region | 12 | Region-scoped fleet commands |
| concurrent | 10 | Session isolation under concurrency |
| tokens | 10 | CDN auth token passthrough |
| errors | 10 | Graceful degradation with corrupt input |
| overrides | 16 | Master override propagation lifecycle |
| disaster | 12 | CDN disaster recovery scenarios |

### Sandbox Dashboard

Browser-based dashboard for manual testing and demos at `http://localhost:5555`.

```bash
npm run dev    # starts all services + sandbox
```

Sections: Health indicators, Session Init, Set Priorities / Exclude, Edge Steer, Manifest Updater, System Status, Encode/Decode State, Event Log.

## Development

### Running Rust Tests

```bash
cargo test --workspace        # all Rust unit + integration tests
cargo test -p apex-edge-steering    # edge-steering only
cargo test -p apex-manifest-updater # manifest-updater only
```

### Running Individual E2E Suites

```bash
npm run test:e2e                                              # all E2E
cd e2e && node --experimental-vm-modules ../node_modules/.bin/vitest run wire-compat
cd e2e && node --experimental-vm-modules ../node_modules/.bin/vitest run hls-session
cd e2e && node --experimental-vm-modules ../node_modules/.bin/vitest run disaster
```

### Ports

| Service | Default Port | Env Override |
|---------|-------------|--------------|
| main-steering | 4444 | `MAIN_PORT` |
| edge-steering | 3077 | `EDGE_PORT` |
| sandbox | 5555 | `SANDBOX_PORT` |

## Shared Types

```typescript
interface SessionState {
  priorities: string[];                  // CDN priority order
  throughput_map: [string, number][];    // CDN → throughput (bps)
  min_bitrate: number;
  max_bitrate: number;
  duration: number;                      // Content length (seconds)
  position: number;                      // Playback position (seconds)
  timestamp: number;                     // Unix timestamp
  override_gen: number;                  // Monotonic generation counter
}

interface SteeringResponse {
  VERSION: number;                       // Always 1
  TTL: number;                           // 300 (normal) or 10 (QoE event)
  "RELOAD-URI"?: string;                 // Next poll URL with updated _ss
  "PATHWAY-PRIORITY"?: string[];         // HLS CDN order
  "SERVICE-LOCATION-PRIORITY"?: string[];// DASH CDN order
}
```
