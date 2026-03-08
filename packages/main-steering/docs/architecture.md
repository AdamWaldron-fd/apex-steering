# Architecture

## System Overview

`apex-main-steering` is the centralized decision-making server in the apex CDN steering system. It sits above a fleet of stateless edge steering servers (WASM modules running on Akamai EdgeWorkers, CloudFront Lambda@Edge, Cloudflare Workers, and Fastly Compute).

The edge servers handle per-request QoE optimization within the constraints set by the master. The master handles global concerns: load balancing across CDN providers, COGS optimization, and contract commitment tracking.

## Communication Model

### 1. Session Initialization (Pull)

When a manifest updater creates a new player session, it calls `GET /session/init` to get a `SessionState` JSON object. This gets base64-encoded and embedded as the `_ss=` parameter in the manifest's `SERVER-URI`.

```
Manifest Updater  ─── GET /session/init ───►  Master
                  ◄── SessionState JSON ────
                  │
                  ▼
              Embeds _ss=<base64(SessionState)> in manifest
                  │
                  ▼
              Player uses SERVER-URI with _ss= param
                  │
                  ▼
              Edge server decodes SessionState, uses priorities
```

The `SessionState` contains:
- `priorities` — ordered list of CDN pathway IDs
- `throughput_map` — historical throughput per CDN (array of `[cdn_id, bps]` tuples)
- `min_bitrate`, `max_bitrate` — bitrate bounds
- `duration`, `position` — content metadata
- `timestamp` — when the state was generated
- `override_gen` — generation counter at state creation time

### 2. Control Commands (Push)

Operators (or automated systems) call `POST /priorities`, `POST /exclude`, or `POST /clear` on the master. The master auto-increments its generation counter and fans out the resulting `ControlCommand` to all matching edge instances via `POST /control`.

```
Operator  ─── POST /priorities ───►  Master
                                       │
                                       ├── POST /control ──► Akamai Edge 1
                                       ├── POST /control ──► Akamai Edge 2
                                       ├── POST /control ──► CloudFront Edge 1
                                       └── POST /control ──► Cloudflare Edge 1
```

All four edge platforms accept identical `ControlCommand` JSON:

```json
{"type": "set_priorities", "region": "us-east", "priorities": ["cdn-b", "cdn-a"], "generation": 1, "ttl_override": 15}
{"type": "exclude_pathway", "region": null, "pathway": "cdn-c", "generation": 2}
{"type": "clear_overrides", "region": null, "generation": 3}
```

Region-scoped commands only propagate to edge instances registered for that region. Instances with null region only receive unscoped (global) commands.

## Priority Calculation

The priority engine scores each CDN with a weighted composite:

```
score = W_urgency * contract_urgency
      + W_cost    * cost_efficiency
      + W_base    * base_weight
```

Default weights: `contract_urgency=0.50`, `cost_efficiency=0.35`, `base_weight=0.15`.

### Contract Urgency (0–100)

Measures how far behind a CDN is on its minimum commit for the current contract period. A CDN at 30% of its commit when 80% of the period has elapsed gets a high urgency score, boosting it in the priority list so traffic gets routed there to meet the commitment.

```
urgency = max(0, (period_elapsed_pct - commit_pct) * 100)
```

### Cost Efficiency (0–100)

Inverse of effective cost per GB, normalized against the maximum observed cost. Within-commit traffic gets a 50% discount on the base `cost_per_gb`. CDNs that have exhausted their burst allowance get `Infinity` cost (effectively excluded).

### Base Weight (0–100)

Operator-assigned traffic weight normalized to 0–100 scale.

## COGS Optimization

The COGS module (`cogs.ts`) computes the effective cost per GB for each CDN considering contract state:

| State | Effective Cost |
|-------|---------------|
| Within commit (below `min_commit_gb`) | `cost_per_gb * 0.5` |
| Above commit, within burst | `burst_cost_per_gb` |
| Burst exhausted | `Infinity` (excluded) |
| No contract | `cost_per_gb` |

## Edge Fleet Management

Edge instances self-register via `POST /fleet/register` with their platform type, control URL, and optional region. The master maintains a fleet registry and fans out commands using `Promise.allSettled` with a 5-second timeout per instance.

Supported platforms: `akamai`, `cloudfront`, `cloudflare`, `fastly`.

## Generation Counter

A monotonically increasing counter shared across all command types. Each `POST /priorities`, `POST /exclude`, or `POST /clear` increments the counter. Edge servers use this to discard stale commands that arrive out of order.

## Data Model

```
AppState
├── CdnRegistry       Map of CDN providers with pricing and regions
├── CommitTracker      Contract definitions + per-period usage tracking
├── EdgeFleet          Registered edge instances
└── generation         Monotonic command counter
```

All state is in-memory. Persistence (database, config files) is a future concern — the current implementation focuses on correct logic and edge compatibility.

## Testing Strategy

The test suite is structured in three tiers:

### Unit Tests (130 tests)
Each module has dedicated tests covering happy paths, edge cases, and boundary conditions:
- **types** (16) — JSON serialization matching Rust serde, `defaultSessionState`, roundtrips
- **cdn** (11) — registry lookups, region filtering, `defaultPricingTier`
- **contracts** (23) — all helper functions, `periodElapsedPct`, null burst, zero commit, `CommitTracker`
- **fleet** (11) — registration, deregistration, platform parsing, null region handling
- **priority** (21) — scoring components, custom weights, burst exhausted urgency
- **cogs** (15) — effective cost calculation, mixed contract states, unlimited burst
- **sessions** (7) — `SessionState` generation, fallback behavior
- **state** (8) — `AppState` construction, generation counter monotonicity

### Integration Tests (81 tests)
- **app** (24) — HTTP API endpoints, CORS, validation, region-scoped commands
- **propagation** (12) — fan-out to mock edge servers, partial failures, concurrent platforms
- **edge-compat** (25) — wire protocol compatibility with `apex-edge-steering`:
  - Exact field sets per command variant (no extra/missing fields)
  - `serde(tag = "type")` discriminated union format
  - `Option<String>` null handling, `Vec<(String, u64)>` tuple arrays
  - Base64/base64url roundtrip for `_ss` manifest parameter
  - Live propagation to simulated edge server validating raw JSON
  - Cross-platform command identity (all 4 platforms receive identical payloads)
- **integration** (32) — full master→edge lifecycle:
  - Contract-aware session init (behind-pace boost, met-commit no boost)
  - 10-step lifecycle (register → priorities → session → exclude → clear → status → deregister)
  - Multi-region fleet (global vs scoped propagation)
  - SessionState field validation against edge Rust expectations
  - Propagation result structure verification

### E2E Tests
Cross-system E2E tests are in `e2e/src/tests/` (vitest). See root `README.md` for details.
