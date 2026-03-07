const MAIN_URL = process.env.MAIN_URL ?? "http://localhost:4444";
const EDGE_URL = process.env.EDGE_URL ?? "http://localhost:3077";

// ─── HTTP Helpers ───────────────────────────────────────────────

export async function get<T = unknown>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GET ${url} → ${resp.status}`);
  return resp.json() as Promise<T>;
}

export async function post<T = unknown>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`POST ${url} → ${resp.status}`);
  return resp.json() as Promise<T>;
}

export async function getText(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GET ${url} → ${resp.status}`);
  return resp.text();
}

// ─── Types (wire-compatible across all 3 projects) ──────────────

export interface SessionState {
  priorities: string[];
  throughput_map: [string, number][];
  min_bitrate: number;
  max_bitrate: number;
  duration: number;
  position: number;
  timestamp: number;
  override_gen: number;
}

export interface PathwayMapping {
  pathway_id: string;
  base_url: string;
}

export interface ManifestUpdateRequest {
  session_state: SessionState;
  pathways: PathwayMapping[];
  steering_uri: string;
}

export interface SteeringResponse {
  VERSION: number;
  TTL: number;
  "RELOAD-URI"?: string;
  "PATHWAY-PRIORITY"?: string[];
  "SERVICE-LOCATION-PRIORITY"?: string[];
}

// ─── Main Steering Client ───────────────────────────────────────

export const main = {
  url: MAIN_URL,

  async health(): Promise<boolean> {
    try {
      await get(`${MAIN_URL}/health`);
      return true;
    } catch {
      return false;
    }
  },

  async sessionInit(params: {
    cdns: string;
    steering_uri: string;
    region?: string;
    min_bitrate?: number;
    max_bitrate?: number;
    duration?: number;
  }): Promise<ManifestUpdateRequest> {
    const qs = new URLSearchParams();
    qs.set("cdns", params.cdns);
    qs.set("steering_uri", params.steering_uri);
    if (params.region) qs.set("region", params.region);
    if (params.min_bitrate != null) qs.set("min_bitrate", String(params.min_bitrate));
    if (params.max_bitrate != null) qs.set("max_bitrate", String(params.max_bitrate));
    if (params.duration != null) qs.set("duration", String(params.duration));
    return get(`${MAIN_URL}/session/init?${qs}`);
  },

  async setPriorities(body: {
    region?: string | null;
    priorities: string[];
    ttl_override?: number;
  }) {
    return post(`${MAIN_URL}/priorities`, body);
  },

  async exclude(body: { pathway: string; region?: string | null }) {
    return post(`${MAIN_URL}/exclude`, body);
  },

  async clear() {
    return post(`${MAIN_URL}/clear`, {});
  },

  async registerFleet(body: {
    platform: string;
    control_url: string;
    region?: string;
  }) {
    return post(`${MAIN_URL}/fleet/register`, body);
  },

  async deregisterFleet(id: string) {
    const resp = await fetch(`${MAIN_URL}/fleet/${id}`, { method: "DELETE" });
    if (!resp.ok) throw new Error(`DELETE /fleet/${id} → ${resp.status}`);
    return resp.json();
  },

  async status() {
    return get(`${MAIN_URL}/status`);
  },
};

// ─── Edge Steering Client ───────────────────────────────────────

export const edge = {
  url: EDGE_URL,

  async health(): Promise<boolean> {
    try {
      await get(`${EDGE_URL}/health`);
      return true;
    } catch {
      return false;
    }
  },

  async steerHls(params: {
    _ss: string;
    _HLS_pathway?: string;
    _HLS_throughput?: number;
    extraParams?: Record<string, string>;
  }): Promise<SteeringResponse> {
    const qs = new URLSearchParams();
    qs.set("_ss", params._ss);
    if (params._HLS_pathway) qs.set("_HLS_pathway", params._HLS_pathway);
    if (params._HLS_throughput != null) qs.set("_HLS_throughput", String(params._HLS_throughput));
    if (params.extraParams) {
      for (const [k, v] of Object.entries(params.extraParams)) qs.set(k, v);
    }
    return get(`${EDGE_URL}/steer/hls?${qs}`);
  },

  async steerDash(params: {
    _ss: string;
    _DASH_pathway?: string;
    _DASH_throughput?: number;
    extraParams?: Record<string, string>;
  }): Promise<SteeringResponse> {
    const qs = new URLSearchParams();
    qs.set("_ss", params._ss);
    if (params._DASH_pathway) qs.set("_DASH_pathway", params._DASH_pathway);
    if (params._DASH_throughput != null) qs.set("_DASH_throughput", String(params._DASH_throughput));
    if (params.extraParams) {
      for (const [k, v] of Object.entries(params.extraParams)) qs.set(k, v);
    }
    return get(`${EDGE_URL}/steer/dash?${qs}`);
  },

  /** Follow a RELOAD-URI with optional client params appended. */
  async followReloadUri(
    reloadUri: string,
    clientParams?: Record<string, string | number>,
  ): Promise<SteeringResponse> {
    const url = new URL(reloadUri, EDGE_URL);
    if (clientParams) {
      for (const [k, v] of Object.entries(clientParams)) {
        url.searchParams.set(k, String(v));
      }
    }
    return get(url.toString());
  },

  /**
   * Dev-only: store initial state on edge as fallback for requests without _ss.
   * NOT used in production — the manifest-updater encodes _ss into the manifest.
   * Only useful for dev/test scenarios (DASH queryBeforeStart without manifest).
   */
  async storeInitialState(state: SessionState): Promise<string> {
    const resp = await post<{ encoded: string }>(`${EDGE_URL}/encode-state`, state);
    return resp.encoded ?? (resp as unknown as string);
  },

  async control(command: unknown) {
    return post(`${EDGE_URL}/control`, command);
  },

  async reset() {
    return post(`${EDGE_URL}/reset`, {});
  },
};

// ─── Utility ────────────────────────────────────────────────────

/** Extract the _ss= value from a steered manifest's SERVER-URI or ContentSteering URL. */
export function extractSsFromManifest(manifest: string): string {
  const match = manifest.match(/_ss=([^"&\s]+)/);
  if (!match) throw new Error("No _ss= parameter found in manifest");
  return match[1];
}

/** Decode a base64url _ss parameter into a SessionState object. */
export function decodeSs(encoded: string): SessionState {
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64url").toString());
}
