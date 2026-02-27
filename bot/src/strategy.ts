import { Detector } from './detector.js';
import { DriftWrapper } from './drift.js';
import { SOL_FEED_ID } from './feed.js';
import type { Tick } from './feed.js';
// Legacy config interface (this class is not used in the active codebase)
interface LegacyStrategyConfig {
  name: string;
  subAccountId: number;
  threshold: number;
  window: number;
  holdSeconds: number;
  leverage: number;
  betSizeSol: number;
}

// Drift taker fee: 10 bps (0.1%) per side
const TAKER_FEE_BPS = 10;
const TAKER_FEE_RATE = TAKER_FEE_BPS / 10_000;

export class Strategy {
  private readonly name: string;
  private readonly subAccountId: number;
  private readonly holdSeconds: number;
  private readonly betSizeSol: number;
  private readonly detector: Detector;
  private readonly drift: DriftWrapper;
  private readonly dryRun: boolean;
  private _inPosition = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastSolPrice = 0;
  private _entryPrice = 0;
  private _entryDirection: 'long' | 'short' = 'long';
  private _cumulativePnlSol = 0;
  private _cumulativeFeesSol = 0;
  private _tradeCount = 0;

  get inPosition() { return this._inPosition; }
  get lastSolPrice() { return this._lastSolPrice; }
  get entryPrice() { return this._entryPrice; }
  get entryDirection() { return this._entryDirection; }
  get cumulativePnlSol() { return this._cumulativePnlSol; }
  get cumulativeFeesSol() { return this._cumulativeFeesSol; }
  get tradeCount() { return this._tradeCount; }

  constructor(config: LegacyStrategyConfig, drift: DriftWrapper, dryRun: boolean) {
    this.name = config.name;
    this.subAccountId = config.subAccountId;
    this.holdSeconds = config.holdSeconds;
    this.betSizeSol = config.betSizeSol;
    this.drift = drift;
    this.dryRun = dryRun;

    this.detector = new Detector(config.threshold, config.window);
  }

  onTick(tick: Tick): void {
    if (tick.feedId !== SOL_FEED_ID) return;

    this._lastSolPrice = tick.price;

    const signal = this.detector.onTick(tick.price, tick.publishTime);
    if (!signal) return;

    if (this._inPosition) {
      this.log(`SIGNAL ${signal.direction.toUpperCase()} SOL ${signal.pctChange > 0 ? '+' : ''}${signal.pctChange.toFixed(2)}% — skipped (in position)`);
      return;
    }

    const dryTag = this.dryRun ? ' (DRY RUN)' : '';
    const dir = signal.direction === 'long' ? 'PUMP' : 'DUMP';
    this.log(
      `SOL ${dir} ${signal.pctChange > 0 ? '+' : ''}${signal.pctChange.toFixed(2)}% → ` +
      `${signal.direction.toUpperCase()} ${this.betSizeSol} SOL @ $${this._lastSolPrice.toFixed(2)}${dryTag}`,
    );

    this.openAndScheduleClose(signal.direction as 'long' | 'short');
  }

  private async openAndScheduleClose(direction: 'long' | 'short'): Promise<void> {
    this._inPosition = true;
    this._entryPrice = this._lastSolPrice;
    this._entryDirection = direction;

    try {
      await this.drift.openPosition(this.subAccountId, direction, this.betSizeSol);
    } catch (err) {
      console.error(`[${this.name}] Failed to open position:`, err);
      this._inPosition = false;
      return;
    }

    this.holdTimer = setTimeout(async () => {
      try {
        await this.drift.closePosition(this.subAccountId);
      } catch (err) {
        console.error(`[${this.name}] Failed to close position:`, err);
      } finally {
        this.logExit();
        this._inPosition = false;
        this.holdTimer = null;
      }
    }, this.holdSeconds * 1000);
  }

  private logExit(): void {
    const exitPrice = this._lastSolPrice;
    const entry = this._entryPrice;

    // PnL in USD then convert to SOL
    const pnlUsd =
      this._entryDirection === 'long'
        ? this.betSizeSol * (exitPrice - entry)
        : this.betSizeSol * (entry - exitPrice);

    // Fees: taker fee on notional each side
    const entryFeeUsd = this.betSizeSol * entry * TAKER_FEE_RATE;
    const exitFeeUsd = this.betSizeSol * exitPrice * TAKER_FEE_RATE;
    const totalFeeUsd = entryFeeUsd + exitFeeUsd;

    // Convert to SOL at exit price
    const pnlSol = exitPrice > 0 ? pnlUsd / exitPrice : 0;
    const feeSol = exitPrice > 0 ? totalFeeUsd / exitPrice : 0;
    const netPnlSol = pnlSol - feeSol;

    this._tradeCount++;
    this._cumulativePnlSol += netPnlSol;
    this._cumulativeFeesSol += feeSol;

    const dryTag = this.dryRun ? ' (DRY RUN)' : '';
    const sign = netPnlSol >= 0 ? '+' : '';
    const pctMove = entry > 0 ? ((exitPrice / entry - 1) * 100).toFixed(3) : '?';
    const solSign = pnlSol >= 0 ? '+' : '';

    this.log(
      `EXIT after ${this.holdSeconds}s | ` +
      `$${entry.toFixed(2)} → $${exitPrice.toFixed(2)} (${pctMove}%) | ` +
      `pnl ${solSign}${pnlSol.toFixed(6)} SOL - fee ${feeSol.toFixed(6)} SOL = net ${sign}${netPnlSol.toFixed(6)} SOL | ` +
      `cumulative ${this._cumulativePnlSol >= 0 ? '+' : ''}${this._cumulativePnlSol.toFixed(6)} SOL (${this._tradeCount} trades, ${this._cumulativeFeesSol.toFixed(6)} SOL fees)${dryTag}`,
    );
  }

  stop(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private log(msg: string): void {
    console.log(`[${this.name}] ${msg}`);
  }
}
