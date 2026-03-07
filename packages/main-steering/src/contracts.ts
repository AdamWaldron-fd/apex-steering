// ─── Contract ────────────────────────────────────────────────────────────────

/** A contract with a CDN provider specifying minimum commit volumes and pricing. */
export interface Contract {
  /** Which CDN provider this contract covers (matches CdnProvider.id). */
  cdn_id: string;
  /** Start of the contract billing period (ISO 8601). */
  period_start: string;
  /** End of the contract billing period (ISO 8601). */
  period_end: string;
  /** Minimum committed volume in GB for this period. */
  min_commit_gb: number;
  /** Maximum burst volume in GB (null = unlimited above commit). */
  max_burst_gb: number | null;
}

// ─── Contract Usage ──────────────────────────────────────────────────────────

/** Tracks how much traffic has been delivered against a contract. */
export interface ContractUsage {
  cdn_id: string;
  period_start: string;
  /** Total delivered traffic in GB this period. */
  delivered_gb: number;
}

/** How many GB remain to meet the minimum commit. */
export function commitRemainingGb(
  usage: ContractUsage,
  contract: Contract,
): number {
  return Math.max(0, contract.min_commit_gb - usage.delivered_gb);
}

/** Percentage of minimum commit delivered (0.0 to 1.0+). */
export function commitPct(usage: ContractUsage, contract: Contract): number {
  if (contract.min_commit_gb <= 0) return 1.0;
  return usage.delivered_gb / contract.min_commit_gb;
}

/** Whether the minimum commit has been met. */
export function commitMet(usage: ContractUsage, contract: Contract): boolean {
  return usage.delivered_gb >= contract.min_commit_gb;
}

/** Whether the burst ceiling has been reached. */
export function burstExhausted(
  usage: ContractUsage,
  contract: Contract,
): boolean {
  if (contract.max_burst_gb === null) return false;
  return usage.delivered_gb >= contract.min_commit_gb + contract.max_burst_gb;
}

/** How far through the billing period we are (0.0 to 1.0). */
export function periodElapsedPct(contract: Contract, now: Date): number {
  const start = new Date(contract.period_start).getTime();
  const end = new Date(contract.period_end).getTime();
  const total = end - start;
  if (total <= 0) return 1.0;
  const elapsed = now.getTime() - start;
  return Math.min(1.0, Math.max(0.0, elapsed / total));
}

/** Whether we're behind pace on the commit. */
export function behindPace(
  usage: ContractUsage,
  contract: Contract,
  now: Date,
): boolean {
  const elapsed = periodElapsedPct(contract, now);
  const fulfilled = commitPct(usage, contract);
  return fulfilled < elapsed;
}

// ─── Commit Tracker ──────────────────────────────────────────────────────────

/** Tracks contract usage across all CDN providers. */
export class CommitTracker {
  contracts: Contract[];
  usage: ContractUsage[];

  constructor(contracts: Contract[] = [], usage: ContractUsage[] = []) {
    this.contracts = contracts;
    this.usage = usage;
  }

  /** Get the active contract for a CDN (the one whose period contains `now`). */
  activeContract(cdnId: string, now: Date): Contract | undefined {
    return this.contracts.find((c) => {
      if (c.cdn_id !== cdnId) return false;
      const start = new Date(c.period_start).getTime();
      const end = new Date(c.period_end).getTime();
      return now.getTime() >= start && now.getTime() < end;
    });
  }

  /** Get current usage for a CDN. */
  currentUsage(cdnId: string): ContractUsage | undefined {
    return this.usage.find((u) => u.cdn_id === cdnId);
  }

  /** Record delivered traffic for a CDN. */
  recordDelivery(cdnId: string, gb: number): void {
    const existing = this.usage.find((u) => u.cdn_id === cdnId);
    if (existing) {
      existing.delivered_gb += gb;
    } else {
      this.usage.push({
        cdn_id: cdnId,
        period_start: new Date().toISOString(),
        delivered_gb: gb,
      });
    }
  }
}
