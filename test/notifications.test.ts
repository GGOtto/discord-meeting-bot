import assert from "node:assert/strict";
import test from "node:test";
import { dueReminderRules, mostRelevantReminder } from "../src/notifications.js";

test("balanced notifications are quiet at 24 hours and targeted at 10 minutes", () => {
  const startsAt = "2027-01-02T12:00:00Z";
  const dayBefore = dueReminderRules("balanced", startsAt, new Date("2027-01-01T12:00:00Z"), new Set());
  assert.deepEqual(dayBefore.map((item) => [item.key, item.mention]), [["24h", "none"]]);

  const tenMinutes = dueReminderRules("balanced", startsAt, new Date("2027-01-02T11:50:00Z"), new Set(["24h"]));
  assert.deepEqual(tenMinutes.map((item) => [item.key, item.mention]), [["10m", "attendees"]]);
});

test("a restart sends only the most relevant overdue reminder", () => {
  const rules = dueReminderRules("high", "2027-01-02T12:00:00Z", new Date("2027-01-02T11:55:00Z"), new Set());
  assert.equal(mostRelevantReminder(rules)?.key, "10m");
});

test("no reminder is due after a meeting begins", () => {
  assert.deepEqual(dueReminderRules("high", "2027-01-02T12:00:00Z", new Date("2027-01-02T12:01:00Z"), new Set()), []);
});
