export type Frequency = "once" | "daily" | "weekly" | "monthly";
export type NotificationPreset = "quiet" | "balanced" | "high";
export type SeriesStatus = "active" | "paused" | "stopped";
export type MeetingStatus = "scheduled" | "live" | "completed" | "canceled" | "skipped";
export type RsvpResponse = "going" | "maybe" | "no";
export type AgendaStatus = "open" | "done";

export interface MeetingSeries {
  id: string;
  guildId: string;
  title: string;
  creatorId: string;
  voiceChannelId: string;
  announcementChannelId: string;
  notifyRoleId: string | null;
  timezone: string;
  localTime: string;
  firstDate: string;
  frequency: Frequency;
  intervalCount: number;
  weekdays: number[];
  monthDay: number | null;
  durationMinutes: number;
  notificationPreset: NotificationPreset;
  endsOn: string | null;
  occurrenceLimit: number | null;
  status: SeriesStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingOccurrence {
  id: string;
  seriesId: string;
  guildId: string;
  startsAt: string;
  durationMinutes: number;
  status: MeetingStatus;
  announcementChannelId: string;
  announcementMessageId: string | null;
  voiceChannelId: string;
  notifyRoleId: string | null;
  notificationPreset: NotificationPreset;
  createdAt: string;
  updatedAt: string;
}

export interface AgendaItem {
  id: number;
  meetingId: string;
  position: number;
  text: string;
  status: AgendaStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Rsvp {
  meetingId: string;
  userId: string;
  response: RsvpResponse;
  updatedAt: string;
}

export interface MeetingDetails {
  meeting: MeetingOccurrence;
  series: MeetingSeries;
  agenda: AgendaItem[];
  rsvps: Rsvp[];
}

export interface ReminderRule {
  key: string;
  minutesBefore: number;
  mention: "none" | "role";
}
