// Re-exports for external consumers and tests.
export { createApp } from "./app.js";
export { AppState } from "./state.js";
export { CdnRegistry, type CdnProvider, type PricingTier } from "./cdn.js";
export {
  CommitTracker,
  type Contract,
  type ContractUsage,
  commitPct,
  commitMet,
  commitRemainingGb,
  burstExhausted,
  behindPace,
  periodElapsedPct,
} from "./contracts.js";
export {
  EdgeFleet,
  type EdgeInstance,
  type EdgePlatformKind,
  parseEdgePlatform,
} from "./fleet.js";
export {
  calculatePriorities,
  scoreCdn,
  DEFAULT_WEIGHTS,
  type PriorityInput,
  type PriorityScore,
  type PriorityWeights,
} from "./priority.js";
export {
  estimateCosts,
  cheapestFirst,
  type CostEstimate,
} from "./cogs.js";
export { buildSessionState, buildManifestUpdateRequest, type SessionInitInput } from "./sessions.js";
export { propagateCommand } from "./propagation.js";
export type {
  SessionState,
  ControlCommand,
  SetPrioritiesCommand,
  ExcludePathwayCommand,
  ClearOverridesCommand,
  PropagationResult,
  PropagationFailure,
  PathwayMapping,
  ManifestUpdateRequest,
} from "./types.js";
export { defaultSessionState } from "./types.js";
