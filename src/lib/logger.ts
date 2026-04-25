type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

function log(level: LogLevel, message: string, data?: object) {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...data as Record<string, unknown>,
  };

  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(JSON.stringify(entry));
}

export const logger = {
  debug: (msg: string, data?: object) => log("debug", msg, data),
  info: (msg: string, data?: object) => log("info", msg, data),
  warn: (msg: string, data?: object) => log("warn", msg, data),
  error: (msg: string, data?: object) => log("error", msg, data),
};
