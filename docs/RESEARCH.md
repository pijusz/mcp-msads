# Research notes — Microsoft Advertising API

Compiled 2026-08-18 from `learn.microsoft.com/en-us/advertising` and a survey of
every Microsoft Advertising MCP server that exists. This file records the facts
the implementation depends on, especially the ones that contradict a reasonable
guess. `docs/SPEC.md` records what we decided to *do* about them.

## 1. Use REST, not SOAP — this is time-critical

Microsoft Advertising was SOAP-only for its whole life. It is not any more, and
SOAP is being switched off:

| Date | Event |
|---|---|
| 2026-10-01 | All new features become **REST-only**. SOAP gets nothing new. |
| 2027-01-31 | SOAP is **fully deprecated** (shut off). |

Source: [Migrate to REST](https://learn.microsoft.com/en-us/advertising/guides/migrate-to-rest?view=bingads-13),
[Evolving the Microsoft Advertising API Platform](https://about.ads.microsoft.com/en/blog/post/april-2026/evolving-the-microsoft-advertising-api-platform).

Consequences for us:

- No XML layer, no WSDL, no SOAP element-ordering landmine (SOAP fails if body
  elements are out of schema order; JSON has no such rule).
- **REST is not content negotiation on the `.svc` endpoints.** It is a
  different URL grammar on the same hosts. Posting JSON at a `.svc` URL fails.
  - SOAP: `https://campaign.api.bingads.microsoft.com/Api/Advertiser/CampaignManagement/v13/CampaignManagementService.svc`
  - REST: `https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns/QueryByAccountId`
- There is **no** `api.ads.microsoft.com`, and no GraphQL.
- API version is **still v13**. REST/SOAP is a protocol split, not a version bump.

### Wire conventions

- **Reads are `POST` with a JSON body**, not `GET` with query params.
- Keys are PascalCase and mirror the SOAP object model.
- **`long` values serialize as strings** (`"Id": "123"`), ints/doubles as numbers.
  Treat every id as a string end to end; parsing to `number` loses precision
  above 2^53.
- Derived types carry a `"Type"` discriminator (`"Type": "CommissionBiddingScheme"`).
- `ArrayOf*` wrappers are gone; arrays are plain JSON arrays.

## 2. Hosts and per-service paths

Base: `https://{sub}.api.bingads.microsoft.com/{prefix}` — insert `.sandbox`
after `api` for sandbox (`{sub}.api.sandbox.bingads.microsoft.com`).

| Service | Subdomain | Path prefix | Account headers? |
|---|---|---|---|
| Customer Management | `clientcenter` | `CustomerManagement/v13` | **No** |
| Customer Billing | `clientcenter` | `CustomerBilling/v13` | **No** |
| Campaign Management | `campaign` | `CampaignManagement/v13` | Yes |
| Reporting | `reporting` | `Reporting/v13` | Yes |
| Bulk | `bulk` | `Bulk/v13` | Yes |
| Ad Insight | `adinsight` | `AdInsight/v13` | Yes |

Two traps encoded in `services/msads-api.ts`:

1. **Bulk's REST path is `/Bulk/v13/`**, nothing like its SOAP path
   (`/Api/Advertiser/CampaignManagement/v13/BulkService.svc`).
2. **Customer Management and Customer Billing reject `CustomerId` /
   `CustomerAccountId` headers.** Sending them to all six services uniformly is
   a documented source of confusion.

### Headers

```
Authorization: Bearer {access_token}     ← the "Bearer " prefix is required
DeveloperToken: {developer_token}
CustomerId: {manager_account_id}         ← account-scoped services only
CustomerAccountId: {ad_account_id}       ← account-scoped services only
Content-Type: application/json
```

`CustomerAccountId` must equal the `AccountId` body element when both appear.
Responses carry a `TrackingId` — capture it, Microsoft support asks for it.
Add `IdentityProvider: Google` only when the token came from Google OAuth.

## 3. Authentication

Two independent credentials, always:

- **Developer token** — proves the *application* may call the API at all.
  Request at <https://ads.microsoft.com/cc/Settings/DevSettings> with **Super
  Admin** credentials. Sandbox has a universal public token: **`BBD37VB98`**.
- **OAuth access token** — proves a *user* authorized us.

### There is no app-only auth

`msads.manage` is a **delegated** permission only. No client credentials, no
managed identity, no daemon flow. An app-only token is issued by Entra and then
rejected by the Ads API with error **105**. A user must consent once,
interactively; after that a rotating refresh token carries us indefinitely.

### Register a Web app WITH a client secret

The single most consequential registration detail:

> "If you register a public application without a client secret, then you cannot
> use a refresh token across devices. A confidential token is bound to the
> client secret."

A public-client refresh token is bound to the **granting device** — mint it on
a laptop, deploy to a server, and you get `invalid_grant`. Registration must
also be **multitenant + personal accounts** ("Accounts in any organizational
directory and personal Microsoft accounts") or `/common` refuses it.

### Endpoints and scope

```
Authorize: https://login.microsoftonline.com/common/oauth2/v2.0/authorize
Token:     https://login.microsoftonline.com/common/oauth2/v2.0/token
Scope:     https://ads.microsoft.com/msads.manage offline_access
```

`ads.manage` and `bingads.manage` are dead — tokens minted with them are refused
under MFA enforcement. PKCE is recommended even for confidential clients.

Access tokens last ~1 hour. Refresh tokens idle out at ~90 days and **rotate on
every use** — persisting the new one each time is mandatory, not optional.

## 4. Error codes (verified — several common assumptions are wrong)

| Code | Symbolic | Meaning |
|---|---|---|
| 0 | `InternalError` | Transient. Retry. |
| **105** | **`InvalidCredentials`** | Bad token **or wrong environment**. Production creds against sandbox produce exactly this. |
| **106** | **`UserIsNotAuthorized`** | Credentials fine, no permission on that entity. |
| **109** | **`AuthenticationTokenExpired`** | Refresh and replay once. |
| 116 | `RequestMissingHeaders` | Usually the account-header asymmetry above. |
| 117 | `CallRateExceeded` | Rolling **60-second** window. Wait 60s. |
| 207 | `ConcurrentRequestOverLimit` | Reporting. **Not time-based** — wait for in-flight reports. |
| 3207 | `AccountTooBigToDownload` | Bulk, >4M keywords. Fall back to per-campaign. |
| 4204 | `BulkNoMoreCallsPermitted` | Bulk throttle. Wait up to **15 minutes**. |

105 vs 106 is the key diagnostic split: authentication vs authorization.
Microsoft publishes **no numeric rate limits** ("internal and subject to
change"), so the client reacts to codes rather than budgeting calls.

### Partial failure is the normal case for batch writes

> "Microsoft doesn't support 'all or nothing' error handling behavior. You will
> have to handle that on the client side."

- The returned id array is **positional** — `CampaignIds[i]` maps to
  `Campaigns[i]`, and is `null` where that item failed.
- `PartialErrors` is **not** positional; each `BatchError` carries its own
  `Index`.
- Some operations return `NestedPartialErrors` (a `BatchErrorCollection[]`).
- Exception: `ApplyProductPartitionActions` has `PartialErrors` but really is
  all-or-nothing.

Any write tool must therefore report per-item outcomes, never a single boolean.

## 5. Reporting

Two operations, `SubmitGenerateReport` and `PollGenerateReport`. **There is no
synchronous option.** REST paths: `/Reporting/v13/GenerateReport/Submit` and
`/Reporting/v13/GenerateReport/Poll`.

Flow: submit → poll while `Status == "Pending"` → download → **unzip** → parse.

| Fact | Value |
|---|---|
| Status values | `Pending`, `Success`, `Error` — exactly three |
| `ReportDownloadUrl` validity | **5 minutes.** Re-poll for a fresh one after that. |
| `ReportRequestId` validity | 1 day (operation ref) / 2 days (guide) — assume **1 day** |
| Compression | **Always ZIP**, whatever `Format` says |
| Poll cadence | Microsoft suggests 2–15 min; their own SDK polls 1s ×5 then 5s |

Two traps:

- **`ReportDownloadUrl` can be null while `Status == "Success"`.** That means
  *zero rows*, not an error.
- "You should not take a dependency on the domain of the download URL" — never
  pin or allowlist the CDN host.

Submit and poll must use the **same user credentials**.

### Report file layout

A quoted metadata block, a blank line, column headers, rows, a blank line, then
a copyright footer. `Potential Incomplete Data: true` and `Last Completed
Available Day` are worth surfacing — they say whether the numbers are still
moving. Recommended request flags: `FormatVersion: "2.0"` (no thousands
separators, sane decimal precision, ISO-ish hourly `TimePeriod`), `Format: Csv`,
footer excluded, header kept.

### Report shape rules

- Every report needs ≥1 attribute column **and** ≥1 non-impression-share metric.
- `TimePeriod` is required for any aggregation other than `Summary`; including
  it *with* `Summary` is error 2034. Omitting it silently downgrades to Summary.
- Aggregation has **9** values, including the easily-missed `WeeklyStartingMonday`.
- `PredefinedTime` (17 values) and `CustomDateRangeStart/End` are mutually
  exclusive — set one, null the other (error 2008).
- Dates are objects: `{ Day, Month, Year }`.
- Impression-share columns cannot coexist with certain attribute columns
  (error 2053), and `HistoricalQualityScore` is Daily-only (error 2054).
- Scope caps: 1,000 account ids, 300 campaigns, 300 ad groups, 100 asset groups.
- Retention varies sharply: 36 months daily for most, but **Search Query hourly
  is 1 month**, **Asset Performance is 30 days total**, **Geographic and User
  Location hourly are 14 days**.

### Deprecated columns that silently return 0

`Conversions`, `AllConversions`, `ViewThroughConversions` (use the
`*Qualified` variants, which are doubles) and `AveragePosition`.

## 6. Batch limits (the guessable numbers are mostly wrong)

| Operation | Limit |
|---|---|
| `AddCampaigns` / `UpdateCampaigns` / `DeleteCampaigns` | **100** (not 1,000) |
| `AddAdGroups` / `UpdateAdGroups` / `DeleteAdGroups` | 1,000 |
| `AddAds` / `UpdateAds` / `DeleteAds` | **50** (`GetAdsByIds` only **20**) |
| `AddKeywords` / `UpdateKeywords` / `DeleteKeywords` | 1,000 |
| `AddAdGroupCriterions` | 1,000 |
| `AddCampaignCriterions` | 100 |
| `AddBudgets` / `AddBidStrategies` / `AddAudiences` / `AddAdExtensions` | 100 |
| `AddConversionGoals` / `AddUetTags` | 100 |
| `ApplyOfflineConversions` | 1,000 |
| `ApplyProductPartitionActions` | 5,000 |

## 7. Behaviour that will otherwise produce confusing failures

- **Match types are `Broad`, `Exact`, `Phrase` only.** No `Content`, no
  broad-match-modifier in v13.
- **`TargetCpaBiddingScheme` / `TargetRoasBiddingScheme` can no longer be set
  on a campaign** (since 2025-08-04). They are silently converted to
  `MaxConversionsBiddingScheme` / `MaxConversionValueBiddingScheme`. Existing
  campaigns are grandfathered.
- **Bid strategies are campaign-level only** since April 2021. Setting one on
  an ad group or keyword is *silently ignored*.
- **`DynamicSearchAds` as a campaign type is deprecated.** DSAs now live in
  `SearchDynamic` ad groups inside Search campaigns.
- **Criterion read/write asymmetry:** write targets with `CriterionType:
  "Targets"` and audiences with `"Audience"`, but *read* them back with the
  specific type (`Age`, `Gender`, `RemarketingList`, …).
- **Ad extension updates are full replacements** — an omitted optional field is
  deleted. Partial update works for most other objects but not these.
- **`ImageAdExtension` moved to an `AssetLink[]`/`Images` model** (2026-05).
  Reads now return `Images`.
- Account **`Number`** (e.g. `X1234567`) is display-only and never valid in an
  API request. Only the numeric **`Id`** is.

## 8. Existing MCP servers — where the gap is

Microsoft ships an **official MCP server** (announced 2026-06-17): hosted,
Streamable HTTP at `partner.api.bingads.microsoft.com/ext/mcp/vnext`, no
developer token needed — and **read-only**, with no published tool list and no
stated roadmap for writes.

Third-party servers found: 8 open-source, all **0–4 stars**, plus a handful of
closed hosted products. Downloads top out around 600/month. Of these:

| Gap | State of the art |
|---|---|
| Customer Billing | **Nobody implements it.** Not one server, official included. |
| Bulk service | Exactly one implementation. |
| Ad Insight (keyword planning) | Exactly one implementation. |
| Transport | Half are on SOAP, which dies 2027-01-31 — including the single most discoverable server. |
| Async reporting | Several submit a report and hand back a URL the model cannot open. |
| Result size | One server bounds report output; the rest dump raw payloads into context. |
| Write safety | Three incompatible philosophies; three servers ship live writes with no gate at all. |
| Tests | Two servers have meaningful coverage. Several have zero tests and full write access. |

**The headline: there is no maintained, well-tested, write-capable Microsoft
Advertising MCP server.** The one with Microsoft's backing cannot write; the
ones that can write are unmaintained hobby repos.

## 9. Genuine differentiators vs Google/Meta

- **LinkedIn profile targeting** (`ProfileCriterion`: company, industry, job
  function) — no equivalent anywhere else. Plus a newer LinkedIn Segments API.
- **Microsoft Audience Network** — native inventory across MSN, Outlook, and
  Microsoft 365.
- **Google Ads import** (`AddImportJobs` / `GetImportResults`) — scheduled,
  selective campaign import from Google.
- **Manager-account-level sharing** of UET tags, audiences, and placement
  exclusion lists.
- **Commission and percent-CPC bidding** for lodging campaigns.

## 10. Sandbox

Sign up at <https://sandbox.bingads.microsoft.com>. Separate credentials from
production entirely; mixing them yields error 105.

Limitations that affect testing:

- MSA signup historically required an **`outlook.com`** address; Google OAuth
  signup is now supported and sidesteps that.
- **Single-threaded only** — no concurrency or load testing.
- Ads never serve. Reporting generates test data only for the same day an
  entity was created, and only 9 report types return anything.
- Ad Insight is badly degraded — docs recommend production instead. Only a
  fixed keyword list responds.
- Bulk upload is capped at 20K rows (production: 100 MB / 4M rows).
- Work/school accounts are **not** supported in sandbox.
