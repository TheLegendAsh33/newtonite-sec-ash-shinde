# Engineering decisions

This is a reliable first version of an internal operations tool. The design prioritizes ownership, safe concurrent changes, and an explainable history. The expected scale in the brief is a design target, not a load-test result.

## 1. A relational core and a small deployment boundary

Work items, team memberships, owners, history, and retry records have relationships that require consistent writes. PostgreSQL with SQLAlchemy keeps those relationships in one transactional database; Alembic records schema changes. UUID identifiers avoid exposing sequential record numbers. A unique team/user membership and a unique user/idempotency-key pair enforce important invariants in the database.

Next.js and TypeScript provide the interactive browser UI; FastAPI and Pydantic provide typed, validated HTTP endpoints. SQLite is a low-setup development and API-test option; the reviewer Docker stack and browser CI use PostgreSQL. Production explicitly requires PostgreSQL so SQLite is not accidentally deployed as the shared database.

Docker Compose runs PostgreSQL, Redis, FastAPI, Next.js, and Caddy on one host. Database and Redis ports are private; the browser uses the same-origin `/api` route through Caddy. This is straightforward to reproduce and operate for the challenge, with a clear trade-off: a single host is a failure domain. Multiple hosts would require managed/shared data services and a separate one-time migration step before API replicas roll out.

## 2. Team membership is the authorization boundary

Roles belong to a `(team, user)` membership, so Morgan can be an admin in Support Operations and a lead in Payments. A member can read, create, comment, claim unassigned work, and edit work they own. Leads and admins can edit team work and reassign an owner to another team member. Lead and admin deliberately share the same work-item permissions; there is no administrative UI to imply broader capabilities.

Every item request checks membership in the API. Work in another team returns 404, avoiding disclosure of its existence. A forbidden mutation within a visible team returns 403. The UI reflects permissions, but requests from an altered browser are checked again. The CLI provisions accounts and memberships; a public self-registration flow would be a poor default for an internal tool.

Passwords use salted PBKDF2 hashes. Signed HTTP-only, SameSite=Lax cookies expire after 12 hours; TLS deployments require secure cookies. Sessions carry identity rather than trusted role claims, so API requests use current database membership. Production requires a long random session secret and Redis-backed sign-in throttling. Local accounts provide an easy reviewer experience; SSO, account recovery, session revocation management, and a formal organization security policy remain future integration work.

## 3. Compare-and-set writes resolve concurrent work deliberately

Each work item has an integer version. A PATCH supplies `expected_version`; a single SQL update matches the item and version and increments the version atomically. A stale form receives 409 even if its proposed values happen to equal the current row. The client reloads the latest server state and asks the user to review it. This avoids holding database locks while someone reads a form, with the trade-off that the user must reconcile their intended change after a conflict.

Claiming is a dedicated operation whose conditional update also requires `owner_id IS NULL`. Two users racing cannot both acquire the item: one update succeeds, the other receives 409, and only the winner writes the claim history event. Workflow rules are enforced server-side: `open → in_progress`; `in_progress → blocked / in_review / done`; `blocked → in_progress`; `in_review → in_progress / done`. Done is terminal. `in_review` signals a review stage; it does not enforce an independent approver or regulated approval policy.

Creating an item requires a user-scoped `Idempotency-Key`. The canonical request hash, original response, new item, and creation event commit together. An identical retry returns the original response; different content with the same key returns 409. The frontend retains its key through a failed create attempt. Unique constraints resolve races between simultaneous duplicate requests. This intentionally covers creation; repeating a comment can create a second note, while edits and claims are guarded by versions. Retaining keys indefinitely makes late retries safe at the cost of storage growth; a future retention window must match the client retry contract.

## 4. Bounded reads and server truth keep the UI understandable

Queue search, filters, total counts, ordering, and pagination run in SQL. API page sizes are bounded; the browser does not fetch all work items. Team/status/priority/owner indexes support common views, and owner/creator users are fetched in a batch for a queue page. Search treats `%` and `_` as literal text, avoiding accidental SQL wildcard searches. A stable item-ID tie-breaker makes identical timestamps deterministic.

The frontend keeps view state locally and adopts the server result after writes. The team diagram shows counts for the complete team; the visible queue is filtered and paginated. Graphical representations explain status without granting permissions or changing workflow rules. Item details derive visited states from available history so a direct move from in-progress to done does not claim an unseen review step occurred. Older history is fetched on demand through a stable timestamp/ID cursor; the graph describes loaded evidence and current status rather than inventing missing history.

Dates represent instants: the API requires timezone-aware datetime input, normalizes it to UTC, and exposes an optional `due_at` on each item. The browser converts its local date/time form value to UTC and formats the live clock, created/updated dates, activity, and recorded workflow-stage times in the user's local timezone. This avoids interpreting an offset-free client time differently on the server. Migration `0003_deadlines` in `0003_work_item_deadlines.py` preserves existing items with a nullable deadline. Timezone follows the OS/browser, with no selector; nonexistent spring daylight-saving times are rejected, and a newly entered repeated autumn time resolves to the earlier occurrence. Unchanged deadlines preserve their exact stored instant when another field is saved.

Owners and team leads/admins can set, change, or clear deadlines through the existing versioned edit path; a deadline change and its audit record commit together. Browser indicators classify active items due within 24 hours as due soon and active items past their deadline as overdue; done items are exempt. Relative labels and warnings recalculate every 30 seconds; the workspace clock ticks each second. The API's `deadline` filters (`overdue`, `due_soon`, `scheduled`, `none`) use server time and retain normal bounded SQL pagination; the browser refreshes time-sensitive filtered results every 60 seconds. An inaccurate browser clock can therefore differ from server filtering. There is no scheduler, notification delivery guarantee, or automatic workflow transition. A future reminder system would need an authoritative server schedule and the outbox delivery model in decision 5.

Offset pagination and substring matching are easy to explain and sufficient for a bounded first release, but deep offsets and broad substring queries get expensive. PostgreSQL trigram/full-text indexes, keyset queue pagination, and measured load testing are the next steps for tens of thousands of items and high concurrency. The design does not claim that its target load has been demonstrated. Push updates and automatic merging are deferred; explicit refresh and version conflicts preserve correctness with less moving state.

## 5. Audit events commit with the action; secondary work is deferred

Creation, claims, edits, and comments append events containing the actor, timestamp, type, and details. Item updates and their corresponding history rows share one transaction, so a successful operation cannot silently omit its audit record. Comments update recency but do not increment the content version, avoiding an unrelated edit conflict when someone adds a note. The API does not expose history mutation or deletion; this is an application audit trail, not tamper-proof regulatory storage.

No background notification or enrichment worker is needed for the primary workflow. Introducing a queue would require delivery semantics, retries, poison-message handling, and operational ownership without improving the item's transactional correctness. If notifications become a requirement, I would write a transactional outbox event with the item change and process it with an idempotent consumer, bounded retries, and an observable failure queue.

History and idempotency records currently have no archival policy. Retention, off-host encrypted backups, restore drills, centralized monitoring, SSO, formal approval controls, and capacity testing need the organization's requirements. Container health/readiness checks, request IDs with structured logs, backup/restore scripts, and migrations provide a concrete foundation without claiming enterprise completeness.

## Risk-focused verification

API tests exercise the dangerous boundaries: stale versions, simultaneous claims, invalid transitions, resource authorization, search/filter/pagination, idempotent creates, and the edge cases around history cursors, literal search, validation, and stale no-op submissions. The Chromium suite adds independent employee sessions and asserts both browser outcomes and stored server state. It runs against disposable PostgreSQL/Redis in CI; a Windows PowerShell SQLite fallback supports environments without Docker.

The browser report presents named steps, screenshots, API outcomes, and retained failure traces. CI uploads report artifacts so a reviewer can inspect evidence instead of relying on a stated coverage percentage. Exact run results should be taken from the current CI run or generated report, rather than a static claim in documentation.

## With another week

First measure PostgreSQL query plans and realistic concurrent traffic, add account/session administration, and integrate centralized logs and alerts. Then validate requirements for review approvals, notifications, retention, and SSO with the operations team. Those requirements determine whether to add an outbox worker, organization-specific approval gates, and archival storage; they should not be guessed from a status label.
