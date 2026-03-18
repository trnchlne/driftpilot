/**
 * Research: Find a new regime strategy that outperforms existing ones.
 *
 * Tests several fundamentally different approaches:
 *
 * 1. SQUEEZE — Only enter after volatility compression + expansion
 *    (filters out chop naturally, catches big moves)
 *
 * 2. DUAL-TF — Require short + long timeframe trend agreement
 *    (fewer but higher-conviction entries)
 *
 * 3. MOMENTUM-FILTER — Use rolling momentum percentile as entry gate
 *    (only enter when momentum is extreme)
 *
 * 4. CHANNEL — Enter on breakout of N-period high/low channel
 *    (classic Donchian-style, adapted with ATR stops)
 *
 * Each is implemented as a standalone strategy in this file for fast iteration.
 */

import { readFileSync } from 'node:fs';
import { SOL_FEED_ID } from './feed.js';
import type { Tick } from './feed.js';
import type { BaseStrategy, PerformanceMetrics, Direction } from './base-strategy.js';
import { PaperTrader } from './base-strategy.js';
import { BankrollManager } from './bankroll.js';

const LEVERAGE = 10;
const TAKER_FEE = 2 / 10_000;
const MAKER_FEE = 0;

/* ─── Data Loading ─── */

function loadTicks(filePath: string): Tick[] {
  const raw = readFileSync(filePath, 'utf-8');
  const ticks: Tick[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      ticks.push({ feedId: obj.feedId, price: obj.price, publishTime: obj.publishTime });
    } catch { /* skip */ }
  }
  ticks.sort((a, b) => a.publishTime - b.publishTime);
  return ticks;
}

/* ═══════════════════════════════════════════════════════════════
   Strategy 1: SQUEEZE BREAKOUT
   ─────────────────────────────────────────────────────────────
   - Track ATR over time, compute ATR percentile (is current vol high or low?)
   - "Squeeze" = ATR drops below squeezePercentile for squeezeMinMinutes
   - After squeeze, enter on first breakout of squeezeMult × ATR
   - Exit: trailing ATR stop + hard SL
   ═══════════════════════════════════════════════════════════════ */

interface SqueezeConfig {
  atrPeriod: number;          // minutes for ATR rolling avg
  atrHistoryMinutes: number;  // lookback for ATR percentile
  squeezePercentile: number;  // ATR must drop below this percentile (0-100)
  squeezeMinMinutes: number;  // minimum duration of squeeze before arming
  breakoutMult: number;       // entry: price move > breakoutMult × scaledATR over breakoutWindow
  breakoutWindowMin: number;  // minutes for breakout detection
  trailAtrMult: number;       // trailing stop = mult × scaledATR
  trailDelaySeconds: number;  // grace before trail activates
  hardSlPct: number;          // fixed SL from entry
  cooldownSeconds: number;
  betSizeSol: number;
}

class SqueezeStrategy {
  readonly name: string;
  private config: SqueezeConfig;
  private paper: PaperTrader;
  private bankroll: BankrollManager | null = null;

  // ATR
  private atrBuffer: number[] = [];
  private atrHistory: number[] = []; // rolling history of ATR values for percentile
  private lastAtrPrice = 0;
  private lastAtrSampleTime = 0;
  private atrPct = 0;

  // Price buffer
  private priceBuffer: { time: number; price: number }[] = [];

  // Squeeze state
  private inSqueeze = false;
  private squeezeStartTime = 0;
  private armed = false; // squeeze completed, waiting for breakout

  // Position
  private entryPrice = 0;
  private entryDirection: Direction = 'long';
  private entryTickTime = 0;
  private bestPrice = 0;
  private lastExitTime = 0;
  private lastTickTime = 0;

  constructor(name: string, config: SqueezeConfig) {
    this.name = name;
    this.config = config;
    this.paper = new PaperTrader(name);
  }

  setBankroll(bm: BankrollManager) { this.bankroll = bm; }
  getMetrics() { return this.paper.getMetrics(); }

  onTick(tick: Tick): void {
    if (tick.feedId !== SOL_FEED_ID) return;
    const now = tick.publishTime;
    const price = tick.price;

    // ATR update
    if (this.lastAtrPrice > 0) {
      if (now - this.lastAtrSampleTime >= 60) {
        const deltaPct = (Math.abs(price - this.lastAtrPrice) / this.lastAtrPrice) * 100;
        this.atrBuffer.push(deltaPct);
        if (this.atrBuffer.length > this.config.atrPeriod) this.atrBuffer.shift();
        this.lastAtrSampleTime = now;
        this.lastAtrPrice = price;

        if (this.atrBuffer.length > 0) {
          this.atrPct = this.atrBuffer.reduce((a, b) => a + b, 0) / this.atrBuffer.length;
        }

        // Track ATR history for percentile
        if (this.atrPct > 0) {
          this.atrHistory.push(this.atrPct);
          const maxHist = this.config.atrHistoryMinutes;
          if (this.atrHistory.length > maxHist) this.atrHistory.shift();
        }
      }
    } else {
      this.lastAtrSampleTime = now;
      this.lastAtrPrice = price;
    }

    // Price buffer (keep enough for breakout window)
    this.priceBuffer.push({ time: now, price });
    const bufCutoff = now - Math.max(this.config.breakoutWindowMin * 60, 4 * 3600);
    while (this.priceBuffer.length > 0 && this.priceBuffer[0].time < bufCutoff) {
      this.priceBuffer.shift();
    }

    this.lastTickTime = now;

    // Warmup
    if (this.atrBuffer.length < this.config.atrPeriod) return;
    if (this.atrHistory.length < 60) return; // need 1h of ATR history minimum

    // In position: check exits
    if (this.paper.inPosition) {
      this.checkExit(price, now);
      return;
    }

    // Cooldown
    if (this.lastExitTime > 0 && (now - this.lastExitTime) < this.config.cooldownSeconds) return;

    // Squeeze detection
    const percentile = this.getAtrPercentile();

    if (percentile < this.config.squeezePercentile) {
      if (!this.inSqueeze) {
        this.inSqueeze = true;
        this.squeezeStartTime = now;
      }
      // Check if squeeze has lasted long enough to arm
      if ((now - this.squeezeStartTime) >= this.config.squeezeMinMinutes * 60) {
        this.armed = true;
      }
    } else {
      // ATR expanded — if we were armed, look for breakout
      if (this.armed) {
        this.checkBreakout(price, now);
      }
      // Reset squeeze state (but keep armed until we enter or it fades)
      this.inSqueeze = false;
      this.squeezeStartTime = 0;

      // Disarm after too long without entry (ATR expanded but no breakout)
      // Give it 2x the breakout window to fire
      if (this.armed && this.priceBuffer.length > 10) {
        // Disarm handled by breakout check returning false repeatedly
      }
    }
  }

  private getAtrPercentile(): number {
    if (this.atrHistory.length < 10) return 50;
    const sorted = [...this.atrHistory].sort((a, b) => a - b);
    const idx = sorted.findIndex(v => v >= this.atrPct);
    return (idx / sorted.length) * 100;
  }

  private scaledAtr(windowMin: number): number {
    return this.atrPct * Math.sqrt(windowMin);
  }

  private checkBreakout(price: number, now: number): void {
    const cutoff = now - this.config.breakoutWindowMin * 60;
    let oldest: { time: number; price: number } | null = null;
    for (const s of this.priceBuffer) {
      if (s.time >= cutoff) { oldest = s; break; }
    }
    if (!oldest) return;

    const changePct = ((price / oldest.price) - 1) * 100;
    const threshold = this.config.breakoutMult * this.scaledAtr(this.config.breakoutWindowMin);

    if (Math.abs(changePct) > threshold) {
      const direction: Direction = changePct > 0 ? 'long' : 'short';
      this.enter(direction, price, now);
      this.armed = false;
    }
  }

  private enter(direction: Direction, price: number, now: number): void {
    const betSize = this.bankroll ? this.bankroll.getBetSize('regime') : this.config.betSizeSol;
    if (betSize <= 0) return;

    this.entryPrice = price;
    this.entryDirection = direction;
    this.entryTickTime = now;
    this.bestPrice = price;

    this.bankroll?.reserveCapital(betSize);
    this.paper.openPaper(direction, price, betSize * LEVERAGE, TAKER_FEE, now);
  }

  private checkExit(price: number, now: number): void {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;

    // Hard SL
    if (favorable <= -this.config.hardSlPct) {
      this.exit(price, now);
      return;
    }

    // Track best
    if (this.entryDirection === 'long' && price > this.bestPrice) this.bestPrice = price;
    if (this.entryDirection === 'short' && price < this.bestPrice) this.bestPrice = price;

    // Trail delay
    if ((now - this.entryTickTime) < this.config.trailDelaySeconds) return;

    // ATR trailing stop
    const trailPct = this.config.trailAtrMult * this.scaledAtr(240); // 4h scaled
    if (this.entryDirection === 'long') {
      const drawdown = ((this.bestPrice - price) / this.bestPrice) * 100;
      if (drawdown >= trailPct) this.exit(price, now);
    } else {
      const drawup = ((price - this.bestPrice) / this.bestPrice) * 100;
      if (drawup >= trailPct) this.exit(price, now);
    }
  }

  private exit(price: number, now: number): void {
    const trade = this.paper.closePaper(price, TAKER_FEE, now);
    if (trade) {
      this.bankroll?.releaseCapital(Math.abs(trade.sizeSol) / LEVERAGE);
      this.bankroll?.recordPnl(trade.netPnlSol);
    }
    this.lastExitTime = now;
  }
}

/* ═══════════════════════════════════════════════════════════════
   Strategy 2: DUAL TIMEFRAME TREND
   ─────────────────────────────────────────────────────────────
   - Long window (8h) determines primary trend direction
   - Short window (1h) confirms with momentum signal
   - Only enter when both agree
   - Exit: ATR trail + hard SL
   ═══════════════════════════════════════════════════════════════ */

interface DualTFConfig {
  atrPeriod: number;
  longWindowSeconds: number;   // 8h or 12h — macro trend
  shortWindowSeconds: number;  // 1h — signal
  longThresholdMult: number;   // long window trend threshold (× ATR)
  shortThresholdMult: number;  // short window signal threshold (× ATR)
  trailAtrMult: number;
  trailDelaySeconds: number;
  hardSlPct: number;
  cooldownSeconds: number;
  betSizeSol: number;
}

class DualTFStrategy {
  readonly name: string;
  private config: DualTFConfig;
  private paper: PaperTrader;
  private bankroll: BankrollManager | null = null;

  private atrBuffer: number[] = [];
  private lastAtrPrice = 0;
  private lastAtrSampleTime = 0;
  private atrPct = 0;
  private priceBuffer: { time: number; price: number }[] = [];

  private entryPrice = 0;
  private entryDirection: Direction = 'long';
  private entryTickTime = 0;
  private bestPrice = 0;
  private lastExitTime = 0;
  private lastTickTime = 0;
  private warmedUp = false;

  constructor(name: string, config: DualTFConfig) {
    this.name = name;
    this.config = config;
    this.paper = new PaperTrader(name);
  }

  setBankroll(bm: BankrollManager) { this.bankroll = bm; }
  getMetrics() { return this.paper.getMetrics(); }

  onTick(tick: Tick): void {
    if (tick.feedId !== SOL_FEED_ID) return;
    const now = tick.publishTime;
    const price = tick.price;

    // ATR
    if (this.lastAtrPrice > 0) {
      if (now - this.lastAtrSampleTime >= 60) {
        const deltaPct = (Math.abs(price - this.lastAtrPrice) / this.lastAtrPrice) * 100;
        this.atrBuffer.push(deltaPct);
        if (this.atrBuffer.length > this.config.atrPeriod) this.atrBuffer.shift();
        this.lastAtrSampleTime = now;
        this.lastAtrPrice = price;
        if (this.atrBuffer.length > 0) {
          this.atrPct = this.atrBuffer.reduce((a, b) => a + b, 0) / this.atrBuffer.length;
        }
      }
    } else {
      this.lastAtrSampleTime = now;
      this.lastAtrPrice = price;
    }

    // Price buffer
    this.priceBuffer.push({ time: now, price });
    const cutoff = now - this.config.longWindowSeconds * 1.1;
    while (this.priceBuffer.length > 0 && this.priceBuffer[0].time < cutoff) {
      this.priceBuffer.shift();
    }

    this.lastTickTime = now;

    // Warmup
    if (!this.warmedUp) {
      if (this.atrBuffer.length >= this.config.atrPeriod) {
        const span = this.priceBuffer.length > 0 ? now - this.priceBuffer[0].time : 0;
        if (span >= this.config.longWindowSeconds * 0.9) this.warmedUp = true;
      }
      if (!this.warmedUp) return;
    }

    if (this.paper.inPosition) {
      this.checkExit(price, now);
      return;
    }

    if (this.lastExitTime > 0 && (now - this.lastExitTime) < this.config.cooldownSeconds) return;
    if (this.atrPct <= 0) return;

    // Long window trend
    const longChange = this.getWindowChange(now, this.config.longWindowSeconds);
    const longAtr = this.atrPct * Math.sqrt(this.config.longWindowSeconds / 60);
    const longThreshold = this.config.longThresholdMult * longAtr;

    if (Math.abs(longChange) < longThreshold) return; // no macro trend
    const macroDir: Direction = longChange > 0 ? 'long' : 'short';

    // Short window signal (must agree with macro)
    const shortChange = this.getWindowChange(now, this.config.shortWindowSeconds);
    const shortAtr = this.atrPct * Math.sqrt(this.config.shortWindowSeconds / 60);
    const shortThreshold = this.config.shortThresholdMult * shortAtr;

    if (macroDir === 'long' && shortChange > shortThreshold) {
      this.enter('long', price, now);
    } else if (macroDir === 'short' && shortChange < -shortThreshold) {
      this.enter('short', price, now);
    }
  }

  private getWindowChange(now: number, windowSec: number): number {
    const cutoff = now - windowSec;
    for (const s of this.priceBuffer) {
      if (s.time >= cutoff) {
        return ((this.priceBuffer[this.priceBuffer.length - 1].price / s.price) - 1) * 100;
      }
    }
    return 0;
  }

  private enter(direction: Direction, price: number, now: number): void {
    const betSize = this.bankroll ? this.bankroll.getBetSize('regime') : this.config.betSizeSol;
    if (betSize <= 0) return;
    this.entryPrice = price;
    this.entryDirection = direction;
    this.entryTickTime = now;
    this.bestPrice = price;
    this.bankroll?.reserveCapital(betSize);
    this.paper.openPaper(direction, price, betSize * LEVERAGE, TAKER_FEE, now);
  }

  private checkExit(price: number, now: number): void {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;

    if (favorable <= -this.config.hardSlPct) { this.exit(price, now); return; }

    if (this.entryDirection === 'long' && price > this.bestPrice) this.bestPrice = price;
    if (this.entryDirection === 'short' && price < this.bestPrice) this.bestPrice = price;

    if ((now - this.entryTickTime) < this.config.trailDelaySeconds) return;

    const trailPct = this.config.trailAtrMult * this.atrPct * Math.sqrt(240);
    if (this.entryDirection === 'long') {
      if (((this.bestPrice - price) / this.bestPrice) * 100 >= trailPct) this.exit(price, now);
    } else {
      if (((price - this.bestPrice) / this.bestPrice) * 100 >= trailPct) this.exit(price, now);
    }
  }

  private exit(price: number, now: number): void {
    const trade = this.paper.closePaper(price, TAKER_FEE, now);
    if (trade) {
      this.bankroll?.releaseCapital(Math.abs(trade.sizeSol) / LEVERAGE);
      this.bankroll?.recordPnl(trade.netPnlSol);
    }
    this.lastExitTime = now;
  }
}

/* ═══════════════════════════════════════════════════════════════
   Strategy 3: CHANNEL BREAKOUT (Donchian-style)
   ─────────────────────────────────────────────────────────────
   - Track rolling N-period high and low
   - Enter long on new high, short on new low
   - ATR filter: only enter when ATR > minAtrPct
   - Exit: ATR trail + hard SL
   ═══════════════════════════════════════════════════════════════ */

interface ChannelConfig {
  atrPeriod: number;
  channelMinutes: number;       // lookback for high/low channel
  confirmMinutes: number;       // price must stay outside channel for this long
  trailAtrMult: number;
  trailDelaySeconds: number;
  hardSlPct: number;
  cooldownSeconds: number;
  minAtrPct: number;
  betSizeSol: number;
}

class ChannelStrategy {
  readonly name: string;
  private config: ChannelConfig;
  private paper: PaperTrader;
  private bankroll: BankrollManager | null = null;

  private atrBuffer: number[] = [];
  private lastAtrPrice = 0;
  private lastAtrSampleTime = 0;
  private atrPct = 0;

  // Channel tracking (sampled once per minute for efficiency)
  private minutePrices: { time: number; price: number }[] = [];
  private lastMinuteSample = 0;

  private entryPrice = 0;
  private entryDirection: Direction = 'long';
  private entryTickTime = 0;
  private bestPrice = 0;
  private lastExitTime = 0;
  private lastTickTime = 0;
  private warmedUp = false;

  // Breakout confirmation
  private breakoutDir: Direction | null = null;
  private breakoutStartTime = 0;

  constructor(name: string, config: ChannelConfig) {
    this.name = name;
    this.config = config;
    this.paper = new PaperTrader(name);
  }

  setBankroll(bm: BankrollManager) { this.bankroll = bm; }
  getMetrics() { return this.paper.getMetrics(); }

  onTick(tick: Tick): void {
    if (tick.feedId !== SOL_FEED_ID) return;
    const now = tick.publishTime;
    const price = tick.price;

    // ATR
    if (this.lastAtrPrice > 0) {
      if (now - this.lastAtrSampleTime >= 60) {
        const deltaPct = (Math.abs(price - this.lastAtrPrice) / this.lastAtrPrice) * 100;
        this.atrBuffer.push(deltaPct);
        if (this.atrBuffer.length > this.config.atrPeriod) this.atrBuffer.shift();
        this.lastAtrSampleTime = now;
        this.lastAtrPrice = price;
        if (this.atrBuffer.length > 0) {
          this.atrPct = this.atrBuffer.reduce((a, b) => a + b, 0) / this.atrBuffer.length;
        }
      }
    } else {
      this.lastAtrSampleTime = now;
      this.lastAtrPrice = price;
    }

    // Minute price sampling
    if (now - this.lastMinuteSample >= 60) {
      this.minutePrices.push({ time: now, price });
      const cutoff = now - this.config.channelMinutes * 60 * 1.1;
      while (this.minutePrices.length > 0 && this.minutePrices[0].time < cutoff) {
        this.minutePrices.shift();
      }
      this.lastMinuteSample = now;
    }

    this.lastTickTime = now;

    // Warmup
    if (!this.warmedUp) {
      if (this.atrBuffer.length >= this.config.atrPeriod && this.minutePrices.length >= this.config.channelMinutes * 0.9) {
        this.warmedUp = true;
      }
      if (!this.warmedUp) return;
    }

    if (this.paper.inPosition) {
      this.checkExit(price, now);
      return;
    }

    if (this.lastExitTime > 0 && (now - this.lastExitTime) < this.config.cooldownSeconds) return;
    if (this.atrPct < this.config.minAtrPct) return;

    // Compute channel (exclude last confirmMinutes to avoid self-referencing)
    const channelCutoff = now - this.config.channelMinutes * 60;
    const confirmCutoff = now - this.config.confirmMinutes * 60;
    let high = -Infinity, low = Infinity;
    for (const s of this.minutePrices) {
      if (s.time >= channelCutoff && s.time < confirmCutoff) {
        if (s.price > high) high = s.price;
        if (s.price < low) low = s.price;
      }
    }
    if (high === -Infinity) return;

    // Check breakout
    if (price > high) {
      if (this.breakoutDir !== 'long') {
        this.breakoutDir = 'long';
        this.breakoutStartTime = now;
      }
      if ((now - this.breakoutStartTime) >= this.config.confirmMinutes * 60) {
        this.enter('long', price, now);
        this.breakoutDir = null;
      }
    } else if (price < low) {
      if (this.breakoutDir !== 'short') {
        this.breakoutDir = 'short';
        this.breakoutStartTime = now;
      }
      if ((now - this.breakoutStartTime) >= this.config.confirmMinutes * 60) {
        this.enter('short', price, now);
        this.breakoutDir = null;
      }
    } else {
      this.breakoutDir = null;
    }
  }

  private enter(direction: Direction, price: number, now: number): void {
    const betSize = this.bankroll ? this.bankroll.getBetSize('regime') : this.config.betSizeSol;
    if (betSize <= 0) return;
    this.entryPrice = price;
    this.entryDirection = direction;
    this.entryTickTime = now;
    this.bestPrice = price;
    this.bankroll?.reserveCapital(betSize);
    this.paper.openPaper(direction, price, betSize * LEVERAGE, TAKER_FEE, now);
  }

  private checkExit(price: number, now: number): void {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;
    if (favorable <= -this.config.hardSlPct) { this.exit(price, now); return; }

    if (this.entryDirection === 'long' && price > this.bestPrice) this.bestPrice = price;
    if (this.entryDirection === 'short' && price < this.bestPrice) this.bestPrice = price;

    if ((now - this.entryTickTime) < this.config.trailDelaySeconds) return;

    const trailPct = this.config.trailAtrMult * this.atrPct * Math.sqrt(240);
    if (this.entryDirection === 'long') {
      if (((this.bestPrice - price) / this.bestPrice) * 100 >= trailPct) this.exit(price, now);
    } else {
      if (((price - this.bestPrice) / this.bestPrice) * 100 >= trailPct) this.exit(price, now);
    }
  }

  private exit(price: number, now: number): void {
    const trade = this.paper.closePaper(price, TAKER_FEE, now);
    if (trade) {
      this.bankroll?.releaseCapital(Math.abs(trade.sizeSol) / LEVERAGE);
      this.bankroll?.recordPnl(trade.netPnlSol);
    }
    this.lastExitTime = now;
  }
}

/* ═══════════════════════════════════════════════════════════════
   Strategy 4: MOMENTUM PERCENTILE
   ─────────────────────────────────────────────────────────────
   - Track N-minute rate of change
   - Compute percentile of current momentum vs history
   - Enter when momentum hits extreme percentile (>90th or <10th)
   - Direction follows momentum
   - Exit: ATR trail + hard SL
   ═══════════════════════════════════════════════════════════════ */

interface MomentumPctConfig {
  atrPeriod: number;
  momentumMinutes: number;      // rate of change window
  historyMinutes: number;       // lookback for percentile calc
  entryPercentile: number;      // enter above this (e.g., 90 = top 10%)
  trailAtrMult: number;
  trailDelaySeconds: number;
  hardSlPct: number;
  cooldownSeconds: number;
  minAtrPct: number;
  betSizeSol: number;
}

class MomentumPctStrategy {
  readonly name: string;
  private config: MomentumPctConfig;
  private paper: PaperTrader;
  private bankroll: BankrollManager | null = null;

  private atrBuffer: number[] = [];
  private lastAtrPrice = 0;
  private lastAtrSampleTime = 0;
  private atrPct = 0;

  private priceBuffer: { time: number; price: number }[] = [];
  private momentumHistory: number[] = [];

  private entryPrice = 0;
  private entryDirection: Direction = 'long';
  private entryTickTime = 0;
  private bestPrice = 0;
  private lastExitTime = 0;
  private lastTickTime = 0;
  private warmedUp = false;

  constructor(name: string, config: MomentumPctConfig) {
    this.name = name;
    this.config = config;
    this.paper = new PaperTrader(name);
  }

  setBankroll(bm: BankrollManager) { this.bankroll = bm; }
  getMetrics() { return this.paper.getMetrics(); }

  onTick(tick: Tick): void {
    if (tick.feedId !== SOL_FEED_ID) return;
    const now = tick.publishTime;
    const price = tick.price;

    // ATR
    if (this.lastAtrPrice > 0) {
      if (now - this.lastAtrSampleTime >= 60) {
        const deltaPct = (Math.abs(price - this.lastAtrPrice) / this.lastAtrPrice) * 100;
        this.atrBuffer.push(deltaPct);
        if (this.atrBuffer.length > this.config.atrPeriod) this.atrBuffer.shift();
        this.lastAtrSampleTime = now;
        this.lastAtrPrice = price;
        if (this.atrBuffer.length > 0) {
          this.atrPct = this.atrBuffer.reduce((a, b) => a + b, 0) / this.atrBuffer.length;
        }
      }
    } else {
      this.lastAtrSampleTime = now;
      this.lastAtrPrice = price;
    }

    // Price buffer
    this.priceBuffer.push({ time: now, price });
    const cutoff = now - Math.max(this.config.momentumMinutes, this.config.historyMinutes) * 60 * 1.1;
    while (this.priceBuffer.length > 0 && this.priceBuffer[0].time < cutoff) {
      this.priceBuffer.shift();
    }

    this.lastTickTime = now;

    // Compute current momentum
    const momCutoff = now - this.config.momentumMinutes * 60;
    let momOldest: { time: number; price: number } | null = null;
    for (const s of this.priceBuffer) {
      if (s.time >= momCutoff) { momOldest = s; break; }
    }

    if (!momOldest) return;
    const momentum = ((price / momOldest.price) - 1) * 100;

    // Track momentum history (one sample per minute)
    if (now - this.lastAtrSampleTime < 2) { // piggyback on ATR timing
      this.momentumHistory.push(momentum);
      if (this.momentumHistory.length > this.config.historyMinutes) {
        this.momentumHistory.shift();
      }
    }

    // Warmup
    if (!this.warmedUp) {
      if (this.atrBuffer.length >= this.config.atrPeriod && this.momentumHistory.length >= 120) {
        this.warmedUp = true;
      }
      if (!this.warmedUp) return;
    }

    if (this.paper.inPosition) {
      this.checkExit(price, now);
      return;
    }

    if (this.lastExitTime > 0 && (now - this.lastExitTime) < this.config.cooldownSeconds) return;
    if (this.atrPct < this.config.minAtrPct) return;

    // Compute momentum percentile
    const absMom = Math.abs(momentum);
    const sorted = this.momentumHistory.map(Math.abs).sort((a, b) => a - b);
    const idx = sorted.findIndex(v => v >= absMom);
    const percentile = (idx / sorted.length) * 100;

    if (percentile >= this.config.entryPercentile) {
      const direction: Direction = momentum > 0 ? 'long' : 'short';
      this.enter(direction, price, now);
    }
  }

  private enter(direction: Direction, price: number, now: number): void {
    const betSize = this.bankroll ? this.bankroll.getBetSize('regime') : this.config.betSizeSol;
    if (betSize <= 0) return;
    this.entryPrice = price;
    this.entryDirection = direction;
    this.entryTickTime = now;
    this.bestPrice = price;
    this.bankroll?.reserveCapital(betSize);
    this.paper.openPaper(direction, price, betSize * LEVERAGE, TAKER_FEE, now);
  }

  private checkExit(price: number, now: number): void {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;
    if (favorable <= -this.config.hardSlPct) { this.exit(price, now); return; }

    if (this.entryDirection === 'long' && price > this.bestPrice) this.bestPrice = price;
    if (this.entryDirection === 'short' && price < this.bestPrice) this.bestPrice = price;

    if ((now - this.entryTickTime) < this.config.trailDelaySeconds) return;

    const trailPct = this.config.trailAtrMult * this.atrPct * Math.sqrt(240);
    if (this.entryDirection === 'long') {
      if (((this.bestPrice - price) / this.bestPrice) * 100 >= trailPct) this.exit(price, now);
    } else {
      if (((price - this.bestPrice) / this.bestPrice) * 100 >= trailPct) this.exit(price, now);
    }
  }

  private exit(price: number, now: number): void {
    const trade = this.paper.closePaper(price, TAKER_FEE, now);
    if (trade) {
      this.bankroll?.releaseCapital(Math.abs(trade.sizeSol) / LEVERAGE);
      this.bankroll?.recordPnl(trade.netPnlSol);
    }
    this.lastExitTime = now;
  }
}


/* ═══════════════════════════════════════════════════════════════
   PARAMETER GRID + RUNNER
   ═══════════════════════════════════════════════════════════════ */

const DATA_DIR = new URL('../data/', import.meta.url).pathname;
const BANKROLL = 3;

interface TestResult {
  name: string;
  roi: number;
  trades: number;
  wr: number;
  pf: number;
  sharpe: number;
  maxDd: number;
  pnl: number;
}

function runStrategy(
  factory: () => { onTick: (t: Tick) => void; getMetrics: () => PerformanceMetrics; setBankroll: (bm: BankrollManager) => void },
  ticks: Tick[],
  name: string,
): TestResult {
  const strat = factory();
  const bm = new BankrollManager({ mode: 'paper', initialEquitySol: BANKROLL });
  strat.setBankroll(bm);

  let peak = BANKROLL;
  let maxDd = 0;

  for (const tick of ticks) {
    strat.onTick(tick);
    const eq = bm.getEquity();
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const m = strat.getMetrics();
  return {
    name,
    roi: ((bm.getEquity() - BANKROLL) / BANKROLL) * 100,
    trades: m.totalTrades,
    wr: m.winRate * 100,
    pf: m.profitFactor,
    sharpe: m.sharpe,
    maxDd,
    pnl: m.netPnlSol,
  };
}

function printResults(results: TestResult[], sortBy: 'roi' | 'sharpe' = 'sharpe'): void {
  results.sort((a, b) => b[sortBy] - a[sortBy]);
  console.log(`${'#'.padStart(3)} ${'Name'.padEnd(35)} | ${'ROI'.padStart(8)} | ${'Trades'.padStart(6)} | ${'WR%'.padStart(5)} | ${'PF'.padStart(5)} | ${'Sharpe'.padStart(7)} | ${'MaxDD'.padStart(6)} | ${'PnL'.padStart(8)}`);
  console.log('─'.repeat(105));
  for (let i = 0; i < Math.min(results.length, 30); i++) {
    const r = results[i];
    const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`;
    const pnl = `${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(3)}`;
    console.log(`${String(i + 1).padStart(3)} ${r.name.padEnd(35)} | ${roi.padStart(8)} | ${String(r.trades).padStart(6)} | ${r.wr.toFixed(1).padStart(5)} | ${r.pf.toFixed(2).padStart(5)} | ${r.sharpe.toFixed(3).padStart(7)} | ${r.maxDd.toFixed(1).padStart(5)}% | ${pnl.padStart(8)}`);
  }
}

// ── Main ──
for (const dataFile of ['history-2y.jsonl']) {
  let ticks: Tick[];
  try {
    ticks = loadTicks(`${DATA_DIR}${dataFile}`);
  } catch {
    console.log(`Skipping ${dataFile}`);
    continue;
  }

  const days = Math.round((ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400);
  console.log(`\n${'═'.repeat(105)}`);
  console.log(`  ${dataFile} (${days} days, ${ticks.length} ticks)`);
  console.log(`${'═'.repeat(105)}\n`);

  const results: TestResult[] = [];

  // ── Squeeze configs ──
  for (const atrPeriod of [60, 90]) {
    for (const squeezePercentile of [20, 30]) {
      for (const squeezeMinMinutes of [30, 60]) {
        for (const breakoutMult of [2.0, 3.0, 4.0]) {
          for (const breakoutWindowMin of [15, 30]) {
            for (const trailAtrMult of [1.0, 1.5]) {
              for (const hardSlPct of [2.0, 3.0]) {
                const name = `SQ-a${atrPeriod}-p${squeezePercentile}-m${squeezeMinMinutes}-b${breakoutMult}-w${breakoutWindowMin}-t${trailAtrMult}-sl${hardSlPct}`;
                results.push(runStrategy(
                  () => new SqueezeStrategy(name, {
                    atrPeriod, atrHistoryMinutes: 4 * 60, squeezePercentile,
                    squeezeMinMinutes, breakoutMult, breakoutWindowMin,
                    trailAtrMult, trailDelaySeconds: 300, hardSlPct,
                    cooldownSeconds: 120, betSizeSol: 1.0,
                  }),
                  ticks, name,
                ));
              }
            }
          }
        }
      }
    }
  }

  // ── Dual TF configs ──
  for (const longWindowH of [6, 8, 12]) {
    for (const shortWindowMin of [30, 60, 120]) {
      for (const longThresholdMult of [0.8, 1.2, 1.5]) {
        for (const shortThresholdMult of [2.0, 3.0, 4.5]) {
          for (const trailAtrMult of [1.0, 1.5]) {
            for (const hardSlPct of [2.0, 3.0]) {
              const name = `DTF-l${longWindowH}h-s${shortWindowMin}m-lt${longThresholdMult}-st${shortThresholdMult}-t${trailAtrMult}-sl${hardSlPct}`;
              results.push(runStrategy(
                () => new DualTFStrategy(name, {
                  atrPeriod: 90, longWindowSeconds: longWindowH * 3600,
                  shortWindowSeconds: shortWindowMin * 60,
                  longThresholdMult, shortThresholdMult,
                  trailAtrMult, trailDelaySeconds: 300, hardSlPct,
                  cooldownSeconds: 120, betSizeSol: 1.0,
                }),
                ticks, name,
              ));
            }
          }
        }
      }
    }
  }

  // ── Channel configs ──
  for (const channelMinutes of [120, 240, 480]) {
    for (const confirmMinutes of [5, 15, 30]) {
      for (const trailAtrMult of [1.0, 1.5]) {
        for (const hardSlPct of [2.0, 3.0]) {
          const name = `CH-c${channelMinutes}-cf${confirmMinutes}-t${trailAtrMult}-sl${hardSlPct}`;
          results.push(runStrategy(
            () => new ChannelStrategy(name, {
              atrPeriod: 90, channelMinutes, confirmMinutes,
              trailAtrMult, trailDelaySeconds: 300, hardSlPct,
              cooldownSeconds: 180, minAtrPct: 0.03, betSizeSol: 1.0,
            }),
            ticks, name,
          ));
        }
      }
    }
  }

  // ── Momentum Percentile configs ──
  for (const momentumMinutes of [15, 30, 60]) {
    for (const entryPercentile of [85, 90, 95]) {
      for (const trailAtrMult of [1.0, 1.5]) {
        for (const hardSlPct of [2.0, 3.0]) {
          const name = `MP-m${momentumMinutes}-p${entryPercentile}-t${trailAtrMult}-sl${hardSlPct}`;
          results.push(runStrategy(
            () => new MomentumPctStrategy(name, {
              atrPeriod: 90, momentumMinutes, historyMinutes: 4 * 60,
              entryPercentile, trailAtrMult, trailDelaySeconds: 300,
              hardSlPct, cooldownSeconds: 120, minAtrPct: 0.03, betSizeSol: 1.0,
            }),
            ticks, name,
          ));
        }
      }
    }
  }

  console.log(`Tested ${results.length} configs\n`);

  // Filter to profitable only
  const profitable = results.filter(r => r.roi > 0 && r.trades >= 5);
  console.log(`── Top 30 by Sharpe (${profitable.length} profitable) ──\n`);
  printResults(profitable, 'sharpe');

  console.log(`\n── Top 30 by ROI ──\n`);
  printResults([...profitable], 'roi');
}
