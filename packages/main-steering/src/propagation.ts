import type { EdgeFleet, EdgeInstance } from "./fleet.js";
import type {
  ControlCommand,
  PropagationFailure,
  PropagationResult,
} from "./types.js";

// ─── Edge Fleet Propagation ──────────────────────────────────────────────────

/** Timeout for individual edge pushes in milliseconds. */
const PUSH_TIMEOUT_MS = 5000;

/**
 * Fan-out a ControlCommand to all matching edge instances.
 *
 * Pushes concurrently using Promise.all. Each push is a POST /control
 * with the ControlCommand JSON body — identical across all four platforms
 * (Akamai, CloudFront, Cloudflare, Fastly).
 */
export async function propagateCommand(
  fleet: EdgeFleet,
  command: ControlCommand,
  region?: string | null,
): Promise<PropagationResult> {
  const targets = fleet.healthyInstances(region ?? undefined);

  if (targets.length === 0) {
    return {
      generation: command.generation,
      propagated: 0,
      failed: 0,
      failures: [],
    };
  }

  const results = await Promise.allSettled(
    targets.map((instance) => pushToInstance(instance, command)),
  );

  let propagated = 0;
  const failures: PropagationFailure[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const instance = targets[i];
    if (result.status === "fulfilled") {
      propagated++;
    } else {
      failures.push({
        instance_id: instance.id,
        control_url: instance.control_url,
        error: result.reason?.message || "unknown error",
      });
    }
  }

  return {
    generation: command.generation,
    propagated,
    failed: failures.length,
    failures,
  };
}

/**
 * Push a ControlCommand to a single edge instance.
 * Throws on HTTP error or timeout.
 */
async function pushToInstance(
  instance: EdgeInstance,
  command: ControlCommand,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

  try {
    const response = await fetch(instance.control_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${response.status} from ${instance.id}: ${body}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}
