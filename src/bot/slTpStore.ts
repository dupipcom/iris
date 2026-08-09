/**
 * In-memory store of SL/TP levels per position, keyed by
 * `${symbol}:${positionType}` so a hedge-mode account can hold BOTH a LONG
 * and a SHORT on the same symbol and each keeps its own SL/TP (and fill order
 * ID). Populated by the bot when an order is placed and read by the summary
 * monitor to evaluate the >50%-toward-SL / >50%-toward-TP alert threshold and
 * to estimate the TP/SL P&L shown in the summary.
 *
 * Entries are removed:
 *   - immediately when the position closes (via `remove()` called by the PNL monitor)
 *   - lazily pruned when older than `retentionDays` (as a safety net, called from
 *     the summary monitor's sample cycle)
 */
export class SlTpStore {
  private map = new Map<string, SlTpEntry>();

  private static keyOf(symbol: string, positionType: 1 | 2): string {
    return `${symbol}:${positionType}`;
  }

  /**
   * Store an entry. Two calling conventions are supported:
   *   set(symbol, positionType, entry)   — explicit direction (recommended)
   *   set(symbol, entry)                 — legacy; direction read from entry.positionType
   */
  set(symbol: string, positionType: 1 | 2, entry: SlTpInput): void;
  set(symbol: string, entry: SlTpEntry): void;
  set(symbol: string, positionType: 1 | 2 | SlTpEntry, entry?: SlTpInput): void {
    let pt: 1 | 2;
    let e: SlTpEntry;
    if (typeof positionType === "number") {
      pt = positionType as 1 | 2;
      e = { ...entry!, positionType: pt, symbol };
    } else {
      e = positionType; // legacy 2-arg form
      pt = e.positionType;
      e = { ...e, symbol };
    }
    this.map.set(SlTpStore.keyOf(symbol, pt), e);
  }

  /**
   * Get the SL/TP for a specific position direction.
   * get(symbol, positionType) — recommended.
   * get(symbol)               — legacy best-effort: returns the first entry for
   *                             the symbol (undefined if you don't say which).
   */
  get(symbol: string, positionType?: 1 | 2): SlTpEntry | undefined {
    if (positionType !== undefined) {
      return this.map.get(SlTpStore.keyOf(symbol, positionType));
    }
    for (const k of this.map.keys()) {
      if (k.startsWith(`${symbol}:`)) return this.map.get(k);
    }
    return undefined;
  }

  /**
   * Remove an entry. remove(symbol, positionType) removes one direction;
   * remove(symbol) removes every direction for the symbol (full close).
   */
  remove(symbol: string, positionType?: 1 | 2): void {
    if (positionType !== undefined) {
      this.map.delete(SlTpStore.keyOf(symbol, positionType));
    } else {
      this.removeSymbol(symbol);
    }
  }

  /**
   * Remove every position direction for a symbol (used when the whole position
   * is closed).
   */
  removeSymbol(symbol: string): void {
    const prefix = `${symbol}:`;
    for (const k of Array.from(this.map.keys())) {
      if (k.startsWith(prefix)) this.map.delete(k);
    }
  }

  /**
   * Get all entries as [compositeKey, entry] pairs where compositeKey is
   * `${symbol}:${positionType}`. Use `entry.symbol` / `entry.positionType`
   * rather than parsing the key.
   */
  entries(): IterableIterator<[string, SlTpEntry]> {
    return this.map.entries();
  }

  /**
   * Prune entries whose `setAt` timestamp is older than `maxAgeMs` milliseconds.
   * Called periodically from the summary monitor to prevent unlimited growth of
   * stale entries for positions that closed without triggering the onClose hook.
   */
  pruneStale(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [symbol, entry] of this.map) {
      if (entry.setAt < cutoff) {
        this.map.delete(symbol);
      }
    }
  }

  get size(): number {
    return this.map.size;
  }
}

export interface SlTpEntry {
  /** Contract symbol (e.g. "BTC_USDT"). */
  symbol?: string;
  /** Stop-loss price */
  sl: number;
  /** Take-profit price (nearest target for multi-TP signals, or furthest target when splitMultiTp is disabled) */
  tp: number;
  /** Position direction: 1 = long, 2 = short */
  positionType: 1 | 2;
  /** Unix ms when the entry was stored, used for retention-based pruning. */
  setAt: number;
  /** Fill order ID — use this for CLOSE / REVERSE / ADD TO commands. */
  orderId?: string;
  /**
   * All TP targets for this position, sorted closest-to-furthest from entry.
   * When splitMultiTp is disabled, the monitor uses this to detect
   * intermediate TP hits and trigger partial closes. The last element is the
   * TP actually attached to the order (furthest target). Empty/non-existent
   * for single-TP signals or when multi-TP splitting is enabled.
   */
  allTpTargets?: number[];
}

/** Entry accepted by `set(symbol, positionType, entry)` — direction/symbol added internally. */
export type SlTpInput = Omit<SlTpEntry, "positionType" | "symbol">;
