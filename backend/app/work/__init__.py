"""Native Work Management (M6): projects, tasks, subtasks, FS dependencies, scheduling, audit.

A module of the SKH monolith, not a second product (docs/WORK_MANAGEMENT.md):

- `calendar`    — Mon–Fri working-day arithmetic over half-open date intervals `[start, end_exclusive)`.
- `scheduler`   — pure DAG + Finish-to-Start forward scheduling (preview diff, conflicts, violations).
- `migrations`, `db` — the `work.sqlite3` schema, versioned by `PRAGMA user_version`, backup before migrating.
- `store`       — SQL over one connection (one transaction per unit of work; no ORM).
- `permissions` — the identity gate: local single operator / read-only exposure / project membership.
- `service`     — business invariants, optimistic locking, idempotency, append-only audit.
- `seed`        — idempotent synthetic demo projects (never touches user data).

Task↔document links (Step 4) and AI work proposals (Step 5) plug in next to `service`; the table for links
already exists (`work_task_links`), proposals get their own migration.
"""
