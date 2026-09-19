import type { NotificationPreset, ReminderRule } from "./types.js";

export const REMINDER_PRESETS: Record<NotificationPreset, ReminderRule[]> = {
  quiet: [],
  balanced: [
    { key: "24h", minutesBefore: 24 * 60, mention: "none" },
    { key: "10m", minutesBefore: 10, mention: "attendees" },
  ],
  high: [
    { key: "24h", minutesBefore: 24 * 60, mention: "role-and-attendees" },
    { key: "1h", minutesBefore: 60, mention: "attendees" },
    { key: "10m", minutesBefore: 10, mention: "attendees" },
  ],
};

export function dueReminderRules(
  preset: NotificationPreset,
  startsAtIso: string,
  now: Date,
  alreadySent: Set<string>,
): ReminderRule[] {
  const startsAt = new Date(startsAtIso).getTime();
  return REMINDER_PRESETS[preset].filter((rule) => {
    const dueAt = startsAt - rule.minutesBefore * 60_000;
    return !alreadySent.has(rule.key) && now.getTime() >= dueAt && now.getTime() < startsAt;
  });
}

export function mostRelevantReminder(rules: ReminderRule[]): ReminderRule | null {
  if (!rules.length) return null;
  return [...rules].sort((a, b) => a.minutesBefore - b.minutesBefore)[0] ?? null;
}
