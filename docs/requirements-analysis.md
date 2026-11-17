# Requirements analysis

## Supplied PDC PDF

The six-page PDF requires a practical distributed application, not merely a local web page. The selected campus-maintenance system maps to its criteria as follows:

| PDF requirement | Implementation |
|---|---|
| At least three to four computers, each with a meaningful role | Four role-assigned laptops use the same application: requester, coordinator, technician, administrator/server. |
| Networked participation and actual information exchange | Browser clients call the central FastAPI REST API over LAN HTTP and receive authenticated WebSocket events. |
| Suitable distributed architecture | Centralized client/server, multi-tier architecture; clients do not connect to PostgreSQL. |
| Fully interactive transactions and feedback | Form submissions, review and assignment, repair notes, verification, live notifications, filters, status feedback. |
| Shared database and consistency | PostgreSQL on Laptop 4; SQLAlchemy transactions, FK constraints, unique active request work order, idempotency keys, row locking/version checks. |
| Failure and recovery challenge | Browser connection indicators and WebSocket backoff; requester IndexedDB outbox for unsent submissions; records remain on central database. Reconnected clients refetch server state. |
| Required architecture/network/database documentation | Mermaid diagrams and ERD in `architecture.md`; deployment and user instructions are separate docs. |
| Multi-computer demonstration and simultaneous work | A detailed physical demo checklist is in `testing.md`; it remains unperformed. |
| Three-title proposal | Not fabricated: the master prompt says the system was approved and says not to invent proposal/approval history. |

### PDF evaluation criteria

- Functionality/completeness (20%): requester-to-verification workflow and role dashboards.
- Distributed implementation (25%): four role computers, shared API, station heartbeat, and real data exchange.
- Communication (15%): REST over HTTP and WebSocket notification channel.
- Database and consistency (10%): normalized relational schema, FKs, transactions, idempotency, row/version conflict handling.
- UI (10%): responsive role-aware React/Tailwind dashboard.
- Documentation (10%): architecture, network, schema, deployment, user and test documentation.
- Presentation/defense (10%): demo and defense checklist; no claim that the live demonstration has occurred.

## Additional master-prompt requirements

The pasted master prompt expands the role permissions and maintenance lifecycle, asks for JWT/password hashing, persistent notifications, reporting/audit, image attachments, reconnection/outbox handling, Windows LAN deployment, automated tests, and technical-defense materials. Core application features are implemented and mapped in the user guide and architecture document.

## Explicit architecture clarification and intentional deviations

The pasted prompt requests separate local Python station services. The user's later explicit clarification says: build only **one** unified web application, not four separate systems or station services. This implementation follows that clarification: the four laptops are independent network clients with distinct role responsibilities, and Laptop 4 hosts the central application/API/database. The API records role-specific station heartbeats; it does not install a second local backend on Laptops 1–3.

## Scope and limitations

- LAN deployment is HTTP on a trusted local network. For real campus/public use, add HTTPS, secure cookie-based sessions, rate limits, retention/backup policy, and institutional identity management.
- There is one central API/database host and no failover.
- The requester offline outbox handles new reports and optional images. Other state-changing operations are online-only to prevent replaying stale assignments or verification decisions.
- A physical laptop demonstration and PostgreSQL-backed concurrency test are required before asserting those acceptance criteria are met.
