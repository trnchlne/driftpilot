"""CLI interface and pipeline orchestration."""

from __future__ import annotations

import argparse
import asyncio
import sys
import time

from . import config
from .db import get_tick_count, get_time_range, init_db, insert_events


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="driftpilot",
        description="Drift Protocol SOL perp trading bot with regime-switching strategy",
    )
    p.add_argument("--days", type=int, default=config.DEFAULT_DAYS,
                   help=f"Days of historical data to fetch (default: {config.DEFAULT_DAYS})")
    p.add_argument("--start", type=int, default=None,
                   help="Start timestamp (overrides --days)")
    p.add_argument("--end", type=int, default=None,
                   help="End timestamp (default: now)")
    p.add_argument("--db", type=str, default=config.DEFAULT_DB_PATH,
                   help=f"SQLite database path (default: {config.DEFAULT_DB_PATH})")
    p.add_argument("--btc-threshold", type=float, default=config.DEFAULT_BTC_THRESHOLD,
                   help=f"BTC move threshold %% (default: {config.DEFAULT_BTC_THRESHOLD})")
    p.add_argument("--sol-threshold", type=float, default=config.DEFAULT_SOL_THRESHOLD,
                   help=f"SOL follow threshold %% (default: {config.DEFAULT_SOL_THRESHOLD})")
    p.add_argument("--window", type=int, default=config.DEFAULT_WINDOW_SECONDS,
                   help=f"Detection window in seconds (default: {config.DEFAULT_WINDOW_SECONDS})")
    p.add_argument("--max-lag", type=int, default=config.DEFAULT_MAX_LAG_SECONDS,
                   help=f"Max lag to scan in seconds (default: {config.DEFAULT_MAX_LAG_SECONDS})")
    p.add_argument("--output-dir", type=str, default=config.DEFAULT_OUTPUT_DIR,
                   help=f"Output directory for charts/CSV (default: {config.DEFAULT_OUTPUT_DIR})")
    p.add_argument("--no-fetch", action="store_true",
                   help="Skip fetching, use existing data in DB")
    p.add_argument("--no-charts", action="store_true",
                   help="Skip chart generation")
    p.add_argument("--live", action="store_true",
                   help="Run in live streaming mode")
    p.add_argument("--live-lookback", type=int, default=config.DEFAULT_LIVE_LOOKBACK,
                   help=f"Live mode lookback in seconds (default: {config.DEFAULT_LIVE_LOOKBACK})")
    return p.parse_args(argv)


async def run_pipeline(args: argparse.Namespace) -> None:
    # Live mode
    if args.live:
        from .stream import run_live
        await run_live(
            btc_threshold=args.btc_threshold,
            sol_threshold=args.sol_threshold,
            window=args.window,
            max_lag=args.max_lag,
        )
        return

    # Historical mode
    conn = init_db(args.db)

    now = int(time.time())
    end_ts = args.end or now
    start_ts = args.start or (end_ts - args.days * 86400)

    # Step 1: Fetch
    if not args.no_fetch:
        from .fetcher import fetch_historical
        print(f"Fetching data from {args.days} days ({end_ts - start_ts} seconds)...")
        await fetch_historical(conn, start_ts, end_ts)

    # Check data
    btc_count = get_tick_count(conn, config.BTC_USD_FEED_STRIPPED)
    sol_count = get_tick_count(conn, config.SOL_USD_FEED_STRIPPED)
    time_range = get_time_range(conn)
    print(f"\nData: BTC={btc_count:,} ticks, SOL={sol_count:,} ticks")
    if time_range[0]:
        from .utils import ts_to_iso
        print(f"Range: {ts_to_iso(time_range[0])} → {ts_to_iso(time_range[1])}")

    if btc_count == 0 or sol_count == 0:
        print("Not enough data for analysis. Run without --no-fetch to fetch data.")
        conn.close()
        return

    # Step 2: Load price series
    from .events import correlate_btc_sol, detect_events, load_price_series

    print("\nLoading price series...")
    btc_series = load_price_series(conn, config.BTC_USD_FEED_STRIPPED, start_ts, end_ts)
    sol_series = load_price_series(conn, config.SOL_USD_FEED_STRIPPED, start_ts, end_ts)
    print(f"BTC series: {len(btc_series)} points | SOL series: {len(sol_series)} points")

    # Step 3: Detect events
    print("\nDetecting BTC events...")
    btc_events = detect_events(
        btc_series,
        config.BTC_USD_FEED_STRIPPED,
        args.btc_threshold,
        args.window,
    )
    print(f"Found {len(btc_events)} BTC events")
    insert_events(conn, btc_events)

    if not btc_events:
        print("No BTC events detected. Try lowering --btc-threshold.")
        conn.close()
        return

    # Step 4: Correlate BTC→SOL
    print("Correlating with SOL response...")
    pairs = correlate_btc_sol(btc_events, sol_series, args.sol_threshold, args.max_lag)

    # Step 5: Analysis
    from .analysis import (
        compute_cross_correlation,
        compute_hit_rate,
        export_csv,
        print_report,
    )

    print("Computing cross-correlation...")
    cross_corr = compute_cross_correlation(btc_series, sol_series, args.max_lag)

    hr = compute_hit_rate(pairs)
    print_report(hr, pairs, cross_corr, args.btc_threshold, args.sol_threshold, args.window, args.max_lag)
    export_csv(pairs, args.output_dir)

    # Step 6: Charts
    if not args.no_charts:
        from .viz import generate_all_charts
        generate_all_charts(cross_corr, pairs, btc_series, sol_series, args.output_dir)

    conn.close()
    print("\nDone.")


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    try:
        asyncio.run(run_pipeline(args))
    except KeyboardInterrupt:
        sys.stderr.write("\nInterrupted.\n")
        sys.exit(1)
