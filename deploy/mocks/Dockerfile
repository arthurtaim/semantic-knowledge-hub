# syntax=docker/dockerfile:1
# TEST DOUBLES ONLY (GitLab REST subset, Confluence MCP, Confluence DC REST subset) for the
# `integration_mock` profile. Never part of the application image; never published on host ports.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /mocks
RUN useradd --system --uid 10002 --home-dir /mocks --shell /usr/sbin/nologin mocks
COPY backend/requirements.lock /mocks/requirements.lock
RUN pip install --require-hashes -r /mocks/requirements.lock
COPY backend/tests/__init__.py /mocks/tests/__init__.py
COPY backend/tests/support /mocks/tests/support
COPY fixtures/knowledge /mocks/fixtures/knowledge
USER mocks
