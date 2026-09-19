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
- Posts the live agenda, RSVP list, and current voice-room attendance
- Supports skipping, canceling, and rescheduling a single occurrence
- Provides quiet, balanced, and high-visibility notification presets
- Keeps all announcements and reminders in the chosen channel—never in DMs
- Persists everything in a local SQLite database

## Notification philosophy

The default **Balanced** preset is useful without being chatty:

| Event | Default behavior |
| --- | --- |
| New occurrence | Meeting card mentioning the invited role (`@everyone` by default) |
| 24 hours before | Reminder and current agenda, without a ping |
| 10 minutes before | Reminder mentioning Going and Maybe attendees |
| Empty agenda at 24 hours | Announcement-channel warning mentioning the organizer |
| Agenda or RSVP edit | Meeting card updates silently |
| Cancellation or reschedule | Going and Maybe attendees are notified |
| Meeting time | Live agenda and attendance appear in the voice room's chat |

The **Quiet** preset omits scheduled reminders. **High visibility** adds 24-hour, 1-hour, and 10-minute reminders and mentions the invited role at 24 hours. The bot never sends direct messages.

## Discord commands

- `/series create` — create a one-time or recurring series
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

Set `DISCORD_GUILD_ID` while developing. Guild-scoped commands update immediately. If it is omitted, the bot registers global commands, which Discord can take longer to distribute.

For a production-style local run:

```sh
npm run build
npm start
```

## Run with Docker

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
- `every: 2` with a weekly schedule creates a biweekly series.
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

The default database is `./data/meetings.sqlite`. Override it with `DATABASE_PATH`.

SQLite keeps installation simple and is appropriate for a single bot process. For a large multi-instance deployment, the `MeetingDatabase` class is the seam to replace with PostgreSQL while leaving the Discord and scheduling behavior intact.

## License

[MIT](LICENSE)
