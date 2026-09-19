import path from "node:path";

export interface Config {
  token: string;
  clientId: string;
  guildId?: string;
  databasePath: string;
  schedulerIntervalMs: number;
  logLevel: string;
  defaultTimezone: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): Config {
  const schedulerIntervalMs = Number(process.env.SCHEDULER_INTERVAL_MS ?? "15000");
  if (!Number.isFinite(schedulerIntervalMs) || schedulerIntervalMs < 5000) {
    throw new Error("SCHEDULER_INTERVAL_MS must be a number of at least 5000");
  }

  const config: Config = {
    token: required("DISCORD_TOKEN"),
    clientId: required("DISCORD_CLIENT_ID"),
    databasePath: path.resolve(process.env.DATABASE_PATH ?? "./data/meetings.sqlite"),
    schedulerIntervalMs,
    logLevel: process.env.LOG_LEVEL ?? "info",
    defaultTimezone: process.env.DEFAULT_TIMEZONE?.trim() || "America/Los_Angeles",
  };
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  if (guildId) config.guildId = guildId;
  return config;
}
