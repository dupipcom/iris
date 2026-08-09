import * as fs from "fs";
import * as path from "path";
import { MexcFuturesSDK } from "../client";
import { Position } from "../types/account";
import { PlanOrderListResponse, StopOrderListResponse } from "../types/orders";
import { Logger } from "../utils/logger";
import { toFiniteNumber } from "../utils/numbers";
import { AccountSnapshot } from "./pnlMonitor";
import { SlTpStore, SlTpEntry } from "./slTpStore";

/**
 * Shorten a long numeric ID for compact display (e.g. "817027833053397504" → "…397504").
 */
function shortId(id: string, tail = 6): string {
  if (!id) return "—";
  if (id.length <= tail + 1) return id;
  return `…${id.slice(-tail)}`;
}

/** A single unrealized-PNL sample for one position. */
interface PnlSample {
  ts: number;
  pnl: number;
}

/** Rolling per-position state kept between summary emissions. */
interface PositionStats {
  positionId: string;
  symbol: string;
  positionType: 1 | 2;
  openType: 1 | 2;
  leverage: number;
  openAvgPrice: number;
  margin: number;
  samples: PnlSample[];
}

/** An open position with its PNL stats over the summary window. */
export interface OpenPositionSummary {
  positionId: string;
  symbol: string;
  positionType: 1 | 2; // 1 = long, 2 = short
  openType: 1 | 2;
  leverage: number;
  openAvgPrice: number;
  /** Current unrealized PNL in quote currency */
  currentPnl: number;
  /** Highest unrealized PNL observed within the window */
  maxPnl: number;
  /** Lowest unrealized PNL observed within the window */
  minPnl: number;
  /** Initial margin of the position */
  margin: number;
  /** Remaining volume (contracts). */
  holdVol: number;
  /** Realized PNL of the position (net of fees, from MEXC `realised`). */
  realisedPnl: number;
  /** Holding/funding fee accrued on the position (negative = paid, from MEXC `holdFee`). */
  holdFee: number;
  /** Estimated settlement PNL if the position were closed right now (floating PNL + realized PNL). */
  totalPnl: number;
  /** Estimated PNL if the position reaches its TP target (quote currency). */
  estTpPnl?: number;
  /** Estimated PNL if the position hits its SL (quote currency, negative). */
  estSlPnl?: number;
  /** Fraction (0..1+) of the TP-target PNL currently reached via currentPnl. */
  tpProgress?: number;
  /** Fraction (0..1+) of the SL-target PNL currently reached via currentPnl (losing positions). */
  slProgress?: number;
  /** Fill order ID (regular MEXC order ID) — use this for CLOSE/REVERSE/ADD TO commands. */
  fillOrderId?: string;
}

/** A pending order shown as a single line in the summary. */
export interface PendingOrderSummary {
  /** MEXC order ID */
  orderId: string;
  symbol: string;
  /** 1=open long, 2=close short (TP/SL), 3=open short, 4=close long (TP/SL) */
  side: 1 | 2 | 3 | 4;
  /** "STOP" = trigger entry, "TP_SL" = attached take-profit/stop-loss pair. */
  kind: "STOP" | "TP_SL";
  /** 1 = fires when price >= triggerPrice, 2 = fires when price <= triggerPrice (STOP). */
  triggerType: 1 | 2;
  /** Trigger price (STOP). */
  triggerPrice: number;
  /** Take-profit price (TP_SL). */
  takeProfitPrice: number;
  /** Stop-loss price (TP_SL). */
  stopLossPrice: number;
  /** Position direction for TP_SL: 1 = long, 2 = short. */
  positionType: 1 | 2;
  /** Volume (contracts). */
  vol: number;
  /** Leverage (STOP entries). */
  leverage: number;
  /** Open type: 1 = isolated, 2 = cross. */
  openType: 1 | 2;
}

/**
 * An alert fired while sampling when an open position has travelled more than
 * halfway from its entry toward its stop-loss or take-profit level.
 */
export interface PositionAlert {
  positionId: string;
  symbol: string;
  positionType: 1 | 2; // 1 = long, 2 = short
  leverage: number;
  /** Average open (entry) price */
  entry: number;
  /** Current price derived from unrealized PNL */
  currentPrice: number;
  /** Stop-loss price */
  sl: number;
  /** Take-profit price */
  tp: number;
  /** Which level the price is more than 50% of the way toward */
  target: "SL" | "TP";
  /** Fraction of the distance from entry toward the target already covered (0..1+) */
  progress: number;
  /** Current unrealized PNL from MEXC (quote currency, e.g. USDT). */
  pnl: number;
  /** Independently computed PNL from (currentPrice − entry) × holdVol × contractSize. */
  computedPnl: number;
}

/**
 * Daily realized + unrealized PNL figures for the summary, including how the
 * day's total compares to the previous day's (the "tick").
 */
export interface DailyPnlInfo {
  /** UTC date (YYYY-MM-DD) these figures apply to. */
  date: string;
  /** Realized PNL from positions closed that day (net of fees). */
  realized: number;
  /** Current unrealized PNL across all open positions. */
  unrealized: number;
  /** realized + unrealized. */
  total: number;
  /** UTC date (YYYY-MM-DD) of the day used for the tick comparison. */
  prevDate?: string;
  /** total − previous day's total (null when no prior-day data is available). */
  tick: number | null;
}

/** Persisted daily snapshot (one per UTC day) used for day-over-day ticks. */
interface DailyPnlEntry {
  realized: number;
  unrealized: number;
  total: number;
  updatedAt: number;
}

/** Full data payload produced on each summary emission. */
export interface PositionSummary {
  /** Trailing window (hours) over which PNL max/min was tracked */
  windowHours: number;
  /** Reporting cadence (hours) */
  intervalHours: number;
  /** Unix ms when the summary was generated */
  generatedAt: number;
  openPositions: OpenPositionSummary[];
  /** Pending (unfilled) STOP/entry orders, one line each in the summary. */
  pendingOrders: PendingOrderSummary[];
  account: AccountSnapshot;
  /** Today's realized + unrealized PNL and its change vs the previous day. */
  dailyPnl: DailyPnlInfo;
}

/**
 * An alert fired while sampling when an open position's current price has
 * crossed an intermediate take-profit target (not the furthest one). The
 * handler should partially close the position at that TP level.
 */
export interface PartialTpHit {
  positionId: string;
  symbol: string;
  positionType: 1 | 2; // 1 = long, 2 = short
  /** The TP price that was crossed */
  tpPrice: number;
  /** Current market price derived from unrealized PNL */
  currentPrice: number;
  /** All remaining TP targets (including the one just hit). */
  remainingTpTargets: number[];
  /** Index (0-based) of the hit TP within the original allTpTargets array. */
  tpIndex: number;
  /** Total number of TP targets originally. */
  totalTpCount: number;
  /** Fill order ID for the position. */
  orderId?: string;
}

export type OnPartialTpHit = (hit: PartialTpHit) => void;

export type OnPositionSummary = (summary: PositionSummary) => void;

export type OnPositionAlert = (alert: PositionAlert) => void;

export interface PositionSummaryMonitorOptions {
  client: MexcFuturesSDK;
  logger: Logger;
  baseCurrency: string;
  /** How often (seconds) unrealized PNL is sampled to track max/min (min 5) */
  sampleIntervalSeconds: number;
  /** Trailing window (hours) for PNL max/min stats */
  windowHours: number;
  /** How often (hours) the summary is emitted */
  intervalHours: number;
  /** Called each time a summary is ready to be sent */
  onSummary: OnPositionSummary;
  /** SL/TP levels per symbol, populated on order execution, for >50%-of-way alerts. */
  slTpStore: SlTpStore;
  /** Called once per position per target when >50% of the way toward SL/TP. */
  onAlert: OnPositionAlert;
  /**
   * Called when an intermediate TP target is crossed (price beyond the TP
   * level). Only fires for multi-TP signals placed with splitMultiTp disabled,
   * where the order uses the furthest TP and the monitor handles partial
   * closes at intermediate targets.
   */
  onPartialTpHit?: OnPartialTpHit;
  /** Days after which stale SL/TP entries are pruned (default LOG_RETENTION_DAYS). */
  slTpRetentionDays: number;
  /**
   * Optional callback fired after each sample with the active positions.
   * Use this to feed a PositionClosureMonitor externally, avoiding a
   * duplicate open-positions API call.
   */
  onSample?: (positions: Position[]) => void;
  /**
   * Minimum spacing (ms) between each API call during summary generation.
   * Default 0 (no extra spacing — relies on the SDK's token-bucket rate limiter).
   * Set to ORDER_RATE_INTERVAL_MS to guarantee each request is spaced.
   */
  requestSpacingMs?: number;

  /**
   * Called when a new position appears that wasn't previously tracked.
   * Used to detect plan-order triggers so deferred limit TP/SL can be placed.
   * Receives the new Position objects that just appeared.
   */
  onNewPosition?: (positions: Position[]) => void;
}

/**
 * Continuously samples unrealized PNL of every open position (using the
 * `unRealizedPnl` field returned by MEXC's open-positions endpoint) and keeps
 * a rolling max/min per position over a trailing window. On a fixed cadence it
 * assembles a summary of:
 *   - currently open positions + their current / max / min PNL
 *   - the account's available balance and equity
 *
 * Both timers are unref'd so they never keep the process alive on their own.
 */
export class PositionSummaryMonitor {
  private client: MexcFuturesSDK;
  private logger: Logger;
  private baseCurrency: string;
  private windowMs: number;
  private intervalMs: number;
  private sampleIntervalMs: number;
  private onSummary: OnPositionSummary;
  private slTpStore: SlTpStore;
  private slTpRetentionMs: number;
  private onAlert: OnPositionAlert;
  private onPartialTpHit: OnPartialTpHit | undefined;
  private onSample: ((positions: Position[]) => void) | undefined;
  private onNewPosition: ((positions: Position[]) => void) | undefined;
  private requestSpacingMs: number;
  /** Timestamp (ms) of the last API call made by emitSummary / fetchPendingOrders. */
  private lastSummaryApiCall = 0;
  private stats = new Map<string, PositionStats>();
  private sampleTimer: NodeJS.Timeout | null = null;
  private summaryTimer: NodeJS.Timeout | null = null;
  private sampling = false;
  /** Tracks which positions already alerted per target, to avoid repeat alerts. */
  private alerted = new Map<string, { sl: boolean; tp: boolean }>();
  /**
   * Tracks which TP targets have already triggered a partial close.
   * Key: `${symbol}:${positionType}`, value: set of TP prices already hit.
   */
  private partialTpHit = new Map<string, Set<number>>();
  /** Previous unrealized PNL per position, used to compute per-poll deltas for console ticker logging. */
  private prevPnl = new Map<string, number>();
  private pendingOrdersCache: { orders: PendingOrderSummary[]; ts: number } | null = null;
  private readonly PENDING_CACHE_TTL_MS = 30_000; // cache pending orders for 30s to avoid rate limits
  /** Cached contract size (price multiplier) per symbol — used to convert between unrealized PNL and price. */
  private contractSizes = new Map<string, number>();
  /** Daily PNL snapshot per UTC day, persisted to daily-pnl.json in the log dir. */
  private dailyPnlStore: Record<string, DailyPnlEntry> = {};
  private dailyPnlFile: string | null = null;

  constructor(opts: PositionSummaryMonitorOptions) {
    this.client = opts.client;
    this.logger = opts.logger;
    this.baseCurrency = opts.baseCurrency;
    this.sampleIntervalMs = Math.max(opts.sampleIntervalSeconds, 5) * 1000;
    this.windowMs = Math.max(opts.windowHours, 1) * 3600 * 1000;
    this.intervalMs = Math.max(opts.intervalHours, 1) * 3600 * 1000;
    this.onSummary = opts.onSummary;
    this.slTpStore = opts.slTpStore;
    this.onAlert = opts.onAlert;
    this.onPartialTpHit = opts.onPartialTpHit;
    this.onSample = opts.onSample;
    this.onNewPosition = opts.onNewPosition;
    this.requestSpacingMs = Math.max(0, opts.requestSpacingMs ?? 0);
    this.slTpRetentionMs = Math.max(opts.slTpRetentionDays, 1) * 86400_000;
    this.loadStats();
    const logDir = (this.logger as any).logDir as string | null | undefined;
    if (logDir) {
      this.dailyPnlFile = path.join(logDir, "daily-pnl.json");
      this.loadDailyPnl();
    }
  }

  /** Start sampling and schedule summary emissions. */
  start(): void {
    if (this.sampleTimer || this.summaryTimer) return;
    this.logger.info(
      `📊 Position summary monitor started ` +
        `(window ${this.windowMs / 3600000}h, emit every ${this.intervalMs / 3600000}h)`
    );
    void this.sample();
    this.sampleTimer = setInterval(() => void this.sample(), this.sampleIntervalMs);

    this.summaryTimer = setInterval(() => void this.emitSummary(), this.intervalMs);

    this.logger.info(
      `⏱️ Polling timer set: sample every ${this.sampleIntervalMs / 1000}s, ` +
        `summary every ${this.intervalMs / 3600000}h`
    );
  }

  /** Stop both timers, run a final sample + summary flush, and persist stats. */
  async stop(): Promise<void> {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }

    // Final sample and summary so the latest data is logged and persisted
    // before the process exits.
    try {
      this.sampling = false; // reset guard so the final sample can run
      await this.sample();
      await this.emitSummary();
      this.logger.info("📊 Final summary flushed on shutdown");
    } catch (error) {
      this.logger.warn(
        "⚠️ Failed to flush final summary on shutdown:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Sample unrealized PNL for every open position and update the rolling
   * max/min window. Public so tests can drive it directly.
   */
  async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const res = await this.client.getOpenPositions();
      const positions: Position[] = Array.isArray(res.data) ? res.data : [];
      const now = Date.now();
      const seen = new Set<string>();
      const active = positions.filter((p) => p.state !== 3 && p.holdVol > 0);

      // Feed active positions downstream (e.g. PositionClosureMonitor) so they
      // don't need to make their own open-positions API call.
      this.onSample?.(active);

      // Detect genuinely new positions (not present in the previous poll).
      // Skip the very first poll (stats is empty) — all positions are "new"
      // only because we haven't seeded yet.
      const wasSeeded = this.stats.size > 0;
      const newPositions: Position[] = [];

      for (const p of active) {
        const id = String(p.positionId);
        seen.add(id);
        const pnl = toFiniteNumber(p.unRealizedPnl);
        if (!Number.isFinite(pnl)) {
          // Some positions (e.g. airdrops) may omit unRealizedPnl — skip sampling.
          continue;
        }

        let st = this.stats.get(id);
        if (!st) {
          st = {
            positionId: id,
            symbol: p.symbol,
            positionType: p.positionType,
            openType: p.openType,
            leverage: p.leverage,
            openAvgPrice: p.openAvgPrice,
            margin: p.oim || p.im || 0,
            samples: [],
          };
          this.stats.set(id, st);
          // Only report as "new" after the first poll has seeded stats.
          if (wasSeeded) {
            newPositions.push(p);
          }
        } else {
          // Refresh metadata in case it changed (e.g. partial close adjusted it).
          st.symbol = p.symbol;
          st.positionType = p.positionType;
          st.openType = p.openType;
          st.leverage = p.leverage;
          st.openAvgPrice = p.openAvgPrice;
          st.margin = p.oim || p.im || 0;
        }
        st.samples.push({ ts: now, pnl });
      }

      // Prune samples older than the window and drop positions no longer open.
      const cutoff = now - this.windowMs;
      for (const [id, st] of this.stats) {
        st.samples = st.samples.filter((s) => s.ts >= cutoff);
        if (!seen.has(id) || st.samples.length === 0) {
          this.stats.delete(id);
        }
      }

      // Log ticker samples so a restart can restore them.
      this.logTickerEntries(active);

      // Notify when genuinely new positions appear (plan-order triggers).
      if (newPositions.length > 0 && this.onNewPosition) {
        this.logger.info(
          `🆕 ${newPositions.length} new position(s) detected: ` +
          newPositions.map((p) => `${p.symbol} ${p.positionType === 1 ? "LONG" : "SHORT"}`).join(", ")
        );
        this.onNewPosition(newPositions);
      }

      // Log per-position PNL ticker to console at every poll.
      for (const p of active) {
        const id = String(p.positionId);
        const pnl = toFiniteNumber(p.unRealizedPnl);
        if (!Number.isFinite(pnl)) continue;

        const dir = p.positionType === 1 ? "LONG" : "SHORT";
        const prev = this.prevPnl.get(id);
        const st = this.stats.get(id);
        const maxPnl = st ? Math.max(...st.samples.map((s) => s.pnl)) : pnl;
        const minPnl = st ? Math.min(...st.samples.map((s) => s.pnl)) : pnl;

        if (prev !== undefined) {
          const delta = pnl - prev;
          const arrow = delta >= 0 ? "▲" : "▼";
          this.logger.info(
            `📈 ${p.symbol} ${dir} ${arrow} ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} · ` +
              `PNL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} · ` +
              `max ${maxPnl >= 0 ? "+" : ""}${maxPnl.toFixed(2)} / min ${minPnl >= 0 ? "+" : ""}${minPnl.toFixed(2)}`
          );
        } else {
          this.logger.info(
            `📈 ${p.symbol} ${dir} · PNL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} · ` +
              `max ${maxPnl >= 0 ? "+" : ""}${maxPnl.toFixed(2)} / min ${minPnl >= 0 ? "+" : ""}${minPnl.toFixed(2)}`
          );
        }
        this.prevPnl.set(id, pnl);
      }

      // Clean up prevPnl for positions no longer active.
      for (const id of Array.from(this.prevPnl.keys())) {
        if (!seen.has(id)) this.prevPnl.delete(id);
      }

      // Evaluate >50%-toward-SL/TP alerts for positions with known targets.
      this.slTpStore.pruneStale(this.slTpRetentionMs);
      await this.ensureContractSizes(active);
      await this.checkAlerts(active);
      await this.checkPartialTpHits(active);
    } catch (error) {
      this.logger.warn(
        "⚠️ Position summary sampling failed:",
        error instanceof Error ? error.message : error
      );
    } finally {
      this.sampling = false;
    }
  }

  /**
   * Assemble and emit the summary. Public so tests can drive it directly.
   *
   * @param forceFreshPending When true (e.g. an explicit CHECK POSITIONS
   *                          command), always fetch pending orders from the
   *                          plan/stop order APIs, bypassing the 30s cache.
   */
  async emitSummary(forceFreshPending = false): Promise<void> {
    try {
      // Fresh open positions so the summary always reflects the current state,
      // merging in the tracked PNL stats (max/min) where available.
      const res = await this.client.getOpenPositions();
      const positions: Position[] = Array.isArray(res.data) ? res.data : [];
      const open = positions.filter((p) => p.state !== 3 && p.holdVol > 0);

      // Space requests to avoid MEXC rate limits on the summary path.
      await this.spaceRequest();

      const openPositions: OpenPositionSummary[] = open.map((p) => {
        const id = String(p.positionId);
        const st = this.stats.get(id);
        // Prefer the freshest value from this fetch for "current"; the tracked
        // samples (rolling window) provide the max/min PNL reached.
        const freshPnl = toFiniteNumber(p.unRealizedPnl);
        let currentPnl = freshPnl;
        let maxPnl = freshPnl;
        let minPnl = freshPnl;

        if (st && st.samples.length > 0) {
          if (!Number.isFinite(currentPnl)) {
            currentPnl = st.samples[st.samples.length - 1].pnl;
          }
          let hi = -Infinity;
          let lo = Infinity;
          for (const s of st.samples) {
            if (s.pnl > hi) hi = s.pnl;
            if (s.pnl < lo) lo = s.pnl;
          }
          maxPnl = hi;
          minPnl = lo;
        }

        return {
          positionId: id,
          symbol: p.symbol,
          positionType: p.positionType,
          openType: p.openType,
          leverage: p.leverage,
          openAvgPrice: p.openAvgPrice,
          currentPnl,
          maxPnl,
          minPnl,
          margin: p.oim || p.im || 0,
          holdVol: p.holdVol,
          realisedPnl: toFiniteNumber(p.realised),
          holdFee: toFiniteNumber(p.holdFee),
          // What the position would settle for if closed right now:
          // floating (unrealized) PNL plus the realized PNL already booked.
          // `realised` is signed (negative = net loss / fees), so the sum
          // correctly nets fees out of the total.
          totalPnl: currentPnl + toFiniteNumber(p.realised),
        };
      });

      // Resolve fill order IDs for open positions so users know what ID to
      // use with CLOSE / REVERSE / ADD TO commands.
      await this.spaceRequest();
      const fillOrderMap = await this.resolveFillOrderIds(open);

      // Attach fill order IDs to the open position summaries.
      for (const pos of openPositions) {
        const key = `${pos.symbol}:${pos.positionType}`;
        pos.fillOrderId = fillOrderMap.get(key);
      }

      // Pending orders: tries the documented open-orders endpoint plus the
      // planorder/stoporder lists as fallbacks, merges and dedupes. Each
      // source fails independently and degrades gracefully.
      const pendingOrders = await this.fetchPendingOrders(forceFreshPending);

      // Estimated TP/SL P&L per position (requires known SL/TP levels).
      await this.ensureContractSizes(open);
      const slTpLookup = this.buildSlTpLookupFrom(pendingOrders);
      for (const pos of openPositions) {
        this.attachEstimatedPnl(pos, slTpLookup);
      }

      // Space before the next API call.
      await this.spaceRequest();

      let account: AccountSnapshot;
      try {
        const asset = await this.client.getAccountAsset(this.baseCurrency);
        const inner: any = asset.data ?? asset;
        account = {
          availableBalance: toFiniteNumber(inner.availableBalance),
          equity: toFiniteNumber(inner.equity),
          currency: this.baseCurrency,
        };
      } catch (error) {
        this.logger.error(
          "❌ Failed to fetch account snapshot for summary:",
          error instanceof Error ? error.message : error
        );
        account = {
          availableBalance: NaN,
          equity: NaN,
          currency: this.baseCurrency,
        };
      }

      // Daily PNL: realized (from position history since UTC midnight) plus
      // unrealized (current floating PNL across open positions).
      const dailyPnl = await this.computeDailyPnl(open);

      const summary: PositionSummary = {
        windowHours: this.windowMs / 3600000,
        intervalHours: this.intervalMs / 3600000,
        generatedAt: Date.now(),
        openPositions,
        pendingOrders,
        account,
        dailyPnl,
      };

      this.logger.info(
        `📊 Emitting position summary: ${openPositions.length} open position(s), ` +
          `${pendingOrders.length} pending order(s)`
      );

      // Log full summary to console for local visibility.
      this.logSummaryToConsole(summary);

      this.onSummary(summary);
    } catch (error) {
      this.logger.error(
        "❌ Failed to generate position summary:",
        error instanceof Error ? error.message : error
      );
    }
  }

  // ── Console summary helper ────────────────────────────────────────

  /**
   * Print a human-readable summary to the node console/log so operators
   * can see the full account snapshot without checking Telegram.
   */
  private logSummaryToConsole(summary: PositionSummary): void {
    const cur = summary.account.currency;
    const fmtN = (n: number, d = 2) =>
      Number.isFinite(n)
        ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
        : "—";
    const fmtS = (n: number, d = 2) => {
      if (!Number.isFinite(n)) return "—";
      const sign = n > 0 ? "+" : n < 0 ? "-" : "";
      return `${sign}${fmtN(Math.abs(n), d)}`;
    };

    this.logger.info("═══════════════════════════════════════════");
    this.logger.info("  📊 POSITION SUMMARY");
    this.logger.info(`  ⏱️  Last ${summary.windowHours}h · report every ${summary.intervalHours}h`);
    this.logger.info("───────────────────────────────────────────");

    if (summary.openPositions.length === 0) {
      this.logger.info("  No open positions");
    } else {
      for (const p of summary.openPositions) {
        const dir = p.positionType === 1 ? "LONG" : "SHORT";
        const icon = p.currentPnl >= 0 ? "🟢" : "🔴";
        // Winning positions show % toward TP; losing positions show % toward SL.
        const isWinning = p.currentPnl >= 0;
        const prog = isWinning ? p.tpProgress : p.slProgress;
        const progLine =
          prog !== undefined && Number.isFinite(prog)
            ? isWinning
              ? ` (${(prog * 100).toFixed(0)}% of TP)`
              : ` (${Math.abs(prog * 100).toFixed(0)}% of SL)`
            : "";
        const estLine =
          p.estTpPnl !== undefined && p.estSlPnl !== undefined
            ? ` · Est TP ${fmtS(p.estTpPnl)} / SL ${fmtS(p.estSlPnl)} ${cur}` + progLine
            : "";
        this.logger.info(
          `  ${icon} ${p.symbol} ${dir} ${p.leverage}x · Entry ${fmtN(p.openAvgPrice)} · ` +
            `PNL ${fmtS(p.currentPnl)} ${cur} · max ${fmtS(p.maxPnl)} / min ${fmtS(p.minPnl)}` +
            ` · Realized ${fmtS(p.realisedPnl)} / Fees ${fmtS(p.holdFee)} ${cur}` +
            ` · Total ${fmtS(p.totalPnl)} ${cur}` +
            estLine +
            ` · 🆔 ${p.positionId}`
        );
      }
    }

    if (summary.pendingOrders.length > 0) {
      this.logger.info("───────────────────────────────────────────");
      this.logger.info(`  📌 Pending Orders (${summary.pendingOrders.length})`);
      for (const o of summary.pendingOrders) {
        const dir = o.side === 1 || o.side === 4 ? "LONG" : "SHORT";
        if (o.kind === "STOP") {
          const arrow = o.triggerType === 1 ? "≥" : "≤";
          this.logger.info(`  🟡 ${o.symbol} ${dir} STOP ${arrow}${fmtN(o.triggerPrice)}`);
        } else {
          const tp = Number.isFinite(o.takeProfitPrice) ? `TP ${fmtN(o.takeProfitPrice)}` : "";
          const sl = Number.isFinite(o.stopLossPrice) ? `SL ${fmtN(o.stopLossPrice)}` : "";
          this.logger.info(`  🟡 ${o.symbol} ${dir} ${[tp, sl].filter(Boolean).join(" / ")}`);
        }
      }
    }

    this.logger.info("───────────────────────────────────────────");
    const dp = summary.dailyPnl;
    this.logger.info(
      `  📅 Daily PNL (${dp.date}) · Realized ${fmtS(dp.realized)} / ` +
        `Unrealized ${fmtS(dp.unrealized)} / Total ${fmtS(dp.total)} ${cur}` +
        (dp.tick !== null && Number.isFinite(dp.tick)
          ? ` · tick ${fmtS(dp.tick)} vs ${dp.prevDate ?? "prev day"}`
          : "")
    );
    this.logger.info(`  💼 Available: ${fmtN(summary.account.availableBalance)} ${cur}`);
    this.logger.info(`  📈 Equity: ${fmtN(summary.account.equity)} ${cur}`);
    this.logger.info("═══════════════════════════════════════════");
  }

  // ── Ticker-{date}.log persistence helpers ─────────────────────────

  /**
   * Load the ticker log files and rebuild the tracked stats map so
   * min/max PNL survives a restart. Reads today's and yesterday's
   * `ticker-YYYY-MM-DD.log` from LOG_DIR. Samples outside the trailing
   * window are filtered out (same as live sampling).
   */
  private loadStats(): void {
    // Logger writes to its logDir. Use a private helper or the Logger's dir.
    // The Logger doesn't expose logDir public; we accept that ticker must be
    // in the same place. If no logDir is set, skip.
    const dir = (this.logger as any).logDir as string | null | undefined;
    if (!dir) return;

    const now = Date.now();
    const today = this.dateStr();
    const yesterday = this.dateStr(now - 86400_000);
    const files = [today, yesterday]
      .map((d) => path.join(dir, `ticker-${d}.log`))
      .filter((f) => fs.existsSync(f));

    const lines: string[] = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(f, "utf-8");
        lines.push(...raw.split("\n").filter(Boolean));
      } catch {
        // file disappeared between stat and read — ignore
      }
    }

    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry.positionId !== "string") continue;
      const id = entry.positionId;
      const pnl = toFiniteNumber(entry.pnl);
      const ts = toFiniteNumber(entry.sampleTs);
      if (!Number.isFinite(pnl) || !Number.isFinite(ts)) continue;

      let st = this.stats.get(id);
      if (!st) {
        st = {
          positionId: id,
          symbol: String(entry.symbol ?? ""),
          positionType: entry.positionType === 2 ? 2 : 1,
          openType: entry.openType === 2 ? 2 : 1,
          leverage: toFiniteNumber(entry.leverage) || 0,
          openAvgPrice: toFiniteNumber(entry.openAvgPrice),
          margin: toFiniteNumber(entry.margin) || 0,
          samples: [],
        };
        this.stats.set(id, st);
      }
      st.samples.push({ ts, pnl });
    }

    // Apply window pruning.
    const cutoff = now - this.windowMs;
    for (const [id, st] of this.stats) {
      st.samples = st.samples.filter((x) => x.ts >= cutoff);
      if (st.samples.length === 0) this.stats.delete(id);
    }

    if (this.stats.size > 0) {
      this.logger.info(
        `📂 Restored ${this.stats.size} position stat(s) from ticker-*.log in ${dir}`
      );
    }
  }

  /**
   * Log one ticker line per tracked open position so a restart can restore
   * the rolling max/min window from `ticker-YYYY-MM-DD.log`.
   */
  private logTickerEntries(active: Position[]): void {
    const now = Date.now();
    for (const p of active) {
      const id = String(p.positionId);
      const pnl = toFiniteNumber(p.unRealizedPnl);
      if (!Number.isFinite(pnl)) continue;
      this.logger.logTicker({
        positionId: id,
        symbol: p.symbol,
        positionType: p.positionType,
        openType: p.openType,
        leverage: p.leverage,
        openAvgPrice: p.openAvgPrice,
        margin: p.oim || p.im || 0,
        pnl,
        sampleTs: now,
      });
    }
  }

  private dateStr(ms?: number): string {
    const d = ms ? new Date(ms) : new Date();
    return d.toISOString().slice(0, 10);
  }

  // ── Daily PNL helpers ─────────────────────────────────────────────

  /**
   * Compute today's realized + unrealized PNL and the change ("tick") versus
   * the previous day. Realized is summed from the position-history endpoint
   * (positions closed since UTC midnight); unrealized is the current floating
   * PNL across open positions. Today's snapshot is persisted so the tick can
   * be derived on later runs.
   */
  private async computeDailyPnl(open: Position[]): Promise<DailyPnlInfo> {
    const now = Date.now();
    const today = this.dateStr(now);
    const yesterday = this.dateStr(now - 86400_000);
    const todayStart = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate()
    );

    // Unrealized = current floating PNL across all open positions.
    let unrealized = 0;
    let unrealizedKnown = false;
    for (const p of open) {
      const u = toFiniteNumber(p.unRealizedPnl);
      if (Number.isFinite(u)) {
        unrealized += u;
        unrealizedKnown = true;
      }
    }

    // Realized = sum of realised PNL from positions closed since UTC midnight.
    let realized = NaN;
    try {
      realized = await this.sumRealizedSince(todayStart);
    } catch (error) {
      this.logger.warn(
        "⚠️ Failed to fetch position history for daily realized PNL:",
        error instanceof Error ? error.message : error
      );
    }

    const realizedFinite = Number.isFinite(realized);
    const total =
      realizedFinite && unrealizedKnown ? realized + unrealized : NaN;
    const prev = this.dailyPnlStore[yesterday];
    const tick =
      prev && Number.isFinite(prev.total) && Number.isFinite(total)
        ? total - prev.total
        : null;

    // Persist today's running snapshot, falling back to the previous value on
    // a failed read so a transient error doesn't zero out the store.
    const existing = this.dailyPnlStore[today];
    const storedRealized = realizedFinite ? realized : existing?.realized ?? 0;
    const storedUnrealized = unrealizedKnown
      ? unrealized
      : existing?.unrealized ?? 0;
    this.dailyPnlStore[today] = {
      realized: storedRealized,
      unrealized: storedUnrealized,
      total: storedRealized + storedUnrealized,
      updatedAt: now,
    };
    this.pruneDailyPnl();
    this.saveDailyPnl();

    return {
      date: today,
      prevDate: prev ? yesterday : undefined,
      realized: realizedFinite ? realized : NaN,
      unrealized: unrealizedKnown ? unrealized : NaN,
      total: Number.isFinite(total) ? total : NaN,
      tick,
    };
  }

  /**
   * Sum the realized PNL of every position closed since `startMs` by reading
   * the position-history endpoint (newest-first). Stops early once a full page
   * predates `startMs` or history is exhausted. Dedupes by positionId keeping
   * the latest record, since a position can appear more than once.
   */
  private async sumRealizedSince(startMs: number): Promise<number> {
    const byId = new Map<string, { realised: number; ts: number }>();
    const pageSize = 100;
    const maxPages = 5;

    for (let page = 1; page <= maxPages; page++) {
      await this.spaceRequest();
      const res = await this.client.getPositionHistory({
        page_num: page,
        page_size: pageSize,
      });
      const list: Position[] = Array.isArray(res.data) ? res.data : [];
      if (list.length === 0) break;

      // Newest-first heuristic: if the newest record on this page already
      // predates today, no later page will contain today's closes either.
      let newest = 0;
      for (const p of list) {
        const ts = toFiniteNumber(p.updateTime);
        if (Number.isFinite(ts) && ts > newest) newest = ts;
      }
      if (newest < startMs) break;

      for (const p of list) {
        const ts = toFiniteNumber(p.updateTime);
        const realised = toFiniteNumber(p.realised);
        if (!Number.isFinite(ts) || ts < startMs || !Number.isFinite(realised)) {
          continue;
        }
        const id = String(p.positionId);
        const prev = byId.get(id);
        if (!prev || ts >= prev.ts) byId.set(id, { realised, ts });
      }

      if (list.length < pageSize) break;
    }

    let total = 0;
    for (const v of byId.values()) total += v.realised;
    return total;
  }

  private loadDailyPnl(): void {
    if (!this.dailyPnlFile) return;
    try {
      if (fs.existsSync(this.dailyPnlFile)) {
        const raw = fs.readFileSync(this.dailyPnlFile, "utf-8");
        const data = JSON.parse(raw);
        if (
          data &&
          typeof data === "object" &&
          data.days &&
          typeof data.days === "object"
        ) {
          this.dailyPnlStore = data.days;
        }
      }
    } catch (error) {
      this.logger.warn("⚠️ Could not load daily PNL store — starting fresh");
    }
  }

  private saveDailyPnl(): void {
    if (!this.dailyPnlFile) return;
    try {
      fs.mkdirSync(path.dirname(this.dailyPnlFile), { recursive: true });
      fs.writeFileSync(
        this.dailyPnlFile,
        JSON.stringify({
          days: this.dailyPnlStore,
          updatedAt: new Date().toISOString(),
        }),
        "utf-8"
      );
    } catch (error) {
      this.logger.error("❌ Failed to persist daily PNL:", error);
    }
  }

  /** Keep only the most recent 7 days of daily PNL snapshots. */
  private pruneDailyPnl(): void {
    const cutoff = this.dateStr(Date.now() - 7 * 86400_000);
    for (const d of Object.keys(this.dailyPnlStore)) {
      if (d < cutoff) delete this.dailyPnlStore[d];
    }
  }

  /**
   * Ensure a minimum spacing between API calls during summary generation.
   * Uses `requestSpacingMs` (typically ORDER_RATE_INTERVAL_MS) to guarantee
   * each request is separated by at least that interval, preventing MEXC
   * rate-limit rejections even during bursts.
   */
  private async spaceRequest(): Promise<void> {
    if (this.requestSpacingMs <= 0) return;
    const now = Date.now();
    const elapsed = now - this.lastSummaryApiCall;
    if (elapsed < this.requestSpacingMs) {
      const wait = this.requestSpacingMs - elapsed;
      await new Promise((r) => setTimeout(r, wait));
    }
    this.lastSummaryApiCall = Date.now();
  }

  // ── Alert helpers ─────────────────────────────────────────────────

  /**
   * Fetch pending orders from the documented plan/stop-order endpoints with a
   * 30-second cache so rapid CHECK POSITIONS commands don't rate-limit the API.
   * Each source fails independently; requests are made sequentially to avoid
   * burst rate-limiting from MEXC.
   *
   * @param forceFresh When true, bypasses the cache and always fetches from the
   *                   plan/stop order APIs (used for explicit CHECK POSITIONS).
   */
  private async fetchPendingOrders(forceFresh = false): Promise<PendingOrderSummary[]> {
    const now = Date.now();
    if (
      !forceFresh &&
      this.pendingOrdersCache &&
      now - this.pendingOrdersCache.ts < this.PENDING_CACHE_TTL_MS
    ) {
      this.logger.debug("📦 Using cached pending orders");
      return this.pendingOrdersCache.orders;
    }

    // Fetch sequentially (not Promise.allSettled) — MEXC rate-limits burst
    // requests, even when within the token-bucket capacity.
    type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

    const planResult: Settled<PlanOrderListResponse> = await this.client
      .getPlanOrders(undefined, "1")
      .then((v) => ({ status: "fulfilled" as const, value: v }))
      .catch((e) => ({ status: "rejected" as const, reason: e }));

    const stopResult: Settled<StopOrderListResponse> = await this.client
      .getStopOrders(undefined, 0, 1)
      .then((v) => ({ status: "fulfilled" as const, value: v }))
      .catch((e) => ({ status: "rejected" as const, reason: e }));

    const results = [planResult, stopResult] as const;
    const src = ["planorder", "stoporder"] as const;

    const extracted = [
      results[0].status === "fulfilled" ? this.extractPlanOrders(results[0].value) : [],
      results[1].status === "fulfilled" ? this.extractStopOrders(results[1].value) : [],
    ];

    // Surface failures loudly so an auth/API error is never masked as
    // "no pending orders".
    const failures: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        failures.push(`${src[i]} (${msg})`);
      }
    }
    if (failures.length === results.length) {
      this.logger.error(
        `❌ All pending-order sources failed — pending orders likely incomplete. ${failures.join(" · ")}`
      );
    } else {
      for (const f of failures) {
        this.logger.warn(`⚠️ Failed to fetch ${f}`);
      }
    }

    if (this.logger.isDebugEnabled()) {
      const status = results.map((r, i) => {
        if (r.status === "fulfilled") return `${src[i]}:ok(${extracted[i].length})`;
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        return `${src[i]}:fail(${msg})`;
      });
      this.logger.debug(`📦 Pending order sources → ${status.join(" · ")}`);
    }

    const seen = new Set<string>();
    const out: PendingOrderSummary[] = [];
    for (const list of extracted) {
      for (const p of list) {
        const key = `${p.symbol}:${p.orderId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
    }
    this.pendingOrdersCache = { orders: out, ts: now };
    return out;
  }

  /**
   * Parse the trigger (plan) order list (`planorder/list/orders`) into pending
   * STOP entries. Keeps only open-side entry orders (side 1/3) that are still
   * untriggered. Tolerates several response envelopes (array / `orders` /
   * `resultList` / `list`).
   */
  private extractPlanOrders(res: any): PendingOrderSummary[] {
    const list = this.asList(res?.data);
    const out: PendingOrderSummary[] = [];
    for (const o of list) {
      if (!o || typeof o !== "object") continue;
      const side = Number(o.side);
      if (side !== 1 && side !== 3) continue; // open-side entry STOPs only

      const orderId = String(o.id ?? o.orderId ?? "");
      const symbol = String(o.symbol ?? "");
      const triggerPrice = toFiniteNumber(o.triggerPrice);
      const triggerType = Number(o.triggerType) === 2 ? 2 : 1;
      const vol = toFiniteNumber(o.vol);
      if (!orderId || !symbol || !Number.isFinite(triggerPrice) || !Number.isFinite(vol) || vol <= 0) {
        continue;
      }

      // Plan orders may carry attached TP/SL prices
      const stopLossPrice = toFiniteNumber(o.stopLossPrice);
      const takeProfitPrice = toFiniteNumber(o.takeProfitPrice);

      out.push({
        orderId,
        symbol,
        side: side as 1 | 3,
        kind: "STOP",
        triggerType,
        triggerPrice,
        takeProfitPrice: Number.isFinite(takeProfitPrice) ? takeProfitPrice : NaN,
        stopLossPrice: Number.isFinite(stopLossPrice) ? stopLossPrice : NaN,
        positionType: side === 1 ? 1 : 2,
        vol,
        leverage: toFiniteNumber(o.leverage) || 0,
        openType: Number(o.openType) === 2 ? 2 : 1,
      });
    }
    return out;
  }

  /**
   * Parse the Stop-Limit order list (`stoporder/list/orders`) into pending
   * TP/SL pairs. Each row carries BOTH the take-profit and stop-loss price for
   * a position. Tolerates several response envelopes.
   */
  private extractStopOrders(res: any): PendingOrderSummary[] {
    const list = this.asList(res?.data);
    const out: PendingOrderSummary[] = [];
    for (const o of list) {
      if (!o || typeof o !== "object") continue;

      const orderId = String(o.id ?? o.orderId ?? "");
      const symbol = String(o.symbol ?? "");
      const stopLossPrice = toFiniteNumber(o.stopLossPrice);
      const takeProfitPrice = toFiniteNumber(o.takeProfitPrice);
      const vol = toFiniteNumber(o.vol);
      const positionType = Number(o.positionType) === 2 ? 2 : 1;
      if (!orderId || !symbol || vol <= 0) continue;
      if (!Number.isFinite(stopLossPrice) && !Number.isFinite(takeProfitPrice)) continue;

      out.push({
        orderId,
        symbol,
        side: positionType === 1 ? 4 : 2, // close long / close short
        kind: "TP_SL",
        triggerType: 1,
        triggerPrice: NaN,
        takeProfitPrice,
        stopLossPrice,
        positionType,
        vol,
        leverage: 0, // TP/SL records do not carry leverage
        openType: Number(o.openType) === 2 ? 2 : 1,
      });
    }
    return out;
  }

  /** Normalize a `data` payload into an array regardless of envelope shape. */
  private asList(raw: any): any[] {
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.orders)) return raw.orders;
    if (Array.isArray(raw?.resultList)) return raw.resultList;
    if (Array.isArray(raw?.list)) return raw.list;
    return [];
  }

  /**
   * Fetch executed plan orders (state 3) and also check slTpStore to build a
   * map of `${symbol}:${positionType}` → fillOrderId.  The fill order ID is
   * the only ID that can be used with CLOSE / REVERSE / ADD TO commands.
   */
  private async resolveFillOrderIds(
    openPositions: Position[]
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    // 1. Check slTpStore first (covers market orders + recently-placed trigger orders).
    for (const [, entry] of this.slTpStore.entries()) {
      if (!entry.orderId || entry.orderId === "DRY_RUN" || entry.orderId === "DISABLED") continue;
      if (!entry.symbol) continue;
      const key = `${entry.symbol}:${entry.positionType}`;
      if (!map.has(key)) {
        map.set(key, entry.orderId);
      }
    }

    // 2. Also check executed plan orders (state 3) — catches positions where
    //    the slTpStore was cleared (e.g. a restart).
    try {
      const res = await this.client.getPlanOrders(undefined, "3"); // executed only
      const list = this.asList((res as any).data);
      for (const o of list) {
        if (!o || typeof o !== "object") continue;
        const side = Number(o.side);
        if (side !== 1 && side !== 3) continue; // open-side only
        const symbol = String(o.symbol ?? "");
        const fillOrderId = String(o.orderId ?? "");
        if (!symbol || !fillOrderId || fillOrderId === "0" || fillOrderId === "undefined") continue;
        const positionType = side === 1 ? 1 : 2;
        const key = `${symbol}:${positionType}`;
        if (!map.has(key)) {
          map.set(key, fillOrderId);
        }
      }
    } catch (e) {
      this.logger.debug(
        `⚠️ Could not fetch plan orders for fill IDs: ${e instanceof Error ? e.message : e}`
      );
    }

    this.logger.debug(
      `🔍 Resolved ${map.size} fill order ID(s) for open positions`
    );
    return map;
  }

  /**
   * For each open position with a known SL/TP entry, evaluate whether the
   * price has moved more than 50% of the way toward the stop-loss or
   * take-profit level. Fires at most once per target per position lifetime.
   */
  private async checkAlerts(active: Position[]): Promise<void> {
    // Prefer the in-memory slTpStore; only fetch pending TP/SL stop orders to
    // fill gaps (e.g. after a restart or for manually-opened positions).
    let lookup = this.buildSlTpLookupFrom([]);
    const missing = active.some(
      (p) => !lookup.has(`${p.symbol}:${p.positionType}`)
    );
    if (missing) {
      try {
        const pending = await this.fetchPendingOrders();
        lookup = this.buildSlTpLookupFrom(pending);
      } catch {
        // keep store-only lookup
      }
    }

    const seen = new Set<string>();
    for (const p of active) {
      const id = String(p.positionId);
      seen.add(id);
      const entry = lookup.get(`${p.symbol}:${p.positionType}`);
      if (!entry) continue;

      const alert = this.evaluateAlert(p, entry);
      if (!alert) continue;

      const key = alert.target.toLowerCase() as "sl" | "tp";
      const flags = this.alerted.get(id);
      if (flags && flags[key]) continue; // already alerted for this target

      this.alerted.set(id, {
        sl: flags?.sl || key === "sl",
        tp: flags?.tp || key === "tp",
      });
      this.logger.info(
        `🚨 ${alert.target} alert: ${p.symbol} ${Math.round(alert.progress * 100)}% of the way`
      );
      this.onAlert(alert);
    }
    // Drop alert flags for positions that are no longer open.
    for (const id of Array.from(this.alerted.keys())) {
      if (!seen.has(id)) this.alerted.delete(id);
    }
  }

  /**
   * Evaluate whether an open position is >50% of the way from entry toward
   * its SL or TP. Returns an alert payload, or null if neither threshold is
   * crossed.
   */
  private evaluateAlert(
    p: Position,
    entry: SlTpEntry
  ): PositionAlert | null {
    const avgEntry = p.openAvgPrice;
    const current = this.deriveCurrentPrice(p);
    if (
      !Number.isFinite(avgEntry) ||
      avgEntry <= 0 ||
      !Number.isFinite(current) ||
      current <= 0
    )
      return null;

    const isLong = p.positionType === 1;
    const { sl, tp } = entry;
    let target: "SL" | "TP" | null = null;
    let progress = 0;

    // Priority: SL first (more critical), then TP.
    if (isLong) {
      if (Number.isFinite(sl) && sl > 0 && sl < avgEntry) {
        const p = (avgEntry - current) / (avgEntry - sl);
        if (p > 0.5) {
          target = "SL";
          progress = p;
        }
      }
      if (!target && Number.isFinite(tp) && tp > 0 && tp > avgEntry) {
        const p = (current - avgEntry) / (tp - avgEntry);
        if (p > 0.5) {
          target = "TP";
          progress = p;
        }
      }
    } else {
      if (Number.isFinite(sl) && sl > 0 && sl > avgEntry) {
        const p = (current - avgEntry) / (sl - avgEntry);
        if (p > 0.5) {
          target = "SL";
          progress = p;
        }
      }
      if (!target && Number.isFinite(tp) && tp > 0 && tp < avgEntry) {
        const p = (avgEntry - current) / (avgEntry - tp);
        if (p > 0.5) {
          target = "TP";
          progress = p;
        }
      }
    }

    if (!target) return null;

    const cs = this.contractSizes.get(p.symbol) ?? 1;
    const vol = p.holdVol;
    const mexcPnl = toFiniteNumber(p.unRealizedPnl);

    // Compute PNL independently from the derived current price so the alert
    // can show a cross-validated figure alongside MEXC's unRealizedPnl.
    const computedPnl =
      Number.isFinite(current) && Number.isFinite(avgEntry) && vol > 0
        ? p.positionType === 1
          ? (current - avgEntry) * vol * cs
          : (avgEntry - current) * vol * cs
        : NaN;

    // Log if MEXC's unRealizedPnl differs from our independent computation.
    // Large discrepancies indicate mark-price vs last-price gaps or stale data.
    if (
      Number.isFinite(mexcPnl) &&
      Number.isFinite(computedPnl) &&
      Math.abs(mexcPnl - computedPnl) > 0.01 &&
      Math.abs(mexcPnl - computedPnl) / Math.max(Math.abs(mexcPnl), 0.01) > 0.05
    ) {
      this.logger.warn(
        `⚠️ PNL mismatch for ${p.symbol}: MEXC unRealizedPnl=${mexcPnl.toFixed(4)} ` +
        `vs computed=${computedPnl.toFixed(4)} (Δ=${(mexcPnl - computedPnl).toFixed(4)}) ` +
        `· cs=${cs} vol=${vol}`
      );
    }

    return {
      positionId: String(p.positionId),
      symbol: p.symbol,
      positionType: p.positionType,
      leverage: p.leverage,
      entry: avgEntry,
      currentPrice: current,
      sl,
      tp,
      target,
      progress: Math.min(progress, 9.99), // cap to avoid absurd values on extreme moves
      pnl: Number.isFinite(mexcPnl) ? mexcPnl : 0,
      computedPnl,
    };
  }

  /**
   * Check whether an open position's current price has crossed any
   * intermediate TP targets. Only fires when the slTpStore entry includes
   * `allTpTargets` (multi-TP signal placed with splitMultiTp disabled).
   *
   * For each intermediate TP (all except the last/furthest one), if the
   * current price has crossed the TP level, the `onPartialTpHit` callback
   * is invoked exactly once per TP per position lifetime.
   */
  private checkPartialTpHits(active: Position[]): void {
    if (!this.onPartialTpHit) return;

    const seen = new Set<string>();
    for (const p of active) {
      const key = `${p.symbol}:${p.positionType}`;
      seen.add(key);
      const entry = this.slTpStore.get(p.symbol, p.positionType);
      if (!entry || !entry.allTpTargets || entry.allTpTargets.length <= 1) continue;

      const allTps = entry.allTpTargets;
      const isLong = p.positionType === 1;
      const current = this.deriveCurrentPrice(p);
      if (!Number.isFinite(current) || current <= 0) continue;

      const hitSet = this.partialTpHit.get(key) ?? new Set<number>();

      // Check each intermediate TP (all except the last/furthest one).
      for (let i = 0; i < allTps.length - 1; i++) {
        const tpPrice = allTps[i];
        if (hitSet.has(tpPrice)) continue; // already handled

        const crossed = isLong
          ? current >= tpPrice   // LONG: price rose above TP
          : current <= tpPrice;  // SHORT: price fell below TP

        if (crossed) {
          hitSet.add(tpPrice);
          this.partialTpHit.set(key, hitSet);

          this.logger.info(
            `🎯 Intermediate TP hit: ${p.symbol} ${isLong ? "LONG" : "SHORT"} ` +
            `TP${i + 1}=${tpPrice} crossed (current=${current}), ` +
            `${allTps.length - i - 1} TP(s) remaining`
          );

          this.onPartialTpHit({
            positionId: String(p.positionId),
            symbol: p.symbol,
            positionType: p.positionType,
            tpPrice,
            currentPrice: current,
            remainingTpTargets: allTps.slice(i + 1), // TPs still ahead
            tpIndex: i,
            totalTpCount: allTps.length,
            orderId: entry.orderId,
          });
        }
      }
    }

    // Clean up hit tracking for positions no longer open.
    for (const key of Array.from(this.partialTpHit.keys())) {
      if (!seen.has(key)) this.partialTpHit.delete(key);
    }
  }

  /**
   * Derive approximate current market price from unrealized PNL, the position's
   * remaining volume, average entry AND the contract size (price multiplier).
   * Avoids an extra ticker API call per position per poll.
   *
   *   LONG:  currentPrice = openAvgPrice + unRealizedPnl / (holdVol * contractSize)
   *   SHORT: currentPrice = openAvgPrice - unRealizedPnl / (holdVol * contractSize)
   *
   * NOTE: contract size matters — e.g. ATOM_USDT has contractSize 0.1 and
   * BTC_USDT 0.0001. Without it the derived price (and therefore alert
   * progress) was wrong by a factor of 1/contractSize, which is why >50%
   * alerts never fired for most contracts.
   */
  private deriveCurrentPrice(p: Position): number {
    const pnl = toFiniteNumber(p.unRealizedPnl);
    const vol = p.holdVol;
    if (!Number.isFinite(pnl) || !vol || vol <= 0) return NaN;
    const cs = this.contractSizes.get(p.symbol) ?? 1;
    return p.positionType === 1
      ? p.openAvgPrice + pnl / (vol * cs)
      : p.openAvgPrice - pnl / (vol * cs);
  }

  /**
   * Ensure the contract size (price multiplier) is cached for every open
   * symbol. Needed to convert unrealized PNL ↔ price. Values are cached
   * indefinitely (contract metadata is stable); a failed fetch defaults to 1
   * (assumes a 1:1 PNL↔price relationship) so the monitor never blocks on it.
   */
  private async ensureContractSizes(positions: Position[]): Promise<void> {
    const missing = new Set<string>();
    for (const p of positions) {
      if (p && p.symbol && !this.contractSizes.has(p.symbol)) {
        missing.add(p.symbol);
      }
    }
    if (missing.size === 0) return;
    for (const symbol of missing) {
      try {
        await this.spaceRequest();
        const res: any = await this.client.getContractDetail(symbol);
        const data = Array.isArray(res?.data)
          ? res.data.find((x: any) => x && x.symbol === symbol)
          : res?.data;
        const cs = Number(data?.contractSize);
        this.contractSizes.set(symbol, Number.isFinite(cs) && cs > 0 ? cs : 1);
      } catch {
        this.contractSizes.set(symbol, 1);
      }
    }
  }

  /**
   * Build a merged SL/TP lookup keyed by `${symbol}:${positionType}`.
   * Prefers the in-memory slTpStore (bot-placed orders) and fills any gaps
   * from the pending TP/SL stop orders (which survive restarts and cover
   * manually-opened positions).
   */
  private buildSlTpLookupFrom(pending: PendingOrderSummary[]): Map<string, SlTpEntry> {
    const map = new Map<string, SlTpEntry>();
    for (const [, entry] of this.slTpStore.entries()) {
      if (entry.symbol) {
        map.set(`${entry.symbol}:${entry.positionType}`, entry);
      }
    }
    for (const o of pending) {
      if (o.kind !== "TP_SL") continue;
      const key = `${o.symbol}:${o.positionType}`;
      if (map.has(key)) continue;
      if (!Number.isFinite(o.stopLossPrice) && !Number.isFinite(o.takeProfitPrice)) continue;
      map.set(key, {
        symbol: o.symbol,
        sl: o.stopLossPrice,
        tp: o.takeProfitPrice,
        positionType: o.positionType,
        setAt: Date.now(),
      });
    }
    return map;
  }

  /**
   * Attach estimated TP/SL P&L (and the current % of the TP target reached) to
   * an open position summary, using the known SL/TP levels and contract size.
   * P&L is linear in price, so:
   *   LONG:  estPnl(target) = (target - entry) * holdVol * contractSize
   *   SHORT: estPnl(target) = (entry - target) * holdVol * contractSize
   * `tpProgress` = currentPnl / estTpPnl (1.0 = target reached, negative = losing).
   * `slProgress`  = currentPnl / estSlPnl (positive when losing, 1.0 = SL hit).
   */
  private attachEstimatedPnl(
    pos: OpenPositionSummary,
    lookup: Map<string, SlTpEntry>
  ): void {
    const entry = lookup.get(`${pos.symbol}:${pos.positionType}`);
    if (!entry) return;
    const avgEntry = pos.openAvgPrice;
    const vol = pos.holdVol;
    const cs = this.contractSizes.get(pos.symbol) ?? 1;
    if (
      !Number.isFinite(avgEntry) || avgEntry <= 0 ||
      !Number.isFinite(vol) || vol <= 0 ||
      !Number.isFinite(cs) || cs <= 0
    ) {
      return;
    }

    const isLong = pos.positionType === 1;

    const tp = Number.isFinite(entry.tp) ? entry.tp : NaN;
    if (Number.isFinite(tp) && tp > 0) {
      const diffTp = isLong ? tp - avgEntry : avgEntry - tp;
      const estTpPnl = diffTp * vol * cs;
      if (Number.isFinite(estTpPnl) && Math.abs(estTpPnl) > 1e-12) {
        pos.estTpPnl = estTpPnl;
        pos.tpProgress = pos.currentPnl / estTpPnl;
      }
    }

    const sl = Number.isFinite(entry.sl) ? entry.sl : NaN;
    if (Number.isFinite(sl) && sl > 0) {
      const diffSl = isLong ? sl - avgEntry : avgEntry - sl;
      const estSlPnl = diffSl * vol * cs;
      if (Number.isFinite(estSlPnl) && Math.abs(estSlPnl) > 1e-12) {
        pos.estSlPnl = estSlPnl;
        // estSlPnl is negative; currentPnl is also negative for a losing
        // position, so slProgress reads as a positive fraction toward the SL.
        if (Number.isFinite(pos.currentPnl)) {
          pos.slProgress = pos.currentPnl / estSlPnl;
        }
      }
    }
  }

}
