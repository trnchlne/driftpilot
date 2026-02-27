"""
Comprehensive backtest grid: test all strategy improvement ideas.
Run: uv run python backtest_grid.py
"""

import sqlite3
import numpy as np
import pandas as pd
from driftpilot import config
from driftpilot.events import load_price_series, detect_events


def run_backtest_v2(
    btc_events,
    sol_ts,
    sol_prices,
    btc_ts,
    btc_prices,
    total_days: float,
    *,
    leverage: float = 1.5,
    bet_size_sol: float = 0.2,
    bankroll: float = 1.0,
    take_profit_pct: float | None = None,
    stop_loss_pct: float | None = None,
    entry_fee_pct: float = 0.1,
    exit_fee_pct: float = 0.1,
    hold_seconds: int | None = None,
    max_lag: int = 300,
    # New: confirmation filter
    confirm_sol_pct: float | None = None,   # SOL must move this % in signal direction before entry
    confirm_window_s: int = 10,              # seconds to wait for confirmation
    # New: volatility filter
    min_btc_vol: float | None = None,       # min BTC stddev of 1s returns over vol_window
    vol_window_s: int = 300,                 # 5 min lookback for vol calc
) -> dict:
    trades = []
    balance = bankroll
    skipped_confirm = 0
    skipped_vol = 0

    for ev in btc_events:
        if balance <= 0:
            break

        actual_bet = min(bet_size_sol, balance)
        direction = 1 if ev.direction == "pump" else -1

        # --- Volatility filter ---
        if min_btc_vol is not None:
            vol_start = ev.start_time - vol_window_s
            vol_mask = (btc_ts >= vol_start) & (btc_ts < ev.start_time)
            vol_prices = btc_prices[vol_mask]
            if len(vol_prices) > 10:
                returns = np.diff(vol_prices) / vol_prices[:-1] * 100
                vol = float(np.std(returns))
                if vol < min_btc_vol:
                    skipped_vol += 1
                    continue
            else:
                skipped_vol += 1
                continue

        # --- Find SOL entry point ---
        if confirm_sol_pct is not None:
            # Confirmation: wait for SOL to move confirm_sol_pct% in signal direction
            confirm_end = ev.start_time + confirm_window_s
            confirm_mask = (sol_ts >= ev.start_time) & (sol_ts <= confirm_end)
            confirm_prices = sol_prices[confirm_mask]
            confirm_times = sol_ts[confirm_mask]

            if len(confirm_prices) < 2:
                skipped_confirm += 1
                continue

            base_sol = float(confirm_prices[0])
            confirmed = False
            entry_price = None
            entry_time = None

            for ci in range(1, len(confirm_prices)):
                sol_move = (confirm_prices[ci] / base_sol - 1) * 100 * direction
                if sol_move >= confirm_sol_pct:
                    entry_price = float(confirm_prices[ci])
                    entry_time = int(confirm_times[ci])
                    confirmed = True
                    break

            if not confirmed:
                skipped_confirm += 1
                continue
        else:
            # Original: enter at first SOL tick within 5s of BTC event
            entry_mask = (sol_ts >= ev.start_time) & (sol_ts <= ev.start_time + 5)
            if not np.any(entry_mask):
                continue
            entry_price = float(sol_prices[entry_mask][0])
            entry_time = int(sol_ts[entry_mask][0])

        if entry_price == 0:
            continue

        # --- Scan for exit ---
        scan_end = entry_time + max_lag
        scan_mask = (sol_ts > entry_time) & (sol_ts <= scan_end)
        scan_prices = sol_prices[scan_mask]
        scan_times = sol_ts[scan_mask]

        if len(scan_prices) == 0:
            continue

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
            exit_price = float(scan_prices[-1])
            exit_time = int(scan_times[-1])

        raw_pct = (exit_price / entry_price - 1) * 100 * direction
        leveraged_pct = raw_pct * leverage

        # Asymmetric fees: entry (maker) + exit (taker)
        total_fee_pct = (entry_fee_pct + exit_fee_pct) * leverage
        net_pct = leveraged_pct - total_fee_pct

        pnl_sol = actual_bet * (net_pct / 100)
        balance += pnl_sol

        trades.append({
            "pnl_sol": pnl_sol,
            "net_pct": net_pct,
            "exit_reason": exit_reason,
            "hold_time": exit_time - entry_time,
            "balance": balance,
        })

    if not trades:
        return {"error": "No trades"}

    df = pd.DataFrame(trades)
    wins = df[df["pnl_sol"] > 0]
    losses = df[df["pnl_sol"] <= 0]

    return {
        "total_trades": len(df),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": len(wins) / len(df),
        "roi_pct": (balance - bankroll) / bankroll * 100,
        "final_balance": balance,
        "total_pnl_sol": float(df["pnl_sol"].sum()),
        "avg_pnl_per_trade": float(df["pnl_sol"].mean()),
        "max_drawdown_sol": float((df["balance"].cummax() - df["balance"]).max()),
        "sharpe_approx": float(df["pnl_sol"].mean() / df["pnl_sol"].std()) if df["pnl_sol"].std() > 0 else 0,
        "trades_per_day": len(df) / total_days if total_days > 0 else 0,
        "exit_reasons": df["exit_reason"].value_counts().to_dict(),
        "avg_hold_time": float(df["hold_time"].mean()),
        "skipped_confirm": skipped_confirm,
        "skipped_vol": skipped_vol,
    }


def main():
    conn = sqlite3.connect("data/driftpilot.db")

    print("Loading price series...")
    btc_series = load_price_series(conn, config.BTC_USD_FEED_STRIPPED)
    sol_series = load_price_series(conn, config.SOL_USD_FEED_STRIPPED)

    total_days = (btc_series.index[-1] - btc_series.index[0]).total_seconds() / 86400
    print(f"Data: {total_days:.0f} days")

    # Pre-convert to numpy
    _res = sol_series.index.dtype
    _unit = str(_res).split("[")[1].split(",")[0].split("]")[0]
    _divisors = {"ns": 10**9, "us": 10**6, "ms": 10**3, "s": 1}
    div = _divisors.get(_unit, 10**9)

    sol_ts = sol_series.index.astype(np.int64) // div
    sol_prices = sol_series.values.astype(np.float64)
    btc_ts = btc_series.index.astype(np.int64) // div
    btc_prices = btc_series.values.astype(np.float64)

    # Pre-detect events for each threshold/window combo
    print("Detecting BTC events...")
    event_cache = {}
    for thresh, window in [(0.3, 60), (0.5, 120)]:
        events = detect_events(btc_series, config.BTC_USD_FEED_STRIPPED, thresh, window)
        event_cache[(thresh, window)] = events
        print(f"  BTC {thresh}% / {window}s → {len(events)} events")

    # ===================================================================
    print("\n" + "=" * 100)
    print("  SECTION 1: BASELINE (current strategy, timed exit, taker fees)")
    print("=" * 100)

    baselines = [
        ("med-60s (current)",    0.3, 60,  60,  0.1, 0.1),
        ("big-180s (current)",   0.5, 120, 180, 0.1, 0.1),
    ]
    for name, thresh, window, hold, entry_fee, exit_fee in baselines:
        r = run_backtest_v2(
            event_cache[(thresh, window)], sol_ts, sol_prices, btc_ts, btc_prices, total_days,
            hold_seconds=hold, entry_fee_pct=entry_fee, exit_fee_pct=exit_fee,
        )
        print(f"\n  {name}: ROI={r['roi_pct']:+.1f}% | {r['total_trades']} trades | WR={r['win_rate']:.1%} | Sharpe={r['sharpe_approx']:.3f} | MaxDD={r['max_drawdown_sol']:.4f}")

    # ===================================================================
    print("\n" + "=" * 100)
    print("  SECTION 2: TP/SL (replace timed exit with take-profit / stop-loss)")
    print("=" * 100)

    tp_sl_combos = [
        # (TP%, SL%, max_hold_fallback)
        (0.3, 0.2, 120),
        (0.3, 0.3, 120),
        (0.5, 0.2, 120),
        (0.5, 0.3, 120),
        (0.5, 0.5, 120),
        (0.8, 0.3, 120),
        (0.8, 0.5, 180),
        (1.0, 0.3, 180),
        (1.0, 0.5, 180),
        (1.5, 0.5, 300),
    ]

    for thresh, window in [(0.3, 60), (0.5, 120)]:
        print(f"\n  --- BTC threshold {thresh}% / window {window}s ---")
        for tp, sl, hold in tp_sl_combos:
            r = run_backtest_v2(
                event_cache[(thresh, window)], sol_ts, sol_prices, btc_ts, btc_prices, total_days,
                take_profit_pct=tp, stop_loss_pct=sl, hold_seconds=hold,
            )
            exits = r.get("exit_reasons", {})
            tp_pct = exits.get("tp", 0) / r["total_trades"] * 100 if r["total_trades"] > 0 else 0
            sl_pct = exits.get("sl", 0) / r["total_trades"] * 100 if r["total_trades"] > 0 else 0
            print(f"  TP={tp}% SL={sl}% hold={hold}s | ROI={r['roi_pct']:+.1f}% | {r['total_trades']} trades | WR={r['win_rate']:.1%} | TP%={tp_pct:.0f}% SL%={sl_pct:.0f}% | Sharpe={r['sharpe_approx']:.3f}")

    # ===================================================================
    print("\n" + "=" * 100)
    print("  SECTION 3: MAKER ENTRY (0% entry fee + 0.1% exit fee)")
    print("=" * 100)

    for thresh, window in [(0.3, 60), (0.5, 120)]:
        print(f"\n  --- BTC threshold {thresh}% / window {window}s ---")

        # Timed exit with maker entry
        for hold in [60, 120, 180]:
            r = run_backtest_v2(
                event_cache[(thresh, window)], sol_ts, sol_prices, btc_ts, btc_prices, total_days,
                hold_seconds=hold, entry_fee_pct=0.0, exit_fee_pct=0.1,
            )
            print(f"  MAKER hold={hold}s        | ROI={r['roi_pct']:+.1f}% | {r['total_trades']} trades | WR={r['win_rate']:.1%} | Sharpe={r['sharpe_approx']:.3f}")

        # Best TP/SL combos with maker entry
        for tp, sl, hold in [(0.5, 0.3, 120), (0.8, 0.3, 180), (1.0, 0.5, 180)]:
            r = run_backtest_v2(
                event_cache[(thresh, window)], sol_ts, sol_prices, btc_ts, btc_prices, total_days,
                take_profit_pct=tp, stop_loss_pct=sl, hold_seconds=hold,
                entry_fee_pct=0.0, exit_fee_pct=0.1,
            )
            exits = r.get("exit_reasons", {})
            tp_pct = exits.get("tp", 0) / r["total_trades"] * 100 if r["total_trades"] > 0 else 0
            print(f"  MAKER TP={tp}% SL={sl}% hold={hold}s | ROI={r['roi_pct']:+.1f}% | {r['total_trades']} trades | WR={r['win_rate']:.1%} | TP%={tp_pct:.0f}% | Sharpe={r['sharpe_approx']:.3f}")

    # ===================================================================
    print("\n" + "=" * 100)
    print("  SECTION 4: CONFIRMATION ENTRY (wait for SOL to start following)")
    print("=" * 100)

    for thresh, window in [(0.3, 60), (0.5, 120)]:
        print(f"\n  --- BTC threshold {thresh}% / window {window}s ---")
        for confirm_pct in [0.03, 0.05, 0.1]:
            for confirm_win in [5, 10, 15]:
                # With timed exit
                r = run_backtest_v2(
                    event_cache[(thresh, window)], sol_ts, sol_prices, btc_ts, btc_prices, total_days,
                    hold_seconds=60, confirm_sol_pct=confirm_pct, confirm_window_s=confirm_win,
                )
                print(f"  confirm={confirm_pct}%/{confirm_win}s hold=60s  | ROI={r['roi_pct']:+.1f}% | {r['total_trades']} trades (skip={r['skipped_confirm']}) | WR={r['win_rate']:.1%} | Sharpe={r['sharpe_approx']:.3f}")

        # Best confirmation + TP/SL + maker
        print(f"  --- Best combo: confirmation + TP/SL + maker ---")
        for confirm_pct in [0.03, 0.05]:
            for tp, sl, hold in [(0.5, 0.3, 120), (0.8, 0.3, 180)]:
                r = run_backtest_v2(
                    event_cache[(thresh, window)], sol_ts, sol_prices, btc_ts, btc_prices, total_days,
                    take_profit_pct=tp, stop_loss_pct=sl, hold_seconds=hold,
                    entry_fee_pct=0.0, exit_fee_pct=0.1,
                    confirm_sol_pct=confirm_pct, confirm_window_s=10,
                )
                exits = r.get("exit_reasons", {})
                tp_pct = exits.get("tp", 0) / r["total_trades"] * 100 if r["total_trades"] > 0 else 0
                print(f"  MAKER confirm={confirm_pct}% TP={tp}% SL={sl}% | ROI={r['roi_pct']:+.1f}% | {r['total_trades']} trades (skip={r['skipped_confirm']}) | WR={r['win_rate']:.1%} | TP%={tp_pct:.0f}% | Sharpe={r['sharpe_approx']:.3f}")

    # ===================================================================
    print("\n" + "=" * 100)
    print("  SECTION 5: VOLATILITY FILTER (only trade when BTC is volatile)")
    print("=" * 100)

    for thresh, window in [(0.3, 60)]:
        print(f"\n  --- BTC threshold {thresh}% / window {window}s ---")
        for min_vol in [0.005, 0.01, 0.015, 0.02]:
            r = run_backtest_v2(
                event_cache[(thresh, window)], sol_ts, sol_prices, btc_ts, btc_prices, total_days,
                hold_seconds=60, min_btc_vol=min_vol,
            )
            print(f"  vol>={min_vol} hold=60s     | ROI={r['roi_pct']:+.1f}% | {r['total_trades']} trades (vol_skip={r['skipped_vol']}) | WR={r['win_rate']:.1%} | Sharpe={r['sharpe_approx']:.3f}")

        # Vol filter + TP/SL + maker
        print(f"  --- Best combo: vol filter + TP/SL + maker ---")
        for min_vol in [0.005, 0.01]:
            for tp, sl, hold in [(0.5, 0.3, 120), (0.8, 0.3, 180)]:
                r = run_backtest_v2(
                    event_cache[(thresh, window)], sol_ts, sol_prices, btc_ts, btc_prices, total_days,
                    take_profit_pct=tp, stop_loss_pct=sl, hold_seconds=hold,
                    entry_fee_pct=0.0, exit_fee_pct=0.1, min_btc_vol=min_vol,
                )
                exits = r.get("exit_reasons", {})
                tp_pct = exits.get("tp", 0) / r["total_trades"] * 100 if r["total_trades"] > 0 else 0
                print(f"  MAKER vol>={min_vol} TP={tp}% SL={sl}% | ROI={r['roi_pct']:+.1f}% | {r['total_trades']} trades (vol_skip={r['skipped_vol']}) | WR={r['win_rate']:.1%} | TP%={tp_pct:.0f}% | Sharpe={r['sharpe_approx']:.3f}")

    # ===================================================================
    print("\n" + "=" * 100)
    print("  SECTION 6: KITCHEN SINK (all improvements combined)")
    print("=" * 100)

    for thresh, window in [(0.3, 60), (0.5, 120)]:
        print(f"\n  --- BTC threshold {thresh}% / window {window}s ---")
        for confirm_pct in [0.03, 0.05]:
            for min_vol in [None, 0.005, 0.01]:
                for tp, sl, hold in [(0.5, 0.3, 120), (0.8, 0.3, 180), (1.0, 0.5, 300)]:
                    r = run_backtest_v2(
                        event_cache[(thresh, window)], sol_ts, sol_prices, btc_ts, btc_prices, total_days,
                        take_profit_pct=tp, stop_loss_pct=sl, hold_seconds=hold,
                        entry_fee_pct=0.0, exit_fee_pct=0.1,
                        confirm_sol_pct=confirm_pct, confirm_window_s=10,
                        min_btc_vol=min_vol,
                    )
                    if r.get("error"):
                        continue
                    vol_tag = f"vol>={min_vol}" if min_vol else "no_vol"
                    exits = r.get("exit_reasons", {})
                    tp_pct = exits.get("tp", 0) / r["total_trades"] * 100 if r["total_trades"] > 0 else 0
                    print(f"  confirm={confirm_pct}% {vol_tag} TP={tp}% SL={sl}% hold={hold}s | ROI={r['roi_pct']:+.1f}% | {r['total_trades']} trades | WR={r['win_rate']:.1%} | TP%={tp_pct:.0f}% | Sharpe={r['sharpe_approx']:.3f} | DD={r['max_drawdown_sol']:.4f}")

    conn.close()
    print("\n\nDone.")


if __name__ == "__main__":
    main()
