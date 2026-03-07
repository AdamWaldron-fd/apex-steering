import { CdnRegistry } from "./cdn.js";
import { CommitTracker } from "./contracts.js";
import { EdgeFleet } from "./fleet.js";

// ─── Application State ──────────────────────────────────────────────────────

/**
 * Shared application state.
 *
 * Unlike the edge steering server (stateless), the main steering server
 * maintains state: CDN registry, contract usage, edge fleet, and a
 * monotonically increasing generation counter for control commands.
 */
export class AppState {
  /** Registry of configured CDN providers. */
  cdnRegistry: CdnRegistry;

  /** Contract tracking for commit management. */
  commitTracker: CommitTracker;

  /** Registry of edge steering server instances. */
  fleet: EdgeFleet;

  /** Monotonically increasing generation counter for control commands. */
  private _generation: number;

  constructor(
    cdnRegistry?: CdnRegistry,
    commitTracker?: CommitTracker,
    fleet?: EdgeFleet,
  ) {
    this.cdnRegistry = cdnRegistry ?? new CdnRegistry();
    this.commitTracker = commitTracker ?? new CommitTracker();
    this.fleet = fleet ?? new EdgeFleet();
    this._generation = 0;
  }

  /** Get the current generation number. */
  get generation(): number {
    return this._generation;
  }

  /** Increment and return the next generation number. */
  nextGeneration(): number {
    this._generation++;
    return this._generation;
  }
}
