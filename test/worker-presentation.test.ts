import assert from "node:assert/strict";
import test from "node:test";
import type { MeetingDetails } from "../src/types.js";
import { allowedMentions, liveMeetingMessage, meetingMessage } from "../src/worker-presentation.js";

const details: MeetingDetails = {
  series: {
    id: "ser_one", guildId: "guild", title: "Planning", creatorId: "organizer",
    voiceChannelId: "voice", announcementChannelId: "announcements", notifyRoleId: "guild",
    timezone: "UTC", localTime: "12:00", firstDate: "2027-01-01", frequency: "weekly",
    intervalCount: 1, weekdays: [5], monthDay: null, durationMinutes: 60,
    notificationPreset: "balanced", endsOn: null, occurrenceLimit: null,
    status: "active", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  },
  meeting: {
    id: "mtg_one", seriesId: "ser_one", guildId: "guild", startsAt: "2027-01-01T12:00:00Z",
    durationMinutes: 60, status: "scheduled", announcementChannelId: "announcements",
    announcementMessageId: "message", voiceChannelId: "voice", notifyRoleId: "guild",
    notificationPreset: "balanced", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  },
  agenda: [],
  rsvps: [{ meetingId: "mtg_one", userId: "person", response: "going", updatedAt: "2026-01-01T00:00:00Z" }],
};

test("Worker meeting cards preserve all RSVP and agenda controls", () => {
  const message = meetingMessage(details);
  const buttons = message.components?.[0]?.components as Record<string, unknown>[];
  assert.deepEqual(buttons.map((button) => button.custom_id), [
    "rsvp:going:mtg_one", "rsvp:maybe:mtg_one", "rsvp:no:mtg_one",
    "agenda-add:mtg_one", "agenda-edit:mtg_one",
  ]);
});

test("Worker start message reports RSVP attendance without claiming live voice state", () => {
  const message = liveMeetingMessage(details);
  const fields = message.embeds?.[0]?.fields as { name: string; value: string }[];
  assert.match(fields[1]!.name, /RSVP'd Going/);
  assert.match(fields[1]!.value, /<@person>/);
  assert.equal(fields.some((field) => /in the room/i.test(field.name)), false);
});

test("only the selected role can be mentioned", () => {
  assert.deepEqual(allowedMentions("guild", "guild"), { parse: ["everyone"], roles: [], users: [] });
  assert.deepEqual(allowedMentions("role", "guild"), { parse: [], roles: ["role"], users: [] });
  assert.deepEqual(allowedMentions(null, "guild"), { parse: [], roles: [], users: [] });
});
