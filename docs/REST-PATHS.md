# Verified REST paths

Every path below was read from the `pivot="rest"` block of its operation's
reference page on learn.microsoft.com, not inferred from a naming pattern.
Inference gets some of them wrong — `SuggestKeywordsForUrl` lives under
`KeywordSuggestions`, and Bulk's REST prefix bears no resemblance to its SOAP one.

## Grammar

```
https://{subdomain}.api[.sandbox].bingads.microsoft.com/{ServiceArea}/v13/{path}
```

- **Add** → `POST` to the bare collection
- **Update** → `PUT` to the same bare collection
- **Delete** → `DELETE` to the same bare collection
- **Read** → `POST` to a verb suffix (`/QueryByIds`, `/Query`, `/Search`, `/Find`, `/Set`, `/Apply`)

Reads are POSTs with a JSON body. There are no GETs and no query-string
parameters anywhere in v13.

The verb is often the *only* thing distinguishing three operations —
`Campaigns` serves Add, Update, and Delete.

## Hosts

| Service | Subdomain | Service area | Account headers |
|---|---|---|---|
| Customer Management | `clientcenter` | `CustomerManagement` | **No** |
| Customer Billing | `clientcenter` | `CustomerBilling` | **No** |
| Campaign Management | `campaign` | `CampaignManagement` | Yes |
| Reporting | `reporting` | `Reporting` | Yes |
| Bulk | `bulk` | `Bulk` | Yes |
| Ad Insight | `adinsight` | `AdInsight` | Yes |

## Customer Management

| Operation | Verb | Path |
|---|---|---|
| GetUser | POST | `User/Query` |
| GetAccountsInfo | POST | `AccountsInfo/Query` |
| SearchAccounts | POST | `Accounts/Search` |
| FindAccountsOrCustomersInfo | POST | `AccountsOrCustomersInfo/Find` |
| GetCustomersInfo | POST | `CustomersInfo/Query` |
| GetAccount | POST | `Account/Query` |

Note the singular/plural inconsistency: `User/Query` and `Account/Query` are
singular; `AccountsInfo`, `CustomersInfo`, and `Accounts` are plural.

## Campaign Management — core entities

| Operation | Verb | Path |
|---|---|---|
| AddCampaigns / UpdateCampaigns / DeleteCampaigns | POST / PUT / DELETE | `Campaigns` |
| GetCampaignsByAccountId | POST | `Campaigns/QueryByAccountId` |
| GetCampaignsByIds | POST | `Campaigns/QueryByIds` |
| AddAdGroups / Update / Delete | POST / PUT / DELETE | `AdGroups` |
| GetAdGroupsByCampaignId | POST | `AdGroups/QueryByCampaignId` |
| GetAdGroupsByIds | POST | `AdGroups/QueryByIds` |
| AddAds / Update / Delete | POST / PUT / DELETE | `Ads` |
| GetAdsByAdGroupId | POST | `Ads/QueryByAdGroupId` |
| AddKeywords / Update / Delete | POST / PUT / DELETE | `Keywords` |
| GetKeywordsByAdGroupId | POST | `Keywords/QueryByAdGroupId` |
| AddBudgets | POST | `Budgets` |
| GetBudgetsByIds | POST | `Budgets/QueryByIds` |

## Campaign Management — targeting

| Operation | Verb | Path |
|---|---|---|
| Add/Update/DeleteCampaignCriterions | POST / PUT / DELETE | `CampaignCriterions` |
| GetCampaignCriterionsByIds | POST | `CampaignCriterions/QueryByIds` |
| Add/Update/DeleteAdGroupCriterions | POST / PUT / DELETE | `AdGroupCriterions` |
| GetAdGroupCriterionsByIds | POST | `AdGroupCriterions/QueryByIds` |
| GetProfileDataFileUrl | POST | `ProfileDataFileUrl/Query` |
| SearchCompanies | POST | `Companies/Search` |
| GetGeoLocationsFileUrl | POST | `GeoLocationsFileUrl/Query` |

## Campaign Management — audiences

| Operation | Verb | Path |
|---|---|---|
| AddAudiences / Update / Delete | POST / PUT / DELETE | `Audiences` |
| GetAudiencesByIds | POST | `Audiences/QueryByIds` |
| ApplyCustomerListUserData | POST | `CustomerListUserData/Apply` |
| ~~ApplyCustomerListItems~~ | POST | `CustomerListItems/Apply` — **deprecated** |

## Campaign Management — extensions, negatives, labels

| Operation | Verb | Path |
|---|---|---|
| AddAdExtensions / Update / Delete | POST / PUT / DELETE | `AdExtensions` |
| GetAdExtensionsByIds | POST | `AdExtensions/QueryByIds` |
| GetAdExtensionIdsByAccountId | POST | `AdExtensionIds/QueryByAccountId` |
| SetAdExtensionsAssociations | POST | `AdExtensionsAssociations/Set` |
| GetAdExtensionsAssociations | POST | `AdExtensionsAssociations/Query` |
| DeleteAdExtensionsAssociations | DELETE | `AdExtensionsAssociations` |
| Add/DeleteNegativeKeywordsToEntities | POST / DELETE | `EntityNegativeKeywords` |
| GetNegativeKeywordsByEntityIds | POST | `NegativeKeywords/QueryByEntityIds` |
| AddSharedEntity | POST | `SharedEntity` (singular) |
| GetSharedEntitiesByAccountId | POST | `SharedEntities/QueryByAccountId` (plural) |
| Add/DeleteListItemsFromSharedList | POST / DELETE | `ListItems` |
| SetSharedEntityAssociations | POST | `SharedEntityAssociations/Set` |
| AddLabels | POST | `Labels` |
| GetLabelsByIds | POST | `Labels/QueryByIds` |
| SetLabelAssociations | POST | `LabelAssociations/Set` |
| GetLabelAssociationsByEntityIds | POST | `LabelAssociations/QueryByEntityIds` |

## Campaign Management — conversions

| Operation | Verb | Path |
|---|---|---|
| AddUetTags / UpdateUetTags | POST / PUT | `UetTags` |
| GetUetTagsByIds | POST | `UetTags/QueryByIds` |
| GetUetTagAuthKey | POST | `UetTagAuthKey/Query` |
| AddConversionGoals / Update | POST / PUT | `ConversionGoals` |
| GetConversionGoalsByIds | POST | `ConversionGoals/QueryByIds` |
| GetConversionGoalsByTagIds | POST | `ConversionGoals/QueryByTagIds` |
| ApplyOfflineConversions | POST | `OfflineConversions/Apply` |
| ApplyOfflineConversionAdjustments | POST | `OfflineConversionAdjustments/Apply` |
| ApplyOnlineConversionAdjustments | POST | `OnlineConversionAdjustments/Apply` |

`GetUetTagAuthKey` has conflicting documentation: the generated service
reference takes `UetTagId` and returns a flat `UetTagAuthKey`, while the CAPI
guide shows `TagId` in and a nested `TagAuthKey.AuthKey` out. We send the
former and accept either response shape.

## Campaign Management — Google Ads import

| Operation | Verb | Path |
|---|---|---|
| AddImportJobs / Update / Delete | POST / PUT / DELETE | `ImportJobs` |
| GetImportJobsByIds | POST | `ImportJobs/QueryByIds` |
| GetImportResults | POST | `ImportResults/Query` |
| GetImportEntityIdsMapping | POST | `ImportEntityIdsMapping/Query` |

## Reporting

| Operation | Verb | Path |
|---|---|---|
| SubmitGenerateReport | POST | `GenerateReport/Submit` |
| PollGenerateReport | POST | `GenerateReport/Poll` |

## Bulk

| Operation | Verb | Path |
|---|---|---|
| DownloadCampaignsByAccountIds | POST | `Campaigns/DownloadByAccountIds` |
| DownloadCampaignsByCampaignIds | POST | `Campaigns/DownloadByCampaignIds` |
| GetBulkDownloadStatus | POST | `BulkDownloadStatus/Query` |
| GetBulkUploadUrl | POST | `BulkUploadUrl/Query` |
| GetBulkUploadStatus | POST | `BulkUploadStatus/Query` |

The bulk *upload* itself is a `multipart/form-data` POST to the URL that
`GetBulkUploadUrl` returns. That endpoint does **not** use `Authorization:
Bearer` — it takes the raw token in an `AuthenticationToken` header, the
SOAP-era convention kept for this one call. Each URL is single-use.

## Ad Insight

| Operation | Verb | Path |
|---|---|---|
| GetKeywordIdeas | POST | `KeywordIdeas/Query` |
| GetKeywordTrafficEstimates | POST | `KeywordTrafficEstimates/Query` |
| SuggestKeywordsForUrl | POST | `KeywordSuggestions/QueryByUrl` |
| GetHistoricalSearchCount | POST | `HistoricalSearchCount/Query` |
| GetBidLandscapeByKeywordIds | POST | `BidLandscape/QueryByKeywordIds` |
| GetAuctionInsightData | POST | `AuctionInsightData/Query` |

Note `SuggestKeywordsForUrl` maps to a `KeywordSuggestions` resource — the one
path that does not follow from the operation name.

## Customer Billing

| Operation | Verb | Path |
|---|---|---|
| GetAccountMonthlySpend | POST | `AccountMonthlySpend/Query` |
| SearchInsertionOrders | POST | `InsertionOrders/Search` |
| GetBillingDocumentsInfo | POST | `BillingDocumentsInfo/Query` |

## Body conventions

- 64-bit ids are JSON **strings**; ints and doubles are bare numbers.
- Derived types carry a `Type` discriminator (`"Type": "GoogleImportJob"`).
- Flags-style serialization is field-specific in REST/JSON; do not apply the
  SOAP flags-enum rule globally. Verified campaign `ReturnAdditionalFields`,
  `ConversionGoalTypes`, and association `AdExtensionType` values are
  **comma-delimited strings**. Other operations must be checked individually.
- `GetKeywordIdeas.IdeaAttributes` is a JSON array in the official REST request
  template and remains an array here.
- `ForwardCompatibilityMap` entries use lowercase `key` / `value`, unlike every
  other field in the API.
