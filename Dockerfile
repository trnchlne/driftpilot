FROM python:3.12-slim AS base

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Install dependencies first (cached layer)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# Copy source + README (referenced in pyproject.toml)
COPY README.md src/ ./
COPY src/ src/
RUN uv sync --frozen --no-dev

# Persist data
VOLUME ["/app/data", "/app/output"]

ENV UV_LINK_MODE=copy

ENTRYPOINT ["uv", "run", "driftpilot"]
CMD ["--db", "/app/data/driftpilot.db", "--output-dir", "/app/output"]
