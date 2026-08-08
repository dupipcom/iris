import { Telegraf, Context } from "telegraf";
import { message, channelPost } from "telegraf/filters";
import * as fs from "fs";
import * as path from "path";
import { MexcFuturesSDK } from "../client";
import { Logger } from "../utils/logger";
import { BotConfig, TradeSignal, TradeRecord, SignalResolutionEvent, QueuedOrder } from "./types";
import { parseSignals, normalizeSymbol } from "./parser";
import { ContractResolver } from "./resolver";
import { calculatePositionSize } from "./sizer";
import { TradeExecutor } from "./executor";
import { PendingPlanTpSl } from "./executor";
import { BotState } from "./state";
import { SignalResolver } from "./signalResolver";
import { formatSignalResolutionMessage } from "./signalResolutionMessage";
import {
  PositionClosureMonitor,
  AccountSnapshot,
  ClosedPositionInfo,
} from "./pnlMonitor";
import { formatPositionClosedMessage } from "./pnlMessage";
import {
  PositionSummaryMonitor,
  PositionSummary,
  PositionAlert,
} from "./summaryMonitor";
import { formatPositionSummaryMessage } from "./summaryMessage";
import { formatOrderPlacedMessage } from "./orderMessage";
import { formatPositionAlertMessage } from "./alertMessage";
import { formatPositionCloseMessage, PositionCloseResult } from "./closeMessage";
import { formatCancelOrdersMessage, CancelOrdersResult } from "./cancelMessage";
import { formatReverseMessage, ReverseResult, formatAddToMessage, AddToResult } from "./reverseAddMessage";
import { formatTradeConfirmationMessage } from "./confirmationMessage";
import { SlTpStore } from "./slTpStore";
import { Position } from "../types/account";
import { GetOrderResponse, PlanOrderListResponse } from "../types/orders";
import { ContractDetail } from "../types/market";
import { ResolvedTrade } from "./types";

/**
 * Resolved identity of an order — either from a regular (fill) order or
 * via a plan-order lookup that extracted the fill order ID.
 */
interface OrderIdentity {
  symbol: string;
  /** 1 = long, 2 = short */
  positionType: 1 | 2;
}

/**
 * Main Telegram Signal Bot.
 * Listens for trading signals on configured channels, parses them,
 * validates against MEXC contracts, sizes positions, and executes trades.
 */
export class SignalBot {
  private config: BotConfig;
  private logger: Logger;
  private telegram: Telegraf;
  private mexcClient: MexcFuturesSDK;
  private resolver: ContractResolver;
  private executor: TradeExecutor;
  private state: BotState;
  /** Polls MEXC for closed positions and sends PNL notifications (null when disabled). */
  private pnlMonitor: PositionClosureMonitor | null = null;
  /** Periodically samples open positions and sends a summary. */
  private summaryMonitor!: PositionSummaryMonitor;
  /** SL/TP levels per symbol, populated on order execution, consumed by the monitor for alerts. */
  private slTpStore = new SlTpStore();
  /** Cache account equity for 10s to avoid rate limits on rapid signals. */
  private equityCache: { equity: number; ts: number } | null = null;
  private readonly EQUITY_CACHE_TTL_MS = 10_000;
  /** Orders sized but NOT yet placed — submitted only on operator CONFIRM ORDERS. */
  private orderQueue: QueuedOrder[] = [];
  /** Monotonic counter generating operator-facing queue IDs (Q1, Q2, ...). */
  private queueCounter = 0;
  /** File path for persisting the queue between bot restarts. */
  private readonly queueFilePath: string;
  /** Signal resolver: monitors resolver-channel signals for TP/SL hits (null when disabled). */
  private signalResolver: SignalResolver | null = null;
  /**
   * Pending plan (trigger) orders that were placed WITHOUT take-profit
   * attached. When the position monitor detects the plan has triggered
   * and a new position appears, we place limit (maker) TP orders.
   * Keyed by externalOid (unique per plan order).
   */
  private pendingPlanOrders = new Map<string, PendingPlanTpSl>();

  constructor(config: BotConfig) {
    this.config = config;
    this.logger = new Logger({
      level: config.logLevel,
      logDir: config.logDir,
      retentionDays: config.logRetentionDays,
    });

    // Initialize MEXC client (prefers API key auth over browser token)
    this.mexcClient = new MexcFuturesSDK({
      apiKey: config.mexcApiKey || undefined,
      secretKey: config.mexcSecretKey || undefined,
      authToken: config.mexcAuthToken || undefined,
      logLevel: config.logLevel,
      // Token-bucket rate limiter: bursts fire ASAP, overflow is spaced to stay
      // within MEXC's request limits (avoids code 513 on multi-order signals).
      rateLimit: {
        capacity: config.orderRateCapacity,
        intervalMs: config.orderRateIntervalMs,
      },
    });

    // Initialize subsystems
    this.resolver = new ContractResolver(this.mexcClient, this.logger);
    this.executor = new TradeExecutor(
      this.mexcClient,
      config,
      this.logger,
      (externalOid, details) => {
        this.pendingPlanOrders.set(externalOid, details);
        this.logger.info(
          `📝 Deferred TP for plan order ${externalOid}: ${details.symbol} ` +
          `${details.positionType === 1 ? "LONG" : "SHORT"} ` +
          `${details.tpTargets.length} TP(s), SL=${details.sl}, vol=${details.vol}`
        );
      },
    );
    this.state = new BotState(config.stateFilePath, this.logger);

    // Position-close PNL notifications (only when a channel is configured)
    if (config.pnlNotificationChannel) {
      this.pnlMonitor = new PositionClosureMonitor({
        client: this.mexcClient,
        logger: this.logger,
        baseCurrency: config.baseCurrency,
        intervalSeconds: config.positionMonitorIntervalSeconds,
        onClose: (info, account) => {
          this.slTpStore.removeSymbol(info.symbol);
          this.sendPositionClosedNotification(info, account);
        },
      });
    }

    // Periodic position summaries — always enabled for local console/file
    // logging; Telegram notifications are sent only when a channel is configured.
    // Feeds open-position data to the PNL monitor so it doesn't need its own timer.
    this.summaryMonitor = new PositionSummaryMonitor({
      client: this.mexcClient,
      logger: this.logger,
      baseCurrency: config.baseCurrency,
      sampleIntervalSeconds: config.positionMonitorIntervalSeconds,
      windowHours: config.summaryWindowHours,
      intervalHours: config.summaryIntervalHours,
      onSummary: (summary) => this.sendPositionSummary(summary),
      slTpStore: this.slTpStore,
      onAlert: (alert) => this.sendPositionAlert(alert),
      slTpRetentionDays: config.logRetentionDays,
      onSample: (positions) => this.pnlMonitor?.feedPositions(positions),
      requestSpacingMs: config.orderRateIntervalMs,
      // When a plan order triggers and a new position appears, place the
      // deferred limit (maker) TP orders to minimize fees.
      onNewPosition: (positions) => { void this.handleNewPositions(positions); },
    });

    // Signal resolver: monitors resolver-channel signals for TP/SL hits
    // without placing any MEXC orders (informational-only channels).
    if (config.signalResolverChannels.length > 0) {
      this.signalResolver = new SignalResolver({
        client: this.mexcClient,
        resolver: this.resolver,
        logger: this.logger,
        intervalSeconds: config.signalResolverIntervalSeconds,
        onResolution: (event) => this.sendSignalResolution(event),
      });
    }

    // Initialize Telegram bot
    this.telegram = new Telegraf(config.telegramBotToken);

    // Queue persistence file lives alongside the state file.
    this.queueFilePath = path.join(
      path.dirname(path.resolve(config.stateFilePath)),
      "queue.json"
    );
  }

  /**
   * Start the bot — connect to Telegram and begin listening.
   */
  async start(): Promise<void> {
    this.logger.info("🤖 Starting Dupip Crypto Connector...");
    this.logger.info(
      `   Mode: ${this.config.dryRun ? "DRY RUN" : "LIVE"}`
    );
    this.logger.info(
      `   Trading: ${this.config.tradingEnabled ? "ENABLED" : "DISABLED"}`
    );
    this.logger.info(
      `   Risk: ${(this.config.riskPercent * 100).toFixed(1)}% per trade`
    );
    this.logger.info(
      `   Leverage: ${this.config.leverage}x ${this.config.openType === 1 ? "Isolated" : "Cross"}`
    );
    this.logger.info(
      `   Channels: ${this.config.allowedChannels.join(", ")}`
    );
    const confirmCh = this.config.confirmChannels;
    this.logger.info(
      confirmCh.length > 0
        ? `   Confirm (queue+approve): ${confirmCh.join(", ")} — other allowed channels auto-place`
        : `   Confirm: disabled (CONFIRM_CHANNELS not set) — all allowed channels auto-place`
    );
    if (this.config.signalResolverChannels.length > 0) {
      this.logger.info(
        `   Resolver channels: ${this.config.signalResolverChannels.join(", ")} (info-only, no trading)`
      );
    }

    // Pre-warm contract cache
    try {
      await this.resolver.refreshIfNeeded();
    } catch (error) {
      this.logger.error("❌ Failed to load MEXC contracts — continuing anyway");
    }

    // Restore any queued orders from a previous session so the operator
    // doesn't lose them on restart.
    await this.loadQueue();

    // Test MEXC connection
    try {
      const connected = await this.mexcClient.testConnection();
      this.logger.info(
        `   MEXC connection: ${connected ? "✅ OK" : "❌ FAILED"}`
      );
    } catch {
      this.logger.warn("⚠️ MEXC connection test failed");
    }

    // Register handlers for both group/DM messages and channel posts
    this.telegram.on(message("text"), (ctx) => this.handleTelegramMessage(ctx, "message"));
    this.telegram.on(channelPost("text"), (ctx) => this.handleTelegramMessage(ctx, "channel_post"));

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      this.logger.info(`\n🛑 Received ${signal} — shutting down...`);
      this.pnlMonitor?.stop();
      this.signalResolver?.stop();
      await this.summaryMonitor.stop();
      this.telegram.stop(signal);
      this.logger.info("🛑 Shutdown complete — flushing logs...");
      await this.logger.close();
      process.exit(0);
    };
    process.once("SIGINT", () => { void shutdown("SIGINT"); });
    process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

    // Start monitors and background work BEFORE awaiting launch() so they
    // run concurrently with Telegram long-polling.
    this.summaryMonitor.start();
    if (this.pnlMonitor) {
      this.pnlMonitor.start(/* externalFeed= */ true);
    }
    if (this.signalResolver) {
      this.signalResolver.start();
    }

    // Fire the initial summary fetch in the background — it makes several
    // spaced API calls (~800ms) but Telegram is already listening.
    void this.summaryMonitor.emitSummary(true).then(() => {
      this.logger.info("📊 Initial summary snapshot emitted");
    }).catch((error) => {
      this.logger.error(
        "❌ Failed to emit initial summary:",
        error instanceof Error ? error.message : error
      );
    });

    const summaryDest = this.config.summaryNotificationChannel
      ? `→ ${this.config.summaryNotificationChannel} `
      : "(local only) ";
    this.logger.info(
      `📊 Position summary ${summaryDest}` +
        `(every ${this.config.summaryIntervalHours}h, window ${this.config.summaryWindowHours}h)`
    );
    if (this.pnlMonitor) {
      this.logger.info(
        `📨 PNL notifications → ${this.config.pnlNotificationChannel}`
      );
    }

    this.logger.info("✅ Bot is running and listening for signals");

    // Block on Telegram long-polling — this keeps the Node process alive and
    // actually processes incoming messages. Monitors run concurrently via their
    // own setInterval timers. On shutdown, telegram.stop() causes launch() to
    // resolve, which lets start() return and the process exit cleanly.
    await this.telegram.launch();
  }

  /**
   * Gracefully stop the bot without exiting the process.
   *
   * Stops the monitors and the Telegram long-polling loop so `start()`'s
   * `await this.telegram.launch()` resolves and the bot can be started again
   * (used by the desktop app on Stop / script-code refresh). Mirrors the
   * SIGINT/SIGTERM shutdown, minus `process.exit()`.
   */
  async stop(): Promise<void> {
    this.logger.info("🛑 Stopping bot...");
    this.pnlMonitor?.stop();
    this.signalResolver?.stop();
    await this.summaryMonitor.stop();
    try {
      this.telegram.stop();
    } catch {
      /* ignore */
    }
    this.logger.info("🛑 Bot stopped");
    await this.logger.close();
  }

  /**
   * Send the position-closed PNL notification to the configured channel.
   */
  private async sendPositionClosedNotification(
    info: ClosedPositionInfo,
    account: AccountSnapshot
  ): Promise<void> {
    const text = formatPositionClosedMessage(info, account);
    try {
      await this.telegram.telegram.sendMessage(
        this.config.pnlNotificationChannel,
        text,
        { parse_mode: "HTML" }
      );
      this.logger.info(
        `📨 PNL notification sent to ${this.config.pnlNotificationChannel}`
      );
    } catch (error) {
      this.logger.error(
        "❌ Failed to send PNL notification:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Send the periodic position summary to the configured channel.
   * Skips Telegram delivery when no summary channel is configured.
   */
  private async sendPositionSummary(summary: PositionSummary): Promise<void> {
    const channel = this.config.summaryNotificationChannel;
    if (!channel) return;
    const text = formatPositionSummaryMessage(summary);
    try {
      await this.telegram.telegram.sendMessage(channel, text, {
        parse_mode: "HTML",
      });
      this.logger.info(`📊 Position summary sent to ${channel}`);
    } catch (error) {
      this.logger.error(
        "❌ Failed to send position summary:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Handle new positions detected by the summary monitor (e.g. plan orders
   * that just triggered). Matches against pending plan orders and places
   * deferred limit (maker) TP orders, reusing the existing SL already
   * attached to the plan order for safety.
   */
  private async handleNewPositions(positions: Position[]): Promise<void> {
    if (this.pendingPlanOrders.size === 0) return;

    for (const pos of positions) {
      for (const [oid, details] of this.pendingPlanOrders) {
        if (
          details.symbol === pos.symbol &&
          details.positionType === pos.positionType
        ) {
          this.logger.info(
            `🔄 Plan order triggered: ${pos.symbol} ${pos.positionType === 1 ? "LONG" : "SHORT"} ` +
            `posId=${pos.positionId} — placing deferred limit TPs`
          );
          await this.executor.placeDeferredLimitTpSl(
            pos.positionId,
            details,
          );
          this.pendingPlanOrders.delete(oid);
          break;
        }
      }
    }

    // Safety net: clear if the map grows too large (stale entries).
    if (this.pendingPlanOrders.size > 50) {
      this.logger.warn(
        `⚠️ Pending plan orders map has ${this.pendingPlanOrders.size} entries — clearing`
      );
      this.pendingPlanOrders.clear();
    }
  }

  /**
   * Send a >50%-toward-SL/TP alert to the summary channel.
   */
  private async sendPositionAlert(alert: PositionAlert): Promise<void> {
    const channel = this.config.summaryNotificationChannel;
    if (!channel) return;
    const text = formatPositionAlertMessage(alert);
    try {
      await this.telegram.telegram.sendMessage(channel, text, {
        parse_mode: "HTML",
      });
      this.logger.info(
        `🚨 Position alert sent to ${channel}: ${alert.symbol} ${alert.target}`
      );
    } catch (error) {
      this.logger.error(
        "❌ Failed to send position alert:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Send the result of a `Close {orderId}` command.
   */
  private async sendCloseResult(res: PositionCloseResult): Promise<void> {
    const channel =
      this.config.summaryNotificationChannel ||
      this.config.pnlNotificationChannel;
    if (!channel) return;
    const text = formatPositionCloseMessage(res);
    try {
      await this.telegram.telegram.sendMessage(channel, text, {
        parse_mode: "HTML",
      });
    } catch (error) {
      this.logger.error(
        "❌ Failed to send close result:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Send the result of a `CANCEL {SYMBOL} {DIRECTION}` command.
   */
  private async sendCancelResult(res: CancelOrdersResult): Promise<void> {
    const channel =
      this.config.summaryNotificationChannel ||
      this.config.pnlNotificationChannel;
    if (!channel) return;
    const text = formatCancelOrdersMessage(res);
    try {
      await this.telegram.telegram.sendMessage(channel, text, {
        parse_mode: "HTML",
      });
    } catch (error) {
      this.logger.error(
        "❌ Failed to send cancel result:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Send the result of a `REVERSE {orderId}` command.
   */
  private async sendReverseResult(res: ReverseResult): Promise<void> {
    const channel =
      this.config.summaryNotificationChannel ||
      this.config.pnlNotificationChannel;
    if (!channel) return;
    const text = formatReverseMessage(res);
    try {
      await this.telegram.telegram.sendMessage(channel, text, {
        parse_mode: "HTML",
      });
    } catch (error) {
      this.logger.error(
        "❌ Failed to send reverse result:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Send the result of an `ADD TO {orderId} {risk%}` command.
   */
  private async sendAddToResult(res: AddToResult): Promise<void> {
    const channel =
      this.config.summaryNotificationChannel ||
      this.config.pnlNotificationChannel;
    if (!channel) return;
    const text = formatAddToMessage(res);
    try {
      await this.telegram.telegram.sendMessage(channel, text, {
        parse_mode: "HTML",
      });
    } catch (error) {
      this.logger.error(
        "❌ Failed to send add-to result:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Cancel all pending plan (trigger) orders for a given symbol and direction.
   *
   * "CANCEL ETHUSDT LONG" → cancels all untriggered open-long plan orders
   * for ETH_USDT.
   */
  private async handleCancelOrders(
    rawSymbol: string,
    direction: "LONG" | "SHORT",
    chatId: string,
    messageId: number
  ): Promise<void> {
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(
        `⏭️ CANCEL ${rawSymbol} ${direction} already processed`
      );
      return;
    }
    this.state.markProcessed(chatId, messageId);

    // Normalize the symbol (e.g. "ETHUSDT" → "ETH_USDT")
    const normalized = normalizeSymbol(rawSymbol);
    if (!normalized) {
      this.logger.warn(
        `⚠️ CANCEL: could not normalize symbol "${rawSymbol}"`
      );
      await this.sendCancelResult({
        status: "error",
        symbol: rawSymbol.toUpperCase(),
        direction,
        found: 0,
        cancelled: 0,
        failed: 0,
        error: `Could not normalize symbol "${rawSymbol}". Use format like ETHUSDT or ETH_USDT.`,
      });
      return;
    }
    const symbol = normalized;

    // Map direction to MEXC side for plan orders: LONG→1, SHORT→3
    const targetSide = direction === "LONG" ? 1 : 3;

    this.logger.info(`🗑️ CANCEL requested: ${symbol} ${direction}`);

    // Dry-run / disabled checks
    if (this.config.dryRun) {
      this.logger.info(`🧪 [DRY RUN] Would cancel ${symbol} ${direction} plan orders`);
      await this.sendCancelResult({
        status: "dry-run",
        symbol,
        direction,
        found: 0,
        cancelled: 0,
        failed: 0,
      });
      return;
    }
    if (!this.config.tradingEnabled) {
      await this.sendCancelResult({
        status: "disabled",
        symbol,
        direction,
        found: 0,
        cancelled: 0,
        failed: 0,
      });
      return;
    }

    // Fetch untriggered plan orders for this symbol only.
    let orders: any[];
    try {
      const res = await this.mexcClient.getPlanOrders(symbol, "1");
      orders = Array.isArray(res.data) ? res.data : [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `❌ Failed to fetch plan orders for ${symbol}: ${msg}`
      );
      await this.sendCancelResult({
        status: "error",
        symbol,
        direction,
        found: 0,
        cancelled: 0,
        failed: 0,
        error: `Failed to fetch plan orders: ${msg}`,
      });
      return;
    }

    // Filter by side
    const matching = orders.filter((o) => Number(o.side) === targetSide);

    if (matching.length === 0) {
      await this.sendCancelResult({
        status: "no-orders",
        symbol,
        direction,
        found: 0,
        cancelled: 0,
        failed: 0,
      });
      return;
    }

    this.logger.info(
      `🗑️ Found ${matching.length} matching ${direction} plan order(s) for ${symbol}`
    );

    // Cancel each plan order by its ID. The cancel endpoint accepts plan-order
    // IDs the same way as regular order IDs.
    const cancelledIds: string[] = [];
    const failedDetails: { id: string; reason: string }[] = [];

    for (const o of matching) {
      const oid = String(o.id ?? o.orderId ?? "");
      if (!oid) continue;
      try {
        await this.mexcClient.cancelOrder([oid]);
        cancelledIds.push(oid);
        this.logger.info(`🗑️ Cancelled plan order ${oid} (${symbol} ${direction})`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        failedDetails.push({ id: oid, reason: msg });
        this.logger.error(
          `❌ Failed to cancel plan order ${oid} (${symbol}): ${msg}`
        );
      }
    }

    if (failedDetails.length === 0) {
      await this.sendCancelResult({
        status: "success",
        symbol,
        direction,
        found: matching.length,
        cancelled: cancelledIds.length,
        failed: 0,
        cancelledIds,
      });
    } else {
      await this.sendCancelResult({
        status: "partial",
        symbol,
        direction,
        found: matching.length,
        cancelled: cancelledIds.length,
        failed: failedDetails.length,
        cancelledIds: cancelledIds.length > 0 ? cancelledIds : undefined,
        failedDetails,
      });
    }
  }

  /**
   * Store the SL/TP levels from a successfully placed trade so the summary
   * monitor can evaluate >50%-of-way alerts for the resulting position.
   */
  private registerSlTp(record: TradeRecord): void {
    const t = record.resolved;
    // Nearest TP: first target for the direction (lowest for LONG, highest for SHORT).
    const tps =
      t.allTpTargets.length > 0 ? t.allTpTargets : [t.takeProfitPrice];
    const nearestTp =
      t.side === 1 ? Math.min(...tps) : Math.max(...tps);

    this.slTpStore.set(t.mexcSymbol, t.side === 1 ? 1 : 2, {
      sl: t.stopLossPrice,
      tp: nearestTp,
      setAt: Date.now(),
      orderId: record.orderId,
    });
    this.logger.info(
      `💾 SL/TP stored for ${t.mexcSymbol}: SL=${t.stopLossPrice} TP=${nearestTp} orderId=${record.orderId}`
    );
  }

  /**
   * True when the message is the on-demand summary command:
   *   "CHECK POSITIONS" (case-insensitive, whitespace-tolerant) or the
   *   shortcut "@" — both emit the position summary immediately when sent
   *   to the summary channel.
   */
  private isCheckPositionsCommand(text: string): boolean {
    const t = text.trim();
    return t.toUpperCase() === "CHECK POSITIONS" || t === "@";
  }

  /**
   * Emit a position summary immediately when "CHECK POSITIONS" is sent to the
   * summary channel. The message is marked processed for idempotency, so a
   * restart or Telegram re-delivery won't re-trigger the same message.
   */
  private async handleCheckPositions(
    chatId: string,
    messageId: number
  ): Promise<void> {
    if (chatId !== this.config.summaryNotificationChannel) {
      this.logger.debug(
        `ℹ️ CHECK POSITIONS ignored — only works in the summary channel (${this.config.summaryNotificationChannel})`
      );
      return;
    }
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(
        `⏭️ CHECK POSITIONS ${chatId}#${messageId} already processed`
      );
      return;
    }

    this.state.markProcessed(chatId, messageId);
    this.logger.info(
      "📊 Summary requested — emitting summary immediately"
    );
    // Force a fresh fetch of pending (plan/trigger) orders — the summary
    // should reflect live Trigger-order state, not the 30s cache.
    await this.summaryMonitor.emitSummary(true);
  }

  /**
   * Resolve an order ID to (symbol, positionType) by trying getOrder first,
   * then falling back to getPlanOrders if the order is a plan/trigger order.
   *
   * Plan orders (from @price/EP signals) have a different ID namespace than
   * regular (fill) orders. When a plan order executes, MEXC populates its
   * `orderId` field with the fill order ID — that fill order IS findable via
   * getOrder.  This helper bridges the gap.
   */
  private async resolveOrderIdentity(
    orderId: string
  ): Promise<OrderIdentity | null> {
    // 1. Try getOrder (works for market orders and fill orders).
    try {
      const orderRes = await this.mexcClient.getOrder(orderId);
      const data: any = (orderRes as any).data ?? orderRes;
      const symbol: string = data?.symbol ?? "";
      const side: number | undefined = data?.side;

      if (symbol && side !== undefined) {
        // side 1=open long → positionType 1 (LONG)
        // side 3=open short → positionType 2 (SHORT)
        const positionType: 1 | 2 = side === 1 ? 1 : side === 3 ? 2 : (side === 2 ? 2 : 1);
        if ((side === 1 || side === 3) && symbol && (positionType === 1 || positionType === 2)) {
          this.logger.info(`🔍 Resolved order ${orderId} via getOrder: ${symbol} ${positionType === 1 ? "LONG" : "SHORT"}`);
          return { symbol, positionType };
        }
      }
    } catch {
      // getOrder threw — order not found as a regular order. Fall through.
      this.logger.debug(`🔍 getOrder failed for ${orderId} — trying plan orders`);
    }

    // 2. Fall back to plan orders. Fetch untriggered (state 1) AND executed (state 3).
    try {
      const planRes: PlanOrderListResponse = await this.mexcClient.getPlanOrders(
        undefined, "1,3"
      );
      const planData: any = (planRes as any).data ?? planRes;
      const plans: any[] = Array.isArray(planData)
        ? planData
        : Array.isArray(planData?.orders) ? planData.orders
        : Array.isArray(planData?.resultList) ? planData.resultList
        : Array.isArray(planData?.list) ? planData.list
        : [];

      for (const p of plans) {
        const pid = String(p.id ?? p.orderId ?? "");
        if (pid !== orderId) continue;

        const symbol = String(p.symbol ?? "");
        const side = Number(p.side);
        if (!symbol || (side !== 1 && side !== 3)) continue;

        // If the plan order executed (state 3), try to resolve via its fill orderId.
        if (Number(p.state) === 3 && p.orderId && String(p.orderId) !== "0") {
          const fillId = String(p.orderId);
          this.logger.info(`🔍 Plan order ${orderId} executed → fill order ${fillId}`);
          try {
            const fillRes = await this.mexcClient.getOrder(fillId);
            const fillData: any = (fillRes as any).data ?? fillRes;
            const fillSymbol = fillData?.symbol ?? "";
            const fillSide = Number(fillData?.side);
            if (fillSymbol && (fillSide === 1 || fillSide === 3)) {
              const positionType: 1 | 2 = fillSide === 1 ? 1 : 2;
              return { symbol: fillSymbol, positionType };
            }
          } catch {
            this.logger.warn(`⚠️ Fill order ${fillId} not found — using plan-order metadata`);
          }
        }

        // Fall back to plan-order metadata.
        const positionType: 1 | 2 = side === 1 ? 1 : 2;
        this.logger.info(`🔍 Resolved order ${orderId} via plan order: ${symbol} ${positionType === 1 ? "LONG" : "SHORT"}`);
        return { symbol, positionType };
      }
    } catch (e) {
      this.logger.debug(`🔍 getPlanOrders also failed for ${orderId}: ${e instanceof Error ? e.message : e}`);
    }

    return null;
  }

  /**
   * Resolve a user-supplied ID to an open position.
   *
   * Priority:
   *   1. Direct `positionId` match against open positions — this is the ID the
   *      summary now shows as the primary CLOSE identifier. It is always
   *      present on the open-positions API and carries the authoritative
   *      `positionType`, so closing by it never hits MEXC's "wrong direction"
   *      error (critical in hedge mode, where a symbol can hold both a LONG
   *      and a SHORT position simultaneously).
   *   2. Legacy order-ID resolution (fill order ID via getOrder, or plan/trigger
   *      order ID via the plan-order list) through resolveOrderIdentity, then
   *      matched by symbol + positionType.
   *
   * Returns `{ position, symbol }` on success, or null when the ID is unknown.
   * Throws when the open-positions fetch itself fails (caller surfaces the error).
   */
  private async resolveOpenPosition(
    orderId: string
  ): Promise<{ position: Position; symbol: string } | null> {
    let positions: Position[] = [];
    try {
      const res = await this.mexcClient.getOpenPositions();
      positions = Array.isArray(res.data) ? res.data : [];
    } catch (error) {
      this.logger.error(
        "❌ Failed to fetch open positions:",
        error instanceof Error ? error.message : error
      );
      throw error;
    }

    // 1. Direct positionId match — the ID shown in the summary.
    const byPositionId = positions.find(
      (p) => String(p.positionId) === orderId && p.state !== 3 && p.holdVol > 0
    );
    if (byPositionId) {
      this.logger.info(
        `🔍 Resolved ${orderId} via positionId → ${byPositionId.symbol} ${byPositionId.positionType === 1 ? "LONG" : "SHORT"}`
      );
      return { position: byPositionId, symbol: byPositionId.symbol };
    }

    // 2. Order-ID resolution (fill order ID / plan order ID).
    const identity = await this.resolveOrderIdentity(orderId);
    if (!identity) return null;

    const position = positions.find(
      (p) =>
        p.symbol === identity.symbol &&
        p.positionType === identity.positionType &&
        p.state !== 3 &&
        p.holdVol > 0
    );
    if (!position) return null;
    return { position, symbol: identity.symbol };
  }

  /**
   * Close a position immediately by its MEXC official order ID or position ID.
   * Resolves via the MEXC `getOrder` API (no local order-ID storage).
   *
   * @param orderId     MEXC position ID or order ID to look up and close.
   * @param closePercent Optional partial-close percentage (1–100, default 100 = full close).
   */
  private async handleClosePosition(
    orderId: string,
    chatId: string,
    messageId: number,
    closePercent?: number
  ): Promise<void> {
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(`⏭️ Close ${orderId} already processed`);
      return;
    }
    this.state.markProcessed(chatId, messageId);

    this.logger.info(`🔚 Close requested for order ${orderId}`);

    // 1. Resolve the target position — tries the summary positionId first
    //    (most reliable), then fill/plan order IDs via resolveOrderIdentity.
    let resolved: { position: Position; symbol: string } | null;
    try {
      resolved = await this.resolveOpenPosition(orderId);
    } catch (error) {
      await this.sendCloseResult({
        status: "error",
        queriedId: orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!resolved) {
      this.logger.error(`❌ Could not resolve order ${orderId}`);
      await this.sendCloseResult({ status: "unknown", queriedId: orderId });
      return;
    }
    const { symbol, position } = resolved;
    const positionType = position.positionType;

    // 3. Resolve current price for market close.
    let currentPrice = 0;
    try {
      const ticker = await this.mexcClient.getTicker(symbol);
      currentPrice = ticker?.data?.lastPrice ?? 0;
    } catch {
      // fall through with 0; MEXC market orders accept price=0
    }

    // 4. Resolve contract details for volume precision.
    await this.resolver.refreshIfNeeded();
    const contract = await this.resolver.resolve(symbol);

    // 5. Validate and normalise close percent.
    const pct = closePercent !== undefined ? Math.min(100, Math.max(1, closePercent)) : 100;
    const isPartial = pct < 100;

    this.logger.info(
      `🔚 Closing ${symbol} ${positionType === 1 ? "LONG" : "SHORT"} ` +
      `${isPartial ? `${pct}% (partial)` : "100% (full)"} — holdVol=${position.holdVol}`
    );

    // 6. Close.
    const result = await this.executor.closePosition(
      symbol,
      position,
      currentPrice,
      positionType,
      position.openType,
      position.leverage,
      pct,
      contract?.volScale,
      contract?.volUnit,
      contract?.priceUnit
    );

    if (result.success) {
      if (!isPartial) {
        this.slTpStore.removeSymbol(symbol);
      }
      // Resolve realized PNL from position history so the close confirmation
      // includes it. Only meaningful for full closes in live mode — partial
      // closes leave the position open, and dry runs place no order.
      const fallbackMargin = position.oim || position.im || 0;
      const pnl =
        !isPartial && !this.config.dryRun
          ? await this.fetchClosedPnl(symbol, positionType, position.positionId, fallbackMargin)
          : null;
      await this.sendCloseResult({
        status: this.config.dryRun ? "dry-run" : "success",
        queriedId: orderId,
        symbol,
        positionType,
        leverage: position.leverage,
        volume: result.volume,
        price: currentPrice || undefined,
        orderId: result.orderId,
        closePercent: isPartial ? pct : undefined,
        currency: this.config.baseCurrency,
        ...(pnl ?? {}),
      });
    } else {
      await this.sendCloseResult({
        status: "error",
        queriedId: orderId,
        symbol,
        error: result.error,
      });
    }
  }

  /**
   * Fetch the realized PNL for a just-closed position from MEXC position
   * history. History can lag the close order slightly, so it retries briefly.
   *
   * @param fallbackMargin Margin from the open-position snapshot, used when
   *                       the history record returns oim/im as 0 (common).
   * @returns `{ realisedPnl, pnlPercent }` when the closed record is found,
   *          or null when it can't be resolved (caller omits the PNL line).
   */
  private async fetchClosedPnl(
    symbol: string,
    positionType: 1 | 2,
    positionId: number,
    fallbackMargin = 0,
  ): Promise<{ realisedPnl: number; pnlPercent: number } | null> {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.mexcClient.getPositionHistory({
          symbol,
          type: positionType,
          page_num: 1,
          page_size: 100,
        });
        const list: Position[] = Array.isArray(res.data) ? res.data : [];
        const found = list.find(
          (p) => String(p.positionId) === String(positionId)
        );
        if (found) {
          const historyMargin = found.oim || found.im || 0;
          const margin = historyMargin > 0 ? historyMargin : fallbackMargin;
          const realisedPnl = Number.isFinite(found.realised) ? found.realised : 0;
          return {
            realisedPnl,
            pnlPercent: margin > 0 ? (realisedPnl / margin) * 100 : 0,
          };
        }
      } catch (error) {
        this.logger.warn(
          `⚠️ Position history fetch failed for close PNL (attempt ${attempt}/${maxAttempts}):`,
          error instanceof Error ? error.message : error
        );
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 750 * attempt));
      }
    }
    return null;
  }

  /**
   * Reverse a position: close it fully, then open the opposite direction
   * at market price with mirrored SL/TP distance.
   *
   * "REVERSE {orderId}" → close LONG → open SHORT (or vice versa).
   */
  private async handleReversePosition(
    orderId: string,
    chatId: string,
    messageId: number
  ): Promise<void> {
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(`⏭️ Reverse ${orderId} already processed`);
      return;
    }
    this.state.markProcessed(chatId, messageId);

    this.logger.info(`🔄 Reverse requested for order ${orderId}`);

    // 1. Resolve the target position — positionId first, then order IDs.
    let resolved: { position: Position; symbol: string } | null;
    try {
      resolved = await this.resolveOpenPosition(orderId);
    } catch (error) {
      await this.sendReverseResult({
        status: "error",
        queriedId: orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!resolved) {
      this.logger.error(`❌ Could not resolve order ${orderId} for reverse`);
      await this.sendReverseResult({ status: "unknown", queriedId: orderId });
      return;
    }
    const { symbol, position } = resolved;
    const positionType = position.positionType;
    const originalDir = positionType === 1 ? "LONG" : "SHORT";

    // 3. Get current price.
    let currentPrice = 0;
    try {
      const ticker = await this.mexcClient.getTicker(symbol);
      currentPrice = ticker?.data?.lastPrice ?? 0;
    } catch { /* fall through with 0 */ }
    if (!currentPrice || currentPrice <= 0) {
      await this.sendReverseResult({
        status: "error", queriedId: orderId, symbol,
        error: "Could not resolve current market price",
      });
      return;
    }

    // 4. Get stored SL/TP for this position direction (for mirroring distance).
    const slTp = this.slTpStore.get(symbol, positionType);
    let newSl: number;
    let newTp: number;

    if (slTp && slTp.sl > 0 && slTp.tp > 0) {
      // Mirror the SL/TP distance from current price.
      const slDist = Math.abs(currentPrice - slTp.sl);
      const tpDist = Math.abs(slTp.tp - currentPrice);

      if (positionType === 1) {
        // Was LONG → now SHORT: SL above, TP below
        newSl = currentPrice + slDist;
        newTp = currentPrice - tpDist;
      } else {
        // Was SHORT → now LONG: SL below, TP above
        newSl = currentPrice - slDist;
        newTp = currentPrice + tpDist;
      }
      this.logger.info(
        `🔄 Mirroring SL/TP: was SL=${slTp.sl} TP=${slTp.tp} → new SL=${newSl} TP=${newTp} (dist: sl=${slDist.toFixed(4)} tp=${tpDist.toFixed(4)})`
      );
    } else {
      // No stored SL/TP — derive from position's holdAvgPrice and a 2% distance heuristic.
      const dist = currentPrice * 0.02;
      if (positionType === 1) {
        newSl = currentPrice + dist;
        newTp = currentPrice - dist * 1.5;
      } else {
        newSl = currentPrice - dist;
        newTp = currentPrice + dist * 1.5;
      }
      this.logger.info(
        `🔄 No stored SL/TP — using heuristic: SL=${newSl} TP=${newTp} (2% distance)`
      );
    }

    // 5. Get contract details for vol precision + later sizing.
    await this.resolver.refreshIfNeeded();
    const contract = await this.resolver.resolve(symbol);
    if (!contract) {
      await this.sendReverseResult({
        status: "error", queriedId: orderId, symbol,
        originalDirection: originalDir,
        error: `Symbol ${symbol} not tradable`,
      });
      return;
    }

    // 6. Close the position fully (100%).
    const closeResult = await this.executor.closePosition(
      symbol, position, currentPrice, positionType, position.openType, position.leverage, 100,
      contract?.volScale, contract?.volUnit, contract?.priceUnit
    );
    if (!closeResult.success) {
      await this.sendReverseResult({
        status: "error", queriedId: orderId, symbol,
        originalDirection: originalDir,
        error: closeResult.error ?? "Close order failed",
      });
      return;
    }
    this.slTpStore.removeSymbol(symbol);

    // Dry-run: stop after the close step.
    if (this.config.dryRun) {
      await this.sendReverseResult({
        status: "dry-run", queriedId: orderId, symbol,
        originalDirection: originalDir,
        newDirection: positionType === 1 ? "SHORT" : "LONG",
        leverage: position.leverage,
        closedVolume: position.holdVol,
        price: currentPrice || undefined,
        newVolume: 0,
        stopLoss: newSl,
        takeProfit: newTp,
      });
      return;
    }

    if (!this.config.tradingEnabled) {
      await this.sendReverseResult({
        status: "disabled", queriedId: orderId,
      });
      return;
    }

    // 7. Fetch equity for sizing the new position.
    let equity: number;
    try {
      equity = await this.fetchEquity();
    } catch (error) {
      await this.sendReverseResult({
        status: "error", queriedId: orderId, symbol,
        originalDirection: originalDir,
        error: "Failed to fetch equity for sizing",
      });
      return;
    }

    // 8. Build a synthetic TradeSignal for the opposite direction and size it.
    const newAction = positionType === 1 ? "SELL" : "BUY";
    const syntheticSignal: TradeSignal = {
      raw: `REVERSE ${orderId}`,
      action: newAction as "BUY" | "SELL",
      rawSymbol: symbol.replace("_", ""),
      entry: currentPrice,
      sl: newSl,
      tp: [newTp],
      orderType: "market",
    };

    const resolvedTrade = calculatePositionSize(
      syntheticSignal, contract, equity, currentPrice, this.config, this.logger
    );
    if (!resolvedTrade) {
      await this.sendReverseResult({
        status: "error", queriedId: orderId, symbol,
        originalDirection: originalDir,
        error: "Position sizing failed for reversed trade",
      });
      return;
    }

    // 9. Execute the new market order.
    const records = await this.executor.execute(resolvedTrade);
    const record = records[0];

    if (record?.success) {
      this.registerSlTp(record);
      await this.sendReverseResult({
        status: "success", queriedId: orderId, symbol,
        originalDirection: originalDir,
        newDirection: positionType === 1 ? "SHORT" : "LONG",
        leverage: position.leverage,
        closedVolume: closeResult.volume ?? position.holdVol,
        newVolume: resolvedTrade.volume,
        price: currentPrice || undefined,
        closeOrderId: closeResult.orderId,
        newOrderId: record.orderId,
        stopLoss: resolvedTrade.stopLossPrice,
        takeProfit: resolvedTrade.takeProfitPrice,
      });
    } else {
      await this.sendReverseResult({
        status: "error", queriedId: orderId, symbol,
        originalDirection: originalDir,
        error: record?.error ?? "Reverse order failed",
      });
    }
  }

  /**
   * Add to an existing position at market price with the same SL/TP.
   *
   * "ADD TO {orderId} [{riskPercent}%]" — the risk percent determines the
   * new lotsize as a percentage of equity (default 1%). SL/TP are inherited
   * from the original position (via slTpStore).
   */
  private async handleAddToPosition(
    orderId: string,
    chatId: string,
    messageId: number,
    riskPercent: number
  ): Promise<void> {
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(`⏭️ ADD TO ${orderId} already processed`);
      return;
    }
    this.state.markProcessed(chatId, messageId);

    // Clamp risk percent to 0.1–6%
    const pct = Math.min(6, Math.max(0.1, riskPercent));
    this.logger.info(`➕ ADD TO requested for order ${orderId} at ${pct}% risk`);

    // 1. Resolve the target position — positionId first, then order IDs.
    let resolved: { position: Position; symbol: string } | null;
    try {
      resolved = await this.resolveOpenPosition(orderId);
    } catch (error) {
      await this.sendAddToResult({
        status: "error",
        queriedId: orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!resolved) {
      this.logger.error(`❌ Could not resolve order ${orderId} for add-to`);
      await this.sendAddToResult({ status: "unknown", queriedId: orderId });
      return;
    }
    const { symbol, position } = resolved;
    const positionType = position.positionType;
    const dir = positionType === 1 ? "LONG" : "SHORT";

    // 3. Get current price.
    let currentPrice = 0;
    try {
      const ticker = await this.mexcClient.getTicker(symbol);
      currentPrice = ticker?.data?.lastPrice ?? 0;
    } catch { /* fall through */ }
    if (!currentPrice || currentPrice <= 0) {
      await this.sendAddToResult({
        status: "error", queriedId: orderId, symbol,
        error: "Could not resolve current market price",
      });
      return;
    }

    // 4. Get stored SL/TP for this position direction — required for consistent risk sizing.
    const slTp = this.slTpStore.get(symbol, positionType);
    if (!slTp || slTp.sl <= 0 || slTp.tp <= 0) {
      await this.sendAddToResult({
        status: "error", queriedId: orderId, symbol,
        error: "No stored SL/TP found for this position. ADD TO requires an existing position with known SL/TP levels.",
      });
      return;
    }

    // Validate SL is on the correct side of current price for the direction.
    const slValid = positionType === 1
      ? slTp.sl < currentPrice  // LONG: SL must be below entry
      : slTp.sl > currentPrice; // SHORT: SL must be above entry
    if (!slValid) {
      await this.sendAddToResult({
        status: "error", queriedId: orderId, symbol, direction: dir,
        error: `SL (${slTp.sl}) is on the wrong side of current price (${currentPrice}) for a ${dir} — cannot safely add.`,
      });
      return;
    }

    // 5. Fetch equity.
    let equity: number;
    try {
      equity = await this.fetchEquity();
    } catch (error) {
      await this.sendAddToResult({
        status: "error", queriedId: orderId, symbol,
        error: "Failed to fetch equity for sizing",
      });
      return;
    }

    // 6. Get contract details.
    await this.resolver.refreshIfNeeded();
    const contract = await this.resolver.resolve(symbol);
    if (!contract) {
      await this.sendAddToResult({
        status: "error", queriedId: orderId, symbol,
        error: `Symbol ${symbol} not tradable`,
      });
      return;
    }

    // 7. Build a synthetic TradeSignal and size it.
    const action = positionType === 1 ? "BUY" : "SELL";
    const syntheticSignal: TradeSignal = {
      raw: `ADD TO ${orderId}`,
      action: action as "BUY" | "SELL",
      rawSymbol: symbol.replace("_", ""),
      entry: currentPrice,
      sl: slTp.sl,
      tp: [slTp.tp],
      orderType: "market",
      riskPercentOverride: pct,
    };

    const resolvedTrade = calculatePositionSize(
      syntheticSignal, contract, equity, currentPrice, this.config, this.logger
    );
    if (!resolvedTrade) {
      await this.sendAddToResult({
        status: "error", queriedId: orderId, symbol, direction: dir,
        error: "Position sizing failed — risk amount may be too small for min order volume",
      });
      return;
    }

    // Dry-run.
    if (this.config.dryRun) {
      await this.sendAddToResult({
        status: "dry-run", queriedId: orderId, symbol,
        direction: dir, leverage: position.leverage,
        addedVolume: resolvedTrade.volume,
        totalVolume: position.holdVol + resolvedTrade.volume,
        price: currentPrice || undefined,
        riskPercent: pct,
        stopLoss: resolvedTrade.stopLossPrice,
        takeProfit: resolvedTrade.takeProfitPrice,
      });
      return;
    }

    if (!this.config.tradingEnabled) {
      await this.sendAddToResult({ status: "disabled", queriedId: orderId });
      return;
    }

    // 8. Execute the market order.
    const records = await this.executor.execute(resolvedTrade);
    const record = records[0];

    if (record?.success) {
      this.registerSlTp(record);
      await this.sendAddToResult({
        status: "success", queriedId: orderId, symbol,
        direction: dir, leverage: position.leverage,
        addedVolume: resolvedTrade.volume,
        totalVolume: position.holdVol + resolvedTrade.volume,
        price: currentPrice || undefined,
        orderId: record.orderId,
        riskPercent: pct,
        stopLoss: resolvedTrade.stopLossPrice,
        takeProfit: resolvedTrade.takeProfitPrice,
      });
    } else {
      await this.sendAddToResult({
        status: "error", queriedId: orderId, symbol, direction: dir,
        error: record?.error ?? "Add-to order failed",
      });
    }
  }

  /**
   * Place every order currently in the pending queue.
   *
   * "CONFIRM ORDERS" — drains the queue, submitting each queued trade via the
   * executor. Sends an order-placed notification for each successful record
   * (skipped in dry-run, mirroring the direct-execution path).
   */
  private async handleConfirmOrders(
    chatId: string,
    messageId: number
  ): Promise<void> {
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(`⏭️ CONFIRM ORDERS already processed`);
      return;
    }
    this.state.markProcessed(chatId, messageId);

    if (this.orderQueue.length === 0) {
      this.logger.info("🧾 CONFIRM ORDERS: queue is empty — nothing to place");
      await this.sendToChannel(
        chatId,
        `🧾 <b>CONFIRM ORDERS</b>\n\nNo pending orders in the queue.`,
        "Empty-queue notice"
      );
      return;
    }

    const pending = [...this.orderQueue];
    this.orderQueue = [];
    this.persistQueue();
    this.logger.info(
      `🧾 CONFIRM ORDERS: placing ${pending.length} queued order(s)`
    );

    for (const queued of pending) {
      const trade = queued.trade;
      const records = await this.executor.execute(trade);
      for (const record of records) {
        if (record.success) {
          this.logger.info(
            `✅ Trade executed: ${record.orderId} for ${trade.mexcSymbol}`
          );
          // Notify the summary channel that an order was placed/executed
          // (skip in dry-run — no real order was submitted).
          if (!this.config.dryRun) {
            await this.sendOrderPlacedNotification(record);
            this.registerSlTp(record);
          }
        } else {
          this.logger.error(
            `❌ Trade failed: ${record.error} for ${trade.mexcSymbol}`
          );
        }
      }
    }
  }

  /**
   * Discard all orders currently in the pending queue.
   *
   * "CANCEL ORDERS" — removes every queued trade without placing anything.
   */
  private async handleCancelQueue(
    chatId: string,
    messageId: number
  ): Promise<void> {
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(`⏭️ CANCEL ORDERS already processed`);
      return;
    }
    this.state.markProcessed(chatId, messageId);

    const count = this.orderQueue.length;
    this.orderQueue = [];
    this.persistQueue();
    this.logger.info(`🧾 CANCEL ORDERS: discarded ${count} queued order(s)`);
    await this.sendToChannel(
      chatId,
      `🗑️ <b>CANCEL ORDERS</b>\n\nDiscarded ${count} queued order(s).`,
      "Queue-cancel notice"
    );
  }

  /**
   * Remove a single order from the pending queue by its queue ID (e.g. "Q2").
   *
   * "CANCEL Q2" — removes only that queued order, leaving the rest pending.
   */
  private async handleCancelQueuedOrder(
    id: string,
    chatId: string,
    messageId: number
  ): Promise<void> {
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(`⏭️ CANCEL ${id} already processed`);
      return;
    }
    this.state.markProcessed(chatId, messageId);

    const normalized = id.toUpperCase();
    const index = this.orderQueue.findIndex(
      (q) => q.id.toUpperCase() === normalized
    );
    if (index === -1) {
      this.logger.warn(`🗑️ CANCEL ${id}: no queued order with that ID`);
      const current =
        this.orderQueue.length > 0
          ? `Current queue: ${this.orderQueue.map((q) => q.id).join(", ")}.`
          : "Queue is empty.";
      await this.sendToChannel(
        chatId,
        `🗑️ <b>CANCEL ${id}</b>\n\nNo queued order with ID <code>${id}</code>. ${current}`,
        "Queue-cancel notice"
      );
      return;
    }

    const [removed] = this.orderQueue.splice(index, 1);
    this.persistQueue();
    const sideLabel = removed.trade.side === 1 ? "LONG" : "SHORT";
    const remaining =
      this.orderQueue.length > 0
        ? `\nRemaining: ${this.orderQueue
            .map((q) => `${q.id} · ${q.trade.mexcSymbol}`)
            .join(", ")}.`
        : "";
    this.logger.info(
      `🗑️ CANCEL ${id}: removed ${removed.trade.mexcSymbol} ${sideLabel} — ${this.orderQueue.length} order(s) remaining`
    );
    await this.sendToChannel(
      chatId,
      `🗑️ <b>CANCEL ${id}</b>\n\nRemoved ${removed.trade.mexcSymbol} ${sideLabel} from the queue. ${this.orderQueue.length} order(s) remaining.${remaining}`,
      "Queue-cancel notice"
    );
  }

  /**
   * "LIST QUEUE" — displays all currently queued orders with their IDs,
   * symbols, sides, entry/Tp/SL prices, and volume. Non-idempotent (always
   * responds) so the operator can check the queue at any time.
   */
  private async handleListQueue(chatId: string): Promise<void> {
    if (this.orderQueue.length === 0) {
      await this.sendToChannel(
        chatId,
        `📋 <b>QUEUE</b>\n\nNo pending orders.`,
        "List-queue notice"
      );
      return;
    }

    const rows = this.orderQueue.map((q) => {
      const t = q.trade;
      const dir = t.side === 1 ? "LONG" : "SHORT";
      const entry = t.signal.entry;
      const sl = t.signal.sl;
      const tp =
        t.signal.tp.length > 0
          ? t.signal.tp.join(" / ")
          : t.takeProfitPrice;
      return (
        `  <code>${q.id}</code> · ${t.mexcSymbol} ${dir} · ${t.leverage}x\n` +
        `    Entry: ${entry} · SL: ${sl} · TP: ${tp} · Vol: ${t.volume}`
      );
    });

    const text =
      `📋 <b>QUEUE (${this.orderQueue.length})</b>\n\n${rows.join("\n")}\n\n` +
      `Send <code>CONFIRM ORDERS</code> to place all · ` +
      `<code>CANCEL ORDERS</code> to discard · ` +
      `<code>CANCEL {ID}</code> to remove one`;

    await this.sendToChannel(chatId, text, "List-queue notice");
  }

  // ── Queue persistence ───────────────────────────────────────────────

  /**
   * Persist the current queue to disk so it survives bot restarts.
   * Serialises only the essential fields needed to reconstruct each
   * QueuedOrder (the full ResolvedTrade is too large and contains
   * non-serialisable references).
   */
  private saveQueue(): void {
    try {
      const dir = path.dirname(this.queueFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = this.orderQueue.map((q) => ({
        id: q.id,
        symbol: q.trade.mexcSymbol,
        side: q.trade.side,
        leverage: q.trade.leverage,
        openType: q.trade.openType,
        volume: q.trade.volume,
        entry: q.trade.entry,
        stopLossPrice: q.trade.stopLossPrice,
        takeProfitPrice: q.trade.takeProfitPrice,
        allTpTargets: q.trade.allTpTargets,
        equity: q.trade.equity,
        riskPercent: q.trade.riskPercent,
        riskAmount: q.trade.riskAmount,
        contractSize: q.trade.contractSize,
        takerFeeRate: q.trade.takerFeeRate,
        makerFeeRate: q.trade.makerFeeRate,
        // Preserve the original signal so precision is not lost.
        signalAction: q.trade.signal.action,
        signalRawSymbol: q.trade.signal.rawSymbol,
        signalEntry: q.trade.signal.entry,
        signalSl: q.trade.signal.sl,
        signalTp: q.trade.signal.tp,
        signalOrderType: q.trade.signal.orderType,
        signalRiskPercentOverride: q.trade.signal.riskPercentOverride,
        signalLeverageOverride: q.trade.signal.leverageOverride,
        signalExecuteCycle: q.trade.signal.executeCycle,
      }));
      fs.writeFileSync(this.queueFilePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (error) {
      this.logger.error("❌ Failed to persist queue:", error);
    }
  }

  /**
   * Load a previously persisted queue from disk. Reconstructs QueuedOrder
   * objects (without the full ResolvedTrade, since that requires the live
   * contract cache). The reconstructed orders can be listed/cancelled but
   * cannot be executed without a live contract cache.
   */
  private async loadQueue(): Promise<void> {
    try {
      if (!fs.existsSync(this.queueFilePath)) return;
      const raw = fs.readFileSync(this.queueFilePath, "utf-8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data) || data.length === 0) return;

      // We need the contract cache to rebuild ResolvedTrade objects.
      await this.resolver.refreshIfNeeded();

      let restored = 0;
      for (const item of data) {
        if (!item.symbol || !item.signalAction) continue;
        const contract = await this.resolver.resolve(item.symbol);
        if (!contract) {
          this.logger.warn(
            `⚠️ Queue restore: contract ${item.symbol} not found — skipping queued order ${item.id}`
          );
          continue;
        }

        // Reconstruct a minimal TradeSignal from the persisted fields.
        const signal: TradeSignal = {
          raw: `[restored] ${item.signalAction} ${item.signalRawSymbol}`,
          action: item.signalAction,
          rawSymbol: item.signalRawSymbol,
          entry: item.signalEntry ?? item.entry,
          sl: item.signalSl ?? item.stopLossPrice,
          tp: item.signalTp ?? (item.allTpTargets?.length ? item.allTpTargets : [item.takeProfitPrice]),
          orderType: item.signalOrderType ?? "market",
          riskPercentOverride: item.signalRiskPercentOverride,
          leverageOverride: item.signalLeverageOverride,
          executeCycle: item.signalExecuteCycle,
        };

        const trade: ResolvedTrade = {
          signal,
          mexcSymbol: item.symbol,
          volume: item.volume,
          side: item.side,
          leverage: item.leverage,
          openType: item.openType ?? 1,
          entry: item.entry,
          stopLossPrice: item.stopLossPrice,
          takeProfitPrice: item.takeProfitPrice,
          allTpTargets: item.allTpTargets ?? [item.takeProfitPrice],
          equity: item.equity ?? 0,
          riskPercent: item.riskPercent ?? 0.005,
          riskAmount: item.riskAmount ?? 0,
          minVol: contract.minVol,
          volScale: contract.volScale ?? 0,
          volUnit: contract.volUnit ?? 1,
          currentPrice: item.entry,
          contractSize: item.contractSize ?? contract.contractSize ?? 1,
          takerFeeRate: item.takerFeeRate ?? contract.takerFeeRate,
          makerFeeRate: item.makerFeeRate ?? contract.makerFeeRate,
        };

        this.orderQueue.push({ id: item.id, trade });
        restored++;
      }

      // Restore the queue counter so new IDs don't collide.
      for (const q of this.orderQueue) {
        const num = parseInt(q.id.replace(/^Q/i, ""), 10);
        if (!isNaN(num) && num > this.queueCounter) {
          this.queueCounter = num;
        }
      }

      if (restored > 0) {
        this.logger.info(
          `📋 Restored ${restored} queued order(s) from previous session`
        );
      }
    } catch (error) {
      this.logger.warn("⚠️ Could not load queue file — starting with empty queue");
    }
  }

  /**
   * Call after any mutation to the queue: persists to disk and updates the
   * confirmation message if needed.
   */
  private persistQueue(): void {
    this.saveQueue();
  }

  /**
   * Send a short text message to a specific Telegram channel (HTML parse mode).
   */
  private async sendToChannel(
    channel: string,
    text: string,
    logTag: string
  ): Promise<void> {
    try {
      await this.telegram.telegram.sendMessage(channel, text, {
        parse_mode: "HTML",
      });
      this.logger.info(`${logTag} sent to ${channel}`);
    } catch (error) {
      this.logger.error(
        `❌ Failed to send ${logTag}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Send a pre-trade confirmation to the allowed channel the signal came from.
   * Shows the expected TP/SL and estimated realized PNL (including fees) before
   * any order is submitted to MEXC. Skips non-allowed channels.
   */
  private async sendTradeConfirmation(
    t: ResolvedTrade,
    chatId?: number | string
  ): Promise<void> {
    if (chatId === undefined || chatId === null) return;
    const channel = String(chatId);
    // Only send confirmations back to an allowed trading channel.
    if (!this.isAllowedChannel(channel)) {
      this.logger.debug(
        `🧾 Skipping trade confirmation to non-allowed channel ${channel}`
      );
      return;
    }
    const text = formatTradeConfirmationMessage(t, this.config.baseCurrency, {
      useLimitTpSl: this.config.useLimitTpSl,
      dryRun: this.config.dryRun,
      queue: this.orderQueue.map((q) => ({
        id: q.id,
        symbol: q.trade.mexcSymbol,
        sideLabel: q.trade.side === 1 ? "LONG" : "SHORT",
        entry: q.trade.signal.entry,
        tp: q.trade.signal.tp[0] ?? q.trade.takeProfitPrice,
        sl: q.trade.signal.sl,
        volume: q.trade.volume,
        contractSize: q.trade.contractSize,
      })),
    });
    try {
      await this.telegram.telegram.sendMessage(channel, text, {
        parse_mode: "HTML",
      });
      this.logger.info(`🧾 Trade confirmation sent to ${channel}`);
    } catch (error) {
      this.logger.error(
        "❌ Failed to send trade confirmation:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Send an order-placed notification to the summary channel.
   */
  private async sendOrderPlacedNotification(record: TradeRecord): Promise<void> {
    if (!this.config.summaryNotificationChannel) return;
    const text = formatOrderPlacedMessage(record, this.config.baseCurrency, {
      useLimitTpSl: this.config.useLimitTpSl,
    });
    try {
      await this.telegram.telegram.sendMessage(
        this.config.summaryNotificationChannel,
        text,
        { parse_mode: "HTML" }
      );
      this.logger.info(
        `🚀 Order-placed notification sent to ${this.config.summaryNotificationChannel}`
      );
    } catch (error) {
      this.logger.error(
        "❌ Failed to send order-placed notification:",
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Handle an incoming text message from Telegram (group/DM or channel post).
   */
  private async handleTelegramMessage(
    ctx: Context,
    source: "message" | "channel_post"
  ): Promise<void> {
    // Extract message data from the correct context property
    const msg: any = source === "channel_post"
      ? (ctx as any).channelPost
      : (ctx as any).message;
    if (!msg || !msg.text) return;

    const chatId = String(msg.chat.id);
    const messageId = msg.message_id;
    const text: string = msg.text;

    // On-demand summary: "CHECK POSITIONS" sent to the summary channel emits
    // the position summary immediately instead of waiting for the next
    // cadence. Handled before the allowed-channel gate so it also works when
    // the summary channel isn't listed in ALLOWED_CHANNELS.
    if (this.isCheckPositionsCommand(text)) {
      await this.handleCheckPositions(chatId, messageId);
      return;
    }

    // Check if from allowed channel
    const chatUsername = msg.chat?.username;
    if (!this.isAllowedChannel(chatId, chatUsername)) {
      // Not a trading channel — check if it's a resolver (info-only) channel
      if (this.isResolverChannel(chatId, chatUsername)) {
        await this.handleResolverMessage(text, chatId, messageId, msg.date);
        return;
      }
      return; // silently ignore
    }

    // Whether this channel uses the queue+confirmation flow (listed in
    // CONFIRM_CHANNELS). Other allowed channels place orders automatically.
    const isConfirmChannel = this.isConfirmChannel(chatId, chatUsername);

    // Queue commands — signals are queued but NOT placed until the operator
    // confirms: "CONFIRM ORDERS" places every queued order, "CANCEL ORDERS"
    // discards the pending queue without placing anything. Only honored on
    // channels configured for the confirmation flow (CONFIRM_CHANNELS).
    if (isConfirmChannel) {
      if (/^confirm\s+orders?\s*$/i.test(text.trim())) {
        await this.handleConfirmOrders(chatId, messageId);
        return;
      }
      if (/^cancel\s+orders?\s*$/i.test(text.trim())) {
        await this.handleCancelQueue(chatId, messageId);
        return;
      }

      // Cancel a single queued order by its queue ID: "CANCEL Q2" — removes
      // only that order from the pending queue, leaving the rest intact.
      const cancelQueuedMatch = /^cancel\s+(Q\d+)\s*$/i.exec(text.trim());
      if (cancelQueuedMatch) {
        await this.handleCancelQueuedOrder(
          cancelQueuedMatch[1],
          chatId,
          messageId
        );
        return;
      }

      // "LIST QUEUE" — displays all currently queued orders with their IDs.
      if (/^list\s+queue\s*$/i.test(text.trim())) {
        await this.handleListQueue(chatId);
        return;
      }
    }

    // Cancel command: "CANCEL {SYMBOL} {DIRECTION}" — finds pending plan
    // (trigger) orders for the symbol/direction and cancels them.
    const cancelMatch = /^cancel\s+(\S+)\s+(long|short|l|s)\s*$/i.exec(text.trim());
    if (cancelMatch) {
      await this.handleCancelOrders(
        cancelMatch[1],
        cancelMatch[2].toUpperCase().startsWith("L") ? "LONG" : "SHORT",
        chatId,
        messageId
      );
      return;
    }

    // Close command: "Close {orderId} [percent%]" — resolves the MEXC official
    // order ID via the getOrder API, finds the matching open position, and
    // closes it (fully or partially). Examples: CLOSE abc123, CLOSE abc123 30%
    const closeMatch = /^close\s+(\S+)(?:\s+(\d+(?:\.\d+)?)\s*%?)?\s*$/i.exec(text.trim());
    if (closeMatch) {
      const closePercent = closeMatch[2] ? parseFloat(closeMatch[2]) : undefined;
      await this.handleClosePosition(closeMatch[1], chatId, messageId, closePercent);
      return;
    }

    // Reverse command: "REVERSE {orderId}" — closes the position and opens
    // the opposite direction at market price, mirroring SL/TP distance.
    const reverseMatch = /^reverse\s+(\S+)\s*$/i.exec(text.trim());
    if (reverseMatch) {
      await this.handleReversePosition(reverseMatch[1], chatId, messageId);
      return;
    }

    // Add-to command: "ADD TO {orderId} [{riskPercent}%]" — opens an
    // additional market order in the same direction with the same SL/TP,
    // sized at the given risk% of equity (default 1%).
    const addToMatch = /^add\s+to\s+(\S+)(?:\s+(\d+(?:\.\d+)?)\s*%?)?\s*$/i.exec(text.trim());
    if (addToMatch) {
      const riskPercent = addToMatch[2] ? parseFloat(addToMatch[2]) : 1;
      await this.handleAddToPosition(addToMatch[1], chatId, messageId, riskPercent);
      return;
    }

    this.logger.info(
      `📨 ${source === "channel_post" ? "Channel" : "Message"} from ${chatId}#${messageId}: ${text.substring(0, 80)}`
    );

    // Idempotency check
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(`⏭️ Message ${chatId}#${messageId} already processed`);
      return;
    }

    // Try to parse as one or more trade signals (multi-line support)
    const signals = parseSignals(text, messageId, chatId, msg.date);
    if (signals.length === 0) {
      this.logger.debug("📝 Not a trade signal — ignoring");
      return;
    }

    this.logger.info(
      `📊 ${signals.length} signal(s) detected in message ${chatId}#${messageId}`
    );

    for (const signal of signals) {
      this.logger.info(
        `   ${signal.action} ${signal.rawSymbol}${signal.orderType === "trigger" ? `@${signal.entry}` : ""} SL ${signal.sl} TP ${signal.tp.join(",") || "(default)"}${signal.riskPercentOverride !== undefined ? ` R${signal.riskPercentOverride}%` : ""} (${signal.orderType === "trigger" ? "🔔 limit entry" : "💹 market order"})`
      );
      // Persist parsed signal to file log
      this.logger.logSignal(signal);
    }

    // Mark as processed now to prevent duplicate processing on restart
    this.state.markProcessed(chatId, messageId);

    // Process each signal sequentially
    for (const signal of signals) {
      await this.processSignal(signal, isConfirmChannel ? "confirm" : "auto");
    }
  }

  /**
   * Fetch account equity with a 10-second cache and retry on rate limits.
   */
  private async fetchEquity(): Promise<number> {
    const now = Date.now();
    if (this.equityCache && now - this.equityCache.ts < this.EQUITY_CACHE_TTL_MS) {
      this.logger.debug(`📦 Using cached equity: ${this.equityCache.equity}`);
      return this.equityCache.equity;
    }

    const equity = await this.fetchEquityWithRetry(5);
    this.equityCache = { equity, ts: now };
    return equity;
  }

  /**
   * Fetch equity from MEXC with retry on 513 rate-limit errors.
   */
  private async fetchEquityWithRetry(maxRetries: number): Promise<number> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const asset = await this.mexcClient.getAccountAsset(
          this.config.baseCurrency
        );

        // Check for API-level error
        if (!asset.success) {
          if (asset.code === 513 && attempt < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            this.logger.warn(
              `⏳ Rate limited (513) fetching equity — retry ${attempt}/${maxRetries} in ${delay}ms`
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw new Error(`MEXC API error: code ${asset.code}`);
        }

        const inner = asset.data ?? asset;
        const equity: number = (inner as any).equity ?? 0;

        if (equity <= 0) {
          throw new Error(
            `Equity returned as ${equity} ${this.config.baseCurrency}`
          );
        }

        return equity;
      } catch (error) {
        // If it's an HTTP/network error and we can retry
        if (attempt < maxRetries) {
          const isRateLimit =
            error instanceof Error &&
            (error.message.includes("513") ||
             error.message.includes("rate limit") ||
             error.message.includes("Invalid request"));

          if (isRateLimit) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            this.logger.warn(
              `⏳ Rate limited fetching equity — retry ${attempt}/${maxRetries} in ${delay}ms`
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }
        throw error; // rethrow if out of retries or not a rate-limit error
      }
    }

    throw new Error("Failed to fetch equity after retries");
  }

  /**
   * Full pipeline: normalize → resolve → size → execute.
   */
  private async processSignal(
    signal: TradeSignal,
    mode: "confirm" | "auto" = "auto"
  ): Promise<void> {
    // 1. Normalize symbol
    const mexcSymbol = normalizeSymbol(signal.rawSymbol);
    if (!mexcSymbol) {
      this.logger.warn(
        `⚠️ Cannot normalize symbol "${signal.rawSymbol}" — unsupported instrument`
      );
      return;
    }
    this.logger.info(`🔄 Normalized: ${signal.rawSymbol} → ${mexcSymbol}`);

    // 2. Resolve against MEXC contracts
    const contract = await this.resolver.resolve(mexcSymbol);
    if (!contract) {
      this.logger.warn(`⚠️ Symbol ${mexcSymbol} not tradable on MEXC — skipping`);
      return;
    }
    this.logger.info(
      `✅ Contract found: ${contract.symbol} (size=${contract.contractSize}, minVol=${contract.minVol})`
    );

    // 2.5. Resolve entry price via ticker. For market orders this provides the entry;
    //      for trigger orders it determines the correct trigger direction so the
    //      plan order stays pending until price actually crosses the entry level.
    let currentPrice: number;
    try {
      const ticker = await this.mexcClient.getTicker(mexcSymbol);
      currentPrice = ticker?.data?.lastPrice;
      if (!currentPrice || currentPrice <= 0) {
        this.logger.error(`❌ Could not resolve market price for ${mexcSymbol}`);
        return;
      }

      if (signal.orderType === "market") {
        signal.entry = currentPrice;
        this.logger.info(`💹 Market entry resolved: ${mexcSymbol} @ ${currentPrice}`);
      } else {
        const dir = signal.action === "BUY"
          ? (currentPrice >= signal.entry ? "above" : "below")
          : (currentPrice <= signal.entry ? "below" : "above");
        this.logger.info(
          `🔔 Trigger entry: ${mexcSymbol} @ ${signal.entry} | current price ${currentPrice} (${dir} trigger) → will wait for price to cross`
        );
      }
    } catch (error) {
      this.logger.error(`❌ Failed to fetch ticker for ${mexcSymbol}:`, error);
      return;
    }

    // 3. Get account equity (cached for 10s to avoid rate limits)
    let equity: number;
    try {
      equity = await this.fetchEquity();
      if (equity <= 0) {
        this.logger.error(
          `❌ Account equity is ${equity} ${this.config.baseCurrency} — cannot size position`
        );
        return;
      }
      this.logger.info(`💰 Account equity: ${equity} ${this.config.baseCurrency}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Failed to fetch account equity: ${errorMsg}`);
      return;
    }

    // 4. Check concurrent positions
    try {
      const positions = await this.mexcClient.getOpenPositions();
      const openCount = positions.data?.length || 0;
      if (openCount >= this.config.maxConcurrentTrades) {
        this.logger.warn(
          `⚠️ Max concurrent trades reached (${openCount}/${this.config.maxConcurrentTrades}) — skipping`
        );
        return;
      }
    } catch (error) {
      this.logger.warn("⚠️ Could not check open positions — proceeding anyway");
    }

    // 5. Calculate position size
    // Compute effective risk % BEFORE the sizer so we can log it even on failure
    const effectiveRiskPct = signal.riskPercentOverride !== undefined
      ? signal.riskPercentOverride
      : this.config.riskPercent * 100;

    const resolvedTrade = calculatePositionSize(
      signal,
      contract,
      equity,
      currentPrice,
      this.config,
      this.logger
    );
    if (!resolvedTrade) {
      // The sizer already logged a specific reason (stop distance, minVol, notional, etc.)
      this.logger.warn(
        `⚠️ Position sizing failed for ${mexcSymbol} (equity=${equity.toFixed(2)}, risk=${effectiveRiskPct.toFixed(2)}%) — skipping trade`
      );
      return;
    }

    this.logger.info(
      `📐 Sized: ${resolvedTrade.volume} contracts, ${resolvedTrade.side === 1 ? "LONG" : "SHORT"}, leverage ${resolvedTrade.leverage}x`
    );

    // 6. Route based on the channel mode:
    //    - "confirm" channels: queue the order and post a confirmation.
    //      Nothing is submitted to MEXC until "CONFIRM ORDERS".
    //    - "auto" channels (monitor feeds): place the order immediately.
    if (mode === "auto") {
      this.logger.info(
        `⚡ Auto-placing ${resolvedTrade.mexcSymbol} ${resolvedTrade.side === 1 ? "LONG" : "SHORT"}`
      );
      const records = await this.executor.execute(resolvedTrade);
      for (const record of records) {
        if (record.success) {
          this.logger.info(
            `✅ Trade executed (auto): ${record.orderId} for ${resolvedTrade.mexcSymbol}`
          );
          if (!this.config.dryRun) {
            await this.sendOrderPlacedNotification(record);
            this.registerSlTp(record);
          }
        } else {
          this.logger.error(
            `❌ Trade failed (auto): ${record.error} for ${resolvedTrade.mexcSymbol}`
          );
        }
      }
      return;
    }

    const queued: QueuedOrder = {
      id: `Q${++this.queueCounter}`,
      trade: resolvedTrade,
    };
    this.orderQueue.push(queued);
    this.persistQueue();
    this.logger.info(
      `🧾 Queued ${queued.id} ${resolvedTrade.mexcSymbol} ${resolvedTrade.side === 1 ? "LONG" : "SHORT"} — ${this.orderQueue.length} order(s) pending, awaiting CONFIRM ORDERS`
    );
    await this.sendTradeConfirmation(resolvedTrade, signal.chatId);
  }

  /**
   * Handle a message from a resolver (info-only) channel: parse signals and
   * feed them to the SignalResolver for TP/SL monitoring. No MEXC orders are
   * placed for these signals.
   */
  private async handleResolverMessage(
    text: string,
    chatId: string,
    messageId: number,
    timestamp?: number
  ): Promise<void> {
    if (!this.signalResolver) return;

    const signals = parseSignals(text, messageId, chatId, timestamp);
    if (signals.length === 0) return;

    // Idempotency check (reuse the same state file as trading signals)
    if (this.state.isProcessed(chatId, messageId)) {
      this.logger.debug(`🔍 Resolver: message ${chatId}#${messageId} already processed`);
      return;
    }
    this.state.markProcessed(chatId, messageId);

    this.logger.info(
      `🔍 Resolver: ${signals.length} signal(s) from ${chatId}#${messageId}`
    );

    for (const signal of signals) {
      this.logger.info(
        `   ${signal.action} ${signal.rawSymbol}${signal.orderType === "trigger" ? `@${signal.entry}` : ""} SL ${signal.sl} TP ${signal.tp.join(",") || "(none)"}`
      );
      await this.signalResolver.track(signal);
    }
  }

  /**
   * Send a TP/SL resolution notification to the resolver channel where the
   * original signal was posted.
   */
  private async sendSignalResolution(event: SignalResolutionEvent): Promise<void> {
    const text = formatSignalResolutionMessage(event);
    try {
      await this.telegram.telegram.sendMessage(
        event.signal.chatId,
        text,
        { parse_mode: "HTML" }
      );
      this.logger.info(
        `🔍 Resolver: resolution sent to ${event.signal.chatId} for ${event.signal.mexcSymbol}`
      );
    } catch (error) {
      this.logger.error(
        `🔍 Resolver: failed to send resolution to ${event.signal.chatId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Check if a chat is a resolver (info-only) channel.
   */
  private isResolverChannel(chatId: string, username?: string): boolean {
    if (!this.signalResolver) return false;
    if (this.config.signalResolverChannels.includes(chatId)) return true;
    if (
      username &&
      this.config.signalResolverChannels.some(
        (ch) =>
          ch === `@${username}` ||
          ch.toLowerCase() === username.toLowerCase()
      )
    ) {
      return true;
    }
    return false;
  }

  /**
   * Check if a chat is in the allowed channels list.
   */
  private isAllowedChannel(chatId: string, username?: string): boolean {
    // Check by numeric ID
    if (this.config.allowedChannels.includes(chatId)) {
      return true;
    }

    // Check by username (e.g. "@channelname")
    if (
      username &&
      this.config.allowedChannels.some(
        (ch) =>
          ch === `@${username}` ||
          ch.toLowerCase() === username.toLowerCase()
      )
    ) {
      return true;
    }

    return false;
  }

  /**
   * Check if a chat uses the queue + operator-confirmation flow (listed in
   * CONFIRM_CHANNELS). Channels NOT listed here place orders automatically.
   */
  private isConfirmChannel(chatId: string, username?: string): boolean {
    if (this.config.confirmChannels.length === 0) return false;
    if (this.config.confirmChannels.includes(chatId)) return true;
    if (
      username &&
      this.config.confirmChannels.some(
        (ch) =>
          ch === `@${username}` ||
          ch.toLowerCase() === username.toLowerCase()
      )
    ) {
      return true;
    }
    return false;
  }
}
