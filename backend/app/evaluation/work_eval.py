"""Deterministic M6 work evaluation (no network, no AI): `python -m app.evaluation.work_eval [--out DIR]`.

A fixed set of acceptance oracles of docs/WORK_MANAGEMENT.md, run against a throw-away work database and the
synthetic knowledge fixtures — the same services the API uses, no HTTP and no model:

- calendar and scheduler: Fri → Mon (M6-09), Mon + 2 working days ends Wed, FS chain, diamond shifts once (M6-28),
  locked successor blocks (M6-29), a disconnected branch is untouched, an unscheduled predecessor is a diagnostic,
  a milestone is a point (M6-10);
- writes: a cycle, a self and a cross-project dependency are refused without writes (M6-05/06/07), preview writes
  nothing (M6-30), a stale apply is 409 and writes nothing (M6-31), a replayed apply is one application (M6-32);
- demo seed (M6-22 and the 07 §2 contract): three synthetic projects, ≥ 30 tasks, 4 levels, all statuses, late and
  overdue work, milestones, FS chains, unscheduled tasks, no FS violation, `is_demo` everywhere, idempotent; the demo
  links point only at synthetic documents of the base and are idempotent;
- task ↔ document links: a hidden document leaks no id or title (M6-12), a changed revision is flagged (M6-24);
- AI plan validation without a model: a cycle or an unknown id is refused (M6-16), assignees / dates / invented sources
  never become data (M6-33), dates are the server's (Mon–Fri).

Prints one line per case and a summary; with `--out` writes `work-eval.json`. Exit code 1 when a case fails.
"""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from app.adapters.ai.work_protocol import RawSource, RawTask, WorkPlanReply
from app.adapters.knowledge.base import KnowledgeSnapshot
from app.adapters.knowledge.local import LocalKnowledgeRepository
from app.domain.models import UserContext
from app.errors import ApiError
from app.work import scheduler as sched
from app.work import store
from app.work.ai import plan_dates, validate_plan
from app.work.calendar import add_workdays, fs_earliest_start
from app.work.db import WorkDatabase
from app.work.links import DocumentScope
from app.work.models import (
    DependencyCreate,
    ProjectCreate,
    ScheduleApplyRequest,
    ScheduleMode,
    SchedulePreviewRequest,
    TaskCreate,
    TaskDateChange,
    TaskLinkCreate,
)
from app.work.permissions import WorkAccessGate, WorkAccessMode, WorkPrincipal
from app.work.seed import DEMO_LINKS, seed_demo, seed_demo_links
from app.work.service import WorkService

OPERATOR = UserContext(user_id="local-demo-user", display_name="eval", is_demo=True)
NOW = datetime(2026, 11, 25, 9, 0, tzinfo=UTC)
FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "knowledge"


@dataclass
class Case:
    id: str
    scenario: str
    title: str
    passed: bool = False
    detail: str = ""


class Eval:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.cases: list[Case] = []

    def service(self, name: str) -> WorkService:
        db = WorkDatabase(self.root / f"{name}.sqlite3")
        return WorkService(
            db, WorkAccessGate(WorkAccessMode.local_operator), operator=OPERATOR, now=lambda: NOW
        )

    def check(self, case_id: str, scenario: str, title: str, fn: Callable[[], str | None]) -> None:
        case = Case(case_id, scenario, title)
        try:
            problem = fn()
            case.passed, case.detail = problem is None, problem or ""
        except Exception as exc:  # a crash is a failed case, with its type
            case.detail = f"{type(exc).__name__}: {exc}"[:300]
        self.cases.append(case)


def principal(documents: DocumentScope | None = None) -> WorkPrincipal:
    return WorkPrincipal(user=OPERATOR, request_id="work-eval", documents=documents)


def _expect(condition: bool, message: str) -> str | None:
    return None if condition else message


def _refused(fn: Callable[[], Any], code: str) -> bool:
    try:
        fn()
    except ApiError as exc:
        return exc.code == code
    return False


def _snapshot(root: Path) -> KnowledgeSnapshot:
    import asyncio

    knowledge = root / "knowledge"
    if not knowledge.exists():
        shutil.copytree(FIXTURES, knowledge)
    repo = LocalKnowledgeRepository(
        knowledge, max_document_bytes=512_000, content_is_demo=True, refresh_seconds=0
    )
    return asyncio.run(repo.snapshot(OPERATOR))


# --- cases ---------------------------------------------------------------------------------------------------------
def calendar_cases(ev: Eval) -> None:
    friday = date(2026, 11, 27)
    ev.check(
        "cal-fri-mon",
        "M6-09",
        "FS after a Friday task starts on Monday",
        lambda: _expect(
            add_workdays(friday, 1) == date(2026, 11, 28)
            and fs_earliest_start(date(2026, 11, 28)) == date(2026, 11, 30),
            "Fri 1 day → [27, 28); successor ≠ Mon 30",
        ),
    )
    ev.check(
        "cal-mon-2",
        "M6-26",
        "Mon 30 + 2 working days ends (exclusive) on Wed 2 Dec",
        lambda: _expect(
            add_workdays(date(2026, 11, 30), 2) == date(2026, 12, 2), "end_exclusive ≠ 2026-12-02"
        ),
    )


def scheduler_cases(ev: Eval) -> None:
    def task(i: str, n: int, start: date | None, end: date | None, **kw: Any) -> sched.SchedTask:
        return sched.SchedTask(
            id=i,
            number=n,
            key=i,
            title=i,
            start=start,
            end=end,
            milestone=kw.get("milestone", False),
            locked=kw.get("locked", False),
            due=None,
            version=1,
        )

    mon = date(2026, 11, 30)
    tasks = {
        "A": task("A", 1, mon, date(2026, 12, 1)),
        "B": task("B", 2, date(2026, 12, 1), date(2026, 12, 2)),
        "C": task("C", 3, date(2026, 12, 1), date(2026, 12, 3)),
        "D": task("D", 4, date(2026, 12, 3), date(2026, 12, 4)),
        "X": task("X", 5, mon, date(2026, 12, 1)),
    }
    edges = [
        sched.SchedEdge(f"e{i}", a, b, 0)
        for i, (a, b) in enumerate([("A", "B"), ("A", "C"), ("B", "D"), ("C", "D")])
    ]

    def diamond() -> str | None:
        result = sched.plan(
            tasks,
            edges,
            mode=ScheduleMode.shift_successors,
            changes={"A": (date(2026, 12, 2), date(2026, 12, 3))},
        )
        ops = {o.task_id: o for o in result.operations}
        if "X" in ops:
            return "an independent task moved"
        d = ops.get("D")
        return _expect(
            d is not None and d.after.start_date == date(2026, 12, 7), f"D after = {d.after if d else None}"
        )

    ev.check("sched-diamond", "M6-28", "Diamond A→B/C→D: D shifts once to the max; X untouched", diamond)

    def locked() -> str | None:
        locked_tasks = dict(tasks, B=task("B", 2, date(2026, 12, 1), date(2026, 12, 2), locked=True))
        result = sched.plan(
            locked_tasks,
            edges,
            mode=ScheduleMode.shift_successors,
            changes={"A": (date(2026, 12, 2), date(2026, 12, 3))},
        )
        return _expect(
            any(c.code == "locked_successor" for c in result.conflicts) and not result.can_apply,
            "no locked conflict",
        )

    ev.check("sched-locked", "M6-29", "A locked successor makes the preview a conflict", locked)

    def unscheduled() -> str | None:
        tasks_u = dict(tasks, A=task("A", 1, None, None))
        result = sched.plan(tasks_u, edges, mode=ScheduleMode.resolve_violations, changes={})
        return _expect(
            any(b.reason == "predecessor_unscheduled" for b in result.blocked),
            "no predecessor_unscheduled diagnostic",
        )

    ev.check(
        "sched-unscheduled", "M6-27", "An unscheduled predecessor is a diagnostic, not a date", unscheduled
    )


def write_cases(ev: Eval) -> None:
    svc = ev.service("writes")
    p = principal()
    project = svc.create_project(p, ProjectCreate(key="EVAL", title="Оценка"))
    other = svc.create_project(p, ProjectCreate(key="OTHR", title="Другой"))
    a = svc.create_task(p, "EVAL", TaskCreate(title="A", start_date=date(2026, 11, 27), duration_workdays=1))
    b = svc.create_task(p, "EVAL", TaskCreate(title="B", start_date=date(2026, 11, 30), duration_workdays=1))
    foreign = svc.create_task(p, "OTHR", TaskCreate(title="Чужая"))
    milestone = svc.create_task(
        p, "EVAL", TaskCreate(title="Веха", is_milestone=True, start_date=date(2026, 12, 1))
    )
    svc.add_dependency(p, b.id, DependencyCreate(predecessor_task_id=a.id))

    def audit() -> int:
        with svc.db.read() as conn:
            return store.count_audit(conn)

    ev.check(
        "write-milestone",
        "M6-10",
        "A milestone is a zero-duration point",
        lambda: _expect(
            milestone.start_date == milestone.end_exclusive and milestone.duration_workdays == 0,
            str(milestone),
        ),
    )

    def refusals() -> str | None:
        before = audit()
        cycle = _refused(
            lambda: svc.add_dependency(p, a.id, DependencyCreate(predecessor_task_id=b.id)),
            "dependency_cycle",
        )
        self_dep = _refused(
            lambda: svc.add_dependency(p, a.id, DependencyCreate(predecessor_task_id=a.id)),
            "invalid_dependency",
        )
        cross = _refused(
            lambda: svc.add_dependency(p, a.id, DependencyCreate(predecessor_task_id=foreign.id)),
            "invalid_dependency",
        )
        return _expect(
            cycle and self_dep and cross and audit() == before, f"cycle={cycle} self={self_dep} cross={cross}"
        )

    ev.check(
        "write-refusals",
        "M6-05/06/07",
        "Cycle, self and cross-project dependencies refused, nothing written",
        refusals,
    )

    def preview_apply() -> str | None:
        before = (audit(), svc.get_project(p, "EVAL").plan_revision)
        preview = svc.preview(
            p,
            "EVAL",
            SchedulePreviewRequest(
                changes=[TaskDateChange(task_id=a.id, start_date=date(2026, 12, 2), duration_workdays=1)]
            ),
        )
        if (audit(), svc.get_project(p, "EVAL").plan_revision) != before:
            return "preview wrote something"
        svc.create_task(p, "EVAL", TaskCreate(title="Между предпросмотром и применением"))
        stale = _refused(
            lambda: svc.apply(
                p,
                "EVAL",
                ScheduleApplyRequest(
                    preview_id=preview.preview_id,
                    expected_plan_revision=preview.base_plan_revision,
                    client_request_id="eval-stale-1",
                ),
            ),
            "stale_schedule",
        )
        fresh = svc.preview(
            p,
            "EVAL",
            SchedulePreviewRequest(
                changes=[TaskDateChange(task_id=a.id, start_date=date(2026, 12, 2), duration_workdays=1)]
            ),
        )
        body = ScheduleApplyRequest(
            preview_id=fresh.preview_id,
            expected_plan_revision=fresh.base_plan_revision,
            client_request_id="eval-apply-1",
        )
        first = svc.apply(p, "EVAL", body)
        events = audit()
        second = svc.apply(p, "EVAL", body)
        return _expect(
            stale
            and not first.replayed
            and second.replayed
            and audit() == events
            and second.plan_revision == first.plan_revision,
            f"stale={stale} replayed={second.replayed}",
        )

    ev.check(
        "write-preview-apply",
        "M6-30/31/32",
        "Preview writes nothing; stale apply 409; replay is one application",
        preview_apply,
    )
    _ = (project, other)


def seed_cases(ev: Eval, snapshot: KnowledgeSnapshot) -> None:
    db = WorkDatabase(ev.root / "seed.sqlite3")
    first = seed_demo(db, now=NOW, timezone="Europe/Moscow")

    def document(doc_id: str) -> tuple[str, str] | None:
        doc = snapshot.get(doc_id)
        return (doc.id, doc.revision) if doc is not None else None

    links = seed_demo_links(db, document=document, now=NOW)
    svc = WorkService(db, WorkAccessGate(WorkAccessMode.local_operator), operator=OPERATOR, now=lambda: NOW)
    scope = DocumentScope.from_snapshot(snapshot, "eval")
    p = principal(scope)
    projects = svc.list_projects(p).items
    tasks = [t for pr in projects for t in svc.gantt(p, pr.key).tasks]

    def contract() -> str | None:
        statuses = {t.status.value for t in tasks}
        gantts = [svc.gantt(p, pr.key) for pr in projects]
        problems = []
        if len(projects) < 3 or len(tasks) < 30:
            problems.append(f"{len(projects)} projects / {len(tasks)} tasks")
        if max(t.depth for t in tasks) < 4:
            problems.append("no 4-level nesting")
        if statuses != {"todo", "in_progress", "review", "done"}:
            problems.append(f"statuses {sorted(statuses)}")
        if sum(t.is_milestone for t in tasks) < 3:
            problems.append("fewer than 3 milestones")
        if not any(t.late or t.overdue for t in tasks):
            problems.append("no delayed work")
        if not any(not t.scheduled for t in tasks):
            problems.append("no unscheduled task")
        if any(g.violations for g in gantts) or not all(g.dependencies for g in gantts):
            problems.append("FS violations or a project without chains")
        if not all(pr.is_demo for pr in projects) or not all(t.is_demo for t in tasks):
            problems.append("missing is_demo")
        if len({t.assignee_id for t in tasks if t.assignee_id}) < 3:
            problems.append("fewer than 3 fixture assignees")
        return "; ".join(problems) or None

    ev.check(
        "seed-contract",
        "07 §2",
        "Three synthetic projects, ≥30 tasks, 4 levels, statuses, delays, milestones, chains",
        contract,
    )

    def idempotent() -> str | None:
        again = seed_demo(db, now=NOW, timezone="Europe/Moscow")
        links_again = seed_demo_links(db, document=document, now=NOW)
        with db.read() as conn:
            count = conn.execute("SELECT COUNT(*) FROM work_tasks").fetchone()[0]
            link_count = conn.execute("SELECT COUNT(*) FROM work_task_links").fetchone()[0]
        expected = sum(len(v) for v in DEMO_LINKS.values())
        return _expect(
            not again.created
            and count == first.tasks_created
            and links_again.created == 0
            and link_count == links.created == expected,
            f"tasks {count}/{first.tasks_created}, links {link_count} (created {links.created}, expected {expected})",
        )

    ev.check("seed-idempotent", "M6-22", "Seed and demo links twice: no duplicates", idempotent)

    def synthetic_links() -> str | None:
        with db.read() as conn:
            ids = [r[0] for r in conn.execute("SELECT document_id FROM work_task_links")]
        bad = [i for i in ids if (doc := snapshot.get(i)) is None or not doc.is_demo]
        return _expect(not bad and len(ids) >= 10, f"non-synthetic or missing: {bad}")

    ev.check(
        "seed-links", "07 §2", "Demo links point only at synthetic documents of the base", synthetic_links
    )


def link_cases(ev: Eval, snapshot: KnowledgeSnapshot) -> None:
    svc = ev.service("links")
    full = principal(DocumentScope.from_snapshot(snapshot, "eval"))
    svc.create_project(full, ProjectCreate(key="LNK", title="Ссылки"))
    t = svc.create_task(full, "LNK", TaskCreate(title="Задача"))
    created = svc.link_document(full, t.id, TaskLinkCreate(document_id="DEMO-INT-002"))
    hidden_docs = {k: v for k, v in snapshot.documents.items() if k != "demo-int-002"}
    guest = principal(DocumentScope(available=True, documents=hidden_docs, generation="eval"))

    def hidden() -> str | None:
        links = svc.task_links(guest, t.id)
        dump = links.model_dump_json()
        item = links.items[0]
        detail = svc.get_task(guest, t.id)
        return _expect(
            item.state == "unavailable"
            and item.document is None
            and "DEMO-INT-002" not in dump
            and detail.link_count == 0,
            f"state={item.state} leaked={'DEMO-INT-002' in dump}",
        )

    ev.check("links-hidden", "M6-12/M6-34", "A hidden document leaks no id, title or count", hidden)

    def changed() -> str | None:
        doc = snapshot.get("DEMO-INT-002")
        assert doc is not None
        moved = dict(snapshot.documents)
        moved["demo-int-002"] = doc.model_copy(update={"revision": doc.revision + "-next"})
        now_scope = principal(DocumentScope(available=True, documents=moved, generation="eval"))
        item = svc.task_links(now_scope, t.id).items[0]
        return _expect(
            item.state == "revision_changed" and item.revision_at_link == created.revision_at_link, item.state
        )

    ev.check("links-revision", "M6-24", "A changed revision is flagged, never re-approved", changed)


def ai_cases(ev: Eval, snapshot: KnowledgeSnapshot) -> None:
    refs = {
        d.id.lower(): d for d in (snapshot.get("DEMO-INT-002"), snapshot.get("SEM-ARCH-001")) if d is not None
    }

    def reply(deps: list[tuple[str, str]], **first: Any) -> WorkPlanReply:
        base = RawTask("t1", "Первая", "", 2, "high", False, None, [RawSource("DEMO-INT-002", "")])
        for key, value in first.items():
            setattr(base, key, value)
        return WorkPlanReply("цель", [base, RawTask("t2", "Вторая", "", 1, "medium", False, None)], deps)

    ev.check(
        "ai-cycle",
        "M6-16",
        "A cyclic plan is refused",
        lambda: _expect(
            _refused(
                lambda: validate_plan(reply([("t1", "t2"), ("t2", "t1")]), refs, {}, 0), "proposal_invalid"
            ),
            "accepted",
        ),
    )
    ev.check(
        "ai-unknown-id",
        "M6-16",
        "A dependency on an unknown local id is refused",
        lambda: _expect(
            _refused(lambda: validate_plan(reply([("t1", "t9")]), refs, {}, 0), "proposal_invalid"),
            "accepted",
        ),
    )

    def hallucinations() -> str | None:
        tasks, _deps, issues = validate_plan(
            reply([], ignored=["assignee", "dates"], sources=[RawSource("SEC-HIDDEN-001", "x" * 20)]),
            refs,
            {},
            0,
        )
        codes = {i.code for i in issues}
        leaked = any(s["document_id"] == "SEC-HIDDEN-001" for t in tasks for s in t.sources)
        return _expect(
            {"assignee_ignored", "dates_ignored", "unknown_source"} <= codes and not leaked,
            str(sorted(codes)),
        )

    ev.check(
        "ai-hallucinations",
        "M6-33",
        "Assignees, dates and invented sources never become data",
        hallucinations,
    )

    def dates() -> str | None:
        tasks, deps, _ = validate_plan(reply([("t1", "t2")]), refs, {}, 0)
        planned, _ = plan_dates(tasks, deps, date(2026, 11, 27))
        return _expect(
            planned["t1"] == (date(2026, 11, 27), date(2026, 12, 1))
            and planned["t2"] == (date(2026, 12, 1), date(2026, 12, 2)),
            str(planned),
        )

    ev.check("ai-dates", "M6-09/M6-13", "Plan dates are the server's (Mon–Fri, FS)", dates)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Deterministic M6 work evaluation (no network, no AI).")
    parser.add_argument("--out", type=Path, default=None, help="directory for work-eval.json")
    args = parser.parse_args(argv)
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="skh-work-eval-") as tmp:
        ev = Eval(Path(tmp))
        snapshot = _snapshot(Path(tmp))
        calendar_cases(ev)
        scheduler_cases(ev)
        write_cases(ev)
        seed_cases(ev, snapshot)
        link_cases(ev, snapshot)
        ai_cases(ev, snapshot)
    elapsed = time.perf_counter() - started
    for case in ev.cases:
        mark = "PASS" if case.passed else "FAIL"
        print(
            f"{mark} {case.id:<20} {case.scenario:<14} {case.title}"
            + (f" — {case.detail}" if case.detail else "")
        )
    passed = sum(c.passed for c in ev.cases)
    summary = (
        f"[work-eval] cases={len(ev.cases)} pass={passed} fail={len(ev.cases) - passed} seconds={elapsed:.2f}"
    )
    print(summary)
    if args.out is not None:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "work-eval.json").write_text(
            json.dumps(
                {
                    "summary": {"cases": len(ev.cases), "passed": passed, "failed": len(ev.cases) - passed},
                    "machine": f"{platform.system()} {platform.machine()} Python {platform.python_version()}",
                    "cases": [case.__dict__ for case in ev.cases],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    return 0 if passed == len(ev.cases) else 1


if __name__ == "__main__":
    raise SystemExit(main())
