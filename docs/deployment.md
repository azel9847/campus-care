# Windows LAN deployment

## 1. Prepare the central (Laptop 4) computer

Install Python 3.11 or newer, Node.js 20 or newer, and PostgreSQL 15 or newer. Keep all computers on the same trusted private network.

From the project directory:

```powershell
.\scripts\setup.ps1
Copy-Item .env.example backend\.env
notepad backend\.env
```

Edit `DATABASE_URL` and `JWT_SECRET`. Do not reuse the sample secret or commit `backend\.env`.

Create a PostgreSQL database and login on Laptop 4 (use `psql` as a PostgreSQL administrator):

```sql
CREATE ROLE campuscare LOGIN PASSWORD 'replace-with-a-strong-database-password';
CREATE DATABASE campuscare OWNER campuscare;
```

Keep PostgreSQL local to Laptop 4. The example `DATABASE_URL` uses `127.0.0.1` because the API and PostgreSQL run on the same computer. Do not expose port 5432 to the client laptops.

## 2. Create the first administrator and start the central application

```powershell
.\scripts\create-admin.ps1
.\scripts\start-central.ps1
```

`start-central.ps1` runs `alembic upgrade head`, then starts one Uvicorn worker on `0.0.0.0:8000`. One worker is intentional: live WebSocket connections are held in the API process. The Vite production build is served from FastAPI's same origin.
`create-admin.ps1` also applies migrations before prompting for the first administrator, so it is safe to use before starting the API.

The `scripts\setup.ps1` command builds the frontend. Re-run it after frontend source changes. The central server health check is `http://127.0.0.1:8000/health`; API docs are at `http://127.0.0.1:8000/docs`.

## 3. Windows Firewall and LAN address

On Laptop 4, run PowerShell as Administrator and create a Private-profile firewall rule:

```powershell
New-NetFirewallRule -DisplayName "CampusCare FastAPI" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
```

Find the host IP with `ipconfig` (choose the active Wi-Fi/Ethernet IPv4 address). Other laptops use:

```text
http://<LAPTOP-4-LAN-IP>:8000
```

Do not use `localhost` from Laptops 1–3. The server binds to all interfaces; the firewall limits which networks should be allowed to connect. Use only a trusted campus LAN. For development on a shared LAN, set `CORS_ORIGINS` to the exact Vite browser origin(s), e.g. `http://<LAPTOP-4-LAN-IP>:5173`; do not use `*` with credentials.

## 4. Assign the four physical computers

1. **Laptop 4 / Administrator:** sign in with the first admin account; use **Team & accounts** to create at least one coordinator and one technician account. Requesters can register from the sign-in page.
2. **Laptop 1 / Requester:** open the shared LAN URL and sign in as a requester.
3. **Laptop 2 / Coordinator:** open the same URL and sign in as a coordinator.
4. **Laptop 3 / Technician:** open the same URL and sign in as a technician.
5. **Laptop 4 / Administrator:** keep its own admin browser session open for account administration, station health, audit, reports, and verification.

These are role-specific clients of the one application. Only Laptop 4 hosts FastAPI and PostgreSQL. Laptops 1–3 do not run local station backends.

## 5. Optional development mode

For frontend development on Laptop 4, keep the central API running and start Vite:

```powershell
.\scripts\start-vite.ps1
```

Open `http://<LAPTOP-4-LAN-IP>:5173` from the client laptops. Vite proxies REST and WebSocket traffic to the central FastAPI process. Allow inbound TCP 5173 on Private profile only while developing. For a final demo, build and serve the frontend through FastAPI on port 8000 instead.

## Environment variables

`backend\.env` reads the root `.env.example` fields:

| Setting | Meaning |
|---|---|
| `DATABASE_URL` | SQLAlchemy PostgreSQL URL; SQLite is the local/test default when omitted. |
| `JWT_SECRET` | Unique high-entropy signing secret. Production refuses the development fallback. |
| `JWT_EXPIRE_MINUTES` | JWT lifetime (default 480 minutes). |
| `CORS_ORIGINS` | Comma-separated exact browser origins; same-origin production requires no cross-origin access. |
| `ENVIRONMENT` | `development` locally; set to `production` to require a real JWT secret. |
| `UPLOAD_DIR` | Optional path for centrally stored evidence; default is `backend\uploads`. |

Changing the central host's LAN IP does not require code changes; browsers connect to the URL used to open the app.

## Operations, failure, and recovery

- `/health` checks FastAPI process availability. It does not currently probe PostgreSQL.
- Client WebSockets reconnect with backoff. On reconnect, the browser refreshes dashboard/notifications and retries the request outbox.
- Requester outbox entries are saved in that browser's IndexedDB and display as pending synchronization. A stable key prevents duplicate requests when the server committed but the acknowledgement was lost.
- Other state-changing operations remain online-only because assignments and verification need current server validation.
- If Laptop 4 is shut down, no other laptop can create authoritative shared records or connect to the database. Restart PostgreSQL and the API on Laptop 4; the server loads the durable database and clients reconnect. This topology has no server failover.
- Back up PostgreSQL and the `backend\uploads` directory together. They are both on the central host.

## Troubleshooting

| Symptom | Check |
|---|---|
| Browser cannot open URL | Verify all laptops use the same network, the admin IP from `ipconfig` is current, FastAPI is running, and TCP 8000 is allowed on the Private firewall profile. |
| Sign-in loads but API calls fail | Check `backend\.env`, `DATABASE_URL`, PostgreSQL service, and `http://<server>:8000/health`. |
| Dashboard shows reconnecting | Check central server reachability; inspect Uvicorn output. WebSocket uses the same host/port under `/api/ws`. |
| Coordinator/technician account cannot sign in | Admin must create an enabled account and distribute the password privately. Public registration creates requester role only. |
| Request remains pending synchronization | Reconnect the requester laptop to the LAN, keep the app open, and use **Sync now**; do not clear site data before it is acknowledged. |
| No station status listed | A user must be signed in and the browser must be open; heartbeats expire after 45 seconds. |
| Production page shows 404 | Run `npm run build` in `frontend` and restart FastAPI so `frontend\dist` exists. |
| Attachment is not available | Ensure the central `UPLOAD_DIR` is writable and backed up; a missing server file returns an explicit unavailable response. |
