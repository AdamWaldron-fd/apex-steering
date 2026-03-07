// ─── Edge Platform ───────────────────────────────────────────────────────────

/**
 * The compute platform where edge steering WASM runs.
 * This is NOT the CDN provider — it's where the steering logic executes.
 */
export type EdgePlatformKind = "akamai" | "cloudfront" | "cloudflare" | "fastly";

const VALID_PLATFORMS: EdgePlatformKind[] = [
  "akamai",
  "cloudfront",
  "cloudflare",
  "fastly",
];

export function parseEdgePlatform(s: string): EdgePlatformKind | undefined {
  const lower = s.toLowerCase() as EdgePlatformKind;
  return VALID_PLATFORMS.includes(lower) ? lower : undefined;
}

// ─── Edge Instance ───────────────────────────────────────────────────────────

/**
 * A single edge steering server instance running on a CDN platform.
 *
 * The master pushes ControlCommand JSON to each instance via POST /control
 * at the control_url. All four platforms accept the identical JSON body.
 */
export interface EdgeInstance {
  /** Unique instance identifier (UUID). */
  id: string;
  /** Which edge compute platform this runs on. */
  platform: EdgePlatformKind;
  /** Full URL for pushing control commands. */
  control_url: string;
  /** Optional region this instance serves. */
  region: string | null;
  /** When this instance was last seen healthy (ISO 8601). */
  last_seen: string;
  /** Whether this instance is considered healthy. */
  healthy: boolean;
}

// ─── Edge Fleet ──────────────────────────────────────────────────────────────

/** Registry of all known edge steering server instances. */
export class EdgeFleet {
  instances: EdgeInstance[] = [];

  /** Register a new edge instance. Returns the assigned ID. */
  register(instance: EdgeInstance): string {
    this.instances.push(instance);
    return instance.id;
  }

  /** Remove an edge instance by ID. Returns true if found and removed. */
  deregister(id: string): boolean {
    const before = this.instances.length;
    this.instances = this.instances.filter((i) => i.id !== id);
    return this.instances.length < before;
  }

  /** Get all healthy instances, optionally filtered by region. */
  healthyInstances(region?: string | null): EdgeInstance[] {
    return this.instances.filter((i) => {
      if (!i.healthy) return false;
      if (region && i.region !== region) return false;
      return true;
    });
  }

  /** Get all instances for a specific platform. */
  byPlatform(platform: EdgePlatformKind): EdgeInstance[] {
    return this.instances.filter((i) => i.platform === platform);
  }

  /** Get an instance by ID. */
  get(id: string): EdgeInstance | undefined {
    return this.instances.find((i) => i.id === id);
  }
}
