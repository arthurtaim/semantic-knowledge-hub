# syntax=docker/dockerfile:1
# Build context: repository root (see docker-compose.yml).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin skh \
    && mkdir -p /data/workspace \
    && chown -R skh:skh /data

COPY backend/requirements.lock /app/requirements.lock
RUN pip install --require-hashes -r /app/requirements.lock

COPY backend/app /app/app
# Synthetic fixtures only — seeded into the (empty) workspace volume on first start.
COPY fixtures/knowledge /app/fixtures/knowledge

USER skh

ENV PROJECT_ROOT=/app \
    APP_HOST=0.0.0.0 \
    APP_PORT=8000 \
    APP_CONTAINER=true \
    APP_PUBLISHED_HOST=127.0.0.1 \
    FIXTURES_DIR=/app/fixtures/knowledge \
    LOCAL_KNOWLEDGE_DIR=/data/workspace/knowledge \
    SEARCH_INDEX_PATH=/data/workspace/search.sqlite3 \
    APP_STATE_PATH=/data/workspace/app_state.sqlite3

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2).status == 200 else 1)"]

CMD ["python", "-m", "app"]
