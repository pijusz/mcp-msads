# Pre-production hardening design

## Goal

Make `mcp-msads` safe to connect to production credentials by fixing every confirmed review finding without introducing a generated API layer, compatibility shims, or broad refactors.

Production API validation is not part of this change. The completed implementation must be hermetically verifiable without Microsoft Advertising credentials and must leave a conservative, explicit live-validation path for later.

## Principles

- Keep the current REST/JSON architecture and existing service/tool boundaries.
- Prefer direct validation at the boundary over generic frameworks.
- Add shared helpers only where multiple call sites need identical behavior.
- Treat MCP annotations as a security boundary, not documentation.
- Never expose reusable credentials in model context.
- Never retry an ambiguous mutation unless the operation is explicitly known to be safe.
- Bound memory and output before parsing or serialization, not only after it.
- Keep all new entities paused unless activation is explicitly requested.

## 1. Credential and test isolation

Before implementation verification, move the newest working token file to an owner-only path outside the checkout and update the ignored local environment to reference it without printing credential values. Remove both token files from tracking, ignore token-file variants, and purge their blobs from local Git history. Because no remote is configured, this is the least disruptive time to rewrite history.

Setup will default to the platform config directory rather than the checkout and reject an in-repository output path unless the operator explicitly overrides the guard. Neither setup nor runtime will persist access tokens. The Google credential import will enforce owner-only permissions on `.env`. CI will scan tracked files for token-shaped JSON fields and known refresh-token patterns so the disclosure cannot recur.

The implementation cannot revoke provider grants without interactive account access. It will make the repository safe, preserve the newest local token outside the checkout, and document that the existing sandbox grants should be revoked and re-consented before the repository is shared.

The default test command will target only non-live files and start every MCP subprocess with an explicit credential-deny environment. A shared isolated-client helper will replace the two divergent subprocess helpers. Tests will fail on unexpected real network access and verify that a sentinel token file is unchanged.

Live tests remain reachable only through `test:live` and retain explicit account and write gates.

## 2. HTTP and token safety

### Retry classification

`msadsFetch` will distinguish safe retries from mutation calls. Authentication error 109 remains replayable because the API rejected authentication. POST reads and explicitly safe polling operations may retry transient failures. Mutation calls default to no ambiguous network/5xx replay. Call sites will state retry safety rather than inferring it only from the HTTP verb, because Microsoft uses POST for reads.

### Token persistence

Token writes will use one small secure-file helper:

1. create a same-directory temporary file with mode `0600`;
2. write and sync it;
3. atomically rename it over the destination;
4. enforce final mode `0600`.

A lock file acquired with exclusive creation will serialize refresh-token read/refresh/write across local processes. Acquisition has a short bounded wait; a lock is recoverable only when its recorded owner no longer exists or its timestamp exceeds the documented stale threshold. Release always runs in `finally`. After acquiring the lock, the process re-reads the token before refreshing so a newer rotation is not overwritten. The secure writer fsyncs the file and parent directory around atomic rename and retains a permissioned recovery copy until the new token is durable.

Token endpoint calls, CAPI calls, bulk uploads, and result downloads will all have explicit timeouts.

### Outbound result URLs

Every API-returned URL and redirect hop must use HTTPS and resolve only to public addresses; loopback, private, link-local, and metadata destinations are rejected after each fresh DNS resolution. Requests use manual redirects and revalidate each hop. Credential-bearing bulk upload URLs additionally require the documented Microsoft Advertising host policy and credentials are never forwarded cross-origin. Credential-free report and bulk downloads may use changing CDN hosts after the same public-destination checks. Download and upload responses have concrete byte ceilings.

## 3. Wire-contract corrections

Add exact request-contract tests and fix these operations:

- Billing documents use UTC ISO date-time strings and include `ReturnInvoiceNumber`.
- Ad-extension association reads include `AccountId`.
- Ad-group negative-keyword reads require the parent campaign ID and enforce the operation's entity limit.
- Targeting deletes map specific read types to `Targets`, `Audience`, `Webpage`, or `ProductScope` write families.
- Audience updates require a `Type` discriminator and constrain updateable types.
- Report custom ranges with `HourOfDay` or `DayOfWeek` fail locally instead of submitting a known-invalid request.
- Association result counts use distinct indexed failures and preserve unattributed errors.
- CAPI identity validation checks only actual attribution identifiers, and non-2xx diagnostics retain a bounded safe error structure.
- Nested partial errors retain both parent and child indexes.
- TSV serialization uses the known report column list, or all already-bounded rows, instead of sampling the first 50.

`GetKeywordIdeas.IdeaAttributes` deliberately remains a JSON array: the official REST request template declares an array, despite generic flags-enum guidance elsewhere. An exact request-body regression test will preserve that verified shape. Documentation will describe delimiter behavior per REST field rather than asserting one global representation.

## 4. Tool-surface safety

### Raw operations

`msads_raw_read` will accept only an explicit `(service, path)` allowlist of reviewed read operations, not suffix inference. Sensitive credential-returning operations, especially `UetTagAuthKey/Query`, are denied across every raw tool. Unknown operations go through a conservatively destructive raw mutation tool; only individually allowlisted non-destructive mutations may use a lighter annotation.

### Sensitive and conditional operations

The public UET auth-key export tool and `auth_key` argument will be removed. `send_conversion_events` will accept an account and tag ID, authorize that account, fetch the key internally, and use it only in memory.

Operations containing destructive modes will be split or conservatively classified:

- customer-list Add remains a write;
- customer-list Remove/Replace is destructive;
- every unrestricted raw mutation is destructive;
- bulk upload is destructive because bulk records can remove data;
- offline conversion retractions are destructive;
- Google imports with deletion mirroring are destructive.

Google imports always send `NewPausedCampaignsAndChildEntities: true` unless the caller explicitly requests active imports. A separate destructive import surface carries deletion mirroring so the ordinary import tool cannot silently cross that boundary.

### Resource validation

`defineRead` will parse resource-derived arguments through the same Zod object used by the tool. Coercion will follow declared types only. Unknown query parameters and conflicts with URI variables will be rejected.

## 5. Bounded data and resumable bulk workflows

All list tools will return one common envelope with a default of 200 rows and a hard maximum of 5,000: total or discovered count where available, showing count, truncation flag, and guidance for narrowing or pagination. Existing APIs with pages will expose page arguments and use server-side page sizes. Extension reads will not silently discard discovered IDs. Raw and dedicated JSON responses will be read through a bounded body parser before `JSON.parse`; the default hard response ceiling is 16 MiB and large-file endpoints use their own explicit limits.

Bulk downloads will enforce a 64 MiB compressed ceiling, a 256 MiB total decompressed ceiling, and a bounded retained-row count before holding an account export. The safe failure tells callers to narrow by campaign or use a delta export. This deliberately favors a lean bounded implementation over building a streaming ZIP/CSV subsystem in this pass.

Bulk upload will reject more than 100,000 input records or 64 MiB of serialized CSV before compression. It gains `get_bulk_upload`, backed by one shared status parser used by initial polling and collection. Empty completed downloads return a completed empty result. Terminal upload failures, including row-count and format failures, return immediately with actionable status.

Report `max_rows` will be passed server-side where Microsoft supports it, while client-side shaping remains the final output bound. Fixed report names use a Zod enum, and documented report scope and bulk campaign limits are encoded with `.max()` in the public schemas.

## 6. Live-test cleanup and release hygiene

Cleanup will inspect every batch outcome, count only successful or already-absent entities, retain failures, and fail teardown when anything remains. The standalone cleanup command will exit nonzero on partial failure. Creation results must be asserted before IDs are registered for cleanup.

OAuth setup binds only to loopback and validates state before processing either success or error callbacks. PII normalization errors identify only the row and rule, never the raw identifier. Startup validation logs success without username or email by default.

Protocol tests will assert the exact tool, resource, and prompt manifests and every tool's read/write/destructive classification. Request-contract tests will cover host, path, method, headers, body, response reconciliation, and partial failures for each dedicated service operation.

CI will run only hermetic tests, secret scanning, typecheck, formatting, package build, and packaged startup. Live report expectations will branch on environment and report validation will run serially in bounded groups to avoid self-throttling. Release automation will synchronize `package.json` and `server.json`, publish the npm package advertised by the README using provenance, and remove stale package metadata such as the nonexistent logo entry. Google OAuth documentation will recommend Desktop clients for local use and explain the registered-loopback requirement for Web clients.

## Verification

The final implementation must satisfy:

- no tracked token files or reachable token blobs in local Git history;
- a clean default test run with no real network or credential-file changes;
- all unit, protocol, request-contract, typecheck, and lint checks passing;
- npm package contents limited to intended publishable files;
- packaged Node startup and MCP handshake passing from an unrelated directory;
- no public tool response or argument containing a reusable CAPI credential;
- exact destructive annotations covered by protocol tests;
- no unresolved P0/P1 findings in an independent review;
- a final simplification pass finds no unnecessary abstraction or duplicated logic in touched code.

## Non-goals

- No production API calls or production credential setup.
- No generated Microsoft Advertising client.
- No SOAP support.
- No backward-compatibility aliases for unsafe tool names or schemas; this is a pre-1.0 product and the clean interface replaces the unsafe one.
- No unbounded streaming framework. Large bulk exports fail safely with narrowing guidance until a separate streaming/export-to-file feature is justified.
