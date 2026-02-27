"""Feed IDs, API URLs, and default configuration."""

# Pyth Network feed IDs (full hex with 0x prefix)
BTC_USD_FEED = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"
SOL_USD_FEED = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"

# Stripped feed IDs (no 0x prefix) for API requests
BTC_USD_FEED_STRIPPED = BTC_USD_FEED[2:]
SOL_USD_FEED_STRIPPED = SOL_USD_FEED[2:]

FEED_IDS = [BTC_USD_FEED_STRIPPED, SOL_USD_FEED_STRIPPED]
FEED_LABELS = {
    BTC_USD_FEED_STRIPPED: "BTC/USD",
    SOL_USD_FEED_STRIPPED: "SOL/USD",
}

# API endpoints
BENCHMARKS_BASE_URL = "https://benchmarks.pyth.network"
HERMES_BASE_URL = "https://hermes.pyth.network"
HERMES_SSE_URL = f"{HERMES_BASE_URL}/v2/updates/price/stream"

# Rate limiting (Benchmarks API)
RATE_LIMIT_TOKENS = 30
RATE_LIMIT_WINDOW_SECONDS = 10

# Fetcher defaults
FETCH_INTERVAL_SECONDS = 60  # Each request covers 60s of tick data
FETCH_WORKERS = 3
BATCH_INSERT_SIZE = 500
PROGRESS_UPDATE_INTERVAL = 100  # Update fetch_progress every N requests
BACKOFF_BASE = 2.0
BACKOFF_MAX = 30.0

# Event detection defaults
DEFAULT_BTC_THRESHOLD = 0.3   # percent
DEFAULT_SOL_THRESHOLD = 0.6   # percent
DEFAULT_WINDOW_SECONDS = 60
DEFAULT_MAX_LAG_SECONDS = 300
MIN_EVENT_GAP_SECONDS = 30

# Analysis defaults
DEFAULT_DAYS = 7
DEFAULT_DB_PATH = "./driftpilot.db"
DEFAULT_OUTPUT_DIR = "./output"
DEFAULT_LIVE_LOOKBACK = 3600  # seconds
