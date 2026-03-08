# Apex Steering Roadmap

Tracked items for future work across the monorepo.

## Edge Steering

### Remove SERVICE-LOCATION-PRIORITY from DASH responses

**Status**: Pending confirmation
**Location**: `crates/edge-steering/src/types.rs` — `SteeringResponse.service_location_priority`

`SERVICE-LOCATION-PRIORITY` was from an early DASH Content Steering draft. The final CTA-5004 spec and dash.js both use `PATHWAY-PRIORITY` for DASH (same field name as HLS). We currently return both fields in DASH steering responses for backward compatibility.

**Action**: Once we confirm no deployed players depend on `SERVICE-LOCATION-PRIORITY`, remove the field entirely:
1. Remove `service_location_priority` from `SteeringResponse` in `types.rs`
2. Update `SteeringResponse::new()` to only set `pathway_priority` for both HLS and DASH
3. Update `response.rs` `build_response()` — remove the `Protocol::Dash` branch that reads `service_location_priority`
4. Update Rust unit tests (`policy.rs`, `response.rs`) and integration tests
5. Update E2E `dash-session.test.ts` — remove `SERVICE-LOCATION-PRIORITY` assertions
6. Update `e2e/src/helpers/api.ts` — remove `SERVICE-LOCATION-PRIORITY` from `SteeringResponse` type

**Validation**: Check production DASH player integrations (dash.js, Shaka Player, ExoPlayer) to confirm none depend on the old field name.

## Manifest Updater

### DASH BaseURL placement

**Status**: Working, review optional
**Location**: `crates/manifest-updater/src/dash/mod.rs` — `inject_base_urls()`

Currently `<BaseURL serviceLocation="...">` elements are injected inside each `<AdaptationSet>`. Per DASH-IF IOP, Period-level placement is more common for Content Steering (ensures all AdaptationSets share the same CDN selection). Both placements are valid per ISO 23009-1 and work with dash.js.

**Action**: Consider moving BaseURL injection to Period level if any player has issues with AdaptationSet-level placement.

## Main Steering

### Production hardening

- Rate limiting on `/session/init` and `/providers` endpoints
- Authentication for fleet management endpoints (`/fleet/register`, `/fleet/:id`)
- Persistent storage for contracts and fleet registry (currently in-memory only)
- Metrics export (Prometheus/OpenTelemetry) for generation counter, propagation latency, fleet health

### Multi-region deployment

- Support for main-steering replicas with shared state (Redis, DynamoDB)
- Generation counter synchronization across replicas
- Regional failover for fleet propagation

## Sandbox

### Automated content packaging

- Script to download and package Big Buck Bunny CMAF into `test/cdna/`, `test/cdnb/`, `test/cdnc/`
- CI job to verify sandbox functionality with packaged content
