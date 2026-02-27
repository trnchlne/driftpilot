"""Rolling-window event detection and BTC→SOL correlation."""

from __future__ import annotations

import sqlite3

import numpy as np
import pandas as pd

from . import config
from .db import load_ticks_as_rows
from .models import CorrelatedPair, Event


def load_price_series(
    conn: sqlite3.Connection,
    feed_id: str,
    start_time: int | None = None,
    end_time: int | None = None,
) -> pd.Series:
    rows = load_ticks_as_rows(conn, feed_id, start_time, end_time)
    if not rows:
        return pd.Series(dtype=float)
    df = pd.DataFrame(rows, columns=["publish_time", "price", "conf"])
    df["timestamp"] = pd.to_datetime(df["publish_time"], unit="s", utc=True)
    df = df.set_index("timestamp").sort_index()
    df = df[~df.index.duplicated(keep="first")]
    series = df["price"].resample("1s").last().ffill()
    return series


def detect_events(
    series: pd.Series,
    feed_id: str,
    threshold_pct: float,
    window_seconds: int = config.DEFAULT_WINDOW_SECONDS,
    min_gap: int = config.MIN_EVENT_GAP_SECONDS,
) -> list[Event]:
    if len(series) < window_seconds + 1:
        return []

    prices = series.values.astype(np.float64)
    pct_change = (prices[window_seconds:] / prices[:-window_seconds] - 1) * 100
    threshold = threshold_pct

    events: list[Event] = []
    i = 0
    n = len(pct_change)

    while i < n:
        if abs(pct_change[i]) >= threshold:
            direction = "pump" if pct_change[i] > 0 else "dump"
            # Find the peak in this cluster
            peak_idx = i
            peak_val = abs(pct_change[i])
            j = i + 1
            while j < n and abs(pct_change[j]) >= threshold:
                if abs(pct_change[j]) > peak_val:
                    peak_idx = j
                    peak_val = abs(pct_change[j])
                j += 1

            end_idx = peak_idx + window_seconds
            start_idx = peak_idx

            start_ts = int(series.index[start_idx].timestamp())
            end_ts = int(series.index[end_idx].timestamp()) if end_idx < len(series) else int(series.index[-1].timestamp())
            start_price = float(prices[start_idx])
            end_price = float(prices[min(end_idx, len(prices) - 1)])

            events.append(Event(
                feed_id=feed_id,
                direction=direction,
                start_time=start_ts,
                end_time=end_ts,
                start_price=start_price,
                end_price=end_price,
                pct_change=float(pct_change[peak_idx]),
                window_seconds=window_seconds,
                threshold=threshold_pct,
            ))

            # Skip ahead by min_gap
            i = j + min_gap
        else:
            i += 1

    return events


def correlate_btc_sol(
    btc_events: list[Event],
    sol_series: pd.Series,
    sol_threshold_pct: float,
    max_lag: int = config.DEFAULT_MAX_LAG_SECONDS,
) -> list[CorrelatedPair]:
    if sol_series.empty:
        return [CorrelatedPair(e, None, None, None, False) for e in btc_events]

    # Convert DatetimeIndex to unix timestamps (seconds).
    # pandas datetime64 resolution varies (ns, us, s), so use .astype('int64')
    # and normalise based on the actual resolution.
    _res = sol_series.index.dtype  # e.g. datetime64[s, UTC]
    _unit = str(_res).split("[")[1].split(",")[0].split("]")[0]  # 's', 'ns', etc.
    _divisors = {"ns": 10**9, "us": 10**6, "ms": 10**3, "s": 1}
    sol_index_ts = sol_series.index.astype(np.int64) // _divisors.get(_unit, 10**9)
    sol_prices = sol_series.values.astype(np.float64)
    pairs: list[CorrelatedPair] = []

    for btc_event in btc_events:
        # Scan from BTC event START (not end) to capture concurrent moves,
        # then continue scanning up to max_lag after the event ends.
        scan_start = btc_event.start_time
        scan_end = btc_event.end_time + max_lag

        # Get SOL price just before the BTC event as the baseline
        pre_mask = sol_index_ts < scan_start
        if not np.any(pre_mask):
            pairs.append(CorrelatedPair(btc_event, None, None, None, False))
            continue
        base_price = float(sol_prices[pre_mask][-1])
        if base_price == 0:
            pairs.append(CorrelatedPair(btc_event, None, None, None, False))
            continue

        mask = (sol_index_ts >= scan_start) & (sol_index_ts <= scan_end)
        window_prices = sol_prices[mask]
        window_times = sol_index_ts[mask]

        if len(window_prices) == 0:
            pairs.append(CorrelatedPair(btc_event, None, None, None, False))
            continue

        pct_changes = (window_prices / base_price - 1) * 100

        # Look for SOL move in the same direction as BTC
        if btc_event.direction == "pump":
            exceeds = pct_changes >= sol_threshold_pct
        else:
            exceeds = pct_changes <= -sol_threshold_pct

        if np.any(exceeds):
            first_idx = np.argmax(exceeds)
            response_time = int(window_times[first_idx])
            lag = float(response_time - scan_start)
            sol_pct = float(pct_changes[first_idx])
            pairs.append(CorrelatedPair(btc_event, response_time, lag, sol_pct, True))
        else:
            pairs.append(CorrelatedPair(btc_event, None, None, None, False))

    return pairs
