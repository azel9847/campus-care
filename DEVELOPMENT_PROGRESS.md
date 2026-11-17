# Development progress

## Phase 1 — Requirements and architecture

- [x] Inspected the empty workspace, supplied master prompt, and all six pages of `FINAL-PROJECT-PDC.pdf`.
- [x] Mapped the PDF's 3–4 computer, meaningful role, real network exchange, shared data consistency, interactive system, failure/recovery, documentation, and live-demo criteria.
- [x] Applied the explicit architecture clarification: one unified role-aware application on all laptops; Laptop 4 hosts the only FastAPI/PostgreSQL server.

## Phase 2 — Backend and data

- [x] FastAPI, SQLAlchemy, PostgreSQL driver, Alembic migrations, development SQLite mode.
- [x] JWT authentication, Argon2 password hashing, requester registration, administrator account creation and access disabling.
- [x] Request review/approval/rejection, priorities, work-order assignment/reassignment/acceptance, repair updates, verification/return.
- [x] Persistent role/user notifications, receipt-based read state, authenticated WebSockets, heartbeat registration, CSV, audit log.
- [x] Administrator-managed categories and campus locations with active/inactive catalog validation and request foreign keys.
- [x] Protected image upload/download, size/type validation, idempotent requester creation, row/version locking and unique work-order constraint.

## Phase 3 — Unified client and recovery behavior

- [x] Role-specific React dashboards and workflow controls, API-connected forms/tables/filters.
- [x] WebSocket reconnect with backoff and refresh-on-reconnect; authenticated per-role station heartbeat.
- [x] IndexedDB requester outbox with stable idempotency key; keep queued until server request and optional image are acknowledged.
- [x] Production frontend served by the central FastAPI service after Vite build.

## Phase 4 — Verification

- [x] Seven backend tests cover request deduplication, role enforcement, full work-order lifecycle, reassignment/transition conflicts, catalog administration/validation, WebSocket delivery/read receipts, station heartbeat, and attachment access/type checks.
- [x] Frontend TypeScript production build.
- [x] Dependency audit for production and full npm dependency tree.
- [ ] Execute four-laptop LAN demonstration, PostgreSQL-backed concurrent-assignment test, and physical disconnect/reconnect test. Hardware/network access was not available during this implementation; these are not claimed as completed.

## Phase 5 — Deployment and documents

- [x] Windows setup/start/admin scripts, example environment, LAN deployment guide, Mermaid architecture/communication diagrams and ERD.
- [x] Admin setup applies Alembic migrations before creating the first administrator.
- [x] Role user guide, PDF requirements analysis, testing/demo checklist, limitations.

## Known boundaries

- The central Laptop 4 API and database are a single point of failure; no HA/failover is implemented.
- Only requester report creation (and its optional image) is queued offline. Assignment, review, repair, and verification need server validation and require connectivity.
- Backend tests use in-memory SQLite; PostgreSQL row-lock behavior must still be exercised against the configured PostgreSQL instance.
- Physical multi-laptop testing and instructor demonstration remain to be performed by the project team.
