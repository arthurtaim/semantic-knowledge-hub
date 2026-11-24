# syntax=docker/dockerfile:1
# Isolated runtime for the EXPERIMENTAL `claude_cli` AI provider (docs/CLAUDE_CODE_CLI_INTEGRATION.md).
# Build context: repository root. Contains ONLY the worker package and the official Claude Code CLI binary —
# no application code, no knowledge base, no fixtures, no credentials.
FROM python:3.12-slim

# Official Claude Code release binary, pinned: version + sha256 from
# https://downloads.claude.ai/claude-code-releases/<version>/manifest.json (same source as claude.ai/install.sh).
ARG CLAUDE_CODE_VERSION=2.1.318
ARG CLAUDE_SHA256_AMD64=708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd
ARG CLAUDE_SHA256_ARM64=53a0d7e219d7b0804ecba5dbc002745e89f786cc946d2de85a6470d5b2d1fb06
ARG TARGETARCH

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN useradd --system --uid 10002 --home-dir /tmp/claude-home --shell /usr/sbin/nologin claudeworker

COPY backend/requirements.lock /app/requirements.lock
RUN pip install --require-hashes -r /app/requirements.lock

RUN <<EOF
set -eu
case "${TARGETARCH:-amd64}" in
  amd64) platform=linux-x64;   sha="${CLAUDE_SHA256_AMD64}" ;;
  arm64) platform=linux-arm64; sha="${CLAUDE_SHA256_ARM64}" ;;
  *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;;
esac
python - "$platform" "$sha" <<'PY'
import hashlib, os, sys, urllib.request
platform, expected = sys.argv[1], sys.argv[2]
version = os.environ["CLAUDE_CODE_VERSION"]
url = f"https://downloads.claude.ai/claude-code-releases/{version}/{platform}/claude"
digest = hashlib.sha256()
with urllib.request.urlopen(url, timeout=300) as resp, open("/usr/local/bin/claude", "wb") as out:
    while chunk := resp.read(1 << 20):
        digest.update(chunk)
        out.write(chunk)
if digest.hexdigest() != expected:
    os.remove("/usr/local/bin/claude")
    sys.exit(f"sha256 mismatch for {url}")
os.chmod("/usr/local/bin/claude", 0o755)
print(f"claude {version} {platform} verified")
PY
EOF
ENV CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}

COPY backend/claude_worker /app/claude_worker
WORKDIR /app
USER claudeworker

ENV CLAUDE_WORKER_HOST=0.0.0.0 \
    CLAUDE_WORKER_PORT=8090 \
    CLAUDE_CLI_COMMAND=/usr/local/bin/claude \
    CLAUDE_WORKER_HOME=/tmp/claude-home \
    CLAUDE_WORKER_RUNS_DIR=/tmp/claude-runs \
    HOME=/tmp/claude-home

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=15s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/v1/health', timeout=10).status == 200 else 1)"]

CMD ["python", "-m", "claude_worker"]
