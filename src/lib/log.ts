// Minimal structured logger. Callers pass ids and flags only; never message
// text, card data, or payment tokens (see CLAUDE.md "Working conventions").

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const LEVELS = ["debug", "info", "warn", "error"] as const;

export function consoleLogger(minLevel: (typeof LEVELS)[number] = (process.env.LOG_LEVEL as any) ?? "info"): Logger {
  const min = LEVELS.indexOf(minLevel);
  const at = (level: (typeof LEVELS)[number]) => (msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS.indexOf(level) < min) return;
    console[level === "debug" ? "log" : level](JSON.stringify({ level, msg, ...fields }));
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
