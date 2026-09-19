import assert from "node:assert/strict";
import test from "node:test";
import { firstOccurrenceIso, nextOccurrenceIso, parseWeekdays } from "../src/recurrence.js";
import type { MeetingSeries } from "../src/types.js";

function series(overrides: Partial<MeetingSeries> = {}): MeetingSeries {
  return {
    id: "ser_test",
    guildId: "guild",
    title: "Team sync",
    creatorId: "creator",
    voiceChannelId: "voice",
    announcementChannelId: "announcements",
    notifyRoleId: null,
    timezone: "America/Los_Angeles",
    localTime: "10:00",
    firstDate: "2027-03-03",
    frequency: "weekly",
    intervalCount: 1,
    weekdays: [3],
    monthDay: null,
    durationMinutes: 60,
    notificationPreset: "balanced",
    endsOn: null,
    occurrenceLimit: null,
    status: "active",
    createdAt: "2027-01-01T00:00:00Z",
    updatedAt: "2027-01-01T00:00:00Z",
    ...overrides,
  };
}

test("parses friendly weekday lists", () => {
  assert.deepEqual(parseWeekdays("Mon, wednesday, FRI"), [1, 3, 5]);
  assert.throws(() => parseWeekdays("mon,funday"), /Weekdays/);
});

test("weekly recurrence stays at the same local time across DST", () => {
  const first = firstOccurrenceIso("2027-03-10", "10:00", "America/Los_Angeles");
  const next = nextOccurrenceIso(series({ firstDate: "2027-03-10" }), first);
  assert.equal(first, "2027-03-10T18:00:00Z");
  assert.equal(next, "2027-03-17T17:00:00Z");
});

test("weekly recurrence supports multiple weekdays", () => {
  const item = series({ firstDate: "2027-03-01", weekdays: [1, 3] });
  const first = firstOccurrenceIso(item.firstDate, item.localTime, item.timezone);
  assert.equal(nextOccurrenceIso(item, first), "2027-03-03T18:00:00Z");
});

test("monthly recurrence clamps to the final day of short months", () => {
  const item = series({
    firstDate: "2027-01-31",
    frequency: "monthly",
    weekdays: [],
    monthDay: 31,
  });
  const first = firstOccurrenceIso(item.firstDate, item.localTime, item.timezone);
  assert.equal(nextOccurrenceIso(item, first), "2027-02-28T18:00:00Z");
});

test("recurrence respects its end date", () => {
  const item = series({ firstDate: "2027-03-03", endsOn: "2027-03-03" });
  const first = firstOccurrenceIso(item.firstDate, item.localTime, item.timezone);
  assert.equal(nextOccurrenceIso(item, first), null);
});
