import { describe, it, expect } from 'vitest';

// Test P&L and fee math in isolation (mirrors strategy.ts logExit logic)

const TAKER_FEE_RATE = 10 / 10_000; // 0.1% = 10 bps

function calculatePnl(
  direction: 'long' | 'short',
  entryPrice: number,
  exitPrice: number,
  betSizeSol: number,
) {
  const pnlUsd =
    direction === 'long'
      ? betSizeSol * (exitPrice - entryPrice)
      : betSizeSol * (entryPrice - exitPrice);

  const entryFeeUsd = betSizeSol * entryPrice * TAKER_FEE_RATE;
  const exitFeeUsd = betSizeSol * exitPrice * TAKER_FEE_RATE;
  const totalFeeUsd = entryFeeUsd + exitFeeUsd;

  const pnlSol = pnlUsd / exitPrice;
  const feeSol = totalFeeUsd / exitPrice;
  const netPnlSol = pnlSol - feeSol;

  return { pnlSol, feeSol, netPnlSol, totalFeeUsd };
}

describe('P&L math', () => {
  describe('long positions', () => {
    it('profitable long: SOL $100 → $101 (+1%)', () => {
      const r = calculatePnl('long', 100, 101, 0.2);
      // Gross: 0.2 * (101-100) / 101 = 0.001980
      expect(r.pnlSol).toBeCloseTo(0.001980, 5);
      expect(r.netPnlSol).toBeGreaterThan(0);
    });

    it('losing long: SOL $100 → $99 (-1%)', () => {
      const r = calculatePnl('long', 100, 99, 0.2);
      // Gross: 0.2 * (99-100) / 99 = -0.002020
      expect(r.pnlSol).toBeCloseTo(-0.002020, 5);
      expect(r.netPnlSol).toBeLessThan(0);
    });

    it('flat long: SOL $100 → $100 (0%)', () => {
      const r = calculatePnl('long', 100, 100, 0.2);
      expect(r.pnlSol).toBe(0);
      // Net is negative due to fees
      expect(r.netPnlSol).toBeLessThan(0);
      expect(r.netPnlSol).toBeCloseTo(-r.feeSol, 10);
    });
  });

  describe('short positions', () => {
    it('profitable short: SOL $100 → $99 (-1%)', () => {
      const r = calculatePnl('short', 100, 99, 0.2);
      // Gross: 0.2 * (100-99) / 99 = 0.002020
      expect(r.pnlSol).toBeCloseTo(0.002020, 5);
      expect(r.netPnlSol).toBeGreaterThan(0);
    });

    it('losing short: SOL $100 → $101 (+1%)', () => {
      const r = calculatePnl('short', 100, 101, 0.2);
      expect(r.pnlSol).toBeCloseTo(-0.001980, 5);
      expect(r.netPnlSol).toBeLessThan(0);
    });
  });

  describe('fee calculation', () => {
    it('fees are ~0.2% round-trip on notional (0.1% each side)', () => {
      const r = calculatePnl('long', 100, 100, 0.2);
      // Entry fee: 0.2 * 100 * 0.001 = $0.02
      // Exit fee: 0.2 * 100 * 0.001 = $0.02
      // Total: $0.04
      expect(r.totalFeeUsd).toBeCloseTo(0.04, 6);
      // In SOL: $0.04 / $100 = 0.0004 SOL
      expect(r.feeSol).toBeCloseTo(0.0004, 6);
    });

    it('fees scale with bet size', () => {
      const small = calculatePnl('long', 100, 100, 0.1);
      const large = calculatePnl('long', 100, 100, 0.5);
      expect(large.feeSol / small.feeSol).toBeCloseTo(5, 1);
    });

    it('fees adjust for entry vs exit price difference', () => {
      const r = calculatePnl('long', 100, 200, 0.2);
      // Entry fee: 0.2 * 100 * 0.001 = $0.02
      // Exit fee: 0.2 * 200 * 0.001 = $0.04
      // Total: $0.06 / $200 = 0.0003 SOL
      expect(r.totalFeeUsd).toBeCloseTo(0.06, 6);
      expect(r.feeSol).toBeCloseTo(0.0003, 6);
    });

    it('break-even requires price move > 2 * fee rate', () => {
      // With 0.1% fee each side, need >0.2% move to break even
      const breakEvenPrice = 100 * (1 + 2 * TAKER_FEE_RATE); // 100.20
      const atBreakEven = calculatePnl('long', 100, breakEvenPrice, 0.2);
      expect(Math.abs(atBreakEven.netPnlSol)).toBeLessThan(0.000001);

      const belowBreakEven = calculatePnl('long', 100, 100.15, 0.2);
      expect(belowBreakEven.netPnlSol).toBeLessThan(0);

      const aboveBreakEven = calculatePnl('long', 100, 100.30, 0.2);
      expect(aboveBreakEven.netPnlSol).toBeGreaterThan(0);
    });
  });

  describe('cross-margin: subaccount isolation math', () => {
    it('three simultaneous positions have independent P&L', () => {
      // Simulating 3 strategies each with own subaccount
      const strat0 = calculatePnl('long', 100, 101, 0.2);   // +1% win
      const strat1 = calculatePnl('short', 100, 99, 0.2);   // -1% win for short
      const strat2 = calculatePnl('long', 100, 99.5, 0.2);  // -0.5% loss

      // Each P&L is independent
      expect(strat0.netPnlSol).toBeGreaterThan(0);
      expect(strat1.netPnlSol).toBeGreaterThan(0);
      expect(strat2.netPnlSol).toBeLessThan(0);

      // Total across all strategies
      const totalNet = strat0.netPnlSol + strat1.netPnlSol + strat2.netPnlSol;
      const totalFees = strat0.feeSol + strat1.feeSol + strat2.feeSol;

      // 2 winners + 1 loser — net should still be positive
      expect(totalNet).toBeGreaterThan(0);
      // Total fees = 3 * ~0.0004 SOL
      expect(totalFees).toBeCloseTo(0.0012, 3);
    });

    it('worst case: all 3 strategies lose simultaneously', () => {
      // BTC pumps, all go long, but SOL drops instead
      const strat0 = calculatePnl('long', 100, 99, 0.2);
      const strat1 = calculatePnl('long', 100, 99, 0.2);
      const strat2 = calculatePnl('long', 100, 99, 0.2);

      const totalLoss = strat0.netPnlSol + strat1.netPnlSol + strat2.netPnlSol;
      const totalFees = strat0.feeSol + strat1.feeSol + strat2.feeSol;

      // Max loss per trade with 0.2 SOL bet and 1% adverse move:
      // ~0.002020 + 0.0004 fees = ~0.002420 SOL per strategy
      // Total: ~0.00726 SOL across all 3
      expect(totalLoss).toBeCloseTo(-0.00726, 3);
      expect(totalFees).toBeCloseTo(0.0012, 3);
    });

    it('collateral per subaccount needed for 1.5x leverage', () => {
      // Position: 0.2 SOL at $100 = $20 notional
      // At 1.5x leverage, required margin = $20 / 1.5 = $13.33
      // Drift initial margin for SOL-PERP is ~5%, so actually $20 * 0.05 = $1
      // But you need enough to not get liquidated on adverse moves
      const notional = 0.2 * 100;
      const marginRequired = notional / 1.5;
      expect(marginRequired).toBeCloseTo(13.33, 1);

      // With 3 subaccounts: need $13.33 * 3 = $40 total
      const totalMargin = marginRequired * 3;
      expect(totalMargin).toBeCloseTo(40, 0);
    });
  });
});
