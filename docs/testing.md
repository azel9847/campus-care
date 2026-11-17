# Testing and final demonstration

## Local automated checks

Run from PowerShell:

```powershell
Set-Location C:\path\to\PARALLEL\backend
.\.venv\Scripts\python.exe -m pytest -q

Set-Location C:\path\to\PARALLEL\frontend
npm run build
npm audit
```

Backend tests use FastAPI TestClient with an isolated in-memory SQLite database and temporary uploads. They exercise:

- Request submission, idempotent lost-ack retry, and full review → assignment → repair note → admin verification workflow.
- Role permission denial, technician request visibility, stale review version rejection, duplicate assignment prevention, reassignment, and invalid transition rejection.
- Authenticated role-targeted WebSocket notification delivery, per-user read receipts, and station heartbeat visibility.
- Image upload/access control, protected download, and MIME/signature rejection.
- Administrator-managed category/location creation and deactivation, requester-visible catalog values, and rejection of inactive selections.
- Fresh Alembic migration and upgrade from the previous schema, including preservation of legacy catalog values.

Frontend verification is a strict TypeScript compile plus production Vite build. The dependency audit is run with npm. These are local software tests, not evidence of physical network or PostgreSQL concurrency testing.

## Testing status

- Backend local tests: 7 passed; one upstream Starlette/httpx deprecation warning remains.
- Frontend production build: passed. Full npm dependency audit: 0 vulnerabilities.
- Alembic fresh-database migration passed, and a populated legacy upgrade preserved request/work-order data and passed SQLite foreign-key checks. The configured PostgreSQL database is upgraded through revision `0004_catalog_fk`.
- PostgreSQL-backed transactions and concurrent coordinators: not executed in this workspace; use the configured PostgreSQL deployment.
- Four physical laptop LAN demo: not executed. Do not present it as completed until your team has performed it and captured evidence.

## Physical demo checklist (to perform, not a test claim)

1. Connect four separate laptops to one private Wi-Fi/LAN; note their host/client role and current IP.
2. Start PostgreSQL and the central FastAPI service on Laptop 4. Verify `/health` and sign in as administrator.
3. Start/open the central URL on Laptops 1, 2, and 3. Sign in with requester, coordinator, and technician accounts.
4. Submit a classroom projector report from Laptop 1 and show it arrive on Laptop 2 without a page refresh.
5. Approve with priority and technician assignment on Laptop 2. Show the work order arrive at Laptop 3.
6. Add a repair note/photo on Laptop 3 and submit for verification. Show Laptop 4's notification/work queue.
7. Verify on Laptop 4; show Completed status on Laptop 1.
8. Submit/process a second report concurrently with the first workflow. Confirm separate request/work-order IDs and no conflicting assignment.
9. Temporarily disconnect Laptop 3's Wi-Fi. Show its offline/reconnecting indicator, and show that the other clients and central records remain available.
10. Reconnect Laptop 3. Show automatic WebSocket reconnection, current work orders, and any missed persisted notifications.
11. Show the PostgreSQL records, admin station heartbeat view, and audit trail.
12. Record date, laptop identities, network conditions, screenshots/log excerpts, and any failed/repeated steps in the team's evidence. Do not include passwords or database secrets.

## PostgreSQL conflict/recovery checks for the team

- Have two coordinators submit approval at nearly the same time for one Pending request. Exactly one work order should be created; the other call should receive a conflict response.
- Retry the same requester operation with its same idempotency key and verify only one report exists.
- Disconnect a requester before submit, queue the report, reconnect, and confirm the queue clears only after server acknowledgement.
- Stop/restart the central API (not PostgreSQL) and verify clients reconnect and refresh persisted data.
- A PostgreSQL restart or Laptop 4 failure interrupts central operations; no failover is implemented.
