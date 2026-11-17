# User guide

## Sign in and accounts

- Requesters can register themselves; public registration always creates a requester account.
- Coordinator and technician accounts are created by the administrator. The administrator can disable/reactivate accounts from **Team & accounts**.
- Use the assigned account on its designated laptop. Do not share administrator credentials.
- Sign out with the top-right icon. The connection indicator reflects the live central WebSocket, while station heartbeat data is visible to the administrator.

## Requester — Laptop 1

1. Choose **Report an issue** or **New request**.
2. Enter a descriptive title, category, building, optional room, and issue details. Attach a JPEG/PNG/WebP photo up to 5 MB if useful.
3. Submit. The request is sent to the central server and becomes visible in the coordinator queue.
4. Track the request's status, priority, technician, and photos in **My requests**. Use **Cancel** only while its status is Pending.
5. Notifications arrive in the notification panel. If the central server is unreachable, the report and optional photo are saved in this browser's IndexedDB queue; reconnect and select **Sync now** or keep the app open. A queued report is not yet a central maintenance record.

## Coordinator — Laptop 2

1. Open **Request queue** and use search/status filters.
2. For a pending report, choose a priority and active technician.
3. Select **Approve & assign**, then enter optional remarks. The server validates that the report is still Pending and creates one work order in a transaction.
4. Select **Decline** and enter a reason to reject the report.
5. Use **Work orders** to monitor active jobs or select a different technician and **Save reassignment**.
6. Use **Reports** to filter by status, location, technician, and date range, then export CSV. Notifications and dashboard updates arrive in real time; refresh on reconnect obtains current server data.

## Technician — Laptop 3

1. Open **My work orders** and review the assignment, location, and priority.
2. Select **Accept assignment**. The server confirms that the assignment is still yours and moves it to In Progress.
3. Add a progress note and optionally attach a repair evidence photo.
4. **Save progress** records work; **Submit for review** moves the request to For Verification.
5. If an administrator returns the work, add follow-up notes and resubmit after completing the additional work.
6. Only the assigned technician can modify their work order. If offline, keep the page open and reconnect before submitting; technician mutations are not queued offline.

## Administrator — Laptop 4

1. Host the central FastAPI application and PostgreSQL database on this computer.
2. Use **Team & accounts** to provision roles and disable/reactivate accounts.
3. In **Team & accounts**, add maintenance categories and campus locations, or deactivate/reactivate options. Deactivated values are hidden from new-request forms; existing reports retain their original values.
4. Use **Verification** to inspect repair notes and evidence. **Verify repair** finalizes Completed; **Return for rework** sets Reopened and notifies the technician.
5. **Stations** shows last heartbeat and online/offline state. A station expires after 45 seconds.
6. **Reports** downloads a status/location-filtered CSV; **Audit trail** shows recorded workflow/account operations.

## Shared status vocabulary

`Pending → Assigned → In Progress → For Verification → Completed`

Exceptional statuses are `Rejected`, `Cancelled`, and `Reopened`. A returned repair can proceed `Reopened → In Progress → For Verification`. The API refuses unsupported transitions; the database is authoritative.
