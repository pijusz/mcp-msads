const PREFIX = "[mcp-msads]";

type Level = "error" | "warn" | "info" | "debug";

const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel(): Level {
  const raw = (process.env.MSADS_LOG_LEVEL ?? "warn").toLowerCase();
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") {
    return raw;
  }
  return "warn";
}

function shouldLog(level: Level): boolean {
  return LEVELS[level] <= LEVELS[currentLevel()];
}

/**
 * stderr-only logger. stdout is the MCP stdio transport — anything written
 * there corrupts the JSON-RPC stream, so every level goes to console.error.
 */
export const log = {
  info: (...args: unknown[]) => {
    if (shouldLog("info")) console.error(PREFIX, ...args);
  },
  warn: (...args: unknown[]) => {
    if (shouldLog("warn")) console.error(PREFIX, "WARN", ...args);
  },
  error: (...args: unknown[]) => {
    if (shouldLog("error")) console.error(PREFIX, "ERROR", ...args);
  },
  debug: (...args: unknown[]) => {
    if (shouldLog("debug")) console.error(PREFIX, "DEBUG", ...args);
  },
};
