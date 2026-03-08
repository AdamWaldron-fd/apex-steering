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

## Documentation

### Architecture documentation suite

**Status**: Not started

Create a comprehensive documentation set covering the full content steering system. The top-level `docs/` directory should contain high-level overviews, with each module linking to its own `docs/` folder for detailed internals.

#### Top-level docs (`docs/`)

- **System overview** — What content steering is, how the components fit together (main-steering → edge-steering ← manifest-updater), request/response flow diagrams
- **Benefits of CDN traffic control** — Cost optimization (contract commitments, COGS), quality-of-experience improvements, disaster recovery, regional failover, A/B testing CDN performance
- **Current level of control** — What operators can do today: priority reordering, pathway exclusion, override clearing, fleet-wide propagation, contract-aware scoring, QoE-based demotion
- **Future granular control possibilities** — Per-session steering policies, real-time ABR-aware decisions, geo-IP + latency-based routing, predictive cost modeling, per-title/per-bitrate CDN selection, audience segmentation, gradual traffic migration (canary CDN rollouts)
- **Module summaries** with links to per-module docs:
  - [Main Steering](../packages/main-steering/docs/) — Control plane, CDN scoring, fleet management
  - [Edge Steering](../crates/edge-steering/docs/) — Stateless edge decisions, QoE demotion, override handling
  - [Manifest Updater](../crates/manifest-updater/docs/) — HLS/DASH manifest transformation, pathway cloning

#### Per-module docs

Each module gets a `docs/` directory with:

- **Architecture deep-dive** — Internal component diagram, data flow, key structs/types, state management
- **Architecture diagrams** — ASCII or Mermaid diagrams showing request paths, state transitions, decision trees
- **Testing strategy** — Unit test coverage, integration test approach, E2E test scenarios, fixture design
- **Wire protocol details** — Session state encoding, control command format, response schema

**Locations**:
- `docs/overview.md` — System overview + benefits + control levels
- `packages/main-steering/docs/architecture.md` — Main-steering deep-dive (update existing)
- `crates/edge-steering/docs/architecture.md` — Edge-steering deep-dive (create)
- `crates/manifest-updater/docs/architecture.md` — Manifest-updater deep-dive (create)

## Integration

### Cookie-based CDN token compatibility analysis

**Status**: Not started
**Priority**: High — required before production deployment

Analyze the current cookie-based token storage scheme used by Fandango at Home and ensure apex-steering can execute content steering while preserving CDN authentication.

#### Background

Fandango at Home currently uses cookie-based tokenization for CDN content protection. The token generation and URL customization logic lives in two repositories:

- **[director2-aws](https://github.com/fandango/director2-aws)** — `director2/suite/media2/src/com/vudu/dir/op/media/EditionLocationCustomizer*.java`
  - `EditionLocationCustomizer` and related classes handle per-edition CDN URL construction
  - Generates auth tokens (start time, end time, userId, hash) and attaches them to content URLs
  - Determines which CDN location/origin to use for a given edition (title)
  - May embed tokens as query parameters or cookies depending on CDN provider

- **[fd-cloudfront-function](https://github.com/fandango/fd-cloudfront-function)** — CloudFront Function(s) that validate cookie-based tokens at the edge
  - Runs on CloudFront viewer-request or origin-request events
  - Validates signed cookies (CloudFront signed cookies or custom cookie auth)
  - Controls access to media segments based on cookie token validity

#### Key questions to answer

1. **Cookie scope vs. pathway switching** — When the player switches pathways (CDN origins), do cookies set for `cdn-a.example.com` get sent to `cdn-b.example.com`? Cookie domain restrictions may prevent cross-CDN token reuse. Determine if each CDN pathway needs its own cookie token or if a shared domain/wildcard approach is possible.

2. **Token lifetime vs. steering TTL** — Cookie tokens have a validity window (`start`/`end`). Steering decisions happen on a 300s (normal) or 10s (QoE) cycle. If a player is steered to a new CDN mid-session, does it have a valid cookie for that CDN? Or does steering need to trigger token refresh?

3. **Manifest-updater impact** — When cloning variants per pathway, each pathway's URIs point to different CDN origins. If cookies are domain-scoped, the browser will only send the appropriate cookie to the matching CDN. Verify that:
   - HLS: media segment URIs under each pathway resolve to a domain the player has cookies for
   - DASH: `<BaseURL>` elements per pathway use domains with valid cookie tokens

4. **EditionLocationCustomizer integration point** — Currently `EditionLocationCustomizer` picks a single CDN location per edition. With content steering, we need it to return *all* CDN locations (pathways) with tokens for each, so the manifest-updater can construct multi-pathway manifests. Determine the required changes to `EditionLocationCustomizer` to support multi-CDN token generation.

5. **CloudFront Function compatibility** — If using CloudFront signed cookies, the signing key pair is tied to a specific CloudFront distribution. Steering between CloudFront and another CDN (Akamai) means different token mechanisms. Map out which CDN uses which token scheme:
   - CloudFront: signed cookies (CloudFront key pairs)
   - Akamai: EdgeAuth tokens (query params or cookies)
   - Others: TBD

6. **Session init token bundling** — Can main-steering's `/session/init` response include pre-generated tokens for all pathways? The origin (director2) would need to generate tokens for every CDN at session start, not just the primary CDN.

#### Potential approaches

**A. Pre-generate tokens for all pathways at session init**
- `EditionLocationCustomizer` generates tokens for all CDN providers, not just the selected one
- Tokens included in `ManifestUpdateRequest` and embedded in per-pathway URIs by manifest-updater
- Pros: no runtime token negotiation, works with existing player behavior
- Cons: tokens for unused CDNs are wasted, token lifetime must cover entire session

**B. Token refresh on pathway switch via steering URI**
- Edge-steering response includes `PATHWAY-CLONES` (per HLS spec) or equivalent with fresh tokens per pathway
- Player uses tokens from steering response when switching CDNs
- Pros: tokens are always fresh, minimal wasted tokens
- Cons: requires player support for `PATHWAY-CLONES`, adds complexity to edge-steering

**C. Shared token domain with CDN-specific subpaths**
- All CDN pathways served under a common domain (e.g., `media.fandango.com`) with path-based routing
- Single cookie covers all pathways since same domain
- Pros: simplest cookie handling, no per-CDN token issues
- Cons: requires DNS/routing infrastructure changes, may not work with existing CDN contracts

**D. Cookie relay via steering endpoint**
- Steering RELOAD-URI response sets cookies for all pathway domains
- Uses `Set-Cookie` with appropriate `Domain` attributes
- Pros: tokens refreshed every steering cycle
- Cons: cross-origin cookie restrictions (SameSite, third-party cookie policies), browser compat issues

#### Action items

1. **Audit `EditionLocationCustomizer*.java`** — Document the exact token generation flow: what parameters are signed, how cookies are set, cookie domain/path/expiry, per-CDN differences
2. **Audit `fd-cloudfront-function`** — Document the validation logic: what cookie fields are checked, how expiry is enforced, error handling for missing/expired cookies
3. **Map token scheme per CDN** — Create a matrix: CDN provider × token mechanism (cookie vs. query param) × domain scope × lifetime
4. **Prototype multi-pathway token generation** — Modify `EditionLocationCustomizer` to return tokens for all configured CDNs, measure token generation overhead
5. **Browser cookie testing** — Verify cookie behavior when player switches between CDN domains: are cookies sent correctly? Do SameSite policies block them?
6. **Generate detailed implementation plan** — Based on findings from steps 1-5, produce a detailed implementation prompt covering:
   - Required changes to director2-aws (EditionLocationCustomizer)
   - Required changes to fd-cloudfront-function (if any)
   - Required changes to apex-steering (main-steering session init, manifest-updater URI construction, edge-steering token relay)
   - Migration strategy (backward-compatible rollout)
   - Test plan (E2E with real token validation)

#### References

- `director2-aws` — `director2/suite/media2/src/com/vudu/dir/op/media/EditionLocationCustomizer*.java`
- `fd-cloudfront-function` — CloudFront Function for cookie token validation
- Current apex-steering token passthrough: `e2e/src/tests/tokens.test.ts` (query param tokens only)
- HLS Content Steering `PATHWAY-CLONES`: RFC 8216bis Section 7.2

## Sandbox

### Automated content packaging

- Script to download and package Big Buck Bunny CMAF into `test/cdna/`, `test/cdnb/`, `test/cdnc/`
- CI job to verify sandbox functionality with packaged content
