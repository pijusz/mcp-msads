# mcp-msads

Microsoft Advertising (Bing Ads) MCP server — campaigns, keywords, reporting,
keyword planning, bulk export, and billing via natural language.

Built on the **REST/JSON** API. Microsoft stops shipping features to the SOAP
API on 2026-10-01 and removes it entirely on 2027-01-31.

## Why this exists

Microsoft ships an official Microsoft Advertising MCP server, but it is hosted
and **read-only**. Of the eight open-source alternatives, none has more than
four stars, half are built on the dying SOAP API, and several ship live write
access with no tests at all.

Nothing in the field covers Customer Billing. One server each covers Bulk and
Ad Insight. `mcp-msads` covers all three, can write, and is tested.

## Install

```bash
claude mcp add msads --scope user --transport stdio \
  -e MSADS_DEVELOPER_TOKEN=... \
  -e MSADS_CLIENT_ID=... \
  -e MSADS_CLIENT_SECRET=... \
  -e MSADS_TOKEN_FILE=/absolute/path/to/msads-token.json \
  -- npx -y mcp-msads@latest
```

## Getting credentials

Microsoft Advertising needs **three** things, and there is no app-only path —
a user must consent once through a browser.

### 1. A developer token

Sign in at <https://ads.microsoft.com/cc/Settings/DevSettings> with **Super
Admin** credentials and request one.

For the sandbox, skip this: the universal token `BBD37VB98` works for everyone.
Set `MSADS_ENVIRONMENT=sandbox` and it is used automatically.

### 2. An Entra ID app registration

<https://portal.azure.com> → Microsoft Entra ID → App registrations → New registration.

- **Supported account types:** "Accounts in any organizational directory and
  personal Microsoft accounts". Anything narrower fails against `/common`.
- **Platform:** Web. **Redirect URI:** `http://127.0.0.1:31544/callback`
- **Certificates & secrets** → New client secret.

The redirect URI must match byte-for-byte. If you pass a custom `--port`,
register the exact `http://127.0.0.1:<port>/callback` URI that setup prints.

> Register a **Web app with a secret**, not a public/native client. A
> public-client refresh token is bound to the device that granted it and fails
> with `invalid_grant` on any other host.

### 3. A refresh token

```bash
MSADS_CLIENT_ID=... MSADS_CLIENT_SECRET=... bun run setup
# or, without a checkout:
MSADS_CLIENT_ID=... MSADS_CLIENT_SECRET=... npx -y mcp-msads setup
```

`mcp-msads setup --help` lists the flags (`--port`, `--out`, `--allow-in-repo`)
without starting authorization; unknown flags are rejected.

This opens a browser, catches the IPv4-loopback callback, and writes a mode-0600
refresh-token file under the platform config directory (`mcp-msads/msads-token.json`).
Point `MSADS_TOKEN_FILE` at the printed path, or copy the refresh token into
`MSADS_REFRESH_TOKEN`. An explicit `--out` inside a Git checkout is rejected unless
`--allow-in-repo` is also supplied.

Prefer `MSADS_TOKEN_FILE`: refresh tokens rotate on every use, and the file lets
the server persist each rotation instead of holding it in memory only. Access
tokens are short-lived and are never persisted.

### If your account signs in with Google

Microsoft Advertising accounts can be created with a Google sign-in, and for
sandbox that is often the only practical route — Microsoft-account sign-up
requires an `outlook.com` address.

A Google-owned user **cannot** be authenticated with a Microsoft token. The API
needs a Google OAuth token plus an `IdentityProvider: Google` header. Point the
server at Google and it handles the rest:

```bash
MSADS_IDENTITY_PROVIDER=google
MSADS_CLIENT_ID=<google client id>
MSADS_CLIENT_SECRET=<google client secret>
```

Create that client at
<https://console.cloud.google.com/apis/credentials> → Create credentials →
OAuth client ID. For local use, choose **Desktop app**: Google accepts loopback
redirects on the temporary callback port without pre-registering each port. A
**Web application** client also works, but it must register the exact loopback
URI printed by setup (by default `http://127.0.0.1:31544/callback`). Then run
`bun run setup` as usual.

The Entra app registration is not used in this mode — a Microsoft app cannot
authenticate a Google user. Everything downstream is unchanged: the same
developer token, the same account permissions, the same tools.

Symptom of getting this wrong: authorization succeeds, then every API call
returns error 105.

### Sharing the setup with a team

The three credentials split three ways, and the split matters.

| Credential | Scope | Share it? |
|---|---|---|
| `MSADS_CLIENT_ID` | The application | Yes — it is a public identifier |
| `MSADS_CLIENT_SECRET` | The application | Yes, but as a real secret |
| `MSADS_DEVELOPER_TOKEN` | The application | Yes — universal since July 2019, it works with *any* Microsoft Advertising user |
| `MSADS_REFRESH_TOKEN` | **One person** | **No.** Each person runs `bun run setup` and gets their own |

One app registration and one developer token serve the whole team. Everyone
puts the same three values in their environment, then authorizes individually:

```bash
bun run setup --out ~/.config/mcp-msads/token.json
```

Per-person refresh tokens are the right design, not a limitation. Actions
attribute to the real person in Microsoft Advertising's change history, one
person leaving does not break everyone, and a password change or MFA prompt
affects only that individual. A single shared refresh token collapses all
three of those.

Before sharing a checkout or credential bundle that predates these safeguards,
revoke its existing OAuth grant with the identity provider and run setup again.
Deleting a local token file does not revoke the provider-side grant.

**Account access is separate from all of this.** A developer token grants no
data access whatsoever — it only permits the *application* to call the API.
Each colleague must also be invited to the Microsoft Advertising account
itself, under Account settings → Users, with a role (Super Admin, Standard,
Advertiser Campaign Manager, or Viewer). Up to 15 users per customer. Someone
with perfect credentials and no invitation gets error 106.

**The secret expires, and everyone breaks at once.** Note the expiry when you
create it. Rotating means issuing a new secret and redistributing it —
existing refresh tokens keep working, since they are bound to the client id.

**One registration covers both environments.** Sandbox and production share
the same Entra app; what differs is the developer token (sandbox uses the
universal `BBD37VB98`) and the accounts themselves. Credentials are never
interchangeable between the two — mixing them produces error 105.

### Trying it without a production account

Sign up at <https://sandbox.bingads.microsoft.com>, set
`MSADS_ENVIRONMENT=sandbox`, and no developer token is needed. Note that ads
never serve, Ad Insight is heavily degraded, and only nine report types return
data.

## Tools

81 tools. ⚠️ marks the destructive ones.

Collection reads return at most 200 rows by default and 5,000 at the hard limit.
Responses keep their domain result key and report `showing`, `truncated`, plus
`total` or `discovered` only when known; truncated results include narrowing or
pagination guidance. Bulk downloads retain at most 100,000 rows, archives are
bounded, and bulk uploads accept at most 100,000 records.

### Accounts

| Tool | Purpose |
|---|---|
| `list_accounts` | List every Microsoft Advertising ad account this login can reach, each paired with the manager (customer) account that owns it. |
| `get_current_user` | Identity of the authenticated Microsoft Advertising user, including the customer roles and account ids they can access. |
| `get_account` | Full detail for one ad account — currency, time zone, language, account mode, financial status, and the parent customer id. |
| `get_account_hierarchy` | Accounts under one manager (customer) account. |

### Campaigns, ad groups, ads, keywords

| Tool | Purpose |
|---|---|
| `list_campaigns` | List campaigns in an ad account, with budget, status, bid strategy, and campaign type. |
| `list_ad_groups` | List the ad groups in a campaign, with status, bids, and targeting settings. |
| `list_ads` | List the ads in an ad group. |
| `list_keywords` | List the keywords in an ad group, with match type, bid, status, and final URLs. |
| `list_budgets` | List shared budgets in the account's budget library. |
| `create_campaigns` | Create up to 100 campaigns in one call. |
| `update_campaigns` | Update existing campaigns. |
| `delete_campaigns` ⚠️ | Permanently delete campaigns. |
| `set_status` | Pause or resume campaigns, ad groups, ads, or keywords by id. |
| `create_ad_groups` | Create up to 1000 ad groups in one campaign. |
| `update_ad_groups` | Update ad groups. |
| `delete_ad_groups` ⚠️ | Permanently delete ad groups and everything under them. |
| `create_ads` | Create up to 50 ads in one ad group. |
| `update_ads` | Update ads. |
| `delete_ads` ⚠️ | Permanently delete ads from an ad group. |
| `create_keywords` | Add up to 1000 keywords to an ad group. |
| `update_keywords` | Update keywords — bids, status, final URLs. |
| `delete_keywords` ⚠️ | Permanently delete keywords from an ad group. |

### Reporting

| Tool | Purpose |
|---|---|
| `run_report` | Run a Microsoft Advertising performance report and return the rows. |
| `get_report` | Collect a report that run_report left in the 'pending' state, using its report_request_id. |
| `list_report_types` | Every report type run_report supports, with what it covers, how it can be scoped, and its default columns. |

### Targeting

| Tool | Purpose |
|---|---|
| `list_targeting` | Read targeting criterions on a campaign or ad group — age, gender, device, location, ad schedule, audiences, or LinkedIn profile targeting. |
| `add_targeting` | Add targeting criterions to a campaign or ad group. |
| `update_targeting` | Update targeting criterions — most commonly to change a bid multiplier. |
| `delete_targeting` ⚠️ | Remove targeting criterions. |
| `search_linkedin_companies` | Search LinkedIn company names and return their ProfileIds, for use with ProfileCriterion targeting. |
| `get_targeting_id_file` | Get a temporary download URL for Microsoft's targeting id reference files. |

### Audiences

| Tool | Purpose |
|---|---|
| `list_audiences` | List audiences available to the account — remarketing lists, customer lists, in-market audiences, product audiences, and combined lists — with their sizes and membership durations. |
| `create_audiences` | Create audiences — remarketing lists, customer (customer-match) lists, product audiences, combined lists, or impression-based remarketing lists. |
| `update_audiences` | Update audiences. |
| `delete_audiences` ⚠️ | Permanently delete audiences. |
| `add_customer_list_members` | Add email addresses to a customer-match audience without removing existing members. |
| `remove_customer_list_members` ⚠️ | Permanently remove selected members from a customer-match audience. |
| `replace_customer_list_members` ⚠️ | Replace every member of a customer-match audience with the supplied addresses. |

### Ad extensions, negatives, labels

| Tool | Purpose |
|---|---|
| `list_ad_extensions` | List ad extensions in the account's extension library — sitelinks, callouts, structured snippets, call, image, price, promotion, and review extensions. |
| `list_ad_extension_associations` | Show which ad extensions are attached to which campaigns or ad groups. |
| `create_ad_extensions` | Create ad extensions in the account library. |
| `update_ad_extensions` | Update ad extensions. |
| `delete_ad_extensions` ⚠️ | Permanently delete ad extensions from the account library, removing them from every campaign and ad group they were associated with. |
| `associate_ad_extensions` | Attach ad extensions to campaigns or ad groups, which is what makes them serve. |
| `remove_ad_extension_associations` ⚠️ | Detach ad extensions from campaigns or ad groups WITHOUT deleting them. |
| `list_negative_keywords` | List negative keywords set directly on campaigns or ad groups. |
| `add_negative_keywords` | Add negative keywords to one campaign or ad group, stopping ads from showing on those searches. |
| `delete_negative_keywords` ⚠️ | Remove negative keywords from a campaign or ad group. |
| `list_labels` | List labels in the account. |
| `create_labels` | Create labels. |
| `apply_labels` | Attach labels to campaigns, ad groups, ads, or keywords. |

### Conversion tracking

| Tool | Purpose |
|---|---|
| `list_uet_tags` | List Universal Event Tracking tags on the account, including the tracking script for each. |
| `create_uet_tags` | Create UET tags. |
| `list_conversion_goals` | List conversion goals with their type, attribution model, conversion window, revenue settings, and tracking status. |
| `create_conversion_goals` | Create conversion goals. |
| `update_conversion_goals` | Update conversion goals — rename them, change the conversion window, revenue value, or count type. |
| `upload_offline_conversions` | Upload conversions that happened away from the website — a phone sale, an in-store purchase, a CRM-qualified lead. |
| `adjust_offline_conversions` ⚠️ | Restate or retract a conversion already uploaded — a refund, a cancelled order, or a corrected value. |
| `send_conversion_events` | Send conversion events server-side through the Microsoft Conversions API; the per-tag credential is fetched internally and never returned. |

### Keyword planning (Ad Insight)

| Tool | Purpose |
|---|---|
| `get_keyword_ideas` | Microsoft Advertising's keyword planner: search volume, competition, and suggested bids for keyword ideas. |
| `get_keyword_traffic_estimates` | Estimate clicks, impressions, average CPC, and total cost for a set of keywords at a given bid — before spending anything on them. |
| `suggest_keywords_for_url` | Suggest keywords by reading the content of a web page. |
| `get_historical_search_count` | Historical search volume for specific terms over time, independent of any campaign. |
| `get_bid_landscape` | For existing keywords, show estimated clicks, impressions, and cost across a range of bids — the data behind 'what would happen if I bid more'. |
| `get_auction_insights` | Competitive auction data: who else shows up in the same auctions, their impression share, overlap rate, and position-above rate. |

### Bulk

| Tool | Purpose |
|---|---|
| `bulk_download` | Export an account's entities in one operation and return them grouped by record type. |
| `get_bulk_download` | Collect a bulk export that bulk_download left pending, using its download_request_id. |
| `bulk_upload` ⚠️ | Create, change, or delete many entities at once by uploading bulk records. |
| `get_bulk_upload` | Collect a bulk upload that bulk_upload left pending, using its request_id. |

### Billing

| Tool | Purpose |
|---|---|
| `get_monthly_spend` | Actual billed spend for an ad account in a given calendar month, in the account's currency. |
| `list_insertion_orders` | Insertion orders on an account — the prepaid or invoiced spending agreements that cap and fund delivery, with their budget, balance, and start/end dates. |
| `list_billing_documents` | Invoice metadata for one or more accounts over a date range — document ids, amounts, and dates. |

### Google Ads import

| Tool | Purpose |
|---|---|
| `create_google_import` | Set up a Google Ads import with new entities paused by default and deletion mirroring disabled. |
| `create_google_import_with_deletion_mirroring` ⚠️ | Set up a Google Ads import that may delete Microsoft entities removed from Google. |
| `list_google_imports` | List Google Ads import jobs configured for this account — their schedule, status, and when each last ran. |
| `get_google_import_results` | Results from completed Google Ads import runs: per-entity-type counts of additions, changes, deletions, and errors, plus an error log URL when a run had problems. |
| `delete_google_imports` ⚠️ | Delete Google Ads import jobs, stopping future scheduled runs. |
| `map_google_entity_ids` | Map Google Ads entity ids to the Microsoft Advertising ids they were imported as. |

### Escape hatch

| Tool | Purpose |
|---|---|
| `msads_raw_read` | Call a read operation from the reviewed `(service, path)` allowlist in `docs/REST-PATHS.md`. |
| `msads_raw_mutation` ⚠️ | Call an operation outside the raw-read allowlist through a conservatively destructive surface. |
| `msads_api_info` | Show how this server reaches the Microsoft Advertising API: the resolved base URL for each service, which environment is active, and which services take account headers. |

Reads whose arguments project cleanly onto a URI are also registered as MCP
resources for clients that surface them. The resource families cover accounts,
the current user, account hierarchy and detail, campaigns, ad groups, ads,
keywords, budgets, audiences, UET tags, conversion goals, monthly spend, and
the report-type registry. Each family supports its documented path template
and, where arguments are available, a `{query}` variant. Structured reads such
as report requests and keyword searches remain tools only.

## Prompts

Five MCP prompts provide reviewed multi-tool workflows:

| Prompt | Purpose |
|---|---|
| `account_audit` | Audit structure, performance, delivery blockers, wasted spend, and quality. |
| `find_wasted_spend` | Find non-converting search spend and draft negative-keyword recommendations. |
| `keyword_expansion` | Research and size keyword opportunities from required seed terms or a URL. |
| `budget_pacing` | Compare billed spend, budgets, delivery, and insertion-order constraints. |
| `google_ads_comparison` | Compare normalized Microsoft Advertising and Google Ads performance. |

## Notes that save debugging time

**Error 105 vs 106.** 105 is authentication — usually production credentials
against sandbox or vice versa. 106 is authorization — usually a mismatched
account/customer pair, which this server resolves for you.

**Use `ConversionsQualified`, not `Conversions`.** The latter was deprecated in
2022 and always returns 0. Same for `AveragePosition`.

**REST collection fields are operation-specific.** Verified campaign and
conversion-goal flag fields use comma-delimited strings, while
`GetKeywordIdeas.IdeaAttributes` is a JSON array. Do not apply one global
flags-enum serialization rule to every REST field.

**Batch writes half-succeed.** Results carry a per-item outcome list with the
assigned id or the specific error. Check `outcomes`, not just `succeeded`.
Deletes, bulk upload, removal/replacement modes, conversion retractions, and
imports with deletion mirroring are marked destructive in their MCP annotations.

**Created entities default to Paused.** Pass `Status: "Active"` explicitly to
start delivery.

**Reports may be incomplete.** Clicks settle in ~2h and conversions in ~3h;
invalid-traffic adjustments can move historical numbers a week later. When
Microsoft flags a report, the response carries a `data_warning`.

**Spend from billing ≠ spend from reports.** Reports show delivery; billing
shows what was charged after credits. Use `get_monthly_spend` for finance
questions.

## Configuration

See [.env.example](.env.example) for the full list. The essentials:

| Variable | Purpose |
|---|---|
| `MSADS_DEVELOPER_TOKEN` | Required in production |
| `MSADS_CLIENT_ID` | Entra app registration GUID |
| `MSADS_CLIENT_SECRET` | Strongly recommended (see above) |
| `MSADS_REFRESH_TOKEN` / `MSADS_TOKEN_FILE` | One is required |
| `MSADS_ACCOUNT_ID` | Default ad account |
| `MSADS_ENVIRONMENT` | `production` (default) or `sandbox` |

## Development

```bash
bun install
bun run test        # hermetic unit + protocol tests, no credentials needed
bun run typecheck
bun run lint
bun run dev         # run the server on stdio
bun run inspect     # MCP Inspector
```

Live tests hit the real API and are opt-in:

```bash
MSADS_RUN_LIVE_TESTS=true MSADS_TEST_ACCOUNT_ID=... bun run test:live
bun run test:cleanup:dry                            # find orphaned test entities
```

Design decisions are in [docs/SPEC.md](docs/SPEC.md); the API research behind
them is in [docs/RESEARCH.md](docs/RESEARCH.md).

## License

MIT
