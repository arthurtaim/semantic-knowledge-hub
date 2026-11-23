"""Allow-listing HTTPS CONNECT proxy — the ONLY way out of the Claude worker's network.

The worker container sits on internal Docker networks only; the CLI reaches Anthropic through this proxy
(HTTPS_PROXY). Only `CONNECT <allowed host>:443` is tunnelled; anything else (other hosts, other ports, plain
HTTP, the server's own services) is refused with 403. The proxy sees only host names (TLS is end to end) and
logs allowed/denied host names, never content.

    EGRESS_ALLOWED_HOSTS=api.anthropic.com python -m claude_worker.egress_proxy
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import logging
import os
import re

logger = logging.getLogger("skh.egress_proxy")

_HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
_MAX_HEADER = 8192
_IDLE_TIMEOUT = 300.0


def parse_connect(head: bytes) -> tuple[str, int] | None:
    """`CONNECT host:port HTTP/1.x` → (host, port); None for anything else."""
    try:
        line = head.split(b"\r\n", 1)[0].decode("ascii")
    except UnicodeDecodeError:
        return None
    parts = line.split()
    if len(parts) != 3 or parts[0] != "CONNECT" or not parts[2].startswith("HTTP/1."):
        return None
    host, _, port = parts[1].rpartition(":")
    if not host or not port.isdigit():
        return None
    host = host.lower().rstrip(".")
    if not _HOST_RE.match(host):  # names only: no brackets, no userinfo
        return None
    with contextlib.suppress(ValueError):
        ipaddress.ip_address(host)
        return None  # IP literals (e.g. other services on the host) are never tunnelled
    return host, int(port)


def is_allowed(host: str, port: int, allowed: frozenset[str]) -> bool:
    return port == 443 and host in allowed


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await asyncio.wait_for(reader.read(65536), timeout=_IDLE_TIMEOUT):
            writer.write(data)
            await writer.drain()
    except (TimeoutError, ConnectionError, OSError):
        pass
    finally:
        with contextlib.suppress(Exception):
            writer.close()


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, allowed: frozenset[str]) -> None:
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, ConnectionError):
        writer.close()
        return
    target = parse_connect(head[:_MAX_HEADER])
    if target is None or not is_allowed(*target, allowed):
        logger.warning("egress denied: %s", f"{target[0]}:{target[1]}" if target else "non-CONNECT request")
        writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        with contextlib.suppress(Exception):
            await writer.drain()
        writer.close()
        return
    host, port = target
    try:
        up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=15)
    except (OSError, TimeoutError):
        logger.warning("egress upstream unreachable: %s:%d", host, port)
        writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        writer.close()
        return
    logger.info("egress allowed: %s:%d", host, port)
    writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    await writer.drain()
    await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer))


async def serve(host: str, port: int, allowed: frozenset[str]) -> None:
    server = await asyncio.start_server(lambda r, w: handle(r, w, allowed), host, port, limit=_MAX_HEADER)
    logger.info("egress proxy on %s:%d, allowed: %s", host, port, ", ".join(sorted(allowed)))
    async with server:
        await server.serve_forever()


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    allowed = frozenset(
        h.strip().lower()
        for h in os.environ.get("EGRESS_ALLOWED_HOSTS", "api.anthropic.com").split(",")
        if h.strip()
    )
    listen = os.environ.get("EGRESS_PROXY_HOST", "0.0.0.0")  # noqa: S104 - container-internal network only
    asyncio.run(serve(listen, int(os.environ.get("EGRESS_PROXY_PORT", "3128")), allowed))


if __name__ == "__main__":
    main()
