import { SOL_FEED_ID } from './feed.js';
import type { Tick } from './feed.js';
import type { BaseStrategy, PerformanceMetrics, Direction, PaperTrade } from './base-strategy.js';
import { PaperTrader } from './base-strategy.js';
import { dashboardBus } from './dashboard-bus.js';
import type { BankrollManager } from './bankroll.js';
import { decisionLog } from './decision-log.js';

/* ─── Fee Rates ─────────────────────────────────────────── */

const TAKER_FEE_RATE = 2 / 10_000; // 2 bps — trend/uncertain entries
const MAKER_FEE_RATE = 0;           // 0 bps — reversion entries (resting maker)

const HARD_SL_PCT = 2.0;                 // fixed 2% hard stop-loss from entry (grid-optimized)

/* ─── Leverage-aware profit locking ────────────────────── */
const LEVERAGE = 10;
const KELLY_FRACTION = 0.30; // 30% of equity per bet
// portfolioGain% = priceMove% × LEVERAGE × KELLY_FRACTION
// Key rule: NEVER let a winner become a loser
// e.g. +0.33% price → +1% portfolio, +1.67% price → +5% portfolio

/* ─── Types ─────────────────────────────────────────────── */

type Regime = 'TRENDING' | 'RANGING' | 'UNCERTAIN';
type TrendDirection = 'UP' | 'DOWN';

interface PriceSample {
  time: number;
  price: number;
}

export interface RegimeConfig {
  type: 'regime';
  name: string;

  // ATR engine
  atrPeriod: number;             // minutes — rolling ATR window

  // Regime classifier
  regimeWindowSeconds: number;   // 4h window for regime detection
  trendThreshold: number;        // multiple of ATR% → TRENDING
  rangeThreshold: number;        // multiple of ATR% → RANGING

  // Trend/Uncertain entry
  signalWindowSeconds: number;   // 15m or 30m — signal detection window
  signalMultiple: number;        // threshold = signalMultiple × ATR%

  // Trend/Uncertain exits
  trailingAtrMultiple: number;   // trailing stop = multiple × ATR%
  slAtrMultiple: number;         // hard SL = multiple × ATR%
  trailDelaySeconds: number;     // grace period before trail activates

  // Reversion entry
  meanWindowSeconds: number;     // 1h or 2h — rolling mean window
  entryBandMultiple: number;     // enter when deviation > multiple × ATR%

  // Reversion exits
  reversionSlMultiple: number;   // hard SL = multiple × ATR%

  // Uncertain regime SL override (default 1.0× — can be raised to reduce chop exits)
  uncertainSlMultiple?: number;

  // Uncertain entry threshold multiplier (default 1.0 — same as trending)
  // Higher values make uncertain entries harder to trigger (1.5 = 50% higher bar)
  uncertainMultiple?: number;

  // Global
  cooldownSeconds: number;       // between any trades
  betSizeSol: number;

  // Minimum ATR% to enter — skip entries in dead volatility (prevents chop trades blocking good signals)
  minAtrPct?: number;

  // Portfolio TP: auto-close when trade P&L >= X% of total portfolio equity (0 = disabled)
  portfolioTpPct?: number;

  // Reversion TP mode: use locked entry-time mean instead of live rolling mean (default false)
  _useLockedMeanTP?: boolean;
}

/* ─── RegimeStrategy ────────────────────────────────────── */

export class RegimeStrategy implements BaseStrategy {
  readonly name: string;
  readonly type = 'regime' as const;

  private readonly config: RegimeConfig;
  private readonly paper: PaperTrader;
  private bankroll: BankrollManager | null = null;

  // Buffers
  private priceBuffer: PriceSample[] = [];  // 4h of samples
  private atrBuffer: number[] = [];         // tick-to-tick |deltas|
  private lastPrice = 0;
  private lastTickTime = 0;
  private lastAtrSampleTime = 0;
  private lastAtrPrice = 0;             // price at previous ATR sample (minute-to-minute)

  // State
  private currentRegime: Regime = 'UNCERTAIN';
  private trendDirection: TrendDirection = 'UP';
  private atrPct = 0;
  private rollingMean = 0;

  // Position tracking
  private entryPrice = 0;
  private entryDirection: Direction = 'long';
  private entryTickTime = 0;
  private entryRegime: Regime = 'UNCERTAIN';
  private bestPriceSinceEntry = 0;
  private entryRollingMean = 0; // mean at entry (for reversion TP)
  private entryScaledAtr = 0;   // ATR snapshot at entry (for reversion SL — locked, not live)
  private lastExitReason = '';
  private lastExitTickTime = 0;

  // Last trade info (for UI)
  private lastTradeInfo: {
    direction: Direction;
    entryPrice: number;
    exitPrice: number;
    holdSec: number;
    reason: string;
    netPnl: number;
    atrAtExit: number;
    trailPctAtExit: number;
    regime: Regime;
  } | null = null;

  // Decision log throttling
  private lastBlockReason = '';       // avoid logging same block repeatedly
  private lastSignalLogTime = 0;      // throttle signal near-miss logs

  // Warm-up
  private warmedUp = false;
  private firstTickTime = 0;

  constructor(config: RegimeConfig, paper?: PaperTrader) {
    this.name = config.name;
    this.config = config;
    this.paper = paper ?? new PaperTrader();

    this.paper.onTrade((trade: PaperTrade) => {
      dashboardBus.emitTrade({
        tradeId: trade.tradeId,
        strategyName: this.name,
        type: 'regime',
        direction: trade.direction,
        entry: trade.entryPrice,
        exit: trade.exitPrice,
        pnl: trade.netPnlSol,
        reason: this.lastExitReason,
        bestPrice: this.bestPriceSinceEntry,
        timestamp: trade.exitTime,
      });
    });
  }

  onTick(tick: Tick): void {
    if (tick.feedId !== SOL_FEED_ID) return;

    const now = tick.publishTime;
    const price = tick.price;

    if (this.firstTickTime === 0) this.firstTickTime = now;

    // ── Update ATR buffer (one sample per minute) ──
    if (this.lastAtrPrice > 0) {
      if (now - this.lastAtrSampleTime >= 60) {
        // Compare minute-to-minute (not tick-to-tick) so smooth trends register as real volatility
        const delta = Math.abs(price - this.lastAtrPrice);
        const deltaPct = (delta / this.lastAtrPrice) * 100;
        this.atrBuffer.push(deltaPct);
        if (this.atrBuffer.length > this.config.atrPeriod) {
          this.atrBuffer.shift();
        }
        this.lastAtrSampleTime = now;
        this.lastAtrPrice = price;

        // Recompute ATR%
        if (this.atrBuffer.length > 0) {
          const sum = this.atrBuffer.reduce((a, b) => a + b, 0);
          this.atrPct = sum / this.atrBuffer.length;
        }
      }
    } else {
      this.lastAtrSampleTime = now;
      this.lastAtrPrice = price;
    }

    // ── Update price buffer ──
    this.priceBuffer.push({ time: now, price });
    const bufferCutoff = now - this.config.regimeWindowSeconds;
    while (this.priceBuffer.length > 0 && this.priceBuffer[0].time < bufferCutoff) {
      this.priceBuffer.shift();
    }

    this.lastPrice = price;
    this.lastTickTime = now;

    // ── Warm-up check ──
    if (!this.warmedUp) {
      const atrFull = this.atrBuffer.length >= this.config.atrPeriod;
      const bufferSpan = this.priceBuffer.length > 0
        ? now - this.priceBuffer[0].time
        : 0;
      const bufferReady = bufferSpan >= this.config.regimeWindowSeconds * 0.9;
      if (atrFull && bufferReady) {
        this.warmedUp = true;
        decisionLog.log('warmup_complete', this.name, price,
          `Warmup done — ATR ${this.atrBuffer.length} samples, buffer ${Math.round(bufferSpan / 60)}m`,
          { atrSamples: this.atrBuffer.length, bufferSpanMin: Math.round(bufferSpan / 60), atrPct: this.atrPct });
      } else {
        return;
      }
    }

    // ── Classify regime ──
    this.classifyRegime(price, now);

    // ── Compute rolling mean for reversion ──
    this.computeRollingMean(now);

    // ── In position: check exits ──
    if (this.paper.inPosition) {
      this.checkExit(price, now);
      return;
    }

    // ── Cooldown ──
    if (this.lastExitTickTime > 0 && (now - this.lastExitTickTime) < this.config.cooldownSeconds) {
      if (this.lastBlockReason !== 'cooldown') {
        this.lastBlockReason = 'cooldown';
        const remaining = this.config.cooldownSeconds - (now - this.lastExitTickTime);
        decisionLog.log('entry_blocked', this.name, price,
          `Cooldown — ${Math.round(remaining)}s remaining after ${this.lastExitReason} exit`,
          { reason: 'cooldown', remainingSec: Math.round(remaining), lastExitReason: this.lastExitReason,
            regime: this.currentRegime, atrPct: this.atrPct });
      }
      return;
    }

    // ── Entry logic by regime ──
    if (this.atrPct <= 0) return;

    // Skip entries in dead volatility — prevents chop trades that block good signals
    if (this.config.minAtrPct && this.atrPct < this.config.minAtrPct) {
      if (this.lastBlockReason !== 'low_atr') {
        this.lastBlockReason = 'low_atr';
        decisionLog.log('entry_blocked', this.name, price,
          `Low ATR — ${this.atrPct.toFixed(4)}% < min ${this.config.minAtrPct}%`,
          { reason: 'low_atr', atrPct: this.atrPct, minAtrPct: this.config.minAtrPct, regime: this.currentRegime });
      }
      return;
    }

    // Clear block reason when we're actively scanning
    this.lastBlockReason = '';

    switch (this.currentRegime) {
      case 'TRENDING':
        this.checkTrendEntry(price, now);
        break;
      case 'RANGING':
        this.checkReversionEntry(price, now);
        break;
      case 'UNCERTAIN':
        this.checkUncertainEntry(price, now);
        break;
    }
  }

  /* ─── Regime Classification ────────────────────────────── */

  private classifyRegime(price: number, now: number): void {
    // Find the oldest sample in the regime window
    const windowStart = now - this.config.regimeWindowSeconds;
    let oldest: PriceSample | null = null;
    for (const s of this.priceBuffer) {
      if (s.time >= windowStart) {
        oldest = s;
        break;
      }
    }
    if (!oldest) return;

    const changePct = ((price / oldest.price) - 1) * 100;
    const absChange = Math.abs(changePct);

    const regimeAtr = this.scaledAtr(this.config.regimeWindowSeconds / 60);

    const prevRegime = this.currentRegime;
    const prevTrend = this.trendDirection;

    if (absChange > this.config.trendThreshold * regimeAtr) {
      this.currentRegime = 'TRENDING';
      this.trendDirection = changePct > 0 ? 'UP' : 'DOWN';
    } else if (absChange < this.config.rangeThreshold * regimeAtr) {
      this.currentRegime = 'RANGING';
    } else {
      this.currentRegime = 'UNCERTAIN';
    }

    if (this.currentRegime !== prevRegime || (this.currentRegime === 'TRENDING' && this.trendDirection !== prevTrend)) {
      const dirInfo = this.currentRegime === 'TRENDING' ? ` ${this.trendDirection}` : '';
      decisionLog.log('regime_change', this.name, price,
        `${prevRegime} → ${this.currentRegime}${dirInfo} | 4h change ${changePct >= 0 ? '+' : ''}${changePct.toFixed(3)}% vs ATR ${regimeAtr.toFixed(3)}%`,
        {
          from: prevRegime, to: this.currentRegime,
          trendDirection: this.trendDirection,
          changePct4h: +changePct.toFixed(4),
          regimeAtr: +regimeAtr.toFixed(4),
          trendThreshold: +(this.config.trendThreshold * regimeAtr).toFixed(4),
          rangeThreshold: +(this.config.rangeThreshold * regimeAtr).toFixed(4),
          atrPct: +this.atrPct.toFixed(4),
        });
    }
  }

  /* ─── ATR Scaling ───────────────────────────────────────── */

  /** ATR% scaled to a time window via sqrt(minutes) — price volatility scales with sqrt(time) */
  private scaledAtr(windowMinutes: number): number {
    return this.atrPct * Math.sqrt(windowMinutes);
  }

  /* ─── Rolling Mean ─────────────────────────────────────── */

  private computeRollingMean(now: number): void {
    const meanCutoff = now - this.config.meanWindowSeconds;
    let sum = 0;
    let count = 0;
    for (const s of this.priceBuffer) {
      if (s.time >= meanCutoff) {
        sum += s.price;
        count++;
      }
    }
    if (count > 0) {
      this.rollingMean = sum / count;
    }
  }

  /* ─── Trend Entry (15m/30m signal window) ──────────────── */

  private checkTrendEntry(price: number, now: number): void {
    const signalCutoff = now - this.config.signalWindowSeconds;
    let signalOldest: PriceSample | null = null;
    for (const s of this.priceBuffer) {
      if (s.time >= signalCutoff) {
        signalOldest = s;
        break;
      }
    }
    if (!signalOldest) return;

    const signalChange = ((price / signalOldest.price) - 1) * 100;
    const threshold = this.config.signalMultiple * this.scaledAtr(this.config.signalWindowSeconds / 60);

    // Only enter in direction of 4h trend
    if (this.trendDirection === 'UP' && signalChange > threshold) {
      this.enter('long', price, now, 'TRENDING', TAKER_FEE_RATE);
    } else if (this.trendDirection === 'DOWN' && signalChange < -threshold) {
      this.enter('short', price, now, 'TRENDING', TAKER_FEE_RATE);
    } else {
      this.logSignalCheck('TRENDING', price, now, signalChange, threshold);
    }
  }

  /* ─── Reversion Entry (mean-reversion in RANGING) ──────── */

  private checkReversionEntry(price: number, now: number): void {
    if (this.rollingMean <= 0) return;

    const deviationPct = ((price / this.rollingMean) - 1) * 100;
    const band = this.config.entryBandMultiple * this.scaledAtr(this.config.meanWindowSeconds / 60);

    if (deviationPct > band) {
      // Price above mean → short (expect reversion down)
      this.enter('short', price, now, 'RANGING', MAKER_FEE_RATE);
    } else if (deviationPct < -band) {
      // Price below mean → long (expect reversion up)
      this.enter('long', price, now, 'RANGING', MAKER_FEE_RATE);
    } else {
      // Log near-misses (>30% of band, throttled to once per minute)
      const fillPct = band > 0 ? Math.abs(deviationPct) / band : 0;
      if (fillPct > 0.3 && now - this.lastSignalLogTime >= 60) {
        this.lastSignalLogTime = now;
        const side = deviationPct > 0 ? 'ABOVE' : 'BELOW';
        decisionLog.log('signal_near_miss', this.name, price,
          `RANGING — ${side} mean by ${Math.abs(deviationPct).toFixed(3)}% / ${band.toFixed(3)}% needed (${Math.round(fillPct * 100)}%)`,
          { regime: 'RANGING', deviation: +deviationPct.toFixed(4), band: +band.toFixed(4), fillPct: +fillPct.toFixed(2),
            rollingMean: +this.rollingMean.toFixed(2), atrPct: +this.atrPct.toFixed(4) });
      }
    }
  }

  /* ─── Uncertain Entry (like trend but stricter) ────────── */

  private checkUncertainEntry(price: number, now: number): void {
    const signalCutoff = now - this.config.signalWindowSeconds;
    let signalOldest: PriceSample | null = null;
    for (const s of this.priceBuffer) {
      if (s.time >= signalCutoff) {
        signalOldest = s;
        break;
      }
    }
    if (!signalOldest) return;

    const signalChange = ((price / signalOldest.price) - 1) * 100;
    const uncMult = this.config.uncertainMultiple ?? 1.0;
    const threshold = this.config.signalMultiple * this.scaledAtr(this.config.signalWindowSeconds / 60) * uncMult;

    // Either direction (no 4h trend constraint)
    if (signalChange > threshold) {
      this.enter('long', price, now, 'UNCERTAIN', TAKER_FEE_RATE);
    } else if (signalChange < -threshold) {
      this.enter('short', price, now, 'UNCERTAIN', TAKER_FEE_RATE);
    } else {
      this.logSignalCheck('UNCERTAIN', price, now, signalChange, threshold);
    }
  }

  /* ─── Enter Position ───────────────────────────────────── */

  private enter(direction: Direction, price: number, now: number, regime: Regime, feeRate: number): void {
    const betSize = this.getBetSize();
    if (betSize <= 0) {
      decisionLog.log('entry_blocked', this.name, price,
        `Zero bet size — bankroll returned 0 (equity too low or fully deployed)`,
        { reason: 'zero_bet', regime, direction, atrPct: +this.atrPct.toFixed(4) });
      return;
    }

    this.entryPrice = price;
    this.entryDirection = direction;
    this.entryTickTime = now;
    this.entryRegime = regime;
    this.bestPriceSinceEntry = price;
    this.entryRollingMean = this.rollingMean;
    this.entryScaledAtr = this.scaledAtr(this.config.meanWindowSeconds / 60); // snapshot for reversion SL

    this.bankroll?.reserveCapital(betSize);
    this.paper.setUseMarketEntry(true);
    this.paper.openPaper(direction, price, betSize * LEVERAGE, feeRate, now);
    this.paper.saveEntryRegime(regime);

    const mode = regime === 'RANGING' ? 'REV' : 'TRD';
    console.log(
      `[${this.name}] ${mode} ${direction.toUpperCase()} @ $${price.toFixed(2)} | ` +
      `regime=${regime} ATR=${this.atrPct.toFixed(3)}% ` +
      `${regime === 'RANGING' ? `mean=$${this.rollingMean.toFixed(2)}` : `trend=${this.trendDirection}`} (PAPER)`,
    );

    // Build exit-level context so log readers know what the exits will be
    const exitContext: Record<string, unknown> = { regime, direction, betSizeSol: +betSize.toFixed(4),
      leveragedSize: +(betSize * LEVERAGE).toFixed(4), feeRate, atrPct: +this.atrPct.toFixed(4),
      rollingMean: +this.rollingMean.toFixed(2), trendDirection: this.trendDirection };
    if (regime === 'RANGING') {
      const slPct = this.config.reversionSlMultiple * this.entryScaledAtr;
      exitContext.tpTarget = `$${this.rollingMean.toFixed(2)} (rolling mean)`;
      exitContext.slPct = +slPct.toFixed(3);
      exitContext.slPrice = +(direction === 'long' ? price * (1 - slPct / 100) : price * (1 + slPct / 100)).toFixed(2);
    } else {
      exitContext.hardSlPct = HARD_SL_PCT;
      exitContext.hardSlPrice = +(direction === 'long' ? price * (1 - HARD_SL_PCT / 100) : price * (1 + HARD_SL_PCT / 100)).toFixed(2);
      exitContext.trailDelaySeconds = this.config.trailDelaySeconds;
      const stopAtr = this.scaledAtr(this.config.regimeWindowSeconds / 60);
      exitContext.trailPct = +(this.config.trailingAtrMultiple * stopAtr).toFixed(3);
    }

    exitContext.tradeId = (this.paper as any)._tradeId;
    decisionLog.log('entry', this.name, price,
      `${mode} ${direction.toUpperCase()} @ $${price.toFixed(2)} — regime=${regime} ATR=${this.atrPct.toFixed(3)}% bet=${betSize.toFixed(4)} SOL`,
      exitContext);

    dashboardBus.emitEntry({
      strategyName: this.name, type: 'regime', direction,
      price, size: betSize, timestamp: Date.now(),
    });
  }

  /* ─── Exit Logic (locked to entry regime) ──────────────── */

  private checkExit(price: number, now: number): void {
    // Portfolio TP: close when trade P&L >= X% of total equity
    if (this.config.portfolioTpPct && this.config.portfolioTpPct > 0 && this.bankroll) {
      const equity = this.bankroll.getEquity();
      if (equity > 0) {
        const sizeSol = this.paper.inPosition ? (this as any).paper._sizeSol : 0;
        const pnlUsd = this.entryDirection === 'long'
          ? sizeSol * (price - this.entryPrice)
          : sizeSol * (this.entryPrice - price);
        const pnlSol = price > 0 ? pnlUsd / price : 0;
        const pnlPct = (pnlSol / equity) * 100;
        if (pnlPct >= this.config.portfolioTpPct) {
          this.exit(price, now, TAKER_FEE_RATE, 'portfolio-TP');
          return;
        }
      }
    }

    if (this.entryRegime === 'RANGING') {
      this.checkReversionExit(price);
    } else {
      this.checkTrendExit(price, now);
    }
  }

  /** Trend/Uncertain exits: hard SL + pure ATR trailing stop (grid-optimized) */
  private checkTrendExit(price: number, now: number): void {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;

    // Hard SL — fixed 2% from entry (always active)
    if (favorable <= -HARD_SL_PCT) {
      this.exit(price, now, TAKER_FEE_RATE, 'SL');
      return;
    }

    // Track best price on every tick (no throttle — just a single comparison)
    this.trackBestPrice(price);

    const holdTime = now - this.entryTickTime;

    // Trail delay: no trailing check yet, just tracking
    if (holdTime < this.config.trailDelaySeconds) return;

    // Pure ATR trail — grid search showed this outperforms profit-locking
    const stopAtr = this.scaledAtr(this.config.regimeWindowSeconds / 60);
    const trailPct = this.config.trailingAtrMultiple * stopAtr;

    // Check trail trigger
    if (this.entryDirection === 'long') {
      const drawdown = ((this.bestPriceSinceEntry - price) / this.bestPriceSinceEntry) * 100;
      if (drawdown >= trailPct) {
        this.exit(price, now, TAKER_FEE_RATE, 'trail');
      }
    } else {
      const drawup = ((price - this.bestPriceSinceEntry) / this.bestPriceSinceEntry) * 100;
      if (drawup >= trailPct) {
        this.exit(price, now, TAKER_FEE_RATE, 'trail');
      }
    }
  }

  /** Reversion exits: TP at rolling mean (live or locked), hard SL (locked ATR from entry) */
  private checkReversionExit(price: number): void {
    if (this.entryScaledAtr <= 0) return;

    // TP: price returns to rolling mean
    // Live mean (default) adapts as the mean drifts — can trigger losing TPs
    // Locked mean uses the entry-time snapshot — guarantees profitable TPs
    const tpMean = this.config._useLockedMeanTP ? this.entryRollingMean : this.rollingMean;
    if (this.entryDirection === 'long' && price >= tpMean) {
      this.exit(price, this.lastTickTime, MAKER_FEE_RATE, 'TP');
      return;
    }
    if (this.entryDirection === 'short' && price <= tpMean) {
      this.exit(price, this.lastTickTime, MAKER_FEE_RATE, 'TP');
      return;
    }

    // Hard SL — uses ATR snapshot from entry (locked, not live)
    const slPct = this.config.reversionSlMultiple * this.entryScaledAtr;
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const adverse = this.entryDirection === 'long' ? -movePct : movePct;

    if (adverse >= slPct) {
      this.exit(price, this.lastTickTime, MAKER_FEE_RATE, 'SL');
    }
  }

  private trackBestPrice(price: number): void {
    if (this.entryDirection === 'long') {
      if (price > this.bestPriceSinceEntry) this.bestPriceSinceEntry = price;
    } else {
      if (price < this.bestPriceSinceEntry) this.bestPriceSinceEntry = price;
    }
  }

  /* ─── Exit ─────────────────────────────────────────────── */

  private exit(price: number, now: number, feeRate: number, reason: string): void {
    // Capture trail % before closing (for last trade info)
    let trailPctAtExit = 0;
    if (this.entryRegime !== 'RANGING') {
      const stopAtr = this.scaledAtr(this.config.regimeWindowSeconds / 60);
      trailPctAtExit = this.config.trailingAtrMultiple * stopAtr;
    }

    this.lastExitReason = reason;
    this.lastExitTickTime = now;

    // Store last trade details for UI
    this.lastTradeInfo = {
      direction: this.entryDirection,
      entryPrice: this.entryPrice,
      exitPrice: price,
      holdSec: now - this.entryTickTime,
      reason,
      netPnl: 0, // updated below
      atrAtExit: this.atrPct,
      trailPctAtExit,
      regime: this.entryRegime,
    };

    const trade = this.paper.closePaper(price, feeRate, now);
    if (trade) {
      this.lastTradeInfo.netPnl = trade.netPnlSol;
      this.bankroll?.releaseCapital(trade.sizeSol / LEVERAGE);
      this.bankroll?.recordPnl(trade.netPnlSol);
      const sign = trade.netPnlSol >= 0 ? '+' : '';
      const holdSec = (trade.exitTime - trade.entryTime).toFixed(0);
      console.log(
        `[${this.name}] EXIT ${reason} (${holdSec}s) | $${trade.entryPrice.toFixed(2)} → $${trade.exitPrice.toFixed(2)} | ` +
        `regime=${this.entryRegime} net ${sign}${trade.netPnlSol.toFixed(6)} SOL (PAPER)`,
      );

      const movePct = ((price / this.entryPrice) - 1) * 100;
      const favorable = this.entryDirection === 'long' ? movePct : -movePct;
      decisionLog.log('exit', this.name, price,
        `EXIT ${reason} (${holdSec}s) ${this.entryDirection.toUpperCase()} $${trade.entryPrice.toFixed(2)}→$${trade.exitPrice.toFixed(2)} | ${sign}${trade.netPnlSol.toFixed(6)} SOL`,
        {
          tradeId: trade.tradeId, reason, direction: this.entryDirection, entryRegime: this.entryRegime,
          entryPrice: +trade.entryPrice.toFixed(2), exitPrice: +trade.exitPrice.toFixed(2),
          holdSeconds: +holdSec, priceMovePct: +favorable.toFixed(3),
          netPnlSol: +trade.netPnlSol.toFixed(6), sizeSol: +trade.sizeSol.toFixed(4),
          atrPctAtExit: +this.atrPct.toFixed(4), trailPctAtExit: +trailPctAtExit.toFixed(3),
          bestPriceSinceEntry: +this.bestPriceSinceEntry.toFixed(2),
          currentRegime: this.currentRegime,
          rollingMean: +this.rollingMean.toFixed(2),
        });
    }
  }

  /* ─── Signal logging (throttled) ──────────────────────── */

  private logSignalCheck(regime: Regime, price: number, now: number, signalChange: number, threshold: number): void {
    const fillPct = threshold > 0 ? Math.abs(signalChange) / threshold : 0;
    // Only log near-misses (>30%), throttled to once per minute
    if (fillPct > 0.3 && now - this.lastSignalLogTime >= 60) {
      this.lastSignalLogTime = now;
      const dir = signalChange > 0 ? 'UP' : 'DOWN';
      const blocked = regime === 'TRENDING' && ((this.trendDirection === 'UP' && signalChange < 0) || (this.trendDirection === 'DOWN' && signalChange > 0));
      const note = blocked ? ' (AGAINST trend — blocked)' : '';
      decisionLog.log('signal_near_miss', this.name, price,
        `${regime} — signal ${dir} ${Math.abs(signalChange).toFixed(3)}% / ${threshold.toFixed(3)}% needed (${Math.round(fillPct * 100)}%)${note}`,
        { regime, signalChange: +signalChange.toFixed(4), threshold: +threshold.toFixed(4), fillPct: +fillPct.toFixed(2),
          trendDirection: this.trendDirection, atrPct: +this.atrPct.toFixed(4), blocked });
    }
  }

  /* ─── Interface ────────────────────────────────────────── */

  getMetrics(): PerformanceMetrics {
    return this.paper.getMetrics();
  }

  getThinking(): Record<string, unknown> {
    if (!this.warmedUp) {
      const bufferSpan = this.priceBuffer.length > 0
        ? this.lastTickTime - this.priceBuffer[0].time
        : 0;
      const warmPct = Math.min(100, Math.round(
        ((this.atrBuffer.length / this.config.atrPeriod) * 50) +
        ((bufferSpan / (this.config.regimeWindowSeconds * 0.9)) * 50),
      ));
      return {
        status: `WARMING UP (${warmPct}%)`,
        atrSamples: `${this.atrBuffer.length}/${this.config.atrPeriod}`,
        bufferSpan: `${Math.round(bufferSpan / 60)}m / ${Math.round(this.config.regimeWindowSeconds * 0.9 / 60)}m`,
        'sol price': this.lastPrice > 0 ? `$${this.lastPrice.toFixed(2)}` : '--',
      };
    }

    const now = this.lastTickTime;
    const price = this.lastPrice;
    const atrFiltered = this.config.minAtrPct && this.atrPct < this.config.minAtrPct;

    // ── In position: show exit levels ──
    if (this.paper.inPosition) {
      const movePct = ((price / this.entryPrice) - 1) * 100;
      const favorable = this.entryDirection === 'long' ? movePct : -movePct;
      const holdSec = now - this.entryTickTime;
      const holdStr = holdSec >= 3600 ? `${(holdSec / 3600).toFixed(1)}h` : `${Math.round(holdSec / 60)}m`;
      const mode = this.entryRegime === 'RANGING' ? 'REV' : 'TRD';

      const roe = favorable * LEVERAGE;
      const portfolioPct = favorable * LEVERAGE * KELLY_FRACTION;

      const result: Record<string, unknown> = {
        status: `${mode} ${this.entryDirection.toUpperCase()} (${roe >= 0 ? '+' : ''}${roe.toFixed(1)}% ROE | ${portfolioPct >= 0 ? '+' : ''}${portfolioPct.toFixed(2)}% portfolio)`,
        position: `${this.entryDirection.toUpperCase()} @ $${this.entryPrice.toFixed(2)} → $${price.toFixed(2)} (${favorable >= 0 ? '+' : ''}${favorable.toFixed(3)}% price)`,
        hold: holdStr,
        regime: `entered ${this.entryRegime} | now ${this.currentRegime}`,
        'ATR%': `${this.atrPct.toFixed(4)}%`,
      };

      // Helper: format ROE/portfolio% at a hypothetical exit price
      const fmtPnl = (exitPrice: number) => {
        const mv = ((exitPrice / this.entryPrice) - 1) * 100;
        const fav = this.entryDirection === 'long' ? mv : -mv;
        const r = fav * LEVERAGE;
        const p = fav * LEVERAGE * KELLY_FRACTION;
        return `ROE ${r >= 0 ? '+' : ''}${r.toFixed(1)}% | portfolio ${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
      };

      // Chart levels for in-position view
      const posLevels: Record<string, number> = { price, entry: this.entryPrice, mean: this.rollingMean };

      if (this.entryRegime === 'RANGING') {
        // Reversion: show TP (mean) and SL levels (uses locked ATR from entry)
        const slPct = this.config.reversionSlMultiple * this.entryScaledAtr;
        const slPrice = this.entryDirection === 'long'
          ? this.entryPrice * (1 - slPct / 100)
          : this.entryPrice * (1 + slPct / 100);
        result['TP target'] = `$${this.rollingMean.toFixed(2)} (mean) | ${this.entryDirection === 'long' ? '+' : ''}${(((this.rollingMean / price) - 1) * 100).toFixed(2)}% away | ${fmtPnl(this.rollingMean)}`;
        result['SL price'] = `$${slPrice.toFixed(2)} (${slPct.toFixed(2)}% from entry) | ${fmtPnl(slPrice)}`;
        posLevels.sl = slPrice;
        posLevels.tp = this.rollingMean;
      } else {
        // Trend/Uncertain: show SL and pure ATR trail levels
        const slPrice = this.entryDirection === 'long'
          ? this.entryPrice * (1 - HARD_SL_PCT / 100)
          : this.entryPrice * (1 + HARD_SL_PCT / 100);

        result['SL price'] = `$${slPrice.toFixed(2)} (${HARD_SL_PCT}% from entry) | ${fmtPnl(slPrice)}`;
        posLevels.sl = slPrice;

        if (holdSec < this.config.trailDelaySeconds) {
          result['trail'] = `DELAYED — ${Math.round(this.config.trailDelaySeconds - holdSec)}s until active`;
        } else {
          const stopAtr = this.scaledAtr(this.config.regimeWindowSeconds / 60);
          const trailPct = this.config.trailingAtrMultiple * stopAtr;

          const trailPrice = this.entryDirection === 'long'
            ? this.bestPriceSinceEntry * (1 - trailPct / 100)
            : this.bestPriceSinceEntry * (1 + trailPct / 100);

          const bestStr = `$${this.bestPriceSinceEntry.toFixed(2)}`;
          const distToTrail = this.entryDirection === 'long'
            ? ((price - trailPrice) / price) * 100
            : ((trailPrice - price) / price) * 100;

          result['trail'] = `ACTIVE | best=${bestStr} trigger=$${trailPrice.toFixed(2)} (${trailPct.toFixed(2)}% from best) | ${fmtPnl(trailPrice)}`;
          result['trail margin'] = `${distToTrail.toFixed(2)}% from trigger`;
          posLevels.trail = trailPrice;
          posLevels.best = this.bestPriceSinceEntry;
        }
      }

      if (this.config.portfolioTpPct && this.config.portfolioTpPct > 0) {
        const portfolioPctNow = favorable * LEVERAGE * KELLY_FRACTION;
        result['portfolio TP'] = `${portfolioPctNow.toFixed(1)}% / ${this.config.portfolioTpPct}% target (${Math.round(portfolioPctNow / this.config.portfolioTpPct * 100)}%)`;
      }

      result['_levels'] = posLevels;
      return result;
    }

    // ── Not in position: show entry signals ──
    const cooldownLeft = this.lastExitTickTime > 0
      ? Math.max(0, this.config.cooldownSeconds - (now - this.lastExitTickTime))
      : 0;

    const fmtWin = (s: number) => s >= 3600 ? `${s / 3600}h` : `${s / 60}m`;
    const result: Record<string, unknown> = {
      status: cooldownLeft > 0
        ? `COOLDOWN (${Math.round(cooldownLeft)}s)`
        : atrFiltered
          ? `SCANNING [${this.currentRegime}] [LOW VOL]`
          : `SCANNING [${this.currentRegime}]`,
      regime: `${this.currentRegime} | trend=${this.trendDirection}`,
      windows: `regime ${fmtWin(this.config.regimeWindowSeconds)} | signal ${fmtWin(this.config.signalWindowSeconds)} | mean ${fmtWin(this.config.meanWindowSeconds)}`,
      'ATR%': `${this.atrPct.toFixed(4)}% (${this.config.atrPeriod}m window)`,
      mean: `$${this.rollingMean.toFixed(2)} (${fmtWin(this.config.meanWindowSeconds)} avg)`,
      'sol price': `$${price.toFixed(2)}`,
    };

    // Last trade summary
    if (this.lastTradeInfo) {
      const lt = this.lastTradeInfo;
      const sign = lt.netPnl >= 0 ? '+' : '';
      const holdStr = lt.holdSec >= 3600 ? `${(lt.holdSec / 3600).toFixed(1)}h` : `${Math.round(lt.holdSec / 60)}m`;
      result['last trade'] = `${lt.direction.toUpperCase()} $${lt.entryPrice.toFixed(2)}→$${lt.exitPrice.toFixed(2)} (${holdStr}) ${lt.reason} ${sign}${lt.netPnl.toFixed(6)} SOL`;

      // Explain why the exit happened
      if (lt.reason === 'trail' && lt.atrAtExit < 0.01) {
        result['last exit'] = `ATR was ${lt.atrAtExit.toFixed(4)}% (very low) — trail only ${lt.trailPctAtExit.toFixed(2)}%, any bounce triggers exit`;
      } else if (lt.reason === 'trail') {
        result['last exit'] = `trail ${lt.trailPctAtExit.toFixed(2)}% from best — price reversed past trigger`;
      } else if (lt.reason === 'SL') {
        result['last exit'] = `hard stop-loss hit — price moved ${HARD_SL_PCT}% against entry`;
      } else if (lt.reason === 'TP') {
        result['last exit'] = `price returned to rolling mean — take profit`;
      }
    }

    // ATR health warning
    if (this.atrPct > 0 && this.atrPct < 0.01) {
      result['ATR warning'] = `ATR very low (${this.atrPct.toFixed(4)}%) — signals/stops unreliable`;
    }

    // Chart levels — numerical values for the dashboard chart
    // Always emit at minimum price + mean so dashboard clears stale position lines
    const chartLevels: Record<string, number | string> = {
      price,
      mean: this.rollingMean,
      meanLabel: `MEAN ${fmtWin(this.config.meanWindowSeconds)}`,
    };

    if (cooldownLeft > 0) { result['_levels'] = chartLevels; return result; }

    // Compute signal strength vs threshold (even during LOW VOL so chart lines stay visible)
    const canTrade = !atrFiltered && this.atrPct > 0;
    const signalCutoff = now - this.config.signalWindowSeconds;
    let signalOldest: PriceSample | null = null;
    for (const s of this.priceBuffer) {
      if (s.time >= signalCutoff) { signalOldest = s; break; }
    }

    if (this.currentRegime === 'TRENDING' || this.currentRegime === 'UNCERTAIN') {
      if (signalOldest) {
        const signalChange = ((price / signalOldest.price) - 1) * 100;
        // Only apply uncertainMultiple for UNCERTAIN regime (matches actual entry logic)
        const mult = this.currentRegime === 'UNCERTAIN' ? (this.config.uncertainMultiple ?? 1.0) : 1.0;
        const threshold = this.config.signalMultiple * this.scaledAtr(this.config.signalWindowSeconds / 60) * mult;
        const signalPct = Math.abs(signalChange);
        const fillPct = threshold > 0 ? Math.round((signalPct / threshold) * 100) : 0;
        const dir = signalChange > 0 ? 'UP' : 'DOWN';
        const wouldEnter = canTrade && (this.currentRegime === 'TRENDING'
          ? (this.trendDirection === 'UP' && signalChange > threshold) || (this.trendDirection === 'DOWN' && signalChange < -threshold)
          : signalPct > threshold);

        result['signal'] = `${dir} ${signalPct.toFixed(3)}% / ${threshold.toFixed(3)}% needed (${fillPct}%)`;
        if (this.currentRegime === 'TRENDING') {
          result['signal dir'] = signalChange > 0 === (this.trendDirection === 'UP') ? 'WITH trend' : 'AGAINST trend (blocked)';
        }
        if (wouldEnter) result['signal'] = `${result['signal']} ← ENTRY!`;

        // Entry trigger prices — always show both directions
        chartLevels.entryLong = signalOldest.price * (1 + threshold / 100);
        chartLevels.entryShort = signalOldest.price * (1 - threshold / 100);
        // In TRENDING mode, mark the against-trend direction as blocked
        if (this.currentRegime === 'TRENDING') {
          chartLevels.blockedDir = this.trendDirection === 'UP' ? 'short' : 'long';
        }
        chartLevels.entryLabel = `${fmtWin(this.config.signalWindowSeconds)} signal`;
      }
    } else if (this.currentRegime === 'RANGING') {
      const deviationPct = this.rollingMean > 0 ? ((price / this.rollingMean) - 1) * 100 : 0;
      const band = this.config.entryBandMultiple * this.scaledAtr(this.config.meanWindowSeconds / 60);
      const fillPct = band > 0 ? Math.round((Math.abs(deviationPct) / band) * 100) : 0;
      const side = deviationPct > 0 ? 'ABOVE' : 'BELOW';
      const wouldEnter = canTrade && Math.abs(deviationPct) > band;

      result['deviation'] = `${side} mean by ${Math.abs(deviationPct).toFixed(3)}% / ${band.toFixed(3)}% needed (${fillPct}%)`;
      if (wouldEnter) result['deviation'] = `${result['deviation']} ← ENTRY!`;

      // Entry band prices for ranging
      chartLevels.entryLong = this.rollingMean * (1 - band / 100);
      chartLevels.entryShort = this.rollingMean * (1 + band / 100);
      chartLevels.entryLabel = `${fmtWin(this.config.meanWindowSeconds)} band`;
    }

    result['_levels'] = chartLevels;
    return result;
  }

  /**
   * Reconstruct position state from Drift on restart.
   * Called AFTER warmup so ATR/price buffers are full for exit management.
   */
  recoverPosition(
    pos: { direction: Direction; size: number; entryPrice: number },
    extras?: { entryTickTime?: number; bestPriceSinceEntry?: number; entryRegime?: string },
  ): void {
    this.entryPrice = pos.entryPrice;
    this.entryDirection = pos.direction;
    this.entryTickTime = extras?.entryTickTime ?? (this.lastTickTime - 3600); // default: 1h ago
    this.entryRegime = (extras?.entryRegime as Regime) ?? 'TRENDING'; // safe default
    this.bestPriceSinceEntry = extras?.bestPriceSinceEntry ?? pos.entryPrice;
    this.entryRollingMean = this.rollingMean; // use current mean (computed during warmup)

    // Re-open paper state only — Drift position already exists, don't place a duplicate order
    if ('recoverPaper' in this.paper) {
      (this.paper as any).recoverPaper(pos.direction, pos.entryPrice, pos.size, this.entryTickTime);
    } else {
      this.paper.openPaper(pos.direction, pos.entryPrice, pos.size, 0, this.entryTickTime);
    }

    console.log(
      `[${this.name}] RECOVERED ${pos.direction.toUpperCase()} @ $${pos.entryPrice.toFixed(2)} | ` +
      `regime=${this.entryRegime} best=$${this.bestPriceSinceEntry.toFixed(2)}`,
    );

    decisionLog.log('recovery', this.name, pos.entryPrice,
      `Recovered ${pos.direction.toUpperCase()} ${pos.size.toFixed(4)} SOL @ $${pos.entryPrice.toFixed(2)} — regime=${this.entryRegime}`,
      { direction: pos.direction, size: +pos.size.toFixed(4), entryPrice: +pos.entryPrice.toFixed(2),
        entryRegime: this.entryRegime, bestPriceSinceEntry: +this.bestPriceSinceEntry.toFixed(2),
        hadStateFile: !!extras });
  }

  setBankroll(bm: BankrollManager): void {
    this.bankroll = bm;
  }

  private getBetSize(): number {
    return this.bankroll?.getBetSize('regime') ?? this.config.betSizeSol;
  }

  stop(): void {
    // No timers to clean up — exits are purely price-based
  }
}
