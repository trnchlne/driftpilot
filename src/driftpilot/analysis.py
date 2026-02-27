"""Cross-correlation, hit rates, direction breakdown, and reporting."""

from __future__ import annotations

import csv
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from . import config
from .models import CorrelatedPair, HitRateResult
from .utils import format_pct, format_price, ts_to_iso


def compute_cross_correlation(
    btc_series: pd.Series,
    sol_series: pd.Series,
    max_lag: int = config.DEFAULT_MAX_LAG_SECONDS,
) -> pd.Series:
    btc_log = np.log(btc_series).diff().dropna()
    sol_log = np.log(sol_series).diff().dropna()

    common = btc_log.index.intersection(sol_log.index)
    btc_arr = btc_log.loc[common].values.astype(np.float64)
    sol_arr = sol_log.loc[common].values.astype(np.float64)

    if len(btc_arr) < max_lag * 2:
        return pd.Series(dtype=float)

    btc_arr = (btc_arr - btc_arr.mean()) / (btc_arr.std() + 1e-12)
    sol_arr = (sol_arr - sol_arr.mean()) / (sol_arr.std() + 1e-12)

    lags = range(-max_lag, max_lag + 1)
    correlations = {}
    n = len(btc_arr)

    for lag in lags:
        if lag >= 0:
            b = btc_arr[:n - lag] if lag > 0 else btc_arr
            s = sol_arr[lag:] if lag > 0 else sol_arr
        else:
            b = btc_arr[-lag:]
            s = sol_arr[:n + lag]
        if len(b) > 0:
            correlations[lag] = float(np.dot(b, s) / len(b))

    return pd.Series(correlations)


def compute_hit_rate(pairs: list[CorrelatedPair]) -> HitRateResult:
    if not pairs:
        return HitRateResult(0, 0, 0, 0.0, None, None, None, None, None, None, 0, 0, 0, 0)

    hits = [p for p in pairs if p.hit]
    misses = [p for p in pairs if not p.hit]
    lags = [p.lag_seconds for p in hits if p.lag_seconds is not None]

    pump_pairs = [p for p in pairs if p.btc_event.direction == "pump"]
    dump_pairs = [p for p in pairs if p.btc_event.direction == "dump"]

    lag_arr = np.array(lags) if lags else np.array([])

    return HitRateResult(
        total_btc_events=len(pairs),
        hits=len(hits),
        misses=len(misses),
        hit_rate=len(hits) / len(pairs) if pairs else 0.0,
        mean_lag=float(lag_arr.mean()) if len(lag_arr) > 0 else None,
        median_lag=float(np.median(lag_arr)) if len(lag_arr) > 0 else None,
        p25_lag=float(np.percentile(lag_arr, 25)) if len(lag_arr) > 0 else None,
        p75_lag=float(np.percentile(lag_arr, 75)) if len(lag_arr) > 0 else None,
        min_lag=float(lag_arr.min()) if len(lag_arr) > 0 else None,
        max_lag=float(lag_arr.max()) if len(lag_arr) > 0 else None,
        pump_hits=sum(1 for p in pump_pairs if p.hit),
        pump_misses=sum(1 for p in pump_pairs if not p.hit),
        dump_hits=sum(1 for p in dump_pairs if p.hit),
        dump_misses=sum(1 for p in dump_pairs if not p.hit),
    )


def time_of_day_breakdown(
    pairs: list[CorrelatedPair],
) -> dict[int, dict]:
    from datetime import datetime, timezone

    hourly: dict[int, dict] = {}
    for hour in range(24):
        hourly[hour] = {"total": 0, "hits": 0, "lags": []}

    for p in pairs:
        dt = datetime.fromtimestamp(p.btc_event.end_time, tz=timezone.utc)
        h = dt.hour
        hourly[h]["total"] += 1
        if p.hit:
            hourly[h]["hits"] += 1
            if p.lag_seconds is not None:
                hourly[h]["lags"].append(p.lag_seconds)

    result = {}
    for hour, data in hourly.items():
        result[hour] = {
            "total": data["total"],
            "hits": data["hits"],
            "hit_rate": data["hits"] / data["total"] if data["total"] > 0 else 0.0,
            "avg_lag": float(np.mean(data["lags"])) if data["lags"] else None,
        }
    return result


def direction_breakdown(pairs: list[CorrelatedPair]) -> dict[str, dict]:
    combos = {
        "pump→follow": {"total": 0, "hits": 0, "lags": []},
        "dump→follow": {"total": 0, "hits": 0, "lags": []},
    }
    for p in pairs:
        key = f"{p.btc_event.direction}→follow"
        combos[key]["total"] += 1
        if p.hit:
            combos[key]["hits"] += 1
            if p.lag_seconds is not None:
                combos[key]["lags"].append(p.lag_seconds)

    result = {}
    for key, data in combos.items():
        result[key] = {
            "total": data["total"],
            "hits": data["hits"],
            "hit_rate": data["hits"] / data["total"] if data["total"] > 0 else 0.0,
            "avg_lag": float(np.mean(data["lags"])) if data["lags"] else None,
            "median_lag": float(np.median(data["lags"])) if data["lags"] else None,
        }
    return result


def print_report(
    hr: HitRateResult,
    pairs: list[CorrelatedPair],
    cross_corr: pd.Series,
    btc_threshold: float,
    sol_threshold: float,
    window: int,
    max_lag: int,
) -> None:
    print("\n" + "=" * 70)
    print("  BTC/SOL Lead-Lag Analysis Report")
    print("=" * 70)

    print(f"\nParameters:")
    print(f"  BTC threshold: {format_pct(btc_threshold)}  |  SOL threshold: {format_pct(sol_threshold)}")
    print(f"  Detection window: {window}s  |  Max lag: {max_lag}s")

    print(f"\nOverall Results:")
    print(f"  BTC events detected: {hr.total_btc_events}")
    print(f"  SOL followed:        {hr.hits} ({hr.hit_rate:.1%})")
    print(f"  SOL missed:          {hr.misses}")

    if hr.mean_lag is not None:
        print(f"\nLag Statistics (seconds):")
        print(f"  Mean: {hr.mean_lag:.1f}  |  Median: {hr.median_lag:.1f}")
        print(f"  P25:  {hr.p25_lag:.1f}  |  P75:    {hr.p75_lag:.1f}")
        print(f"  Min:  {hr.min_lag:.1f}  |  Max:    {hr.max_lag:.1f}")

    dir_bd = direction_breakdown(pairs)
    print(f"\nDirection Breakdown:")
    for key, data in dir_bd.items():
        rate = f"{data['hit_rate']:.1%}" if data["total"] > 0 else "N/A"
        lag_str = f"avg lag {data['avg_lag']:.1f}s" if data["avg_lag"] else "—"
        print(f"  {key}: {data['hits']}/{data['total']} ({rate}) {lag_str}")

    tod = time_of_day_breakdown(pairs)
    active_hours = {h: d for h, d in tod.items() if d["total"] > 0}
    if active_hours:
        print(f"\nTime-of-Day (UTC) — top hours:")
        sorted_hours = sorted(active_hours.items(), key=lambda x: x[1]["total"], reverse=True)
        for hour, data in sorted_hours[:8]:
            rate = f"{data['hit_rate']:.0%}" if data["total"] > 0 else "—"
            print(f"  {hour:02d}:00  events={data['total']:>3}  hit_rate={rate:>4}")

    if not cross_corr.empty:
        peak_lag = int(cross_corr.idxmax())
        peak_val = cross_corr.max()
        print(f"\nCross-Correlation:")
        print(f"  Peak correlation: {peak_val:.4f} at lag={peak_lag}s")
        if peak_lag > 0:
            print(f"  → BTC leads SOL by ~{peak_lag}s")
        elif peak_lag < 0:
            print(f"  → SOL leads BTC by ~{-peak_lag}s")
        else:
            print(f"  → Moves are roughly simultaneous")

    print("\n" + "=" * 70)


def export_csv(pairs: list[CorrelatedPair], output_dir: str | Path) -> Path:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "correlated_pairs.csv"

    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "btc_direction", "btc_start_time", "btc_end_time",
            "btc_start_price", "btc_end_price", "btc_pct_change",
            "sol_response_time", "lag_seconds", "sol_pct_change", "hit",
        ])
        for p in pairs:
            writer.writerow([
                p.btc_event.direction,
                ts_to_iso(p.btc_event.start_time),
                ts_to_iso(p.btc_event.end_time),
                f"{p.btc_event.start_price:.2f}",
                f"{p.btc_event.end_price:.2f}",
                f"{p.btc_event.pct_change:.4f}",
                ts_to_iso(p.sol_response_time) if p.sol_response_time else "",
                f"{p.lag_seconds:.1f}" if p.lag_seconds is not None else "",
                f"{p.sol_pct_change:.4f}" if p.sol_pct_change is not None else "",
                p.hit,
            ])

    print(f"Exported {len(pairs)} pairs to {path}")
    return path
