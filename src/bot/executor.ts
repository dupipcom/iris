import crypto from "crypto";
import { MexcFuturesSDK } from "../client";
import { SubmitOrderRequest, SubmitOrderResponse, SubmitPlanOrderRequest, SubmitStopOrderRequest } from "../types/orders";
import { Position } from "../types/account";
import { BotConfig, ResolvedTrade, TradeRecord } from "./types";
import { Logger } from "../utils/logger";
import { fibonacciTpDistribution } from "./config";

/**
 * How long (ms) to wait for a maker (limit) close order to fill before
 * cancelling it and falling back to a market close. Trade-off: longer gives the
 * maker order more time to fill at 0%/low maker fees, but risks the position
 * staying open longer on a fast market.
 */
const MAKER_CLOSE_GRACE_MS = 2500;

/**
 * Details of a plan (trigger) order that was placed WITHOUT attached TP/SL.
 * When the plan triggers and the position opens, the bot calls
 * {@link TradeExecutor.placeDeferredLimitTpSl} to attach limit (maker) TP/SL.
 */
export interface PendingPlanTpSl {
  /** MEXC contract symbol. */
  symbol: string;
  /** Position direction: 1 = long, 2 = short. */
  positionType: 1 | 2;
  /** All take-profit targets (prices). */
  tpTargets: number[];
  /** Stop-loss price. */
  sl: number;
  /** Total entry volume (contracts). */
  vol: number;
  /** Leverage used. */
  leverage: number;
  /** Open type: 1 = isolated, 2 = cross. */
  openType: 1 | 2;
}

/** Called when a plan order is placed without TP/SL so the bot can store it. */
export type OnPlanOrderDeferred = (externalOid: string, details: PendingPlanTpSl) => void;

/**
 * Executes a resolved trade by submitting orders to MEXC.
 */
export class TradeExecutor {
  private client: MexcFuturesSDK;
  private config: BotConfig;
  private logger: Logger;
  private onPlanDeferred: OnPlanOrderDeferred | undefined;

  constructor(
    client: MexcFuturesSDK,
    config: BotConfig,
    logger: Logger,
    onPlanDeferred?: OnPlanOrderDeferred,
  ) {
    this.client = client;
    this.config = config;
    this.logger = logger;
    this.onPlanDeferred = onPlanDeferred;
  }

  /**
   * Execute a single resolved trade.
   * Routes to market or trigger order based on signal.orderType.
   * If multiple TP targets exist, splits volume equally across them.
   */
  async execute(trade: ResolvedTrade): Promise<TradeRecord[]> {
    // Dry-run / disabled checks
    if (this.config.dryRun) {
      const orderTypeLabel = trade.signal.orderType === "trigger" ? "LIMIT_ENTRY" : "MARKET";
      this.logger.info(`🧪 [DRY RUN] Would submit ${orderTypeLabel} order:`);
      this.logger.info(
        `   Symbol: ${trade.mexcSymbol}, Side: ${trade.side === 1 ? "LONG" : "SHORT"}`
      );
      this.logger.info(
        `   Volume: ${trade.volume}, Entry/Trigger: ${trade.entry}, SL: ${trade.stopLossPrice}`
      );
      this.logger.info(`   TP targets: ${trade.allTpTargets.join(", ")}`);
      this.logger.info(
        `   Leverage: ${trade.leverage}, OpenType: ${trade.openType === 1 ? "Isolated" : "Cross"}`
      );
      this.logger.info(
        `   Risk: ${trade.riskAmount.toFixed(2)} USDT (${(trade.riskPercent * 100).toFixed(1)}% of ${trade.equity.toFixed(2)})`
      );
      if (this.config.useLimitTpSl) {
        this.logger.info(
          `   🛡️ TP/SL mode: LIMIT (Maker) via /stoporder/place${trade.signal.orderType === "trigger" ? " — not applicable to stop-entry orders, market TP/SL will be used" : ""}`
        );
      }

      const record: TradeRecord = {
        resolved: trade,
        orderId: "DRY_RUN",
        success: true,
        executedAt: Date.now(),
        orderVolume: trade.volume,
        orderTp: trade.takeProfitPrice,
      };
      this.logTradeRecord(record);
      return [record];
    }

    if (!this.config.tradingEnabled) {
      this.logger.warn("⚠️ Trading is disabled — skipping execution");
      const record: TradeRecord = {
        resolved: trade,
        orderId: "DISABLED",
        success: false,
        error: "Trading disabled",
        executedAt: Date.now(),
        orderVolume: trade.volume,
        orderTp: trade.takeProfitPrice,
      };
      this.logTradeRecord(record);
      return [record];
    }

    // Route to the appropriate execution method
    if (trade.signal.orderType === "trigger") {
      return this.executeTrigger(trade);
    }
    return this.executeMarket(trade);
  }

  /**
   * Close an open position immediately (or partially) with a market order.
   *
   * @param symbol   MEXC contract symbol (e.g. "BTC_USDT")
   * @param position The open-position record, providing holdVol and positionId
   * @param currentPrice Current market price for the market close order
   * @param positionType 1=long, 2=short
   * @param openType 1=isolated, 2=cross
   * @param leverage Leverage used (optional, MEXC may require for isolated)
   * @param closePercent Percentage of the position to close (1–100, default 100 = full close)
   * @param volScale Volume decimal places for this contract (0 = integer), defaults to 8 as safety
   * @param volUnit Volume step unit for this contract (e.g. 0.01), defaults to 1e-8 as safety
   * @param priceUnit Price step unit (tick) for this contract — required for maker closes (e.g. 0.01)
   */
  async closePosition(
    symbol: string,
    position: Position,
    currentPrice: number,
    positionType: 1 | 2,
    openType: 1 | 2,
    leverage: number,
    closePercent: number = 100,
    volScale?: number,
    volUnit?: number,
    priceUnit?: number
  ): Promise<{ success: boolean; orderId?: string; volume?: number; error?: string }> {
    // Calculate the volume to close, respecting the percentage and contract precision.
    const rawVol = position.holdVol * (closePercent / 100);

    // Round to contract precision.  When volScale/volUnit are known, use them;
    // otherwise fall back to a safe default (8 decimals) with a warning.
    let closeVol: number;
    if (volScale !== undefined && volUnit !== undefined && volUnit > 0) {
      const stepped = Math.floor(rawVol / volUnit) * volUnit;
      if (volScale > 0) {
        const factor = Math.pow(10, volScale);
        closeVol = Math.floor(stepped * factor) / factor;
      } else {
        closeVol = stepped;
      }
    } else {
      // Fallback: round to 8 decimals — may fail for contracts with coarse volume steps.
      closeVol = Math.floor(rawVol * 1e8) / 1e8;
      this.logger.warn(
        `⚠️ No volScale/volUnit provided for ${symbol} — rounding vol to 8dp (may fail for some contracts)`
      );
    }

    if (closeVol <= 0) {
      // If the rounded volume rounds to zero, try the minimum possible step.
      if (volUnit && volUnit > 0) {
        closeVol = volUnit;
      } else {
        return { success: false, error: `Computed close volume is zero (${closePercent}% of ${position.holdVol})` };
      }
    }

    if (this.config.dryRun) {
      this.logger.info(
        `🧪 [DRY RUN] Would close ${symbol} ${closePercent}% (vol=${closeVol}, price=${currentPrice})`
      );
      return { success: true, orderId: "DRY_RUN", volume: closeVol };
    }

    if (!this.config.tradingEnabled) {
      return { success: false, error: "Trading disabled" };
    }

    // side 4 = close long, side 2 = close short (see types/orders.ts)
    const side = positionType === 1 ? 4 : 2;

    // Preferred: close as a LIMIT (maker) order at the touch so the exit pays the
    // maker fee (0.02% — and often 0% during MEXC promos) instead of the taker
    // fee (0.05%) of a market close. Falls back to market if it doesn't fill in time.
    if (this.config.useMakerClose && priceUnit && priceUnit > 0) {
      const makerResult = await this.tryMakerClose(
        symbol,
        position,
        closeVol,
        side,
        openType,
        leverage,
        priceUnit,
        currentPrice
      );
      if (makerResult) return makerResult;
    }

    // Market (taker) close — guaranteed fill, pays taker fees.
    return this.submitMarketClose(
      {
        symbol,
        price: currentPrice || 0,
        vol: closeVol,
        side,
        type: 5, // market
        openType,
        leverage,
        reduceOnly: true,
        positionId: position.positionId,
      },
      closeVol
    );
  }

  /**
   * Attempt a LIMIT (maker) close at the touch, falling back to a market close.
   *
   * MEXC has no separate "close position" endpoint — closing is always an
   * opposite reduce-only order, and the fee depends on maker vs taker. A market
   * close (type 5) is always a taker fill (taker fee). Posting a limit close at
   * the passive touch (type 2, Post Only) makes it a maker fill (maker fee, often
   * 0%). We poll briefly for a fill; if it doesn't fill in time we cancel it and
   * market-close the remainder so the position is never left open.
   *
   * Returns a result when a close was actually placed (maker or market fallback),
   * or null when the maker path isn't applicable (no ticker/priceUnit) — in which
   * case the caller does a plain market close.
   */
  private async tryMakerClose(
    symbol: string,
    position: Position,
    closeVol: number,
    side: 4 | 2,
    openType: 1 | 2,
    leverage: number,
    priceUnit: number,
    currentPrice: number
  ): Promise<{ success: boolean; orderId?: string; volume?: number; error?: string } | null> {
    // Best bid/ask — used to derive a passive (maker) price.
    let bid1 = 0;
    let ask1 = 0;
    try {
      const ticker = await this.client.getTicker(symbol);
      bid1 = ticker?.data?.bid1 ?? 0;
      ask1 = ticker?.data?.ask1 ?? 0;
    } catch {
      this.logger.warn(`⚠️ USE_MAKER_CLOSE: no ticker for ${symbol} — using market close`);
      return null;
    }
    if (bid1 <= 0 || ask1 <= 0) {
      this.logger.warn(`⚠️ USE_MAKER_CLOSE: bad ticker for ${symbol} — using market close`);
      return null;
    }

    // Close LONG (sell) → post one tick above the best bid (passive maker).
    // Close SHORT (buy) → post one tick below the best ask (passive maker).
    const makerPrice = side === 4 ? bid1 + priceUnit : ask1 - priceUnit;
    if (makerPrice <= 0) return null;

    const makerParams: SubmitOrderRequest = {
      symbol,
      price: makerPrice,
      vol: closeVol,
      side,
      type: 2, // Post Only (maker) — MEXC rejects it if it would cross the book
      openType,
      leverage,
      reduceOnly: true,
      positionId: position.positionId,
    };

    try {
      this.logger.info(
        `🎯 Maker close: ${symbol} ${side === 4 ? "LONG" : "SHORT"} vol=${closeVol} @ ${makerPrice} (Post-Only)`
      );
      const response = await this.client.submitOrder(makerParams);
      if (!response.success) {
        this.logger.warn(
          `⚠️ Maker close rejected for ${symbol}: ${response.message || `Code ${response.code}`} — using market close`
        );
        return null;
      }
      const makerOid = String(response.data ?? "");
      this.logger.info(`✅ Maker close order placed: ${makerOid} for ${symbol}`);

      // Poll for a fill (Post-Only orders sit on the book and fill as maker).
      const deadline = Date.now() + MAKER_CLOSE_GRACE_MS;
      let dealVol = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const ord = (await this.client.getOrder(makerOid)) as any;
          const data = ord?.data ?? ord;
          dealVol = Number(data?.dealVol ?? 0);
          const state = Number(data?.state ?? 0);
          // 3 = completed. A full fill is done regardless of state.
          if (state === 3 || dealVol >= closeVol) {
            this.logger.info(`✅ Maker close filled for ${symbol}: ${makerOid} vol=${dealVol}`);
            return { success: true, orderId: makerOid, volume: dealVol };
          }
          if (state === 4 || state === 5) break; // cancelled / invalid → fall back
        } catch {
          // keep polling
        }
      }

      // Not filled in time → cancel the maker order and market-close the remainder.
      try {
        await this.client.cancelOrder([makerOid]);
      } catch {
        // best-effort cancel
      }
      const remaining = Math.max(0, closeVol - dealVol);
      this.logger.warn(
        `⏱️ Maker close ${makerOid} not filled in time for ${symbol} — market-close remainder vol=${remaining}`
      );
      if (remaining <= 0) {
        return { success: true, orderId: makerOid, volume: dealVol };
      }
      return this.submitMarketClose(
        {
          symbol,
          price: currentPrice || 0,
          vol: remaining,
          side,
          type: 5,
          openType,
          leverage,
          reduceOnly: true,
          positionId: position.positionId,
        },
        remaining
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Maker close failed for ${symbol}: ${msg} — using market close`);
      return null;
    }
  }

  /**
   * Submit a market (taker) close order and log the outcome.
   */
  private async submitMarketClose(
    params: SubmitOrderRequest,
    volume: number
  ): Promise<{ success: boolean; orderId?: string; volume?: number; error?: string }> {
    try {
      this.logger.info(
        `🔚 Closing position: ${params.symbol} ${params.side === 4 ? "LONG" : "SHORT"} vol=${volume} side=${params.side}`
      );
      const response = await this.client.submitOrder(params);
      if (response.success) {
        const oid = String(response.data ?? "");
        this.logger.info(`✅ Close order placed: ${oid} for ${params.symbol}`);
        return { success: true, orderId: oid, volume };
      }
      return {
        success: false,
        error: response.message || `Code ${response.code}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Close order failed for ${params.symbol}: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Execute a market order (immediate fill, no @/EP in signal).
   */
  private async executeMarket(trade: ResolvedTrade): Promise<TradeRecord[]> {
    return this.splitAndSubmit(trade, false);
  }

  /**
   * Execute a trigger (stop-entry) order (signal had @ or EP).
   * Places pending trigger orders that fire when price reaches entry.
   */
  private async executeTrigger(trade: ResolvedTrade): Promise<TradeRecord[]> {
    return this.splitAndSubmit(trade, true);
  }

  /**
   * Shared split-and-submit logic for both market and trigger orders.
   *
   * When `splitMultiTp` is enabled with multiple TP targets:
   *   - Market orders: 1 entry order (SL attached, NO TP) + N partial limit
   *     TP orders placed after the fill. This saves (N-1) entry taker fees.
   *   - Plan orders: the SL is ALWAYS attached to the plan order for safety.
   *     TP is deferred — stored via onPlanDeferred and placed as limit
   *     (maker) orders when the position opens.
   *
   * When `splitMultiTp` is disabled or there's only 1 TP:
   *   Single entry order, no splitting.
   */
  private async splitAndSubmit(trade: ResolvedTrade, isTrigger: boolean): Promise<TradeRecord[]> {
    const records: TradeRecord[] = [];

    // Single TP, or splitting disabled → one order with all volume.
    if (trade.allTpTargets.length <= 1 || !this.config.splitMultiTp) {
      if (trade.allTpTargets.length > 1 && !this.config.splitMultiTp) {
        this.logger.info(
          `📎 Signal has ${trade.allTpTargets.length} TP targets but SPLIT_MULTI_TP is disabled — using TP1=${trade.takeProfitPrice} only, single order`
        );
      }
      const record = await this.submitSingleOrder(trade, trade.volume, trade.takeProfitPrice, isTrigger);
      records.push(record);
      this.logTradeRecord(record);
      return records;
    }

    // ── Multi-TP splitting enabled ──────────────────────────────────

    // For plan orders: place 1 plan order with SL attached (safety!),
    // defer all TPs to be placed as limit orders after the position opens.
    if (isTrigger) {
      this.logger.info(
        `📎 Multi-TP plan order for ${trade.mexcSymbol}: 1 entry with SL, ` +
        `${trade.allTpTargets.length} limit TPs deferred until position opens`
      );
      // The plan order carries the SL but NO TP — all TPs are deferred.
      const record = await this.submitSingleOrder(trade, trade.volume, trade.takeProfitPrice, true);
      records.push(record);
      this.logTradeRecord(record);
      return records;
    }

    // Market order with multi-TP: 1 entry (SL attached, NO TP) +
    // N partial limit TP orders placed after the fill.
    this.logger.info(
      `📎 Multi-TP market order for ${trade.mexcSymbol}: 1 entry + ` +
      `${trade.allTpTargets.length} partial limit TPs`
    );

    // Place the entry order WITHOUT TP attached — we'll add limit TPs after fill.
    const entryRecord = await this.submitSingleOrder(
      trade, trade.volume, trade.takeProfitPrice, false
    );
    records.push(entryRecord);
    this.logTradeRecord(entryRecord);

    if (entryRecord.success && entryRecord.orderId && entryRecord.orderId !== "unknown") {
      await this.attachMultiLimitTps(trade, entryRecord.orderId);
    } else if (entryRecord.success) {
      this.logger.error(
        `❌ Multi-TP: entry filled but no orderId — TP orders NOT placed for ${trade.mexcSymbol}`
      );
    }

    return records;
  }

  /**
   * Submit a single order.
   *
   * Market orders (isTrigger=false): immediate fill via /order/submit (type=5).
   *
   * Plan/stop orders (isTrigger=true): placed via /planorder/place/v2.
   * The triggerType is chosen so the order is ALWAYS pending — it only fires
   * when the market price actually CROSSES the entry price, regardless of
   * which side of the entry the market is currently on:
   *
   *   BUY:
   *     currentPrice < entry  → triggerType=1 (price >= EP, buy stop — wait for rise)
   *     currentPrice >= entry → triggerType=2 (price <= EP, buy limit — wait for drop)
   *   SELL:
   *     currentPrice > entry  → triggerType=2 (price <= EP, sell stop — wait for drop)
   *     currentPrice <= entry → triggerType=1 (price >= EP, sell limit — wait for rise)
   *
   * If currentPrice ≈ entry (within 0.01%), falls back to a market order
   * since either trigger direction would fire immediately.
   */
  private async submitSingleOrder(
    trade: ResolvedTrade,
    volume: number,
    takeProfitPrice: number,
    isTrigger: boolean
  ): Promise<TradeRecord> {
    const rawId = `${trade.signal.chatId || 0}_${trade.signal.messageId || 0}_${takeProfitPrice}_${volume}`;
    const hash = crypto.createHash("md5").update(rawId).digest("hex").substring(0, 16);
    const externalOid = `tg_${hash}`;

    if (isTrigger) {
      const isBuy = trade.side === 1;
      const entry = trade.entry;
      const cp = trade.currentPrice;

      // If current price is within 0.01% of entry, either trigger direction
      // fires immediately — fall back to market order.
      const tolerance = entry * 0.0001;
      if (Math.abs(cp - entry) <= tolerance) {
        this.logger.info(
          `📍 Price ${cp} ≈ entry ${entry} (within tolerance) — using market order instead of plan order`
        );
        return this.submitSingleOrder(trade, volume, takeProfitPrice, false);
      }

      // Determine triggerType so the order is always pending:
      //   triggerType=1 → fires when price RISES to >= triggerPrice
      //   triggerType=2 → fires when price FALLS to <= triggerPrice
      let triggerType: 1 | 2;
      let dirLabel: string;

      if (isBuy) {
        if (cp < entry) {
          triggerType = 1; // price is below → wait for rise (buy stop)
          dirLabel = "↑ buy stop";
        } else {
          triggerType = 2; // price is above → wait for drop (buy limit)
          dirLabel = "↓ buy limit";
        }
      } else {
        if (cp > entry) {
          triggerType = 2; // price is above → wait for drop (sell stop)
          dirLabel = "↓ sell stop";
        } else {
          triggerType = 1; // price is below → wait for rise (sell limit)
          dirLabel = "↑ sell limit";
        }
      }

      // Plan order (stop/conditional entry) via /planorder/place/v2.
      // SL is ALWAYS attached for safety. TP is deferred — stored via
      // onPlanDeferred and placed as limit (maker) orders when the
      // position opens, saving taker fees on the take-profit side.
      const deferTp = this.config.useLimitTpSl || this.config.splitMultiTp;
      const planParams: SubmitPlanOrderRequest = {
        symbol: trade.mexcSymbol,
        triggerPrice: entry,
        triggerType,
        orderType: 5, // market execution on trigger
        executeCycle: trade.signal.executeCycle ?? 1, // V7 → 7d, default 24h
        trend: 1, // latest price
        vol: volume,
        leverage: trade.leverage,
        side: trade.side,
        openType: trade.openType,
        stopLossPrice: trade.stopLossPrice, // SL always attached — safety first!
        // TP deferred when useLimitTpSl or multi-TP splitting is active
        ...(deferTp ? {} : { takeProfitPrice }),
        externalOid,
      };

      const tpLabel = deferTp
        ? `${trade.allTpTargets.length} TP(s) deferred (limit/maker after position opens)`
        : `TP=${takeProfitPrice}`;
      this.logger.info(
        `🎯 Plan/Stop entry: ${trade.mexcSymbol} ${isBuy ? "LONG" : "SHORT"} ${dirLabel} trigger@${entry} (current=${cp}) vol=${volume} SL=${trade.stopLossPrice} ${tpLabel}`
      );

      try {
        const response = await this.client.submitPlanOrder(planParams);
        const record = this.toTradeRecord(trade, response as SubmitOrderResponse, volume, takeProfitPrice);

        // If TP is deferred, notify the bot so it can place limit TP orders
        // when the position opens (detected by the position monitor).
        if (deferTp && record.success && this.onPlanDeferred) {
          this.onPlanDeferred(externalOid, {
            symbol: trade.mexcSymbol,
            positionType: trade.side === 1 ? 1 : 2,
            tpTargets: trade.allTpTargets,
            sl: trade.stopLossPrice,
            vol: volume,
            leverage: trade.leverage,
            openType: trade.openType,
          });
        }

        return record;
      } catch (error) {
        return this.toErrorRecord(trade, error, volume, takeProfitPrice);
      }
    }

    // Market order — immediate fill
    const useLimitTpSl = this.config.useLimitTpSl;
    const multiTp = this.config.splitMultiTp && trade.allTpTargets.length > 1;

    // When using limit TP/SL or multi-TP splitting, we do NOT attach TP to the
    // entry order — it will be placed as limit (maker) orders after the fill.
    // SL is ALWAYS attached (either inline or via stoporder/place after fill).
    const attachTpInline = !useLimitTpSl && !multiTp;
    const attachSlInline = !useLimitTpSl;

    const orderParams: SubmitOrderRequest = {
      symbol: trade.mexcSymbol,
      price: trade.entry,
      vol: volume,
      side: trade.side,
      type: 5, // market
      openType: trade.openType,
      leverage: trade.leverage,
      ...(attachSlInline ? { stopLossPrice: trade.stopLossPrice } : {}),
      ...(attachTpInline ? { takeProfitPrice } : {}),
      externalOid,
    };

    const tpLabel = multiTp
      ? `${trade.allTpTargets.length} partial limit TPs (${attachSlInline ? "SL inline" : "SL after fill"})`
      : useLimitTpSl
        ? "TP/SL as LIMIT after fill"
        : `SL=${trade.stopLossPrice} TP=${takeProfitPrice}`;

    this.logger.info(
      `🚀 Market order: ${trade.mexcSymbol} ${trade.side === 1 ? "LONG" : "SHORT"} price=${trade.entry} vol=${volume} · ${tpLabel}`
    );

    try {
      const response: SubmitOrderResponse = await this.client.submitOrder(orderParams);
      const record = this.toTradeRecord(trade, response, volume, takeProfitPrice);

      // After-fill TP/SL placement: needed when TP/SL was NOT attached inline.
      if (record.success && record.orderId && record.orderId !== "unknown") {
        if (multiTp) {
          // Multi-TP: place N partial limit TPs + 1 limit SL
          await this.attachMultiLimitTps(trade, record.orderId);
        } else if (useLimitTpSl) {
          // Single TP, limit mode: place 1 limit TP + 1 limit SL
          await this.attachLimitTpSlAfterFill(trade, volume, takeProfitPrice, record.orderId);
        }
      } else if (record.success && (multiTp || useLimitTpSl)) {
        this.logger.error(
          `❌ Entry filled but no orderId — TP/SL NOT placed for ${trade.mexcSymbol}! ` +
          `Close manually or set SL/TP in MEXC UI immediately.`
        );
      }

      return record;
    } catch (error) {
      return this.toErrorRecord(trade, error, volume, takeProfitPrice);
    }
  }

  /**
   * Attach Stop-Limit (maker) TP/SL orders to the position just opened by a
   * market entry order. Used when USE_LIMIT_TP_SL is enabled.
   *
   * The entry order was submitted WITHOUT attached TP/SL, so we now place the
   * take-profit and stop-loss as LIMIT orders via /stoporder/place. If a limit
   * placement fails we fall back to a MARKET TP/SL through the same endpoint so
   * the position is never left unprotected.
   */
  private async attachLimitTpSlAfterFill(
    trade: ResolvedTrade,
    volume: number,
    takeProfitPrice: number,
    orderId: string
  ): Promise<void> {
    const positionType: 1 | 2 = trade.side === 1 ? 1 : 2;

    const positionId = await this.resolvePositionId(trade.mexcSymbol, positionType, orderId);
    if (!positionId) {
      this.logger.error(
        `❌ USE_LIMIT_TP_SL: could not resolve positionId for ${trade.mexcSymbol} (order ${orderId}) — TP/SL NOT placed! Close the position manually or set SL/TP in the MEXC UI.`
      );
      return;
    }

    // Place TP and SL together in ONE /stoporder/place call
    // (profitLossVolType=SAME → the same vol covers both), which halves the
    // number of API calls vs the old SL-then-TP approach. If the combined order
    // is rejected, fall back to placing SL and TP separately (limit first, then
    // market) so the position is never left unprotected.
    const combined = await this.placeStopOrder(
      {
        symbol: trade.mexcSymbol,
        positionId,
        vol: volume,
        lossTrend: 1,
        stopLossPrice: trade.stopLossPrice,
        stopLossType: 1,
        stopLossOrderPrice: trade.stopLossPrice,
        profitTrend: 1,
        takeProfitType: 1,
        takeProfitOrderPrice: takeProfitPrice,
        profitLossVolType: "SAME",
      },
      "Limit TP/SL"
    );
    if (!combined) {
      // Fallback 1: stop-loss (limit → market).
      const slPlaced = await this.placeStopOrder(
        {
          symbol: trade.mexcSymbol,
          positionId,
          vol: volume,
          lossTrend: 1,
          stopLossPrice: trade.stopLossPrice,
          stopLossType: 1,
          stopLossOrderPrice: trade.stopLossPrice,
        },
        "Limit SL"
      );
      if (!slPlaced) {
        await this.placeStopOrder(
          {
            symbol: trade.mexcSymbol,
            positionId,
            vol: volume,
            lossTrend: 1,
            stopLossPrice: trade.stopLossPrice,
          },
          "Market SL (fallback)"
        );
      }

      // Fallback 2: take-profit as a limit (maker) order — note a limit TP only
      // sends takeProfitOrderPrice, NEVER takeProfitPrice (MEXC rejects both).
      const tpPlaced = await this.placeStopOrder(
        {
          symbol: trade.mexcSymbol,
          positionId,
          vol: volume,
          profitTrend: 1,
          takeProfitType: 1,
          takeProfitOrderPrice: takeProfitPrice,
        },
        "Limit TP",
        1
      );
      if (!tpPlaced) {
        await this.placeStopOrder(
          {
            symbol: trade.mexcSymbol,
            positionId,
            vol: volume,
            profitTrend: 1,
            takeProfitPrice,
          },
          "Market TP (fallback)"
        );
      }
    }
  }

  /**
   * Resolve the MEXC positionId for a position just opened by a placed order.
   * Tries getOrder(orderId) first (the fill order carries positionId directly),
   * then falls back to matching the open-positions list by symbol + direction.
   * Retries briefly since the position may take a moment to appear after the fill.
   */
  private async resolvePositionId(
    symbol: string,
    positionType: 1 | 2,
    orderId: string
  ): Promise<number | undefined> {
    const attempts = 4;
    for (let attempt = 0; attempt < attempts; attempt++) {
      // 1. getOrder returns positionId on the fill order.
      try {
        const orderRes = (await this.client.getOrder(orderId)) as any;
        const data = orderRes?.data ?? orderRes;
        const pid = data?.positionId;
        if (pid !== undefined && pid !== null && Number(pid) > 0) {
          return Number(pid);
        }
      } catch {
        // fall through to the open-positions lookup below
      }

      // 2. Match the open position by symbol + direction.
      try {
        const res = await this.client.getOpenPositions(symbol);
        const positions: Position[] = Array.isArray(res.data) ? res.data : [];
        const match = positions.find(
          (p) =>
            p.symbol === symbol &&
            p.positionType === positionType &&
            p.state !== 3 &&
            p.holdVol > 0
        );
        if (match) return Number(match.positionId);
      } catch {
        // retry
      }

      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    return undefined;
  }

  /**
   * Place a single TP/SL order via /stoporder/place and log the outcome.
   * Returns true when MEXC accepted the order.
   */
  private async placeStopOrder(
    params: SubmitStopOrderRequest,
    label: string,
    retries: number = 0
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        this.logger.warn(
          `🔁 ${label} attempt ${attempt + 1}/${retries + 1} for ${params.symbol} — retrying`
        );
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
      try {
        const response = await this.client.submitStopOrder(params);
        if (response.success) {
          this.logger.info(
            `✅ ${label} placed for ${params.symbol}: ${String(response.data ?? "")}`
          );
          return true;
        }
        this.logger.error(
          `❌ ${label} rejected for ${params.symbol}: ${response.message || `Code ${response.code}`}`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ ${label} failed for ${params.symbol}: ${msg}`);
      }
    }
    return false;
  }

  /** Convert a successful/failed API response to a TradeRecord. */
  private toTradeRecord(
    trade: ResolvedTrade,
    response: SubmitOrderResponse,
    volume: number,
    takeProfitPrice: number
  ): TradeRecord {
    if (response.success) {
      const orderId = String(response.data || "unknown");
      this.logger.info(`✅ Order placed: ${orderId}`);
      return {
        resolved: trade,
        orderId,
        success: true,
        executedAt: Date.now(),
        orderVolume: volume,
        orderTp: takeProfitPrice,
      };
    }
    const errorMsg = response.message || `Code ${response.code}`;
    this.logger.error(`❌ Order rejected: ${errorMsg}`);
    return {
      resolved: trade,
      orderId: "",
      success: false,
      error: errorMsg,
      executedAt: Date.now(),
      orderVolume: volume,
      orderTp: takeProfitPrice,
    };
  }

  /** Convert a thrown error to a TradeRecord. */
  private toErrorRecord(
    trade: ResolvedTrade,
    error: unknown,
    volume: number,
    takeProfitPrice: number
  ): TradeRecord {
    const errorMsg = error instanceof Error ? error.message : String(error);
    this.logger.error(`❌ Order submission failed: ${errorMsg}`);
    return {
      resolved: trade,
      orderId: "",
      success: false,
      error: errorMsg,
      executedAt: Date.now(),
      orderVolume: volume,
      orderTp: takeProfitPrice,
    };
  }

  /**
   * Compute per-TP volumes based on the configured distribution.
   *
   * When `config.tpDistribution` is set (e.g. [60,30,10]), it's used directly
   * after normalization. When empty, Fibonacci-based defaults are computed
   * for the given number of TP targets.
   *
   * The distribution array maps: dist[0] → TP1 (closest, largest share),
   * dist[last] → farthest TP (smallest share).
   *
   * @returns Array of volumes, one per TP target (same order as targets).
   */
  private computeTpVolumes(
    totalVol: number,
    n: number,
    volScale: number,
    volUnit: number,
  ): number[] {
    // Get the distribution percentages, normalized to sum to 100.
    let dist: number[];
    if (this.config.tpDistribution.length > 0) {
      const userLen = this.config.tpDistribution.length;
      if (n <= userLen) {
        // Signal has ≤ TPs than configured: truncate and re-normalize.
        // e.g. user=[60,30,10], signal has 2 TPs → [60,30] → norm → [67,33].
        dist = this.config.tpDistribution.slice(0, n);
      } else {
        // Signal has MORE TPs than configured: use user dist for the first
        // userLen levels, then fill the rest with Fibonacci proportions.
        // e.g. user=[60,30], signal has 4 TPs → [60,30] + fib(2) → normalized.
        const fibTail = fibonacciTpDistribution(n - userLen);
        dist = [...this.config.tpDistribution, ...fibTail];
      }
    } else {
      // Fibonacci default.
      dist = fibonacciTpDistribution(n);
    }

    // Normalize to sum to 1.
    const sum = dist.reduce((a, b) => a + b, 0);
    const norm = dist.map((d) => (sum > 0 ? d / sum : 1 / n));

    // Round helper respecting contract precision.
    const roundVol = (v: number): number => {
      const stepped = Math.floor(v / volUnit) * volUnit;
      if (volScale > 0) {
        const factor = Math.pow(10, volScale);
        return Math.floor(stepped * factor) / factor;
      }
      return stepped;
    };

    // Compute raw volumes.
    const rawVols = norm.map((frac) => frac * totalVol);

    // Round each, then adjust the last to account for rounding remainder.
    const vols = rawVols.map(roundVol);
    const placed = vols.reduce((a, b) => a + b, 0);
    const remainder = roundVol(totalVol - placed);
    if (remainder > 0 && vols.length > 0) {
      vols[vols.length - 1] += remainder;
    }

    // Ensure no zero volumes — give at least volUnit.
    for (let i = 0; i < vols.length; i++) {
      if (vols[i] <= 0) vols[i] = volUnit;
    }

    return vols;
  }

  /**
   * Place N partial limit (maker) TP orders + 1 limit SL for a position that
   * just opened from a single market entry order. Used by multi-TP splitting
   * to avoid N separate entry orders (and their taker fees).
   *
   * Volume is split according to the configured TP distribution
   * (Fibonacci-based by default, or user-configured via TP_DISTRIBUTION).
   * The SL covers the full position volume. All orders use the limit (maker)
   * order type for reduced fees; if a limit placement fails, falls back to market.
   */
  private async attachMultiLimitTps(
    trade: ResolvedTrade,
    orderId: string,
  ): Promise<void> {
    const positionType: 1 | 2 = trade.side === 1 ? 1 : 2;

    const positionId = await this.resolvePositionId(trade.mexcSymbol, positionType, orderId);
    if (!positionId) {
      this.logger.error(
        `❌ Multi-TP: could not resolve positionId for ${trade.mexcSymbol} (order ${orderId}) — TP/SL NOT placed!`
      );
      return;
    }

    const targets = trade.allTpTargets;
    const n = targets.length;
    const { volScale, volUnit } = trade;

    // Compute per-TP volumes using the configured distribution (Fibonacci default).
    const tpVolumes = this.computeTpVolumes(trade.volume, n, volScale, volUnit);

    // 1) SL FIRST (always, for the full volume).
    this.logger.info(
      `🛡️ Multi-TP: placing LIMIT SL for ${trade.mexcSymbol} posId=${positionId} vol=${trade.volume} @ ${trade.stopLossPrice}`
    );
    const slPlaced = await this.placeStopOrder(
      {
        symbol: trade.mexcSymbol,
        positionId,
        vol: trade.volume,
        lossTrend: 1,
        stopLossPrice: trade.stopLossPrice,
        stopLossType: 1,
        stopLossOrderPrice: trade.stopLossPrice,
      },
      "Limit SL"
    );
    if (!slPlaced) {
      await this.placeStopOrder(
        {
          symbol: trade.mexcSymbol,
          positionId,
          vol: trade.volume,
          lossTrend: 1,
          stopLossPrice: trade.stopLossPrice,
        },
        "Market SL (fallback)"
      );
    }

    // 2) N partial limit TP orders, one per target with weighted volumes.
    // The distribution is already computed in tpVolumes.
    const distLabel = this.config.tpDistribution.length > 0
      ? "user" : "Fibonacci";
    this.logger.info(
      `📊 Multi-TP ${trade.mexcSymbol}: ${n} TPs with ${distLabel} distribution: ` +
      tpVolumes.map((v, i) => `TP${i + 1}=${v}`).join(", ")
    );

    for (let i = 0; i < n; i++) {
      const tpVol = tpVolumes[i];
      if (tpVol <= 0) continue;

      const tpPrice = targets[i];
      this.logger.info(
        `🎯 Multi-TP [${i + 1}/${n}]: placing LIMIT TP for ${trade.mexcSymbol} ` +
        `posId=${positionId} vol=${tpVol} @ ${tpPrice}`
      );

      const tpPlaced = await this.placeStopOrder(
        {
          symbol: trade.mexcSymbol,
          positionId,
          vol: tpVol,
          profitTrend: 1,
          takeProfitType: 1,
          takeProfitOrderPrice: tpPrice,
        },
        `Limit TP${i + 1}`,
        1
      );
      if (!tpPlaced) {
        await this.placeStopOrder(
          {
            symbol: trade.mexcSymbol,
            positionId,
            vol: tpVol,
            profitTrend: 1,
            takeProfitPrice: tpPrice,
          },
          `Market TP${i + 1} (fallback)`
        );
      }
    }
  }

  /**
   * Place limit (maker) TP/SL orders for a position that opened from a
   * previously-deferred plan order. Called by the bot when the position
   * monitor detects the plan order has triggered and the position is open.
   *
   * SL is placed first for safety. For multi-TP, volume is split equally
   * across partial limit TP orders. Falls back to market orders on failure.
   *
   * @returns true when at least the SL was placed successfully.
   */
  async placeDeferredLimitTpSl(
    positionId: number,
    details: PendingPlanTpSl,
  ): Promise<boolean> {
    const { symbol, positionType, tpTargets, sl, vol, leverage, openType } = details;
    const n = tpTargets.length;
    this.logger.info(
      `🔄 Placing deferred limit TP/SL for ${symbol} posId=${positionId}: ` +
      `${n} TP(s), SL=${sl}, vol=${vol}`
    );

    // Single TP: place SL + TP together in ONE /stoporder/place call
    // (profitLossVolType=SAME → the same vol covers both). If the combined order
    // is rejected, fall back to SL first (limit → market), then TP (limit → market).
    if (n === 1) {
      const tpPrice = tpTargets[0];
      const combined = await this.placeStopOrder(
        {
          symbol,
          positionId,
          vol,
          lossTrend: 1,
          stopLossPrice: sl,
          stopLossType: 1,
          stopLossOrderPrice: sl,
          profitTrend: 1,
          takeProfitType: 1,
          takeProfitOrderPrice: tpPrice,
          profitLossVolType: "SAME",
        },
        "Deferred Limit TP/SL"
      );
      if (!combined) {
        const slPlaced = await this.placeStopOrder(
          {
            symbol,
            positionId,
            vol,
            lossTrend: 1,
            stopLossPrice: sl,
            stopLossType: 1,
            stopLossOrderPrice: sl,
          },
          "Deferred Limit SL"
        );
        if (!slPlaced) {
          // Market SL fallback — any SL is better than none.
          const mktSl = await this.placeStopOrder(
            {
              symbol,
              positionId,
              vol,
              lossTrend: 1,
              stopLossPrice: sl,
            },
            "Deferred Market SL (fallback)"
          );
          if (!mktSl) {
            this.logger.error(
              `❌ CRITICAL: Could not place SL for ${symbol} posId=${positionId}! ` +
              `Close manually or set SL in MEXC UI immediately.`
            );
            return false;
          }
        }
        // A limit TP only sends takeProfitOrderPrice — NEVER takeProfitPrice
        // (MEXC rejects both). Retried so a transient failure still attaches it.
        await this.placeStopOrder(
          {
            symbol,
            positionId,
            vol,
            profitTrend: 1,
            takeProfitType: 1,
            takeProfitOrderPrice: tpPrice,
          },
          "Deferred Limit TP",
          1
        );
      }
    } else {
      // Multi-TP: SL FIRST — non-negotiable safety net.
      const slPlaced = await this.placeStopOrder(
        {
          symbol,
          positionId,
          vol,
          lossTrend: 1,
          stopLossPrice: sl,
          stopLossType: 1,
          stopLossOrderPrice: sl,
        },
        "Deferred Limit SL"
      );
      if (!slPlaced) {
        // Market SL fallback — any SL is better than none.
        const mktSl = await this.placeStopOrder(
          {
            symbol,
            positionId,
            vol,
            lossTrend: 1,
            stopLossPrice: sl,
          },
          "Deferred Market SL (fallback)"
        );
        if (!mktSl) {
          this.logger.error(
            `❌ CRITICAL: Could not place SL for ${symbol} posId=${positionId}! ` +
            `Close manually or set SL in MEXC UI immediately.`
          );
          return false;
        }
      }
      // Use the configured distribution (Fibonacci default).
      // volScale/volUnit are not available from PendingPlanTpSl details,
      // so we use a safe default (0 decimals, unit=1) — the contract
      // will reject if precision is wrong, but the original plan order
      // already validated the total volume.
      const tpVolumes = this.computeTpVolumes(vol, n, 0, 1);
      const distLabel = this.config.tpDistribution.length > 0
        ? "user" : "Fibonacci";
      this.logger.info(
        `📊 Deferred multi-TP ${symbol}: ${n} TPs with ${distLabel} distribution: ` +
        tpVolumes.map((v, i) => `TP${i + 1}=${v}`).join(", ")
      );

      for (let i = 0; i < n; i++) {
        const tpVol = tpVolumes[i];
        if (tpVol <= 0) continue;
        const tpPrice = tpTargets[i];
        await this.placeStopOrder(
          {
            symbol,
            positionId,
            vol: tpVol,
            profitTrend: 1,
            takeProfitType: 1,
            takeProfitOrderPrice: tpPrice,
          },
          `Deferred Limit TP${i + 1}`,
          1
        );
      }
    }

    this.logger.info(
      `✅ Deferred limit TP/SL placed for ${symbol} posId=${positionId}`
    );
    return true;
  }

  /** Persist a trade record to the trades log file. */
  private logTradeRecord(record: TradeRecord): void {
    const t = record.resolved;
    this.logger.logTrade({
      orderId: record.orderId,
      success: record.success,
      error: record.error,
      symbol: t.mexcSymbol,
      side: t.side === 1 ? "LONG" : "SHORT",
      volume: t.volume,
      entry: t.entry,
      sl: t.stopLossPrice,
      tp: t.takeProfitPrice,
      leverage: t.leverage,
      openType: t.openType === 1 ? "ISOLATED" : "CROSS",
      equity: t.equity,
      riskAmount: t.riskAmount,
      dryRun: this.config.dryRun,
      signalChatId: t.signal.chatId,
      signalMessageId: t.signal.messageId,
      signalRaw: t.signal.raw,
    });
  }
}
