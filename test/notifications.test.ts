import assert from "node:assert/strict";
import test from "node:test";
import { dueReminderRules, mostRelevantReminder } from "../src/notifications.js";

test("balanced notifications ping the selected audience at 8 hours and 10 minutes", () => {
  const startsAt = "2027-01-02T12:00:00Z";
  const eightHours = dueReminderRules("balanced", startsAt, new Date("2027-01-02T04:00:00Z"), new Set());
  assert.deepEqual(eightHours.map((item) => [item.key, item.mention]), [["8h", "role"]]);

  const tenMinutes = dueReminderRules("balanced", startsAt, new Date("2027-01-02T11:50:00Z"), new Set(["8h"]));
  assert.deepEqual(tenMinutes.map((item) => [item.key, item.mention]), [["10m", "role"]]);
});

test("a restart sends only the most relevant overdue reminder", () => {
  const rules = dueReminderRules("high", "2027-01-02T12:00:00Z", new Date("2027-01-02T11:55:00Z"), new Set());
  assert.equal(mostRelevantReminder(rules)?.key, "10m");
});

test("no reminder is due after a meeting begins", () => {
  assert.deepEqual(dueReminderRules("high", "2027-01-02T12:00:00Z", new Date("2027-01-02T12:01:00Z"), new Set()), []);
});
