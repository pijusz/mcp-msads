# Agent Guidelines for mcp-msads

> Design decisions live in [docs/SPEC.md](docs/SPEC.md); the API research behind
> them is in [docs/RESEARCH.md](docs/RESEARCH.md). This file documents
> conventions for working in the code.

## Project structure

```
src/
├── index.ts                   # Entry point (stdio transport + `setup` dispatch)
├── server.ts                  # McpServer creation + registration
├── auth/
│   ├── oauth.ts               # Token refresh, rotation, persistence
│   ├── secure-file.ts         # Atomic owner-only token files + process lock
│   └── setup.ts               # One-time browser consent (auth code + PKCE)
├── config/
│   └── env.ts                 # Zod-validated env + .env loader
├── services/
│   ├── msads-api.ts           # The only HTTP path: retries, 109 refresh, faults
│   ├── accounts.ts            # Customer Management + account/customer resolution
│   ├── campaigns.ts           # Campaign Management CRUD
│   ├── reporting.ts           # submit → poll → download → unzip → parse
│   ├── report-types.ts        # Registry of 28 report types and their scope kinds
│   ├── ad-insight.ts          # Keyword planning
│   ├── bulk.ts                # Whole-account export + delta sync
│   ├── billing.ts             # Customer Billing
│   ├── guardrails.ts          # Rules the API ignores silently
│   └── cache.ts               # In-memory, credential-scoped
├── tools/
│   ├── index.ts               # Barrel
│   ├── accounts.ts  campaigns.ts  reports.ts
│   ├── insights.ts  bulk.ts       billing.ts
│   └── raw.ts                 # Escape hatch for unwrapped operations
└── utils/
    ├── define-read.ts         # Register a read as tool AND resource
    ├── register-tool.ts       # read / write / destructive annotations
    ├── tool-response.ts       # ok / fail / run wrappers
    ├── batch.ts               # Partial-failure reconciliation
    ├── collection.ts          # Shared bounded collection envelope
    ├── errors.ts              # MsAdsError, code table, hints
    ├── zip.ts                 # Dependency-free bounded ZIP reader
    ├── csv.ts                 # RFC 4180 + Microsoft report envelope
    ├── tsv.ts                 # Token-efficient tabular output
    └── logger.ts              # stderr only — stdout is the MCP transport
```

## The wire format

REST/JSON only. SOAP loses feature updates on 2026-10-01 and is removed on
2027-01-31; do not add SOAP support.

```ts
// Reads are POSTs with a JSON body, not GETs.
await msadsFetch("CampaignManagement", "Campaigns/QueryByAccountId", {
  body: { AccountId: ids.accountId },
  accountId: ids.accountId,
  customerId: ids.customerId,
});
```

Path grammar: `{Entity}` for add (POST), the same for update (PUT) and delete
(DELETE), and `{Entity}/{Verb}` for reads. Verify any new path against the
`pivot="rest"` section of its reference page — inference is not reliable
(`SuggestKeywordsForUrl` lives at `KeywordSuggestions/QueryByUrl`).

Conventions:
- 64-bit ids are JSON **strings**. Keep them strings; parsing loses precision.
- Derived types carry a `Type` discriminator.
- REST flags are field-specific. Verified campaign `ReturnAdditionalFields`,
  `ConversionGoalTypes`, and association `AdExtensionType` are comma-delimited.
- `GetKeywordIdeas.IdeaAttributes` is a JSON array, per its REST template.

## Shared tool helpers

`src/tools/_shared.ts` holds `WRITE`, `ACCOUNT_ARGS`, and `ids()`. Use them
rather than re-declaring — eight copies had already drifted into two different
descriptions for the same argument.

`ACCOUNT_ARGS` exposes only `account_id`. `customer_id` is resolved from it and
is deliberately not on tool schemas: it appeared in 64 of 74 only to say
"resolved automatically", and setting it wrong causes error 106. It stays on
the raw escape-hatch tools and via `MSADS_CUSTOMER_ID`.

## Adding a read

Use `defineRead` so the read lands on both surfaces:

```ts
defineRead(server, {
  name: "list_widgets",
  title: "Widgets",
  uriTemplate: "msads://account/{accountId}/widgets",  // optional
  uriVars: { accountId: "account_id" },
  description: "…",
  inputSchema: { account_id: z.string().optional() },
  handler: async (args) => { /* return a raw payload */ },
});
```

Resource arguments are coerced only according to declared types, then parsed
through the same strict Zod shape as tool arguments. Unknown query parameters,
URI/query conflicts, invalid scalars/enums/ranges, and missing required fields
are rejected before the handler runs, so handlers receive validated arguments
on both surfaces.

Omit `uriTemplate` when the arguments don't project onto a URI (report requests,
keyword searches). The tool is still registered.

## Adding a write

```ts
writeTool(server, "create_widgets", `⚠️ WRITE OPERATION — …`, schema, run(handler));
destructiveTool(server, "delete_widgets", `⚠️ WRITE OPERATION — …`, schema, run(handler));
```

- `writeTool` for create/update (`destructiveHint: false`).
- `destructiveTool` for deletes and anything that loses data.
- Descriptions start with **⚠️ WRITE OPERATION**.
- Default new entities to `Paused`.
- Return `mapBatchResult()` output — never a bare boolean.

## Batch writes

Microsoft has no all-or-nothing mode. The id array is positional with `null` for
failures; `PartialErrors` is not positional and carries its own `Index`.

```ts
assertBatchLimit(items, BATCH_LIMITS.campaigns, "campaigns");
const res = await call("Campaigns", "POST", { AccountId, Campaigns: items }, ids);
return mapBatchResult(res, "CampaignIds", items.map((c) => String(c.Name)), items.length);
```

Real limits are lower than intuition: **100** campaigns, **50** ads, 1,000 ad
groups, 1,000 keywords. See `BATCH_LIMITS`.

**Check the response shape before reaching for `mapBatchResult`.** Not every
write returns a positional id array, and assuming it does has produced real
bugs: association writes return only `PartialErrors` (use `AssociationResult`),
`AdExtensionIdentities` holds objects rather than ids, and `NegativeKeywordIds`
is keyed to entities with the keyword ids nested one level down. Read the
operation's reference page rather than following the prevailing pattern.

## Errors

Throw `MsAdsError`; `run()` renders it. Add a hint to the table in
`utils/errors.ts` for any code an operator can act on.

| Code | Meaning |
|---|---|
| 105 | Bad credential **or wrong environment** |
| 106 | Valid credential, no permission on that entity |
| 109 | Token expired — handled automatically (refresh + replay once) |
| 117 / 207 / 4204 | Throttling — handled with per-class backoff |

## Output size

Tabular output is TSV by default and row-capped, and truncation always states
the true total. Do not return an unbounded list from a tool.

## Reusing a Google OAuth client

Microsoft Advertising accounts that sign in with Google need a Google OAuth
client, not the Entra app registration. Any existing one works — scopes are
chosen per authorization, not baked into the client:

```bash
bun run import:google ../mcp-gsc/credentials.json
```

That copies the id and secret into `.env` without printing either, and sets
`MSADS_IDENTITY_PROVIDER=google`.

A **Desktop app** client is preferable: Google accepts loopback ports without
pre-registering each one. A Web client must register the exact callback URI
printed by setup. Note that the public-client warning from Microsoft setup does
not carry over — device-bound refresh tokens are an Entra behaviour, not a
Google one.

Setup defaults to the platform config directory outside the checkout and writes
only the rotating refresh token; access tokens are never persisted. Revoke and
re-consent any older OAuth grant before sharing a previously credentialed
checkout or bundle.

## Tests

| Tier | Path | Command | Credentials |
|---|---|---|---|
| Unit | `tests/*.test.ts` | `bun run test` | No |
| Protocol | `tests/mcp-protocol.test.ts` | included above | No |
| Live | `tests/live/*.test.ts` | `bun run test:live` | Yes, opt-in |

Unit tests use `tests/_mock.ts`, which swaps global fetch for a router and
records calls. Reach for it rather than mocking individual modules.

```ts
beforeEach(() => {
  setTestEnv();
  resetEnvForTesting();
  resetAuthForTesting();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
});
```

ZIP and CSV fixtures in `tests/fixtures/` are real Info-ZIP archives stored as
base64, so the suite is hermetic across platforms. Regenerate with the `zip` CLI
and re-encode rather than hand-editing bytes.

### Live tests

Three env vars gate reads, and a fourth gates writes:

```bash
MSADS_RUN_LIVE_TESTS=true
MSADS_TEST_ACCOUNT_ID=123456789     # never falls back to "the first account"
bun run test:live
```

Contract for write tests: create everything **paused**, assert its creation
succeeded before registering the returned id, name it `mcp-msads-test-*`, and
let `afterEach` delete it. Cleanup must inspect every batch outcome; only
confirmed success/already-absent counts, failed ids remain registered, and any
partial cleanup fails teardown. `bun run test:cleanup` applies the same rule and
exits nonzero on partial failure; `bun run test:cleanup:dry` only lists orphans.
