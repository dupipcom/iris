import { TradeExecutor } from "../executor";
import { Logger } from "../../utils/logger";
import { BotConfig, ResolvedTrade, TradeSignal } from "../types";

const logger = new Logger({ level: "SILENT" });

function makeConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    mexcApiKey: "",
    mexcSecretKey: "",
    mexcAuthToken: "test",
    telegramBotToken: "test",
    allowedChannels: ["123"],
    leverage: 10,
    openType: 1,
    riskPercent: 0.01,
    defaultTpRatio: 1.5,
    maxConcurrentTrades: 5,
    maxNotionalPerTrade: 100000,
    dryRun: false,
    tradingEnabled: true,
    useLimitTpSl: false,
    useMakerClose: false,
    logLevel: "SILENT",
    baseCurrency: "USDT",
    stateFilePath: "/tmp/test-state.json",
    logDir: "/tmp/test-logs",
    logRetentionDays: 90,
    pnlNotificationChannel: "",
    positionMonitorIntervalSeconds: 30,
    summaryNotificationChannel: "",
    summaryIntervalHours: 8,
    summaryWindowHours: 4,
    orderRateCapacity: 3,
    orderRateIntervalMs: 200,
    signalResolverChannels: [],
    signalResolverIntervalSeconds: 15,
    splitMultiTp: false,
    trailingStopOnTp: false,
    confirmChannels: [],
    tpDistribution: [],
    ...overrides,
  };
}

function makeTrade(overrides?: Partial<ResolvedTrade>): ResolvedTrade {
  const signal: TradeSignal = {
    raw: "BUY BTCUSDT 66000 SL 65000 TP 68000",
    action: "BUY",
    rawSymbol: "BTCUSDT",
    entry: 66000,
    sl: 65000,
    tp: [68000],
    orderType: "market",
    messageId: 1,
    chatId: "123",
  };
  return {
    signal,
    mexcSymbol: "BTC_USDT",
    volume: 1,
    side: 1,
    leverage: 10,
    openType: 1,
    entry: 66000,
    stopLossPrice: 65000,
    takeProfitPrice: 68000,
    allTpTargets: [68000],
    equity: 10000,
    riskPercent: 0.01,
    riskAmount: 100,
    minVol: 0.001,
    volScale: 3,
    volUnit: 0.001,
    currentPrice: 66000,
    contractSize: 1,
    ...overrides,
  };
}

describe("TradeExecutor limit (maker) TP/SL mode", () => {
  let client: any;

  beforeEach(() => {
    client = {
      submitOrder: jest.fn(),
      submitStopOrder: jest.fn(),
      submitPlanOrder: jest.fn(),
      getOrder: jest.fn(),
      getOpenPositions: jest.fn(),
      getTicker: jest.fn(),
      cancelOrder: jest.fn(),
    };
  });

  it("submits a market entry WITHOUT attached TP/SL and places combined limit TP+SL via one stoporder/place call", async () => {
    client.submitOrder.mockResolvedValue({ success: true, code: 0, data: "order-1" });
    client.getOrder.mockResolvedValue({
      success: true,
      code: 0,
      data: { positionId: 111 },
    });
    client.submitStopOrder.mockResolvedValue({ success: true, code: 0, data: "stop-1" });

    const executor = new TradeExecutor(client, makeConfig({ useLimitTpSl: true }), logger);
    const records = await executor.execute(makeTrade());

    // Entry order must NOT carry market TP/SL attachments in limit mode.
    const orderParams = client.submitOrder.mock.calls[0][0];
    expect(orderParams.stopLossPrice).toBeUndefined();
    expect(orderParams.takeProfitPrice).toBeUndefined();

    // Single combined call carries both limit SL + limit TP against the resolved
    // positionId (profitLossVolType=SAME). takeProfitPrice is NOT sent for a limit TP.
    expect(client.submitStopOrder).toHaveBeenCalledTimes(1);
    const [req] = client.submitStopOrder.mock.calls.map((c: any[]) => c[0]);
    expect(req).toMatchObject({
      positionId: 111,
      vol: 1,
      stopLossType: 1,
      stopLossOrderPrice: 65000,
      stopLossPrice: 65000,
      takeProfitType: 1,
      takeProfitOrderPrice: 68000,
      profitLossVolType: "SAME",
    });
    expect(req.takeProfitPrice).toBeUndefined();

    expect(records[0].success).toBe(true);
  });

  it("keeps attached market TP/SL when limit mode is disabled (default)", async () => {
    client.submitOrder.mockResolvedValue({ success: true, code: 0, data: "order-1" });

    const executor = new TradeExecutor(client, makeConfig({ useLimitTpSl: false }), logger);
    const records = await executor.execute(makeTrade());

    const orderParams = client.submitOrder.mock.calls[0][0];
    expect(orderParams.stopLossPrice).toBe(65000);
    expect(orderParams.takeProfitPrice).toBe(68000);
    expect(client.submitStopOrder).not.toHaveBeenCalled();
    expect(records[0].success).toBe(true);
  });

  it("falls back to MARKET TP/SL via stoporder/place when the limit placement fails", async () => {
    client.submitOrder.mockResolvedValue({ success: true, code: 0, data: "order-1" });
    client.getOrder.mockResolvedValue({
      success: true,
      code: 0,
      data: { positionId: 222 },
    });
    client.submitStopOrder
      // Combined TP/SL → rejected, Limit SL → rejected, Market SL fallback → ok,
      // Limit TP → rejected, Limit TP retry → ok (no market TP needed)
      .mockResolvedValueOnce({ success: false, code: 999, message: "combined rejected" })
      .mockResolvedValueOnce({ success: false, code: 999, message: "limit rejected" })
      .mockResolvedValueOnce({ success: true, code: 0, data: "stop-sl" })
      .mockResolvedValueOnce({ success: false, code: 999, message: "limit rejected" })
      .mockResolvedValueOnce({ success: true, code: 0, data: "stop-tp" });

    const executor = new TradeExecutor(client, makeConfig({ useLimitTpSl: true }), logger);
    await executor.execute(makeTrade());

    expect(client.submitStopOrder).toHaveBeenCalledTimes(5);
    const reqs = client.submitStopOrder.mock.calls.map((c: any[]) => c[0]);
    // Combined TP/SL → Limit SL → Market SL fallback → Limit TP → Limit TP (retry, ok).
    expect(reqs[0]).toMatchObject({ stopLossType: 1, takeProfitType: 1 });
    expect(reqs[0].takeProfitPrice).toBeUndefined();
    expect(reqs[1]).toMatchObject({ stopLossType: 1 });
    expect(reqs[1].takeProfitType).toBeUndefined();
    expect(reqs[2].stopLossType).toBeUndefined();
    expect(reqs[3]).toMatchObject({ takeProfitType: 1 });
    expect(reqs[3].takeProfitPrice).toBeUndefined();
    expect(reqs[4]).toMatchObject({ takeProfitType: 1 });
    expect(reqs[4].takeProfitPrice).toBeUndefined();
  });
});

describe("TradeExecutor maker (limit) close mode", () => {
  let client: any;

  beforeEach(() => {
    client = {
      submitOrder: jest.fn(),
      submitStopOrder: jest.fn(),
      submitPlanOrder: jest.fn(),
      getOrder: jest.fn(),
      getOpenPositions: jest.fn(),
      getTicker: jest.fn(),
      cancelOrder: jest.fn(),
    };
  });

  const position = { positionId: 999, holdVol: 1, openType: 1, leverage: 10 } as any;

  it("closes with a Post-Only limit (maker) order at the touch when USE_MAKER_CLOSE is on", async () => {
    client.getTicker.mockResolvedValue({
      success: true, code: 0,
      data: { lastPrice: 66000, bid1: 65950, ask1: 66050 },
    });
    client.submitOrder.mockResolvedValue({ success: true, code: 0, data: "maker-1" });
    client.getOrder.mockResolvedValue({
      success: true, code: 0,
      data: { orderId: "maker-1", dealVol: 1, vol: 1, state: 3 },
    });

    const executor = new TradeExecutor(client, makeConfig({ useMakerClose: true }), logger);
    const result = await executor.closePosition(
      "BTC_USDT", position, 66000, 1, 1, 10, 100, 3, 0.001, 0.1
    );

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("maker-1");
    // Post-Only limit at bid1 + priceUnit, reduce-only, tied to the position.
    const makerParams = client.submitOrder.mock.calls[0][0];
    expect(makerParams.type).toBe(2);
    expect(makerParams.price).toBe(65950 + 0.1);
    expect(makerParams.reduceOnly).toBe(true);
    expect(makerParams.positionId).toBe(999);
    expect(client.submitOrder).toHaveBeenCalledTimes(1);
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("uses a plain market close when USE_MAKER_CLOSE is off", async () => {
    client.submitOrder.mockResolvedValue({ success: true, code: 0, data: "mkt-1" });

    const executor = new TradeExecutor(client, makeConfig({ useMakerClose: false }), logger);
    const result = await executor.closePosition(
      "BTC_USDT", position, 66000, 1, 1, 10, 100, 3, 0.001, 0.1
    );

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("mkt-1");
    const params = client.submitOrder.mock.calls[0][0];
    expect(params.type).toBe(5);
    expect(params.reduceOnly).toBe(true);
    expect(params.positionId).toBe(999);
    expect(client.getTicker).not.toHaveBeenCalled();
  });

  it("falls back to a market close when the Post-Only maker close is rejected", async () => {
    client.getTicker.mockResolvedValue({
      success: true, code: 0,
      data: { lastPrice: 66000, bid1: 65950, ask1: 66050 },
    });
    client.submitOrder
      .mockResolvedValueOnce({ success: false, code: 999, message: "post only rejected" })
      .mockResolvedValueOnce({ success: true, code: 0, data: "mkt-1" });

    const executor = new TradeExecutor(client, makeConfig({ useMakerClose: true }), logger);
    const result = await executor.closePosition(
      "BTC_USDT", position, 66000, 1, 1, 10, 100, 3, 0.001, 0.1
    );

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("mkt-1");
    const [makerParams, mktParams] = client.submitOrder.mock.calls.map((c: any[]) => c[0]);
    expect(makerParams.type).toBe(2); // Post-Only attempt
    expect(mktParams.type).toBe(5);   // market fallback
  });
});
