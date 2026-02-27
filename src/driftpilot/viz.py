"""Chart generation for analysis results."""

from __future__ import annotations

from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
import pandas as pd

from .models import CorrelatedPair, Event
from .analysis import time_of_day_breakdown


def _save(fig: plt.Figure, output_dir: Path, name: str) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / name
    fig.savefig(path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved {path}")


def plot_cross_correlation(
    cross_corr: pd.Series,
    output_dir: str | Path,
) -> None:
    if cross_corr.empty:
        return
    output_dir = Path(output_dir)
    fig, ax = plt.subplots(figsize=(12, 5))

    lags = cross_corr.index.values
    vals = cross_corr.values

    colors = ["#e74c3c" if v < 0 else "#2ecc71" for v in vals]
    # Subsample for readability if too many lags
    if len(lags) > 200:
        step = max(1, len(lags) // 200)
        lags = lags[::step]
        vals = vals[::step]
        colors = colors[::step]

    ax.bar(lags, vals, color=colors, width=max(1, step if len(cross_corr) > 200 else 1), alpha=0.7)

    peak_lag = cross_corr.idxmax()
    peak_val = cross_corr.max()
    ax.axvline(x=peak_lag, color="red", linestyle="--", linewidth=1.5, label=f"Peak: lag={peak_lag}s (r={peak_val:.3f})")
    ax.axvline(x=0, color="black", linestyle="-", linewidth=0.5, alpha=0.3)
    ax.set_xlabel("Lag (seconds) — positive = BTC leads SOL")
    ax.set_ylabel("Pearson Correlation")
    ax.set_title("BTC/SOL Cross-Correlation of Log Returns")
    ax.legend()
    ax.grid(axis="y", alpha=0.3)

    _save(fig, output_dir, "cross_correlation.png")


def plot_lag_histogram(
    pairs: list[CorrelatedPair],
    output_dir: str | Path,
) -> None:
    hits = [p for p in pairs if p.hit and p.lag_seconds is not None]
    if not hits:
        return
    output_dir = Path(output_dir)
    fig, ax = plt.subplots(figsize=(10, 5))

    pump_lags = [p.lag_seconds for p in hits if p.btc_event.direction == "pump"]
    dump_lags = [p.lag_seconds for p in hits if p.btc_event.direction == "dump"]

    bins = np.linspace(0, max(p.lag_seconds for p in hits) + 5, 30)

    if pump_lags:
        ax.hist(pump_lags, bins=bins, alpha=0.6, label=f"Pump ({len(pump_lags)})", color="#2ecc71")
    if dump_lags:
        ax.hist(dump_lags, bins=bins, alpha=0.6, label=f"Dump ({len(dump_lags)})", color="#e74c3c")

    all_lags = [p.lag_seconds for p in hits]
    median = float(np.median(all_lags))
    ax.axvline(x=median, color="orange", linestyle="--", linewidth=2, label=f"Median: {median:.1f}s")

    ax.set_xlabel("Lag (seconds)")
    ax.set_ylabel("Count")
    ax.set_title("Distribution of BTC→SOL Response Lag")
    ax.legend()
    ax.grid(axis="y", alpha=0.3)

    _save(fig, output_dir, "lag_histogram.png")


def plot_magnitude_scatter(
    pairs: list[CorrelatedPair],
    output_dir: str | Path,
) -> None:
    hits = [p for p in pairs if p.hit and p.sol_pct_change is not None]
    if not hits:
        return
    output_dir = Path(output_dir)
    fig, ax = plt.subplots(figsize=(8, 8))

    btc_pcts = [p.btc_event.pct_change for p in hits]
    sol_pcts = [p.sol_pct_change for p in hits]
    lags = [p.lag_seconds for p in hits]

    scatter = ax.scatter(btc_pcts, sol_pcts, c=lags, cmap="coolwarm",
                         alpha=0.7, edgecolors="black", linewidth=0.5, s=50)
    plt.colorbar(scatter, label="Lag (seconds)")

    # Regression line
    if len(btc_pcts) > 1:
        z = np.polyfit(btc_pcts, sol_pcts, 1)
        p_fn = np.poly1d(z)
        x_line = np.linspace(min(btc_pcts), max(btc_pcts), 50)
        ax.plot(x_line, p_fn(x_line), "r--", alpha=0.7, label=f"Fit: y={z[0]:.2f}x{z[1]:+.2f}")

    ax.axhline(y=0, color="black", linewidth=0.5, alpha=0.3)
    ax.axvline(x=0, color="black", linewidth=0.5, alpha=0.3)
    ax.set_xlabel("BTC Move (%)")
    ax.set_ylabel("SOL Move (%)")
    ax.set_title("BTC vs SOL Move Magnitude")
    ax.legend()
    ax.grid(alpha=0.3)

    _save(fig, output_dir, "magnitude_scatter.png")


def plot_timeline(
    btc_series: pd.Series,
    sol_series: pd.Series,
    pairs: list[CorrelatedPair],
    output_dir: str | Path,
) -> None:
    if btc_series.empty or sol_series.empty:
        return
    output_dir = Path(output_dir)

    # Limit to first 24h for readability if dataset is large
    btc_plot = btc_series
    sol_plot = sol_series
    if len(btc_series) > 86400:
        btc_plot = btc_series.iloc[:86400]
        sol_plot = sol_series.iloc[:86400]

    fig, ax1 = plt.subplots(figsize=(16, 6))
    ax2 = ax1.twinx()

    ax1.plot(btc_plot.index, btc_plot.values, color="#f39c12", linewidth=0.5, alpha=0.8, label="BTC/USD")
    ax2.plot(sol_plot.index, sol_plot.values, color="#3498db", linewidth=0.5, alpha=0.8, label="SOL/USD")

    # Mark events
    plot_start = btc_plot.index[0].timestamp() if hasattr(btc_plot.index[0], 'timestamp') else 0
    plot_end = btc_plot.index[-1].timestamp() if hasattr(btc_plot.index[-1], 'timestamp') else float('inf')

    for p in pairs:
        if p.btc_event.end_time < plot_start or p.btc_event.end_time > plot_end:
            continue
        btc_time = pd.Timestamp(p.btc_event.end_time, unit="s", tz="UTC")
        color = "#2ecc71" if p.btc_event.direction == "pump" else "#e74c3c"
        ax1.axvline(x=btc_time, color=color, alpha=0.3, linewidth=1)

        if p.hit and p.sol_response_time:
            sol_time = pd.Timestamp(p.sol_response_time, unit="s", tz="UTC")
            ax2.axvline(x=sol_time, color=color, alpha=0.2, linewidth=1, linestyle="--")

    ax1.set_ylabel("BTC/USD", color="#f39c12")
    ax2.set_ylabel("SOL/USD", color="#3498db")
    ax1.set_xlabel("Time (UTC)")
    ax1.set_title("BTC & SOL Price Timeline with Detected Events")

    ax1.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
    ax1.tick_params(axis="x", rotation=45)

    lines1, labels1 = ax1.get_legend_handles_labels()
    lines2, labels2 = ax2.get_legend_handles_labels()
    ax1.legend(lines1 + lines2, labels1 + labels2, loc="upper left")
    ax1.grid(alpha=0.2)

    _save(fig, output_dir, "timeline.png")


def plot_time_of_day(
    pairs: list[CorrelatedPair],
    output_dir: str | Path,
) -> None:
    if not pairs:
        return
    output_dir = Path(output_dir)
    tod = time_of_day_breakdown(pairs)

    hours = list(range(24))
    hit_rates = [tod[h]["hit_rate"] * 100 for h in hours]
    totals = [tod[h]["total"] for h in hours]

    fig, ax1 = plt.subplots(figsize=(12, 5))
    ax2 = ax1.twinx()

    bars = ax1.barh([f"{h:02d}:00" for h in hours], hit_rates,
                    color="#3498db", alpha=0.7, label="Hit Rate (%)")
    ax2.barh([f"{h:02d}:00" for h in hours], totals,
             color="#e74c3c", alpha=0.3, label="Event Count")

    ax1.set_xlabel("Hit Rate (%)")
    ax2.set_xlabel("Event Count")
    ax1.set_title("BTC→SOL Follow Rate by Time of Day (UTC)")

    lines1, labels1 = ax1.get_legend_handles_labels()
    lines2, labels2 = ax2.get_legend_handles_labels()
    ax1.legend(lines1 + lines2, labels1 + labels2, loc="lower right")

    _save(fig, output_dir, "time_of_day.png")


def generate_all_charts(
    cross_corr: pd.Series,
    pairs: list[CorrelatedPair],
    btc_series: pd.Series,
    sol_series: pd.Series,
    output_dir: str | Path,
) -> None:
    print("\nGenerating charts...")
    plot_cross_correlation(cross_corr, output_dir)
    plot_lag_histogram(pairs, output_dir)
    plot_magnitude_scatter(pairs, output_dir)
    plot_timeline(btc_series, sol_series, pairs, output_dir)
    plot_time_of_day(pairs, output_dir)
