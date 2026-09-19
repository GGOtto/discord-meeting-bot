import { DateTime, IANAZone } from "luxon";
import type { MeetingSeries } from "./types.js";

const WEEKDAYS: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7,
};

export function parseWeekdays(input: string | null | undefined): number[] {
  if (!input?.trim()) return [];
  const values = input
    .split(",")
    .map((value) => WEEKDAYS[value.trim().toLowerCase()])
    .filter((value): value is number => value !== undefined);
  const tokens = input.split(",").filter((value) => value.trim());
  if (values.length !== tokens.length) {
    throw new Error("Weekdays must be comma-separated names such as mon,wed,fri");
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export function validateSchedule(date: string, time: string, timezone: string): DateTime {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("The date must use YYYY-MM-DD");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("The time must use 24-hour HH:mm");
  if (!IANAZone.isValidZone(timezone)) throw new Error(`Unknown timezone: ${timezone}`);

  const result = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  if (!result.isValid || result.toFormat("yyyy-MM-dd") !== date || result.toFormat("HH:mm") !== time) {
    throw new Error("That local date and time does not exist in the selected timezone");
  }
  return result;
}

export function firstOccurrenceIso(date: string, time: string, timezone: string): string {
  return validateSchedule(date, time, timezone).toUTC().toISO({ suppressMilliseconds: true })!;
}

function atSeriesTime(date: DateTime, series: MeetingSeries): DateTime {
  const [hourText, minuteText] = series.localTime.split(":");
  return date.set({
    hour: Number(hourText),
    minute: Number(minuteText),
    second: 0,
    millisecond: 0,
  });
}

export function nextOccurrenceIso(series: MeetingSeries, afterIso: string): string | null {
  if (series.frequency === "once" || series.status !== "active") return null;

  const after = DateTime.fromISO(afterIso, { zone: "utc" }).setZone(series.timezone);
  const first = validateSchedule(series.firstDate, series.localTime, series.timezone);
  let candidate: DateTime | null = null;

  if (series.frequency === "daily") {
    const elapsedDays = Math.max(0, Math.floor(after.startOf("day").diff(first.startOf("day"), "days").days));
    const jumps = Math.floor(elapsedDays / series.intervalCount) + 1;
    candidate = atSeriesTime(first.plus({ days: jumps * series.intervalCount }), series);
  }

  if (series.frequency === "weekly") {
    const weekdays = series.weekdays.length ? series.weekdays : [first.weekday];
    let cursor = after.startOf("day").plus({ days: 1 });
    for (let scanned = 0; scanned < 3660; scanned += 1) {
      const weeksFromStart = Math.floor(cursor.startOf("week").diff(first.startOf("week"), "weeks").weeks);
      if (weeksFromStart >= 0 && weeksFromStart % series.intervalCount === 0 && weekdays.includes(cursor.weekday)) {
        candidate = atSeriesTime(cursor, series);
        break;
      }
      cursor = cursor.plus({ days: 1 });
    }
  }

  if (series.frequency === "monthly") {
    const monthDay = series.monthDay ?? first.day;
    const monthsFromStart = Math.max(
      0,
      (after.year - first.year) * 12 + after.month - first.month,
    );
    let jumps = Math.floor(monthsFromStart / series.intervalCount) + 1;
    for (let scanned = 0; scanned < 1200; scanned += 1) {
      const month = first.startOf("month").plus({ months: jumps * series.intervalCount });
      const day = Math.min(monthDay, month.daysInMonth ?? monthDay);
      const possible = atSeriesTime(month.set({ day }), series);
      if (possible > after) {
        candidate = possible;
        break;
      }
      jumps += 1;
    }
  }

  if (!candidate?.isValid) return null;
  if (series.endsOn && candidate.toFormat("yyyy-MM-dd") > series.endsOn) return null;
  return candidate.toUTC().toISO({ suppressMilliseconds: true });
}

export function describeRecurrence(series: MeetingSeries): string {
  if (series.frequency === "once") return "Does not repeat";
  const every = series.intervalCount === 1 ? "Every" : `Every ${series.intervalCount}`;
  if (series.frequency === "daily") return `${every}${series.intervalCount === 1 ? " day" : " days"}`;
  if (series.frequency === "weekly") {
    const names = series.weekdays.map((day) => ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day]);
    return `${every}${series.intervalCount === 1 ? " week" : " weeks"} on ${names.join(", ")}`;
  }
  return `${every}${series.intervalCount === 1 ? " month" : " months"} on day ${series.monthDay}`;
}
