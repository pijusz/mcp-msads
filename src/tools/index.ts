import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "@/tools/accounts";
import { registerAudienceTools } from "@/tools/audiences";
import { registerBillingTools } from "@/tools/billing";
import { registerBulkTools } from "@/tools/bulk";
import { registerCampaignTools } from "@/tools/campaigns";
import { registerConversionTools } from "@/tools/conversions";
import { registerExtensionTools } from "@/tools/extensions";
import { registerImportTools } from "@/tools/import-jobs";
import { registerInsightTools } from "@/tools/insights";
import { registerRawTools } from "@/tools/raw";
import { registerReportTools } from "@/tools/reports";
import { registerTargetingTools } from "@/tools/targeting";

/**
 * Tool registration barrel.
 *
 * Reads go through `defineRead`, which registers each one as both a tool and a
 * resource. Writes are tools only — a mutation is not a resource.
 */
export function registerAllTools(server: McpServer): void {
  registerAccountTools(server);
  registerCampaignTools(server);
  registerReportTools(server);
  registerTargetingTools(server);
  registerAudienceTools(server);
  registerExtensionTools(server);
  registerConversionTools(server);
  registerInsightTools(server);
  registerBulkTools(server);
  registerBillingTools(server);
  registerImportTools(server);
  registerRawTools(server);
}
