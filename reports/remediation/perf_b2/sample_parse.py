"""Attribute leaf samples of a macOS `sample` call tree to interesting ancestor frames. Usage: sample_parse.py FILE"""
import re
import sys
from collections import Counter

LINE = re.compile(r"^(?P<prefix>[\s+!:|]*)(?P<count>\d+)\s+(?P<name>\S+)")
INTEREST = ("_pysqlite_step", "pysqlite_cursor_iternext", "pysqlite_connection_init", "connection_close",
            "sqlite3_open", "sqlite3_prepare", "sqlite3_step", "sqlite3_close", "take_gil", "drop_gil",
            "PyEval_RestoreThread", "PyEval_SaveThread", "_PyEval_EvalFrameDefault", "kevent", "sqlite3_exec",
            "unixLock", "unixShmLock", "walTryBeginRead", "sqlite3WalBeginReadTransaction", "pthread_mutex_lock",
            "sqlite3_mutex_enter", "pthreadMutexEnter", "sqlite3BtreeBeginTrans", "pager_wait_on_lock",
            "unixShmMap", "sqlite3OsSleep", "sqliteDefaultBusyCallback", "posixUnlock", "unixFileLock", "fcntl")
lines = open(sys.argv[1]).read().split("\n")
end = next((i for i, l in enumerate(lines) if l.startswith("Total number in stack")), len(lines))
stack: list[tuple[int, str, int]] = []
attributed = Counter()
for raw in lines[:end]:
    m = LINE.match(raw)
    if not m:
        continue
    depth = len(m.group("prefix"))
    count = int(m.group("count"))
    name = m.group("name")
    while stack and stack[-1][0] >= depth:
        stack.pop()
    stack.append((depth, name, count))
    # a leaf is a frame whose next line is not deeper — approximate: system leaves we care about
    if name.startswith("__psynch_mutexwait") or name.startswith("__psynch_cvwait") or name.startswith("__psynch_mutexdrop"):
        chain = [n for _, n, _ in stack]
        tags = [n for n in chain if n in INTEREST]
        attributed[(name, " > ".join(tags[-4:]))] += count
for (leaf, chain), n in attributed.most_common(25):
    print(f"{n:7d} {leaf:22s} {chain}")
