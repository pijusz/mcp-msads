# Design decisions — mcp-msads

Background facts and citations live in [RESEARCH.md](RESEARCH.md). This file
records what we chose and why, especially where we diverged from the two sibling
servers (`mcp-gads`, `mcp-meta-ads`).

## 1. Why build this at all

Microsoft ships an official Microsoft Advertising MCP server. It is hosted,
needs no developer token — and is **read-only**, with no published tool list and
no stated roadmap for writes.

The third-party field is eight open-source servers, none above four stars, half
of them built on SOAP that stops receiving features on 2026-10-01 and is deleted
on 2027-01-31. Nobody implements Customer Billing. One server each implements
Bulk and Ad Insight. Several ship live write access with no tests.

So the gap is specific: **no maintained, well-tested, write-capable Microsoft
Advertising MCP server exists.** That is what this is.

## 2. REST, not SOAP

Decision: implement REST/JSON exclusively.

SOAP has been the only transport for this API's whole life, and every SOAP
server in the field dies on 2027-01-31. REST covers every operation, needs no
XML layer, and drops SOAP's element-ordering requirement. Writing a SOAP
envelope builder in 2026 would have been dead code before it shipped.

Consequence: every wrapped REST path was verified against the `pivot="rest"`
section of its operation's reference page rather than inferred from a naming
pattern. `SuggestKeywordsForUrl`, for example, lives at
`KeywordSuggestions/QueryByUrl`. REST field serialization is operation-specific:
verified campaign and conversion-goal flags are comma-delimited strings, while
`GetKeywordIdeas.IdeaAttributes` is an array. There is no safe global flags rule.

## 3. Reads are tools; URI-projectable reads are also resources

The sibling servers disagree: `mcp-meta-ads` exposes reads as MCP resources,
`mcp-gads` exposes them as tools. Both lose something. Resources are the
semantically correct surface for a read, but several popular clients never
surface resource templates, so a resource-only read is invisible there. Tools
work everywhere but model a read as an action.

`utils/define-read.ts` always registers one handler as a tool and also binds it
to a resource when its arguments project cleanly onto a stable URI. Rich
structured reads such as report requests and keyword searches stay tool-only.
There is no second implementation to drift. Resource URIs accept the tool's
declared arguments as query params, so `msads://accounts?filter=Brand` and the
`list_accounts` tool run the same code. URI arguments are parsed through the
same strict Zod shape as tools: unknown parameters, path/query conflicts,
invalid scalar coercions, enum/range violations, and missing required fields
fail before the handler runs.

## 4. No mutation gate

`mcp-gads` hides mutation tools behind `GOOGLE_ADS_ENABLE_MUTATIONS=true`;
`mcp-meta-ads` ships them ungated. We follow `mcp-meta-ads`: if credentials are
configured, write tools register.

Rationale: the operator supplied a credential that can already spend money, and
a hidden tool cannot be discovered or asked about. Safety comes from three
things that survive a careless call, rather than from invisibility:

- Every write description starts with **⚠️ WRITE OPERATION**.
- Deletes and conditional surfaces that can remove data are annotated
  `destructiveHint: true`; creates and updates are not, so clients can prompt
  proportionally rather than treating every write alike.
- **Created entities default to `Paused`.** An agent that creates a campaign
  without being explicit about status does not start spending money.

## 5. Partial failure is a first-class result

Microsoft has no all-or-nothing mode for batch writes: "You will have to handle
that on the client side." The response splits across two structures with
different indexing rules — a positional id array with `null` for failures, and a
non-positional `PartialErrors` array carrying its own `Index`.

`utils/batch.ts` reconciles them into one outcome per submitted item. A write
tool therefore returns `{ submitted, succeeded, failed, ids, outcomes }`, never a
boolean. This is the single most commonly mishandled part of this API.

## 6. Reporting: bounded wait, resumable id

Reporting is asynchronous with no synchronous option, and Microsoft suggests
polling for as long as an hour. Neither extreme works for a tool call: blocking
an hour is unusable, and returning a bare URL — which is what several existing
servers do — hands the model something it cannot open.

`run_report` submits, polls with a fast-then-backing-off cadence, downloads,
unzips, and parses. If the budget expires it returns `status: "pending"` with the
`report_request_id`, and `get_report` collects it later. The report is never
lost and never paid for twice.

Two details that would otherwise surface as bugs:

- `ReportDownloadUrl` is null while `Status == "Success"` when the report matched
  zero rows. That is `status: "no_data"`, not an error.
- Download URLs expire after ~5 minutes, so `get_report` always re-polls for a
  fresh one instead of caching the URL.

## 7. Output size is managed, and truncation is always stated

Ad reports run to tens of thousands of rows. Exactly one existing server bounds
its output; the rest return raw payloads.

Defaults: TSV (roughly half the tokens of equivalent JSON, since keys are not
repeated per row), 200 rows, with column projection available and a hard 5,000-row
output limit. Collection envelopes report `showing`, `truncated`, and only a known
`total` or discovered count, plus guidance when truncated. Bulk exports are
additionally grouped by record type with empty cells dropped — a bulk row is mostly empty
columns, because every record type shares one header. Bulk archives are bounded
at 64 MiB compressed and 256 MiB decompressed; exports retain at most 100,000
rows and uploads accept at most 100,000 records / 64 MiB of CSV. A pending upload
is resumed through `get_bulk_upload` rather than submitted again.

## 8. Guardrails encode behaviour that fails silently

`services/guardrails.ts` refuses requests the API would accept and then quietly
ignore. Silent no-ops are worse than errors, because the caller believes the
change took effect:

- `TargetCpaBiddingScheme` / `TargetRoasBiddingScheme` are converted to
  `MaxConversions` / `MaxConversionValue` behind your back (since 2025-08-04).
- Bid strategies below campaign level are ignored (since April 2021).
- Omitting `TimePeriod` downgrades your aggregation to `Summary` without saying so.
- `Conversions` and `AveragePosition` return 0 rather than erroring.

Each rejection names the replacement rather than only reporting a problem.

## 9. Account/customer id resolution

Every account-scoped call needs a `CustomerId` + `CustomerAccountId` pair, and a
mismatch produces error 106 — which reads as a permissions problem and usually
is not. `resolveAccount()` looks the customer up from the account id, cached for
10 minutes, so callers pass one id and get the right pair.

The API also rejects the account *number* (`X1234567`) that the web UI displays.
We detect that specific shape and say so, rather than passing it through.

## 10. Auth: plain fetch, not MSAL

MSAL Node keeps the refresh token inside an opaque serialized cache and steers
callers toward `acquireTokenSilent`, which would mean persisting a blob instead
of a string an operator can read and rotate. The flow we need is one POST.

There is no app-only auth for this API — `msads.manage` is delegated-only, and
an app-only token is issued by Entra and then rejected with error 105. So
consent happens once via `mcp-msads setup` (authorization code + PKCE + local
callback), and the refresh token carries the server from then on.

`setup` defaults its owner-only refresh-token file to the platform config
directory, rejects checkout paths without an explicit override, and persists
only the rotating refresh token — never the access token. Token replacement is
atomic, durable, and serialized across local processes. The callback listens
only on IPv4 loopback and validates OAuth state before either success or error.

For Entra, `setup` warns when no client secret is configured, because a
public-client refresh token is bound to the granting device and fails anywhere
else. For Google local setup, a Desktop OAuth client is preferable because it
accepts loopback ports without registration; a Web client must register the
exact callback URI.

## 11. Two runtime dependencies

`@modelcontextprotocol/sdk` and `zod`. Everything else is hand-rolled:

- **ZIP reader** (`utils/zip.ts`) — Node has no ZIP support and every report and
  bulk download is zipped. ~180 lines covering stored, deflate, Zip64, and
  trailing comments, with a size check that catches truncated downloads.
- **CSV parser** (`utils/csv.ts`) — RFC 4180 with quoted delimiters, embedded
  newlines, and doubled-quote escapes, plus the Microsoft report envelope.
- **dotenv loader**, **retry/backoff**, **in-memory cache**.

## 12. Backoff is per-error-class

Microsoft's throttles are measured in minutes, not milliseconds, and publish no
numeric limits. Retrying error 117 after one second just burns another call
against a 60-second window. So rate-limit codes get their own curve (10s → 60s
for 117; 15s → 60s for 207 and 4204) while transient failures use ordinary
exponential backoff, and `Retry-After` wins when the server sends one.

Error 109 is handled separately: refresh the token and replay once, without
consuming the throttling retry budget.

## 13. Escape hatch

Campaign Management alone has ~190 operations. Wrapping all of them would make
the tool list unusable. `msads_raw_read` accepts only literal reviewed
`(service, path)` pairs from `docs/REST-PATHS.md`; POST and path suffixes cannot
prove an operation is safe. Credential-returning paths are excluded. Everything
else uses the conservatively destructive `msads_raw_mutation` surface.
`msads_api_info` reports the resolved base URLs for constructing those calls.

## 14. Testing

| Tier | Path | Command | Credentials |
|---|---|---|---|
| Unit | `tests/*.test.ts` | `bun run test` | None — hermetic, runs in CI |
| Protocol | `tests/mcp-protocol.test.ts` | included above | None |
| Live read | `tests/live/read.test.ts` | `bun run test:live` | Yes |
| Live write | `tests/live/write.test.ts` | `bun run test:live` | Yes + explicit opt-in |

The protocol tier boots the real binary over a real stdio transport, because
unit tests on the registration helpers would still pass if the handshake were
broken. It asserts that a **missing credential degrades to a failing tool call,
never a failed handshake** — a server that exits during init shows up in clients
as an opaque "connection closed".

ZIP and CSV fixtures are real archives produced by Info-ZIP, checked in as
base64 so the suite is hermetic across Linux, macOS, and Windows.

Live tests never fall back to "the first account we can see": `MSADS_TEST_ACCOUNT_ID`
is required, opting in covers writes as well, every entity is
created paused and registered only after confirmed creation, and everything is
named `mcp-msads-test-*` so `bun run test:cleanup` can find orphans from a crashed
run. Teardown and the standalone cleanup command inspect every batch outcome;
partial cleanup is a failure and unsuccessful ids remain registered for retry.
Report validation uses environment-specific expectations and waits serially so
the harness does not create its own concurrent-report throttle.

CI first scans tracked files for token material, then runs only hermetic tests,
typecheck, lint, the npm build, an exact package-content/version check, and an
MCP handshake against the bundled Node entrypoint from an unrelated directory.
Release tags synchronize `package.json` and `server.json`, publish npm with OIDC
provenance, and attach compiled binaries to the GitHub release.

## 15. What review changed

Three review agents went over the first complete build — one for correctness,
one for duplication, one for tool-surface design. Worth recording what they
found, because most of it was invisible from the inside.

### Bugs that unit tests did not catch

- **`run_report` with `Summary` aggregation failed for 26 of 29 report types.**
  The guard against "TimePeriod + Summary" (API error 2034) ran against the
  *defaulted* column list, and most defaults lead with TimePeriod. Worse, this
  server's own prompts instruct exactly that call. The existing test only
  covered a caller who passed TimePeriod explicitly — which is the case that
  worked.
- **Association writes reported every success as a total failure.**
  `SetAdExtensionsAssociations` returns only `PartialErrors`, with no id array,
  so `mapBatchResult` saw "no id and no error" for every item and set
  `all_failed: true`. An agent would have retried a write that had succeeded.
- **`create_ad_extensions` returned `"[object Object]"` for every id**, because
  `AdExtensionIdentities` holds `{Id, Version}` objects rather than bare ids —
  so the result could not be fed to `associate_ad_extensions`.
- **`add_negative_keywords` reported N−1 phantom failures**, because
  `NegativeKeywordIds` is an `IdCollection[]` keyed to *entities*, not keywords.

The common thread: every one is a response shape that differs from the
prevailing "positional id array plus PartialErrors" pattern. Assuming the
pattern held was the mistake, and only a live call or a careful read of each
reference page catches it.

### Six capabilities implemented and registered nowhere

`deleteAdExtensionAssociations`, `getLabels`, `addLabels`,
`setLabelAssociations`, `updateConversionGoals`, `getAdGroupsByIds` all existed
in `src/services/` and were reachable from no tool. The first was worse than
dead code: `delete_ad_extensions`' own description told the model to "delete the
association instead", pointing at a capability that did not exist.

### Tool count was the wrong thing to worry about

The instinct to trim 74 tools was aimed at the wrong target. Measured against
the siblings, this server is not more granular per surface — `mcp-gads` has 36
tools and *no write surface at all*; `mcp-meta-ads` has 38 write tools to our
39. And it was already consolidated where it counts: `run_report` covers 29
report types in one tool where `mcp-gads` spends ~20 tools on one-report-each.

Where the tokens actually were:

| Change | Saving |
|---|---|
| Delete the 4 most marginal tools | 3.1% |
| Remove `customer_id` from 64 schemas | **6.3%** |

Removing one argument beat deleting four whole tools by 2×. `customer_id` was
present only to say "resolved automatically", and setting it wrong causes the
exact error 106 that `resolveAccount` exists to prevent.

That review produced 78 tools. The later security split of conditional
mutations and removal of the public credential-export surface brought the
manifest to 80 tools; the resumable bulk-upload collector brings it to 81.

### Abstractions worth removing, and worth keeping

Eight services carried an identical `scope(ids)` helper written for
`exactOptionalPropertyTypes` — a flag this project does not enable, making the
helper a no-op wrapper around a plain spread. Deleted, 50 lines.

The add/update/delete triples were deliberately **not** abstracted. They only
look uniform: the id field differs per *operation* (`AdExtensionIdentities` on
add, `AdExtensionIds` on update), update synthesizes an id array where add does
not, the human-readable label differs per entity, and validation differs per
operation. A factory would replace readable wire shapes with configuration you
have to decode — and the value of these functions is that reading one tells you
exactly what JSON Microsoft receives, which is what has to be checked against
the reference page.
