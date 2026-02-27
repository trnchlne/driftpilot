"""
Multi-period backtest: fetch 2 years of 1m candles from Binance,
then run the BTC→SOL lead-lag strategy across different time windows.

Run: uv run python backtest_periods.py
"""

import sqlite3
import sys
import time
from datetime import datetime, timezone

import httpx
import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DB_PATH = "data/driftpilot_binance.db"
BINANCE_BASE = "https://api.binance.com"
SYMBOLS = {"BTCUSDT": "btc", "SOLUSDT": "sol"}
CANDLE_LIMIT = 1000  # max per Binance request


# ---------------------------------------------------------------------------
# Database setup
# ---------------------------------------------------------------------------
def init_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS candles_1m (
            symbol      TEXT    NOT NULL,
            open_time   INTEGER NOT NULL,
            open        REAL    NOT NULL,
            high        REAL    NOT NULL,
            low         REAL    NOT NULL,
            close       REAL    NOT NULL,
            volume      REAL    NOT NULL,
            close_time  INTEGER NOT NULL,
            UNIQUE(symbol, open_time)
        );
        CREATE INDEX IF NOT EXISTS idx_candles_sym_time
            ON candles_1m(symbol, open_time);
    """)
    conn.commit()
    return conn


def get_latest_ts(conn: sqlite3.Connection, symbol: str) -> int | None:
    row = conn.execute(
        "SELECT MAX(open_time) FROM candles_1m WHERE symbol = ?", (symbol,)
    ).fetchone()
    return row[0] if row[0] is not None else None


def insert_candles(conn: sqlite3.Connection, symbol: str, candles: list) -> int:
    if not candles:
        return 0
    rows = []
    for c in candles:
        rows.append((
            symbol,
            int(c[0]),      # open_time (ms)
            float(c[1]),    # open
            float(c[2]),    # high
            float(c[3]),    # low
            float(c[4]),    # close
            float(c[5]),    # volume
            int(c[6]),      # close_time (ms)
        ))
    conn.executemany(
        "INSERT OR IGNORE INTO candles_1m VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    return len(rows)


# ---------------------------------------------------------------------------
# Binance fetcher
# ---------------------------------------------------------------------------
def fetch_binance_klines(
    symbol: str,
    start_ms: int,
    end_ms: int,
    conn: sqlite3.Connection,
) -> int:
    """Fetch 1m candles from Binance, paginating with limit=1000."""
    total = 0
    current = start_ms
    client = httpx.Client(timeout=30.0)

    # Estimate total for progress
    total_minutes = (end_ms - start_ms) // 60_000
    fetched_minutes = 0

    while current < end_ms:
        url = (
            f"{BINANCE_BASE}/api/v3/klines"
            f"?symbol={symbol}&interval=1m&startTime={current}"
            f"&endTime={end_ms}&limit={CANDLE_LIMIT}"
        )

        for attempt in range(5):
            try:
                resp = client.get(url)
                if resp.status_code == 429:
                    wait = int(resp.headers.get("Retry-After", "10"))
                    sys.stderr.write(f"\n  Rate limited, waiting {wait}s...")
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                break
            except (httpx.HTTPError, httpx.TimeoutException) as e:
                if attempt == 4:
                    sys.stderr.write(f"\n  Failed: {e}\n")
                    client.close()
                    return total
                time.sleep(2 ** attempt)

        data = resp.json()
        if not data:
            break

        inserted = insert_candles(conn, symbol, data)
        total += inserted
        fetched_minutes += len(data)

        # Move cursor past last candle
        last_open_time = int(data[-1][0])
        current = last_open_time + 60_000  # next minute

        pct = min(100, fetched_minutes / total_minutes * 100) if total_minutes > 0 else 100
        sys.stderr.write(f"\r  {symbol}: {fetched_minutes:,}/{total_minutes:,} minutes ({pct:.0f}%)   ")
        sys.stderr.flush()

        # Small delay to respect rate limits
        time.sleep(0.1)

    sys.stderr.write(f"\r  {symbol}: {total:,} candles fetched" + " " * 30 + "\n")
    client.close()
    return total


# ---------------------------------------------------------------------------
# Load data as pandas Series
# ---------------------------------------------------------------------------
def load_series(conn: sqlite3.Connection, symbol: str,
                start_ts: int | None = None, end_ts: int | None = None) -> pd.Series:
    """Load 1m close prices as a pandas Series indexed by UTC datetime."""
    sql = "SELECT open_time, close FROM candles_1m WHERE symbol = ?"
    params: list = [symbol]
    if start_ts:
        params.append(start_ts * 1000)
        sql += " AND open_time >= ?"
    if end_ts:
        params.append(end_ts * 1000)
        sql += " AND open_time <= ?"
    sql += " ORDER BY open_time"
    rows = conn.execute(sql, params).fetchall()
    if not rows:
        return pd.Series(dtype=float)
    df = pd.DataFrame(rows, columns=["open_time", "close"])
    df["timestamp"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    df = df.set_index("timestamp").sort_index()
    df = df[~df.index.duplicated(keep="first")]
    return df["close"]


# ---------------------------------------------------------------------------
# Event detection (adapted for minute data)
# ---------------------------------------------------------------------------
def detect_events_minute(
    series: pd.Series,
    threshold_pct: float,
    window_minutes: int = 5,
    min_gap_minutes: int = 5,
) -> list[dict]:
    """Detect BTC pump/dump events on minute-level data."""
    if len(series) < window_minutes + 1:
        return []

    prices = series.values.astype(np.float64)
    pct_change = (prices[window_minutes:] / prices[:-window_minutes] - 1) * 100

    events = []
    i = 0
    n = len(pct_change)

    while i < n:
        if abs(pct_change[i]) >= threshold_pct:
            direction = "pump" if pct_change[i] > 0 else "dump"
            peak_idx = i
            peak_val = abs(pct_change[i])
            j = i + 1
            while j < n and abs(pct_change[j]) >= threshold_pct:
                if abs(pct_change[j]) > peak_val:
                    peak_idx = j
                    peak_val = abs(pct_change[j])
                j += 1

            start_ts = int(series.index[peak_idx].timestamp())
            end_idx = min(peak_idx + window_minutes, len(series) - 1)
            end_ts = int(series.index[end_idx].timestamp())

            events.append({
                "direction": direction,
                "start_time": start_ts,
                "end_time": end_ts,
                "start_price": float(prices[peak_idx]),
                "end_price": float(prices[end_idx]),
                "pct_change": float(pct_change[peak_idx]),
            })

            i = j + min_gap_minutes
        else:
            i += 1

    return events


# ---------------------------------------------------------------------------
# Backtest engine (adapted for minute data)
# ---------------------------------------------------------------------------
def run_backtest_minute(
    btc_events: list[dict],
    sol_ts: np.ndarray,
    sol_prices: np.ndarray,
    btc_ts: np.ndarray,
    btc_prices: np.ndarray,
    total_days: float,
    *,
    leverage: float = 1.5,
    bet_size_sol: float = 0.2,
    bankroll: float = 1.0,
    take_profit_pct: float | None = None,
    stop_loss_pct: float | None = None,
    entry_fee_pct: float = 0.1,
    exit_fee_pct: float = 0.1,
    hold_minutes: int | None = None,
    max_lag_minutes: int = 30,
    confirm_sol_pct: float | None = None,
    confirm_window_m: int = 2,
    min_btc_vol: float | None = None,
    vol_window_m: int = 30,
) -> dict:
    trades = []
    balance = bankroll
    skipped_confirm = 0
    skipped_vol = 0

    for ev in btc_events:
        if balance <= 0:
            break

        actual_bet = min(bet_size_sol, balance)
        direction = 1 if ev["direction"] == "pump" else -1

        # Volatility filter
        if min_btc_vol is not None:
            vol_start = ev["start_time"] - vol_window_m * 60
            vol_mask = (btc_ts >= vol_start) & (btc_ts < ev["start_time"])
            vol_p = btc_prices[vol_mask]
            if len(vol_p) > 5:
                rets = np.diff(vol_p) / vol_p[:-1] * 100
                vol = float(np.std(rets))
                if vol < min_btc_vol:
                    skipped_vol += 1
                    continue
            else:
                skipped_vol += 1
                continue

        # Find SOL entry
        if confirm_sol_pct is not None:
            confirm_end = ev["start_time"] + confirm_window_m * 60
            cmask = (sol_ts >= ev["start_time"]) & (sol_ts <= confirm_end)
            cp = sol_prices[cmask]
            ct = sol_ts[cmask]
            if len(cp) < 2:
                skipped_confirm += 1
                continue
            base_sol = float(cp[0])
            confirmed = False
            entry_price = None
            entry_time = None
            for ci in range(1, len(cp)):
                sol_move = (cp[ci] / base_sol - 1) * 100 * direction
                if sol_move >= confirm_sol_pct:
                    entry_price = float(cp[ci])
                    entry_time = int(ct[ci])
                    confirmed = True
                    break
            if not confirmed:
                skipped_confirm += 1
                continue
        else:
            # Enter at first SOL tick within 2 minutes of BTC event
            entry_mask = (sol_ts >= ev["start_time"]) & (sol_ts <= ev["start_time"] + 120)
            if not np.any(entry_mask):
                continue
            entry_price = float(sol_prices[entry_mask][0])
            entry_time = int(sol_ts[entry_mask][0])

        if entry_price == 0:
            continue

        # Scan for exit
        scan_end = entry_time + max_lag_minutes * 60
        scan_mask = (sol_ts > entry_time) & (sol_ts <= scan_end)
        scan_p = sol_prices[scan_mask]
        scan_t = sol_ts[scan_mask]

        if len(scan_p) == 0:
            continue

        exit_price = None
        exit_time = None
        exit_reason = "timeout"

        hold_seconds = hold_minutes * 60 if hold_minutes else None

        for i in range(len(scan_p)):
            pct_move = (scan_p[i] / entry_price - 1) * 100 * direction
            elapsed = int(scan_t[i]) - entry_time

            if take_profit_pct is not None and pct_move >= take_profit_pct:
                exit_price = float(scan_p[i])
                exit_time = int(scan_t[i])
                exit_reason = "tp"
                break
            if stop_loss_pct is not None and pct_move <= -stop_loss_pct:
                exit_price = float(scan_p[i])
                exit_time = int(scan_t[i])
                exit_reason = "sl"
                break
            if hold_seconds is not None and elapsed >= hold_seconds:
                exit_price = float(scan_p[i])
                exit_time = int(scan_t[i])
                exit_reason = "hold_exit"
                break

        if exit_price is None:
            exit_price = float(scan_p[-1])
            exit_time = int(scan_t[-1])

        raw_pct = (exit_price / entry_price - 1) * 100 * direction
        leveraged_pct = raw_pct * leverage
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
        return {"error": "No trades", "total_trades": 0}

    df = pd.DataFrame(trades)
    wins = df[df["pnl_sol"] > 0]
    losses = df[df["pnl_sol"] <= 0]

    cum_max = df["balance"].cummax()
    drawdowns = cum_max - df["balance"]

    return {
        "total_trades": len(df),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": len(wins) / len(df),
        "roi_pct": (balance - bankroll) / bankroll * 100,
        "final_balance": balance,
        "total_pnl_sol": float(df["pnl_sol"].sum()),
        "avg_pnl_per_trade": float(df["pnl_sol"].mean()),
        "max_drawdown_sol": float(drawdowns.max()),
        "sharpe_approx": float(df["pnl_sol"].mean() / df["pnl_sol"].std()) if df["pnl_sol"].std() > 0 else 0,
        "trades_per_day": len(df) / total_days if total_days > 0 else 0,
        "exit_reasons": df["exit_reason"].value_counts().to_dict(),
        "avg_hold_time": float(df["hold_time"].mean()),
        "skipped_confirm": skipped_confirm,
        "skipped_vol": skipped_vol,
    }


def fmt_result(r: dict, label: str) -> str:
    if r.get("error"):
        return f"  {label}: NO TRADES"
    exits = r.get("exit_reasons", {})
    tp_pct = exits.get("tp", 0) / r["total_trades"] * 100 if r["total_trades"] > 0 else 0
    sl_pct = exits.get("sl", 0) / r["total_trades"] * 100 if r["total_trades"] > 0 else 0
    return (
        f"  {label:<45s} | ROI={r['roi_pct']:+7.1f}% | {r['total_trades']:5d} trades "
        f"| WR={r['win_rate']:.1%} | Sharpe={r['sharpe_approx']:.3f} "
        f"| DD={r['max_drawdown_sol']:.4f} | {r['trades_per_day']:.1f}/day"
        + (f" | TP%={tp_pct:.0f}% SL%={sl_pct:.0f}%" if tp_pct > 0 or sl_pct > 0 else "")
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    now = int(time.time())
    two_years_ago = now - 2 * 365 * 86400

    conn = init_db(DB_PATH)

    # ---------------------------------------------------------------
    # Step 1: Fetch data from Binance (skip if already cached)
    # ---------------------------------------------------------------
    print("=" * 100, flush=True)
    print("  STEP 1: Fetching 2 years of 1m candle data from Binance", flush=True)
    print("=" * 100, flush=True)

    for symbol in SYMBOLS:
        latest = get_latest_ts(conn, symbol)
        if latest:
            start_ms = latest + 60_000
        else:
            start_ms = two_years_ago * 1000
        end_ms = now * 1000
        if start_ms < end_ms:
            fetch_binance_klines(symbol, start_ms, end_ms, conn)
        else:
            sys.stderr.write(f"  {symbol}: already up to date\n")

    # ---------------------------------------------------------------
    # Step 2: Pre-load ALL data into memory ONCE
    # ---------------------------------------------------------------
    print("\nLoading full 2y data into memory...", flush=True)
    btc_full = load_series(conn, "BTCUSDT", two_years_ago, now)
    sol_full = load_series(conn, "SOLUSDT", two_years_ago, now)
    conn.close()

    print(f"  BTC: {len(btc_full):,} points | SOL: {len(sol_full):,} points", flush=True)
    print(f"  Range: {btc_full.index[0]} to {btc_full.index[-1]}", flush=True)

    # Pre-compute numpy arrays for full dataset
    _res = sol_full.index.dtype
    _unit = str(_res).split("[")[1].split(",")[0].split("]")[0]
    _div = {"ns": 10**9, "us": 10**6, "ms": 10**3, "s": 1}.get(_unit, 10**9)

    def slice_period(series, start_ts, end_ts):
        """Slice a pre-loaded series by unix timestamp."""
        start_dt = pd.Timestamp(start_ts, unit="s", tz="UTC")
        end_dt = pd.Timestamp(end_ts, unit="s", tz="UTC")
        return series[start_dt:end_dt]

    def to_numpy(series):
        ts = series.index.astype(np.int64) // _div
        prices = series.values.astype(np.float64)
        return ts, prices

    def run_for_period(start, end, strat):
        """Slice pre-loaded data and run backtest."""
        btc = slice_period(btc_full, start, end)
        sol = slice_period(sol_full, start, end)

        if len(btc) < 100 or len(sol) < 100:
            return {"error": "Insufficient data", "total_trades": 0}

        total_days = (btc.index[-1] - btc.index[0]).total_seconds() / 86400
        if total_days <= 0:
            return {"error": "Zero days", "total_trades": 0}

        events = detect_events_minute(btc, strat["threshold"], strat["window_m"], min_gap_minutes=5)
        if not events:
            return {"error": "No events", "total_trades": 0}

        sol_ts, sol_prices = to_numpy(sol)
        btc_ts, btc_prices = to_numpy(btc)

        return run_backtest_minute(
            events, sol_ts, sol_prices, btc_ts, btc_prices, total_days,
            take_profit_pct=strat["tp"], stop_loss_pct=strat["sl"],
            hold_minutes=strat["hold_m"],
            entry_fee_pct=strat["entry_fee"], exit_fee_pct=strat["exit_fee"],
            confirm_sol_pct=strat["confirm"], min_btc_vol=strat["vol"],
        )

    # ---------------------------------------------------------------
    # Define periods
    # ---------------------------------------------------------------
    periods = [
        ("2y (full)",       two_years_ago,          now),
        ("1y (last year)",  now - 365 * 86400,      now),
        ("6m (last 6mo)",   now - 180 * 86400,      now),
        ("3m (last 3mo)",   now - 90 * 86400,       now),
        ("1m (last month)", now - 30 * 86400,       now),
    ]

    monthly_periods = []
    for months_ago in range(24, 0, -1):
        m_start = now - months_ago * 30 * 86400
        m_end = now - (months_ago - 1) * 30 * 86400
        d = datetime.fromtimestamp(m_start, tz=timezone.utc)
        monthly_periods.append((d.strftime("%Y-%m"), m_start, m_end))

    quarterly_periods = []
    for q in range(8, 0, -1):
        q_start = now - q * 90 * 86400
        q_end = now - (q - 1) * 90 * 86400
        d_s = datetime.fromtimestamp(q_start, tz=timezone.utc)
        d_e = datetime.fromtimestamp(q_end, tz=timezone.utc)
        quarterly_periods.append((f"{d_s.strftime('%Y-%m')} to {d_e.strftime('%Y-%m')}", q_start, q_end))

    # ---------------------------------------------------------------
    # Strategy configurations
    # ---------------------------------------------------------------
    strategies = [
        {"name": "baseline-5m-hold",      "threshold": 0.3, "window_m": 5,  "hold_m": 5,  "tp": None, "sl": None, "entry_fee": 0.1, "exit_fee": 0.1, "confirm": None, "vol": None},
        {"name": "baseline-10m-hold",     "threshold": 0.5, "window_m": 10, "hold_m": 10, "tp": None, "sl": None, "entry_fee": 0.1, "exit_fee": 0.1, "confirm": None, "vol": None},
        {"name": "tp0.5-sl0.3-hold10m",   "threshold": 0.3, "window_m": 5,  "hold_m": 10, "tp": 0.5,  "sl": 0.3,  "entry_fee": 0.1, "exit_fee": 0.1, "confirm": None, "vol": None},
        {"name": "tp0.8-sl0.3-hold15m",   "threshold": 0.3, "window_m": 5,  "hold_m": 15, "tp": 0.8,  "sl": 0.3,  "entry_fee": 0.1, "exit_fee": 0.1, "confirm": None, "vol": None},
        {"name": "tp1.0-sl0.5-hold30m",   "threshold": 0.5, "window_m": 10, "hold_m": 30, "tp": 1.0,  "sl": 0.5,  "entry_fee": 0.1, "exit_fee": 0.1, "confirm": None, "vol": None},
        {"name": "maker-tp0.5-sl0.3",     "threshold": 0.3, "window_m": 5,  "hold_m": 10, "tp": 0.5,  "sl": 0.3,  "entry_fee": 0.0, "exit_fee": 0.1, "confirm": None, "vol": None},
        {"name": "maker-tp0.8-sl0.3",     "threshold": 0.3, "window_m": 5,  "hold_m": 15, "tp": 0.8,  "sl": 0.3,  "entry_fee": 0.0, "exit_fee": 0.1, "confirm": None, "vol": None},
        {"name": "maker-tp1.0-sl0.5-big", "threshold": 0.5, "window_m": 10, "hold_m": 30, "tp": 1.0,  "sl": 0.5,  "entry_fee": 0.0, "exit_fee": 0.1, "confirm": None, "vol": None},
        {"name": "confirm0.05-tp0.5-sl0.3","threshold": 0.3, "window_m": 5, "hold_m": 10, "tp": 0.5,  "sl": 0.3,  "entry_fee": 0.0, "exit_fee": 0.1, "confirm": 0.05, "vol": None},
        {"name": "vol0.01-tp0.8-sl0.3",   "threshold": 0.3, "window_m": 5,  "hold_m": 15, "tp": 0.8,  "sl": 0.3,  "entry_fee": 0.0, "exit_fee": 0.1, "confirm": None, "vol": 0.01},
        {"name": "kitchen-sink",           "threshold": 0.3, "window_m": 5,  "hold_m": 15, "tp": 0.8,  "sl": 0.3,  "entry_fee": 0.0, "exit_fee": 0.1, "confirm": 0.05, "vol": 0.01},
    ]

    # ---------------------------------------------------------------
    # Step 3: Backtests by period
    # ---------------------------------------------------------------
    print("\n" + "=" * 100, flush=True)
    print("  STEP 2: BACKTESTS BY TIME PERIOD", flush=True)
    print("=" * 100, flush=True)

    for strat in strategies:
        print(f"\n{'─' * 100}", flush=True)
        print(f"  Strategy: {strat['name']}", flush=True)
        print(f"{'─' * 100}", flush=True)

        for label, start, end in periods:
            r = run_for_period(start, end, strat)
            print(fmt_result(r, label), flush=True)

    # ---------------------------------------------------------------
    # Step 4: Monthly breakdown (top strategies)
    # ---------------------------------------------------------------
    best_strats = [s for s in strategies if s["name"] in [
        "maker-tp0.8-sl0.3", "kitchen-sink", "baseline-5m-hold"
    ]]

    print("\n" + "=" * 100, flush=True)
    print("  STEP 3: MONTHLY BREAKDOWN (top strategies)", flush=True)
    print("=" * 100, flush=True)

    for strat in best_strats:
        print(f"\n{'─' * 100}", flush=True)
        print(f"  Strategy: {strat['name']}", flush=True)
        print(f"{'─' * 100}", flush=True)

        rois, wrs = [], []
        for label, start, end in monthly_periods:
            r = run_for_period(start, end, strat)
            if r.get("error"):
                print(f"  {label:<12s} | NO TRADES", flush=True)
            else:
                print(fmt_result(r, label), flush=True)
                rois.append(r["roi_pct"])
                wrs.append(r["win_rate"])

        if rois:
            profitable = sum(1 for roi in rois if roi > 0)
            print(f"\n  Summary: {profitable}/{len(rois)} profitable months | "
                  f"avg ROI={np.mean(rois):+.1f}% | median={np.median(rois):+.1f}% | "
                  f"best={max(rois):+.1f}% | worst={min(rois):+.1f}% | avg WR={np.mean(wrs):.1%}", flush=True)

    # ---------------------------------------------------------------
    # Step 5: Quarterly breakdown
    # ---------------------------------------------------------------
    print("\n" + "=" * 100, flush=True)
    print("  STEP 4: QUARTERLY BREAKDOWN", flush=True)
    print("=" * 100, flush=True)

    for strat in best_strats:
        print(f"\n{'─' * 100}", flush=True)
        print(f"  Strategy: {strat['name']}", flush=True)
        print(f"{'─' * 100}", flush=True)

        rois = []
        for label, start, end in quarterly_periods:
            r = run_for_period(start, end, strat)
            if r.get("error"):
                print(f"  {label:<25s} | NO TRADES", flush=True)
            else:
                print(fmt_result(r, label), flush=True)
                rois.append(r["roi_pct"])

        if rois:
            profitable = sum(1 for roi in rois if roi > 0)
            print(f"\n  Summary: {profitable}/{len(rois)} profitable quarters | "
                  f"avg ROI={np.mean(rois):+.1f}% | best={max(rois):+.1f}% | worst={min(rois):+.1f}%", flush=True)

    # ---------------------------------------------------------------
    # Step 6: Market regime analysis
    # ---------------------------------------------------------------
    print("\n" + "=" * 100, flush=True)
    print("  STEP 5: MARKET REGIME ANALYSIS", flush=True)
    print("=" * 100, flush=True)

    print("\n  BTC monthly returns:", flush=True)
    for label, start, end in monthly_periods:
        btc_m = slice_period(btc_full, start, end)
        if len(btc_m) > 10:
            ret = (btc_m.iloc[-1] / btc_m.iloc[0] - 1) * 100
            regime = "BULL" if ret > 5 else ("BEAR" if ret < -5 else "FLAT")
            bar = "+" * int(min(abs(ret), 30)) if ret > 0 else "-" * int(min(abs(ret), 30))
            print(f"  {label}: {ret:+6.1f}% [{regime}] {bar}", flush=True)

    # ---------------------------------------------------------------
    # Step 7: Parameter sweep on 2y data
    # ---------------------------------------------------------------
    print("\n" + "=" * 100, flush=True)
    print("  STEP 6: PARAMETER SWEEP ON FULL 2Y DATA", flush=True)
    print("=" * 100, flush=True)

    total_days_2y = (btc_full.index[-1] - btc_full.index[0]).total_seconds() / 86400
    sol_ts_2y, sol_prices_2y = to_numpy(sol_full)
    btc_ts_2y, btc_prices_2y = to_numpy(btc_full)

    event_cache = {}
    for thresh, wm in [(0.3, 5), (0.5, 10), (0.3, 3), (0.5, 5), (1.0, 15)]:
        events = detect_events_minute(btc_full, thresh, wm)
        event_cache[(thresh, wm)] = events
        print(f"  Events: thresh={thresh}% window={wm}m -> {len(events)} ({len(events)/total_days_2y:.1f}/day)", flush=True)

    sweep_results = []
    print(f"\n  --- TP/SL sweep (maker fees, thresh=0.3%, window=5m) ---", flush=True)
    for tp in [0.3, 0.5, 0.8, 1.0, 1.5, 2.0]:
        for sl in [0.2, 0.3, 0.5, 0.8]:
            for hold in [5, 10, 15, 30]:
                r = run_backtest_minute(
                    event_cache[(0.3, 5)],
                    sol_ts_2y, sol_prices_2y, btc_ts_2y, btc_prices_2y,
                    total_days_2y,
                    take_profit_pct=tp, stop_loss_pct=sl,
                    hold_minutes=hold, entry_fee_pct=0.0, exit_fee_pct=0.1,
                )
                if not r.get("error"):
                    sweep_results.append({"config": f"TP={tp}% SL={sl}% hold={hold}m", **r})

    sweep_results.sort(key=lambda x: x.get("roi_pct", -999), reverse=True)
    print(f"\n  Top 20 by ROI:", flush=True)
    for i, sr in enumerate(sweep_results[:20]):
        exits = sr.get("exit_reasons", {})
        tp_pct = exits.get("tp", 0) / sr["total_trades"] * 100 if sr["total_trades"] > 0 else 0
        print(f"  #{i+1:2d} {sr['config']:<30s} | ROI={sr['roi_pct']:+7.1f}% | {sr['total_trades']:5d} trades "
              f"| WR={sr['win_rate']:.1%} | Sharpe={sr['sharpe_approx']:.3f} | DD={sr['max_drawdown_sol']:.4f}", flush=True)

    sweep_results.sort(key=lambda x: x.get("sharpe_approx", -999), reverse=True)
    print(f"\n  Top 10 by Sharpe:", flush=True)
    for i, sr in enumerate(sweep_results[:10]):
        print(f"  #{i+1:2d} {sr['config']:<30s} | ROI={sr['roi_pct']:+7.1f}% | Sharpe={sr['sharpe_approx']:.3f} "
              f"| WR={sr['win_rate']:.1%} | DD={sr['max_drawdown_sol']:.4f} | {sr['trades_per_day']:.1f}/day", flush=True)

    # Threshold sweep
    print(f"\n  --- Threshold sweep ---", flush=True)
    for thresh, wm in [(0.3, 3), (0.3, 5), (0.5, 5), (0.5, 10), (1.0, 15)]:
        if (thresh, wm) not in event_cache:
            continue
        for tp in [0.5, 0.8, 1.0]:
            for sl in [0.3, 0.5]:
                r = run_backtest_minute(
                    event_cache[(thresh, wm)],
                    sol_ts_2y, sol_prices_2y, btc_ts_2y, btc_prices_2y,
                    total_days_2y,
                    take_profit_pct=tp, stop_loss_pct=sl,
                    hold_minutes=15, entry_fee_pct=0.0, exit_fee_pct=0.1,
                )
                if not r.get("error"):
                    print(f"  thresh={thresh}% win={wm}m TP={tp}% SL={sl}% | "
                          f"ROI={r['roi_pct']:+7.1f}% | {r['total_trades']:5d} trades | "
                          f"WR={r['win_rate']:.1%} | Sharpe={r['sharpe_approx']:.3f}", flush=True)

    print("\n\nDone.", flush=True)


if __name__ == "__main__":
    main()
