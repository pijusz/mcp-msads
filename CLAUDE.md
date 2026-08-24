# mcp-msads

Microsoft Advertising (Bing Ads) MCP server in Bun/TypeScript. See
[AGENTS.md](AGENTS.md) for conventions and [docs/SPEC.md](docs/SPEC.md) for
design decisions.

## Quick reference

- **Runtime:** Bun (dev) / Node (built)
- **Entry:** `src/index.ts`
- **Build:** `bun run build` → `mcp-msads` binary; `bun run build:npm` → `dist/index.js`
- **Test:** `bun run test` (hermetic unit + protocol, no credentials)
- **API:** Microsoft Advertising v13, **REST/JSON** — never SOAP

## Key patterns

- Reads are declared once via `defineRead()` and registered as **both** a tool
  and a resource. Writes are tools only.
- `msadsFetch()` in `services/msads-api.ts` is the only HTTP path: it refreshes
  on error 109, backs off per error class, and translates faults to `MsAdsError`.
- Customer Management and Customer Billing must **not** receive `CustomerId` /
  `CustomerAccountId` headers. This is modelled per service in `SERVICES`.
- Batch writes half-succeed. Always return `mapBatchResult()` output, never a boolean.
- Reports and bulk downloads are ZIPped CSV. `utils/zip.ts` + `utils/csv.ts`
  handle that with no dependencies.
- 64-bit ids are strings on the wire and stay strings in our code — parsing to
  `number` loses precision.
- Mutation tool descriptions start with **⚠️ WRITE OPERATION**; created entities
  default to `Paused`.

## Gotchas encoded in `services/guardrails.ts`

These fail *silently* against the live API, so we reject them up front:

- `TargetCpa` / `TargetRoas` bid strategies are converted to
  `MaxConversions` / `MaxConversionValue` without notice.
- Bid strategies below campaign level are ignored.
- Match types are `Broad` / `Phrase` / `Exact` only.
- `DynamicSearchAds` is no longer a campaign type.
- Omitting the `TimePeriod` column downgrades a report to `Summary`.
- `MSClickIdPerformanceReportRequest` deserializes but is servable in no
  environment; it is deliberately absent from the 28-type catalog.

## Prod testing (published package)

```bash
claude mcp add msads --scope user --transport stdio \
  -e MSADS_DEVELOPER_TOKEN=... \
  -e MSADS_CLIENT_ID=... \
  -e MSADS_CLIENT_SECRET=... \
  -e MSADS_REFRESH_TOKEN=... \
  -- npx -y mcp-msads@latest
```

If the client reports `connection closed: initialize response`, the process is
exiting before MCP init. Check in order:

1. `npx -y mcp-msads@latest --version` works.
2. `MSADS_CLIENT_ID` is a GUID, not a legacy hex id.
3. A refresh token is present (`MSADS_REFRESH_TOKEN` or `MSADS_TOKEN_FILE`).
4. Environment matches the credentials — production tokens against sandbox
   produce error 105.

Note the server is designed so missing credentials fail the *tool call*, not the
handshake; a failed handshake means something else is wrong.
