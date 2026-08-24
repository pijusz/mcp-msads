import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPrompts } from "@/prompts/index";
import { registerAllTools } from "@/tools/index";
import pkg from "../package.json";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-msads",
    version: pkg.version,
  });

  registerAllTools(server);
  registerPrompts(server);

  return server;
}
