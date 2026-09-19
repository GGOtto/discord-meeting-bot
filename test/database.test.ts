import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MeetingDatabase } from "../src/database.js";
import type { MeetingOccurrence, MeetingSeries } from "../src/types.js";

test("stores RSVPs and carries open agenda items into the next occurrence", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "meeting-bot-test-"));
  const database = new MeetingDatabase(path.join(directory, "test.sqlite"));
  const now = new Date().toISOString();
  const series: MeetingSeries = {
    id: "ser_one", guildId: "guild", title: "Planning", creatorId: "user1",
    voiceChannelId: "voice", announcementChannelId: "channel", notifyRoleId: null,
    timezone: "UTC", localTime: "12:00", firstDate: "2027-01-01", frequency: "weekly",
    intervalCount: 1, weekdays: [5], monthDay: null, durationMinutes: 60,
    notificationPreset: "balanced", endsOn: null, occurrenceLimit: null,
    status: "active", createdAt: now, updatedAt: now,
  };
  const first: MeetingOccurrence = {
    id: "mtg_one", seriesId: series.id, guildId: "guild", startsAt: "2027-01-01T12:00:00Z",
    durationMinutes: 60, status: "scheduled", announcementChannelId: "channel",
    announcementMessageId: null, voiceChannelId: "voice", notifyRoleId: null,
    notificationPreset: "balanced", createdAt: now, updatedAt: now,
  };
  const second: MeetingOccurrence = { ...first, id: "mtg_two", startsAt: "2027-01-08T12:00:00Z" };

  try {
    database.createSeries(series, first, "Carry me forward");
    database.addAgendaItem(first.id, "Already discussed", "user2");
    database.setAgendaStatus(first.id, 2, "done");
    database.upsertRsvp(first.id, "user2", "going");
    database.createNextMeeting(second, first.id);

    assert.equal(database.getMeetingDetails(first.id)?.rsvps[0]?.response, "going");
    assert.deepEqual(database.getAgenda(second.id).map((item) => item.text), ["Carry me forward"]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
