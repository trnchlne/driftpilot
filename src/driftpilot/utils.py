"""Price conversion and formatting helpers."""

from datetime import datetime, timezone


def pyth_price_to_float(raw_price: int, expo: int) -> float:
    return raw_price * (10 ** expo)


def ts_to_iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def ts_to_short(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%H:%M:%S UTC")


def format_pct(value: float) -> str:
    return f"{value:+.2f}%"


def format_price(value: float, decimals: int = 2) -> str:
    return f"${value:,.{decimals}f}"
