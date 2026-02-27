"""Backtest BTC→SOL signal with leverage, fees, and position sizing."""

from __future__ import annotations

import sys
import sqlite3

import numpy as np
import pandas as pd

from . import config
from .events import load_price_series, detect_events


def run_backtest(
    conn: sqlite3.Connection,
    btc_threshold: float,
    sol_threshold: float,
    window: int,
    max_lag: int,
    leverage: float = 1.5,
    bet_size_sol: float = 0.2,
    bankroll: float = 1.0,
    take_profit_pct: float | None = None,
    stop_loss_pct: float | None = None,
    taker_fee_pct: float = 0.1,     # Drift taker fee ~0.1%
    hold_seconds: int | None = None, # If set, exit after N seconds instead of TP/SL
) -> dict:
    """Simulate trading SOL perps on Drift based on BTC lead signal."""

    btc_series = load_price_series(conn, config.BTC_USD_FEED_STRIPPED)
    sol_series = load_price_series(conn, config.SOL_USD_FEED_STRIPPED)

    if btc_series.empty or sol_series.empty:
        return {"error": "No data"}

    # Detect BTC events
    btc_events = detect_events(btc_series, config.BTC_USD_FEED_STRIPPED, btc_threshold, window)

    # Convert SOL series to numpy for fast lookups
    _res = sol_series.index.dtype
    _unit = str(_res).split("[")[1].split(",")[0].split("]")[0]
    _divisors = {"ns": 10**9, "us": 10**6, "ms": 10**3, "s": 1}
    sol_ts = sol_series.index.astype(np.int64) // _divisors.get(_unit, 10**9)
    sol_prices = sol_series.values.astype(np.float64)

    trades: list[dict] = []
    balance = bankroll

    for ev in btc_events:
        if balance <= 0:
            break

        actual_bet = min(bet_size_sol, balance)
        position_size = actual_bet * leverage

        # Entry: SOL price at BTC event start time (when we detect the signal)
        entry_mask = (sol_ts >= ev.start_time) & (sol_ts <= ev.start_time + 5)
        if not np.any(entry_mask):
            continue
        entry_price = float(sol_prices[entry_mask][0])
        entry_time = int(sol_ts[entry_mask][0])

        if entry_price == 0:
            continue

        direction = 1 if ev.direction == "pump" else -1

        # Scan SOL prices after entry
        scan_end = entry_time + max_lag
        scan_mask = (sol_ts > entry_time) & (sol_ts <= scan_end)
        scan_prices = sol_prices[scan_mask]
        scan_times = sol_ts[scan_mask]

        if len(scan_prices) == 0:
            continue

        # Simulate tick-by-tick
        exit_price = None
        exit_time = None
        exit_reason = "timeout"

        for i in range(len(scan_prices)):
            pct_move = (scan_prices[i] / entry_price - 1) * 100 * direction
            elapsed = int(scan_times[i]) - entry_time

            if take_profit_pct is not None and pct_move >= take_profit_pct:
                exit_price = float(scan_prices[i])
                exit_time = int(scan_times[i])
                exit_reason = "tp"
                break
            if stop_loss_pct is not None and pct_move <= -stop_loss_pct:
                exit_price = float(scan_prices[i])
                exit_time = int(scan_times[i])
                exit_reason = "sl"
                break
            if hold_seconds is not None and elapsed >= hold_seconds:
                exit_price = float(scan_prices[i])
                exit_time = int(scan_times[i])
                exit_reason = "hold_exit"
                break

        if exit_price is None:
            # Exit at end of scan window
            exit_price = float(scan_prices[-1])
            exit_time = int(scan_times[-1])

        raw_pct = (exit_price / entry_price - 1) * 100 * direction
        leveraged_pct = raw_pct * leverage

        # Fees: entry + exit
        total_fee_pct = taker_fee_pct * 2 * leverage
        net_pct = leveraged_pct - total_fee_pct

        pnl_sol = actual_bet * (net_pct / 100)
        balance += pnl_sol

        trades.append({
            "entry_time": entry_time,
            "exit_time": exit_time,
            "direction": ev.direction,
            "entry_price": entry_price,
            "exit_price": exit_price,
            "raw_pct": raw_pct,
            "leveraged_pct": leveraged_pct,
            "fee_pct": total_fee_pct,
            "net_pct": net_pct,
            "pnl_sol": pnl_sol,
            "balance": balance,
            "bet_size": actual_bet,
            "exit_reason": exit_reason,
            "hold_time": exit_time - entry_time,
        })

    if not trades:
        return {"error": "No trades executed"}

    # Compute stats
    df = pd.DataFrame(trades)
    wins = df[df["pnl_sol"] > 0]
    losses = df[df["pnl_sol"] <= 0]

    total_days = (btc_series.index[-1] - btc_series.index[0]).total_seconds() / 86400

    return {
        "params": {
            "btc_threshold": btc_threshold,
            "sol_threshold": sol_threshold,
            "window": window,
            "max_lag": max_lag,
            "leverage": leverage,
            "bet_size": bet_size_sol,
            "take_profit": take_profit_pct,
            "stop_loss": stop_loss_pct,
            "hold_seconds": hold_seconds,
            "taker_fee": taker_fee_pct,
        },
        "total_trades": len(df),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": len(wins) / len(df),
        "total_pnl_sol": float(df["pnl_sol"].sum()),
        "final_balance": balance,
        "roi_pct": (balance - bankroll) / bankroll * 100,
        "avg_pnl_per_trade": float(df["pnl_sol"].mean()),
        "avg_win": float(wins["pnl_sol"].mean()) if len(wins) > 0 else 0,
        "avg_loss": float(losses["pnl_sol"].mean()) if len(losses) > 0 else 0,
        "max_drawdown_sol": float((df["balance"].cummax() - df["balance"]).max()),
        "avg_hold_time": float(df["hold_time"].mean()),
        "median_hold_time": float(df["hold_time"].median()),
        "avg_net_pct": float(df["net_pct"].mean()),
        "median_net_pct": float(df["net_pct"].median()),
        "trades_per_day": len(df) / total_days if total_days > 0 else 0,
        "total_days": total_days,
        "exit_reasons": df["exit_reason"].value_counts().to_dict(),
        "sharpe_approx": float(df["pnl_sol"].mean() / df["pnl_sol"].std()) if df["pnl_sol"].std() > 0 else 0,
        "best_trade": float(df["pnl_sol"].max()),
        "worst_trade": float(df["pnl_sol"].min()),
    }


def print_backtest(result: dict) -> None:
    if "error" in result:
        print(f"Error: {result['error']}")
        return

    p = result["params"]
    print(f"\n{'='*60}")
    print(f"  BACKTEST: BTC {p['btc_threshold']}% → SOL {p['leverage']}x lev")
    print(f"{'='*60}")
    print(f"  Window: {p['window']}s | Max lag: {p['max_lag']}s | Bet: {p['bet_size']} SOL")
    tp = f"{p['take_profit']}%" if p['take_profit'] else "none"
    sl = f"{p['stop_loss']}%" if p['stop_loss'] else "none"
    hold = f"{p['hold_seconds']}s" if p['hold_seconds'] else "none"
    print(f"  TP: {tp} | SL: {sl} | Hold exit: {hold}")
    print(f"  Fee per side: {p['taker_fee']}%")

    print(f"\n  Period: {result['total_days']:.0f} days")
    print(f"  Trades: {result['total_trades']} ({result['trades_per_day']:.1f}/day)")
    print(f"  Win rate: {result['win_rate']:.1%}")

    print(f"\n  --- PnL ---")
    print(f"  Starting: 1.000 SOL")
    print(f"  Final:    {result['final_balance']:.4f} SOL")
    print(f"  Total PnL: {result['total_pnl_sol']:+.4f} SOL")
    print(f"  ROI: {result['roi_pct']:+.1f}%")

    print(f"\n  --- Per Trade ---")
    print(f"  Avg PnL:  {result['avg_pnl_per_trade']:+.6f} SOL")
    print(f"  Avg win:  {result['avg_win']:+.6f} SOL")
    print(f"  Avg loss: {result['avg_loss']:+.6f} SOL")
    print(f"  Best:     {result['best_trade']:+.6f} SOL")
    print(f"  Worst:    {result['worst_trade']:+.6f} SOL")
    print(f"  Avg net %%: {result['avg_net_pct']:+.3f}%")

    print(f"\n  --- Risk ---")
    print(f"  Max drawdown: {result['max_drawdown_sol']:.4f} SOL")
    print(f"  Sharpe (approx): {result['sharpe_approx']:.3f}")

    print(f"\n  --- Timing ---")
    print(f"  Avg hold: {result['avg_hold_time']:.0f}s | Median: {result['median_hold_time']:.0f}s")
    print(f"  Exit reasons: {result['exit_reasons']}")
    print(f"{'='*60}")
