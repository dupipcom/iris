import { calculatePositionSize } from "../sizer";
import { BotConfig, TradeSignal } from "../types";
import { ContractDetail } from "../../types/market";
import { Logger } from "../../utils/logger";

const logger = new Logger({ level: "SILENT" });

const defaultConfig: BotConfig = {
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
};

function makeContract(overrides?: Partial<ContractDetail>): ContractDetail {
  return {
    symbol: "TAO_USDT",
    displayName: "TAO_USDT",
    displayNameEn: "TAO/USDT",
    positionOpenType: 3,
    baseCoin: "TAO",
    quoteCoin: "USDT",
    settleCoin: "USDT",
    contractSize: 1,
    minLeverage: 1,
    maxLeverage: 50,
    priceScale: 2,
    volScale: 0,
    amountScale: 2,
    priceUnit: 0.01,
    volUnit: 1,
    minVol: 1,
    maxVol: 100000,
    bidLimitPriceRate: 0.1,
    askLimitPriceRate: 0.1,
    takerFeeRate: 0.0006,
    makerFeeRate: 0.0002,
    maintenanceMarginRate: 0.005,
    initialMarginRate: 0.01,
    riskBaseVol: 10000,
    riskIncrVol: 5000,
    riskIncrMmr: 0.005,
    riskIncrImr: 0.01,
    riskLevelLimit: 5,
    priceCoefficientVariation: 0.1,
    indexOrigin: ["binance"],
    state: 0,
    isNew: false,
    isHot: true,
    isHidden: false,
    conceptPlate: [],
    riskLimitType: "BY_VOLUME",
    maxNumOrders: [100],
    marketOrderMaxLevel: 5,
    marketOrderPriceLimitRate1: 0.1,
    marketOrderPriceLimitRate2: 0.1,
    triggerProtect: 0.05,
    appraisal: 0,
    showAppraisalCountdown: 0,
    automaticDelivery: 0,
    apiAllowed: true,
    ...overrides,
  };
}

function makeSignal(overrides?: Partial<TradeSignal>): TradeSignal {
  return {
    raw: "BUY TAOUSDT@187.54 SL 185.13 TP 188.81",
    action: "BUY",
    rawSymbol: "TAOUSDT",
    entry: 187.54,
    sl: 185.13,
    tp: [188.81],
    orderType: "trigger",
    ...overrides,
  };
}

describe("calculatePositionSize", () => {
  it("calculates correct volume for a BUY signal", () => {
    const signal = makeSignal();
    const contract = makeContract();
    const equity = 10000;

    const result = calculatePositionSize(signal, contract, equity, 187.54, defaultConfig, logger);
    expect(result).not.toBeNull();
    expect(result!.side).toBe(1); // open long
    expect(result!.mexcSymbol).toBe("TAO_USDT");
    expect(result!.leverage).toBe(10);
    expect(result!.stopLossPrice).toBe(185.13);
    expect(result!.takeProfitPrice).toBe(188.81);

    // risk = 10000 * 0.01 = 100 USDT
    // stop distance = 187.54 - 185.13 = 2.41
    // volume = 100 / (2.41 * 1) = 41.49... → floor to 41
    expect(result!.volume).toBe(41);
  });

  it("uses the signal's leverageOverride clamped to the contract max", () => {
    const signal = makeSignal({ leverageOverride: 100 });
    const contract = makeContract(); // minLeverage 1, maxLeverage 50
    const equity = 10000;

    const result = calculatePositionSize(
      signal,
      contract,
      equity,
      187.54,
      defaultConfig,
      logger
    );
    expect(result).not.toBeNull();
    // 100x override is clamped to the contract max leverage (50)
    expect(result!.leverage).toBe(50);
  });

  it("uses a leverageOverride within the contract range as-is", () => {
    const signal = makeSignal({ leverageOverride: 5 });
    const contract = makeContract();
    const equity = 10000;

    const result = calculatePositionSize(
      signal,
      contract,
      equity,
      187.54,
      defaultConfig,
      logger
    );
    expect(result).not.toBeNull();
    expect(result!.leverage).toBe(5);
  });

  it("falls back to config leverage when no override is present", () => {
    const signal = makeSignal();
    const contract = makeContract();
    const equity = 10000;

    const result = calculatePositionSize(
      signal,
      contract,
      equity,
      187.54,
      defaultConfig,
      logger
    );
    expect(result).not.toBeNull();
    expect(result!.leverage).toBe(defaultConfig.leverage); // 10
  });

  it("calculates correct volume for a SELL signal", () => {
    const signal = makeSignal({
      action: "SELL",
      entry: 65000,
      sl: 66000,
      tp: [63000],
      rawSymbol: "BTCUSDT",
    });
    const contract = makeContract({
      symbol: "BTC_USDT",
      contractSize: 0.001,
      minVol: 1,
      volUnit: 1,
    });
    const equity = 10000;

    const result = calculatePositionSize(signal, contract, equity, 65000, defaultConfig, logger);
    expect(result).not.toBeNull();
    expect(result!.side).toBe(3); // open short

    // risk = 100, stop distance = 1000, contractSize = 0.001
    // volume = 100 / (1000 * 0.001) = 100
    expect(result!.volume).toBe(100);
  });

  it("returns null when volume is below minimum", () => {
    const signal = makeSignal({ entry: 100, sl: 99 });
    const contract = makeContract({ minVol: 1000 });
    const equity = 100; // very small equity

    // risk = 1, stop distance = 1, volume = 1 → below minVol 1000
    const result = calculatePositionSize(signal, contract, equity, 100, defaultConfig, logger);
    expect(result).toBeNull();
  });

  it("applies default TP when none provided", () => {
    const signal = makeSignal({ tp: [] });
    const contract = makeContract();
    const equity = 10000;

    const result = calculatePositionSize(signal, contract, equity, 187.54, defaultConfig, logger);
    expect(result).not.toBeNull();

    // default TP = entry + stopDistance * 1.5 = 187.54 + 2.41 * 1.5 = 187.54 + 3.615 = 191.155
    // Math.round(191.155 * 100) / 100 — floating point gives 191.15 or 191.16
    expect(result!.takeProfitPrice).toBeCloseTo(191.155, 1);
    expect(result!.allTpTargets).toHaveLength(1);
  });

  it("clamps leverage to contract max", () => {
    const signal = makeSignal();
    const contract = makeContract({ maxLeverage: 5 });
    const equity = 10000;
    const config = { ...defaultConfig, leverage: 50 };

    const result = calculatePositionSize(signal, contract, equity, 187.54, config, logger);
    expect(result).not.toBeNull();
    expect(result!.leverage).toBe(5);
  });

  it("clamps volume to max notional", () => {
    const signal = makeSignal();
    const contract = makeContract();
    const equity = 1000000;
    const config = { ...defaultConfig, maxNotionalPerTrade: 1000 };

    const result = calculatePositionSize(signal, contract, equity, 187.54, config, logger);
    expect(result).not.toBeNull();
    // maxNotional = 1000, entry = 187.54, contractSize = 1
    // maxVol = 1000 / (1 * 187.54) = 5.33 → floor to 5
    expect(result!.volume).toBeLessThanOrEqual(6);
  });

  it("returns null when stop distance is zero", () => {
    const signal = makeSignal({ entry: 100, sl: 100 });
    const contract = makeContract();

    // This actually won't reach calculatePositionSize because parser rejects SL == entry,
    // but the sizer has its own guard
    const result = calculatePositionSize(signal, contract, 10000, 100, defaultConfig, logger);
    expect(result).toBeNull();
  });
});
