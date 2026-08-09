/**
 * Trade signal parsed from a Telegram message.
 */
export interface TradeSignal {
  /** Original raw message text */
  raw: string;
  /** BUY or SELL */
  action: "BUY" | "SELL";
  /** Symbol as it appeared in the message (e.g. "TAOUSDT") */
  rawSymbol: string;
  /** Entry price from the signal; 0 means market entry (resolved later via ticker) */
  entry: number;
  /** Stop-loss price */
  sl: number;
  /** Take-profit price(s); at least one is always present after normalization */
  tp: number[];
  /** Order type: "market" when no @/EP given, "trigger" when explicit entry provided */
  orderType: "market" | "trigger";
  /** Optional per-order risk override as a percentage (0-6, e.g. 2.5 = 2.5%). Falls back to config.riskPercent when absent. */
  riskPercentOverride?: number;
  /** Optional per-order leverage override (1-200, e.g. 200 = 200x). Falls back to config.leverage when absent. */
  leverageOverride?: number;
  /** Optional plan-order validity: 1 = 24h (default), 2 = 7 days. Set via V7 marker. */
  executeCycle?: 1 | 2;
  /** Telegram message ID for idempotency */
  messageId?: number;
  /** Telegram channel/chat ID */
  chatId?: number | string;
  /** Timestamp of the message */
  timestamp?: number;
}

/**
 * A fully resolved trade ready for submission.
 */
export interface ResolvedTrade {
  signal: TradeSignal;
  /** MEXC contract symbol (e.g. "TAO_USDT") */
  mexcSymbol: string;
  /** Computed order volume (contracts) */
  volume: number;
  /** Order side: 1=open long, 3=open short */
  side: 1 | 3;
  /** Leverage to use */
  leverage: number;
  /** Open type: 1=isolated, 2=cross */
  openType: 1 | 2;
  /** Entry price (rounded to contract priceScale) */
  entry: number;
  /** Stop-loss price (rounded to contract priceScale) */
  stopLossPrice: number;
  /** Take-profit price (first/only target for the main order) */
  takeProfitPrice: number;
  /** All TP targets if multiple */
  allTpTargets: number[];
  /** Account equity at time of sizing */
  equity: number;
  /** Risk percentage applied for this trade (0.01 = 1%), may differ from config default */
  riskPercent: number;
  /** Risk amount (equity * riskPercent) */
  riskAmount: number;
  /** Minimum order volume (contracts) */
  minVol: number;
  /** Volume scale (decimal places) */
  volScale: number;
  /** Volume step unit */
  volUnit: number;
  /** Current market price at time of resolution (used to determine trigger direction) */
  currentPrice: number;
  /** Contract size from MEXC (e.g. 0.0001 for BTC_USDT — 1 contract = 0.0001 BTC) */
  contractSize: number;
  /** Taker fee rate for this contract (e.g. 0.0006 = 0.06%). Populated when known. */
  takerFeeRate?: number;
  /** Maker fee rate for this contract (e.g. 0.0002 = 0.02%). Populated when known. */
  makerFeeRate?: number;
}

/**
 * A trade queued for operator confirmation before submission to MEXC.
 * Each queued order carries an operator-facing ID (e.g. "Q1") so it can be
 * selectively removed with "CANCEL {ID}" without affecting the rest of the queue.
 */
export interface QueuedOrder {
  /** Operator-facing queue ID (e.g. "Q1", "Q2") used with CANCEL {ID} */
  id: string;
  /** Fully-resolved trade awaiting CONFIRM ORDERS */
  trade: ResolvedTrade;
}

/**
 * Record of an executed trade for traceability.
 */
export interface TradeRecord {
  resolved: ResolvedTrade;
  orderId: string;
  success: boolean;
  error?: string;
  executedAt: number;
  /**
   * Volume actually submitted for THIS order. Differs from resolved.volume
   * when a signal with multiple TPs is split into one order per TP.
   */
  orderVolume?: number;
  /**
   * Take-profit price attached to THIS order. Differs from resolved when a
   * signal with multiple TPs is split into one order per TP.
   */
  orderTp?: number;
}

/**
 * Bot configuration loaded from environment.
 */
export interface BotConfig {
  /** MEXC API key (e.g. "mx0...") */
  mexcApiKey: string;
  /** MEXC API secret key */
  mexcSecretKey: string;
  /** MEXC WEB auth token (browser session token, legacy) */
  mexcAuthToken: string;
  /** Telegram Bot API token */
  telegramBotToken: string;
  /** Allowed Telegram channel/chat IDs (numeric or @username strings) */
  allowedChannels: string[];
  /** Channels where signals are queued for operator confirmation ("CONFIRM ORDERS").
   *  Empty = all allowed channels auto-place immediately. */
  confirmChannels: string[];

  /** Default leverage */
  leverage: number;
  /** Open type: 1=isolated, 2=cross */
  openType: 1 | 2;

  /** Risk percentage per trade (0.01 = 1%) */
  riskPercent: number;
  /** Default TP:SL ratio when no TP is given */
  defaultTpRatio: number;
  /** Max concurrent open positions */
  maxConcurrentTrades: number;
  /** Max notional per trade in USDT */
  maxNotionalPerTrade: number;

  /** Dry-run mode: parse and size but do not submit */
  dryRun: boolean;
  /** Trading enabled switch */
  tradingEnabled: boolean;

  /**
   * Use Limit (Maker) orders for TP/SL instead of market (taker) orders.
   * When enabled, TP/SL are placed as Stop-Limit orders via
   * /private/stoporder/place so they can add liquidity and qualify for
   * maker (often 0%) fees. Only applies to market entries; plan/stop entries
   * still use market TP/SL (a warning is logged).
   */
  useLimitTpSl: boolean;

  /**
   * Close positions with LIMIT (maker) orders instead of market (taker) orders.
   * When enabled, manual/reverse closes first try a Post-Only limit close at the
   * best bid/ask (maker fee, often 0%); if it doesn't fill within a short grace
   * period it's cancelled and a market close is used as fallback.
   */
  useMakerClose: boolean;

  /** Log level */
  logLevel: "SILENT" | "ERROR" | "WARN" | "INFO" | "DEBUG";

  /** Base currency for equity (default USDT) */
  baseCurrency: string;

  /** State file path for idempotency */
  stateFilePath: string;

  /** Directory for persistent log files (signals, trades, bot, ticker, http). */
  logDir: string;

  /** Days to retain log files (default 90). */
  logRetentionDays: number;

  /** Telegram channel/chat ID to receive position-close PNL notifications (empty = disabled). */
  pnlNotificationChannel: string;

  /** How often (seconds) to poll MEXC for closed positions (min 5, default 30). */
  positionMonitorIntervalSeconds: number;

  /** Telegram channel/chat ID for periodic position summaries (empty = falls back to pnlNotificationChannel). */
  summaryNotificationChannel: string;

  /** How often (hours) to send the position summary (default 8). */
  summaryIntervalHours: number;

  /** Trailing window (hours) for PNL max/min stats in the summary (default 4). */
  summaryWindowHours: number;

  /** Token-bucket burst capacity for MEXC API requests — max requests sent immediately before throttling (default 3). */
  orderRateCapacity: number;

  /** Milliseconds between API request refills — sustained rate ≈ 1000/orderRateIntervalMs req/s (default 200). */
  orderRateIntervalMs: number;

  /** Channels that receive signal-resolution updates (TP/SL hit notifications). Signals from these channels are monitored but NOT traded. */
  signalResolverChannels: string[];

  /** How often (seconds) to poll MEXC tickers for signal resolution checks (min 5, default 15). */
  signalResolverIntervalSeconds: number;

  /**
   * When true, a signal with multiple TP targets (e.g. TP1/TP2/TP3) splits
   * the total volume equally into separate orders — one per TP — each with
   * its own entry and exit fees. When false (default), only the first TP is
   * used and a single entry order is placed with all volume, minimizing fees.
   */
  splitMultiTp: boolean;

  /**
   * Volume distribution percentages for multi-TP partial closing.
   * The first value is for TP1 (closest to entry, hit first), the last is
   * for the farthest TP. Each value is a percentage (1–100) of the total
   * position volume allocated to that TP level. The array is normalized
   * internally so the values don't need to sum to exactly 100.
   *
   * When empty or not set, a Fibonacci-based default is used:
   *   2 TPs → [61.8, 38.2]
   *   3 TPs → [50, 30, 20]
   *   4 TPs → [40, 30, 20, 10]
   *   5 TPs → [35, 25, 18, 13, 9]
   *   N TPs → reversed Fibonacci weights normalized to 100.
   *
   * Set via TP_DISTRIBUTION env var (comma-separated, e.g. "60,30,10").
   */
  tpDistribution: number[];

  /**
   * When true and splitMultiTp is disabled, the stop-loss trails behind
   * each hit TP: TP1 hit → SL moves to entry (breakeven), TP2 hit → SL
   * moves to TP1, etc. Requires splitMultiTp=false (partial-close mode).
   *
   * Set via TRAILING_STOP_ON_TP env var ("true"/"1" to enable, default false).
   */
  trailingStopOnTp: boolean;
}

/**
 * A signal being tracked by the SignalResolver for TP/SL monitoring.
 */
export interface TrackedSignal {
  /** Unique ID (chatId_messageId_tpIndex for dedup) */
  id: string;
  /** Raw symbol from the signal text (e.g. "BTCUSDT") */
  symbol: string;
  /** Normalized MEXC contract symbol (e.g. "BTC_USDT") */
  mexcSymbol: string;
  /** BUY or SELL */
  action: "BUY" | "SELL";
  /** Entry price (resolved from ticker for market signals) */
  entry: number;
  /** Stop-loss price */
  sl: number;
  /** All take-profit levels to track */
  tps: number[];
  /** Telegram chat ID where the signal was posted */
  chatId: string;
  /** Telegram message ID of the signal */
  messageId: number;
  /** When the signal was first tracked (epoch ms) */
  createdAt: number;
}

/**
 * Emitted when a tracked signal's TP or SL is hit.
 */
export interface SignalResolutionEvent {
  type: "tp" | "sl";
  signal: TrackedSignal;
  /** The price level that was hit */
  hitPrice: number;
  /** Which TP index was hit (0-based), only set for type=tp */
  tpIndex?: number;
}
