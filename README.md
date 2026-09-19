# Discord Meeting Bot

A focused Discord bot for recurring voice meetings: schedule a series, collect RSVPs, build the agenda together, send useful reminders, and post the live agenda and attendance in the voice room's text chat.

The bot never joins the call, records audio, or reads ordinary messages.

## What it does

- Creates one-time, daily, weekly, biweekly, multi-weekday, and monthly meeting series
- Keeps meetings at the same local time across daylight-saving changes
- Gives every occurrence its own RSVPs, agenda, status, and history
- Offers one-click **Going**, **Maybe**, and **Can't attend** responses
- Lets every server member add and edit agenda items
- Rolls unfinished agenda items into the next occurrence
- Automatically starts and ends meetings at their scheduled times
- Posts the live agenda and RSVP attendance list in the voice room's chat
- Supports skipping, canceling, and rescheduling a single occurrence
- Uses a fixed, low-noise reminder schedule with a selectable role or no ping
- Keeps all announcements and reminders in the chosen channel—never in DMs
- Persists everything in a local SQLite database

## Notification philosophy

The notification system is deliberately small and predictable:

| Event | Default behavior |
| --- | --- |
| New occurrence | Quiet meeting card with agenda and RSVP buttons |
| 8 hours before | Reminder with RSVP buttons; pings the selected role (`@everyone` by default) or nobody |
| 10 minutes before | Second reminder with RSVP buttons; same audience choice |
| Agenda or RSVP edit | Meeting card updates silently |
| Cancellation or reschedule | The selected role is notified, or the update is posted without a ping |
| Meeting time | Live agenda and RSVP attendance appear in the voice room's chat without a ping |

The bot never sends direct messages or pings individual RSVP respondents. RSVP buttons remain open before and during the meeting, and close when the occurrence is completed, canceled, or skipped.

## Discord commands

- `/series create` — open a private setup wizard for a one-time or recurring series
- `/series list|pause|resume|stop` — manage a series
- `/meeting list|show|start|end|cancel|skip|reschedule` — manage one occurrence
- `/agenda add|edit|remove|done|reopen|list` — collaborate on the agenda
- `/meeting-help` — show concise help inside Discord

Only the organizer or a member with **Manage Events** can change lifecycle state. Agenda editing is intentionally open to everyone.

## Set up the Discord application

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Open **Bot**, create the bot user, and copy its token.
3. Open **OAuth2 → URL Generator** and select the `bot` and `applications.commands` scopes.
4. Give the bot these permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Read Message History
   - Mention Everyone
   - Use Application Commands
5. Use the generated URL to add the bot to your server.
6. Copy `.env.example` to `.env` and fill in the token and application ID.

No privileged gateway intents or Message Content intent are required.

## Run locally

Node.js 24 or newer is required.

```sh
npm install
cp .env.example .env
# Edit .env with your Discord values.
set -a; source .env; set +a
npm run dev
```

Set `DISCORD_GUILD_IDS` to a comma-separated list of servers where commands should update immediately. If it is omitted, the bot registers global commands, which Discord can take longer to distribute. The older singular `DISCORD_GUILD_ID` setting is still accepted.

For a production-style local run:

```sh
npm run build
npm start
```

## Deploy free on Cloudflare Workers

The production deployment uses Cloudflare Workers and D1, so no laptop or always-on server is required.

```sh
npm install
npx wrangler login
npx wrangler d1 create discord-meeting-bot
# Put the returned database_id in wrangler.toml.
npm run d1:migrate
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npm run deploy:worker
```

After deployment, set the Worker's URL as the application's **Interactions Endpoint URL** in Discord's Developer Portal. The scheduled Worker runs once per minute to deliver reminders and start/end meetings. D1 stores meeting series, occurrences, agendas, RSVPs, setup drafts, and sent-reminder history.

Cloudflare receives slash commands and components over Discord's HTTP interactions API. Because this deployment does not keep a Gateway connection open, the meeting-start message lists people who RSVP'd Going rather than reading live voice-channel membership.

## Run the Gateway version with Docker

```sh
docker build -t discord-meeting-bot .
docker run --env-file .env -v meeting-bot-data:/app/data discord-meeting-bot
```

Keep `/app/data` on a persistent volume. The bot uses one SQLite database and is intended to run as a single process.

## Scheduling details

- Dates use `YYYY-MM-DD`.
- Times use 24-hour `HH:mm`.
- Timezones use IANA names such as `America/Los_Angeles`, `America/New_York`, or `Europe/London`.
- For selected weekdays, enter values such as `mon,wed,fri`.
- Setting **Repeat every** to `2` with a weekly schedule creates a biweekly series.
- Monthly meetings created on the 29th–31st use the final day in shorter months.
- `ends-on` and `ends-after` are mutually exclusive.
- Finishing, skipping, or canceling an occurrence publishes the next meeting card.
- If nobody manually ends a live meeting, it ends automatically after its configured duration.

## Development

```sh
npm run check
npm test
npm run build
```

The test suite covers recurrence across daylight-saving changes, multi-weekday and monthly schedules, reminder selection, SQLite persistence, RSVPs, and agenda rollover. GitHub Actions runs all three checks on every push and pull request.

## Data and deployment

The Gateway version's default database is `./data/meetings.sqlite`. Override it with `DATABASE_PATH`. The Cloudflare deployment uses the D1 database configured in `wrangler.toml`.

SQLite keeps installation simple and is appropriate for a single bot process. For a large multi-instance deployment, the `MeetingDatabase` class is the seam to replace with PostgreSQL while leaving the Discord and scheduling behavior intact.

## License

[MIT](LICENSE)
