# CampusCare — Distributed Campus Maintenance System

CampusCare is one role-aware React/TypeScript web application backed by a central FastAPI service and PostgreSQL. Four laptops connect over the same LAN/Wi-Fi and work on one shared maintenance workflow:

1. **Requester laptop** — reports facility issues, tracks status, and receives repair updates.
2. **Coordinator laptop** — reviews/declines reports, prioritizes and assigns work, and reassigns active work orders.
3. **Technician laptop** — records repair progress and evidence, then submits work for verification.
4. **Administrator laptop** — hosts the API and PostgreSQL, manages accounts, monitors station heartbeats, and verifies or returns repairs.

This follows the requested architecture clarification: **one unified web application**, not separate local station services. Each role performs a different authenticated operation against the central API; REST writes are persisted in shared transactions and notifications are pushed to connected clients over authenticated WebSockets. The administrator computer is the server and therefore a single point of failure.

## What is implemented

- React 18, TypeScript, Vite, Tailwind CSS, Lucide icons, React Router.
- FastAPI REST API, SQLAlchemy, Alembic, PostgreSQL support, and SQLite for local development/tests.
- Argon2 password hashing, JWT login, requester-only public registration, backend role checks, admin-managed role accounts and account disabling.
- Request submission, optional image evidence, requester cancellation while pending, coordinator review/priority/assignment/reassignment, technician repair notes and evidence, admin verification or return for rework.
- Validated status transitions, optimistic versions, PostgreSQL row locks, unique one-work-order-per-request constraint, idempotent request retries.
- Authenticated WebSocket notifications persisted for later retrieval, per-user read receipts, reconnection, role station heartbeats, offline/online status.
- IndexedDB outbox for requester submissions (including an optional photo); server acknowledgement uses the stable idempotency key before the outbox entry is removed. Coordinator, technician, and administrator state-changing actions require a live server.
- Role dashboards, current-workload metrics, searchable/filterable requests, CSV export, station monitor, and administrator audit trail.
- Administrator-managed maintenance categories and campus locations, validated against every new request and retained for existing records when deactivated.
- Protected attachment downloads and image type/size checks (JPEG/PNG/WebP; 5 MB maximum).

## Quick start (Windows PowerShell)

Prerequisites on the central/admin laptop: Python 3.11+, Node.js 20+, and PostgreSQL 15+ installed locally. No cloud account is used.

```powershell
Set-Location C:\path\to\PARALLEL
.\scripts\setup.ps1
```

1. Create a PostgreSQL role and database on the admin laptop, then set the connection string in `backend\.env`. Keep PostgreSQL bound to the admin laptop only; other laptops connect to FastAPI, not port 5432.
2. Set `JWT_SECRET` to a unique random value. For example:

   ```powershell
   python -c "import secrets; print(secrets.token_urlsafe(48))"
   ```

3. Run `.\scripts\create-admin.ps1` and provide an administrator email, name, and password when prompted.
4. Run `.\scripts\start-central.ps1`. It applies Alembic migrations and binds FastAPI on `0.0.0.0:8000`. The production-built frontend is served by that same service.
5. Allow inbound TCP **8000** on the admin laptop's **Private** Windows Firewall profile. Find its LAN IP using `ipconfig`.
6. On each laptop, browse to `http://<ADMIN-LAPTOP-LAN-IP>:8000`. The administrator creates coordinator and technician accounts from **Team & accounts**; requester accounts may also self-register.
7. Assign one physical laptop and one account to each role. Keep all four computers connected to the same trusted Wi-Fi/LAN.

See [docs/deployment.md](docs/deployment.md) for PostgreSQL commands, exact setup/deployment, firewall, troubleshooting, and a development-mode option. See [docs/user-guide.md](docs/user-guide.md) for each role's workflow.

## Local verification

```powershell
Set-Location C:\path\to\PARALLEL\backend
.\.venv\Scripts\python.exe -m pytest -q

Set-Location C:\path\to\PARALLEL\frontend
npm run build
npm audit
```

The backend tests use an in-memory SQLite database and exercise the role-protected request-to-verification workflow, catalog administration and validation, idempotent retries, an authenticated WebSocket event, and protected image uploads. They are **not** a substitute for PostgreSQL concurrency testing or the required physical four-laptop demonstration. `create-admin.ps1` applies Alembic migrations before prompting for the first administrator.

## Project references

- [Requirements analysis](docs/requirements-analysis.md) — maps the supplied PDC PDF and master prompt to the implementation.
- [Architecture and data model](docs/architecture.md) — architecture and message-flow diagrams, database ERD, consistency decisions, limitations.
- [Deployment guide](docs/deployment.md) — Windows/PostgreSQL/four-laptop setup and recovery.
- [User guide](docs/user-guide.md) — requester, coordinator, technician, and administrator workflows.
- [Testing and demonstration plan](docs/testing.md) — verified local tests and an honest physical-demo checklist.
- [Development progress](DEVELOPMENT_PROGRESS.md) — delivered work and remaining external verification.

The initial three-title proposal is not recreated: the provided prompt says this project was already approved, and no earlier proposal documents were supplied.
