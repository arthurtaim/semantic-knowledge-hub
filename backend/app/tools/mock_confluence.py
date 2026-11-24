"""Scenario controls of the MOCK Confluence corpus (synthetic pages only; never a real Confluence).

    python -m app.tools.mock_confluence status
    python -m app.tools.mock_confluence revoke 200121      # access revoked: the page disappears for everyone
    python -m app.tools.mock_confluence restore 200121
    python -m app.tools.mock_confluence delete 200116
    python -m app.tools.mock_confluence update 200115      # switch to the page's `next_version`
    python -m app.tools.mock_confluence reset

The running backend re-reads the state file when it changes. The state path comes from
CONFLUENCE_MOCK_STATE_PATH (same setting as the backend) or --state.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from app.adapters.corporate.mock import MockState, load_corpus
from app.config import Settings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scenario controls of the MOCK Confluence corpus.")
    parser.add_argument(
        "command", choices=["status", "revoke", "restore", "delete", "undelete", "update", "reset"]
    )
    parser.add_argument("page_id", nargs="?")
    parser.add_argument("--state", type=Path, default=None)
    parser.add_argument("--corpus", type=Path, default=None)
    args = parser.parse_args(argv)
    settings = Settings()
    state_path = args.state or settings.confluence_mock_state_file
    corpus_path = args.corpus or settings.confluence_mock_pages_file
    corpus = {p.page.page_id: p for p in load_corpus(corpus_path)}
    state = MockState.load(state_path)

    if args.command == "status":
        print(f"state: {state_path}  corpus: {len(corpus)} page(s) from {corpus_path}")
        print(
            f"revoked: {sorted(state.revoked)}\ndeleted: {sorted(state.deleted)}\nupdated: {sorted(state.updated)}"
        )
        return 0
    if args.command == "reset":
        MockState(set(), set(), set()).save(state_path)
        print("state reset")
        return 0
    if not args.page_id or args.page_id not in corpus:
        print(f"unknown page id {args.page_id!r}; corpus ids: {', '.join(sorted(corpus))}", file=sys.stderr)
        return 2
    page_id = args.page_id
    if args.command == "revoke":
        state.revoked.add(page_id)
    elif args.command == "restore":
        state.revoked.discard(page_id)
    elif args.command == "delete":
        state.deleted.add(page_id)
    elif args.command == "undelete":
        state.deleted.discard(page_id)
    elif args.command == "update":
        if corpus[page_id].next_version is None:
            print(f"page {page_id} has no next_version in the corpus", file=sys.stderr)
            return 2
        state.updated.add(page_id)
    state.save(state_path)
    print(f"{args.command} {page_id}: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
