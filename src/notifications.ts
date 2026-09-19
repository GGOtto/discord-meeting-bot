import type { NotificationPreset, ReminderRule } from "./types.js";

export const REMINDER_PRESETS: Record<NotificationPreset, ReminderRule[]> = {
  // Preset names remain in storage for compatibility with existing databases.
  // The user-facing behavior is now one fixed, intentionally small schedule.
  quiet: [
    { key: "8h", minutesBefore: 8 * 60, mention: "role" },
    { key: "10m", minutesBefore: 10, mention: "role" },
  ],
  balanced: [
    { key: "8h", minutesBefore: 8 * 60, mention: "role" },
    { key: "10m", minutesBefore: 10, mention: "role" },
  ],
  high: [
    { key: "8h", minutesBefore: 8 * 60, mention: "role" },
    { key: "10m", minutesBefore: 10, mention: "role" },
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
