import { loadConfig } from "./config.js";
import { MeetingBot } from "./bot.js";
import { MeetingDatabase } from "./database.js";

const config = loadConfig();
const database = new MeetingDatabase(config.databasePath);
const bot = new MeetingBot(config, database);

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down`);
  await bot.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => console.error("Unhandled rejection", error));

await bot.start();
