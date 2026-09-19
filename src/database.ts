import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  AgendaItem,
  MeetingDetails,
  MeetingOccurrence,
  MeetingSeries,
  MeetingStatus,
  Rsvp,
  RsvpResponse,
  SeriesStatus,
  UserNotificationMode,
} from "./types.js";

type SqlValue = string | number | bigint | null;

function jsonArray(value: unknown): number[] {
  if (typeof value !== "string") return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === "number") : [];
}

function mapSeries(row: Record<string, unknown>): MeetingSeries {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    title: String(row.title),
    creatorId: String(row.creator_id),
    voiceChannelId: String(row.voice_channel_id),
    announcementChannelId: String(row.announcement_channel_id),
    notifyRoleId: row.notify_role_id === null ? null : String(row.notify_role_id),
    timezone: String(row.timezone),
    localTime: String(row.local_time),
    firstDate: String(row.first_date),
    frequency: row.frequency as MeetingSeries["frequency"],
    intervalCount: Number(row.interval_count),
    weekdays: jsonArray(row.weekdays_json),
    monthDay: row.month_day === null ? null : Number(row.month_day),
    durationMinutes: Number(row.duration_minutes),
    notificationPreset: row.notification_preset as MeetingSeries["notificationPreset"],
    endsOn: row.ends_on === null ? null : String(row.ends_on),
    occurrenceLimit: row.occurrence_limit === null ? null : Number(row.occurrence_limit),
    status: row.status as MeetingSeries["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMeeting(row: Record<string, unknown>): MeetingOccurrence {
  return {
    id: String(row.id),
    seriesId: String(row.series_id),
    guildId: String(row.guild_id),
    startsAt: String(row.starts_at),
    durationMinutes: Number(row.duration_minutes),
    status: row.status as MeetingOccurrence["status"],
    announcementChannelId: String(row.announcement_channel_id),
    announcementMessageId: row.announcement_message_id === null ? null : String(row.announcement_message_id),
    voiceChannelId: String(row.voice_channel_id),
    notifyRoleId: row.notify_role_id === null ? null : String(row.notify_role_id),
    notificationPreset: row.notification_preset as MeetingOccurrence["notificationPreset"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapAgenda(row: Record<string, unknown>): AgendaItem {
  return {
    id: Number(row.id),
    meetingId: String(row.meeting_id),
    position: Number(row.position),
    text: String(row.text),
    status: row.status as AgendaItem["status"],
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRsvp(row: Record<string, unknown>): Rsvp {
  return {
    meetingId: String(row.meeting_id),
    userId: String(row.user_id),
    response: row.response as RsvpResponse,
    updatedAt: String(row.updated_at),
  };
}

export class MeetingDatabase {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meeting_series (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        title TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        voice_channel_id TEXT NOT NULL,
        announcement_channel_id TEXT NOT NULL,
        notify_role_id TEXT,
        timezone TEXT NOT NULL,
        local_time TEXT NOT NULL,
        first_date TEXT NOT NULL,
        frequency TEXT NOT NULL CHECK(frequency IN ('once','daily','weekly','monthly')),
        interval_count INTEGER NOT NULL DEFAULT 1,
        weekdays_json TEXT NOT NULL DEFAULT '[]',
        month_day INTEGER,
        duration_minutes INTEGER NOT NULL DEFAULT 60,
        notification_preset TEXT NOT NULL DEFAULT 'balanced',
        ends_on TEXT,
        occurrence_limit INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meeting_occurrences (
        id TEXT PRIMARY KEY,
        series_id TEXT NOT NULL REFERENCES meeting_series(id) ON DELETE CASCADE,
        guild_id TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        announcement_channel_id TEXT NOT NULL,
        announcement_message_id TEXT,
        voice_channel_id TEXT NOT NULL,
        notify_role_id TEXT,
        notification_preset TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_occurrences_schedule
      ON meeting_occurrences(status, starts_at);

      CREATE TABLE IF NOT EXISTS agenda_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL REFERENCES meeting_occurrences(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rsvps (
        meeting_id TEXT NOT NULL REFERENCES meeting_occurrences(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        response TEXT NOT NULL CHECK(response IN ('going','maybe','no')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (meeting_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS sent_notifications (
        meeting_id TEXT NOT NULL REFERENCES meeting_occurrences(id) ON DELETE CASCADE,
        notification_key TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (meeting_id, notification_key)
      );

      CREATE TABLE IF NOT EXISTS notification_preferences (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('channel','dm','important','off')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
    `);
  }

  private all(statement: StatementSync, ...params: SqlValue[]): Record<string, unknown>[] {
    return statement.all(...params) as Record<string, unknown>[];
  }

  createSeries(series: MeetingSeries, meeting: MeetingOccurrence, initialAgenda?: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO meeting_series (
          id, guild_id, title, creator_id, voice_channel_id, announcement_channel_id,
          notify_role_id, timezone, local_time, first_date, frequency, interval_count,
          weekdays_json, month_day, duration_minutes, notification_preset, ends_on,
          occurrence_limit, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        series.id, series.guildId, series.title, series.creatorId, series.voiceChannelId,
        series.announcementChannelId, series.notifyRoleId, series.timezone, series.localTime,
        series.firstDate, series.frequency, series.intervalCount, JSON.stringify(series.weekdays),
        series.monthDay, series.durationMinutes, series.notificationPreset, series.endsOn,
        series.occurrenceLimit, series.status, series.createdAt, series.updatedAt,
      );
      this.insertMeeting(meeting);
      if (initialAgenda?.trim()) this.insertAgenda(meeting.id, initialAgenda.trim(), series.creatorId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertMeeting(meeting: MeetingOccurrence): void {
    this.db.prepare(`
      INSERT INTO meeting_occurrences (
        id, series_id, guild_id, starts_at, duration_minutes, status,
        announcement_channel_id, announcement_message_id, voice_channel_id,
        notify_role_id, notification_preset, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      meeting.id, meeting.seriesId, meeting.guildId, meeting.startsAt, meeting.durationMinutes,
      meeting.status, meeting.announcementChannelId, meeting.announcementMessageId,
      meeting.voiceChannelId, meeting.notifyRoleId, meeting.notificationPreset,
      meeting.createdAt, meeting.updatedAt,
    );
  }

  getSeries(id: string): MeetingSeries | null {
    const row = this.db.prepare("SELECT * FROM meeting_series WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapSeries(row) : null;
  }

  listSeries(guildId: string, limit = 25): MeetingSeries[] {
    return this.all(
      this.db.prepare("SELECT * FROM meeting_series WHERE guild_id = ? AND status != 'stopped' ORDER BY created_at DESC LIMIT ?"),
      guildId,
      limit,
    ).map(mapSeries);
  }

  setSeriesStatus(id: string, status: SeriesStatus): void {
    this.db.prepare("UPDATE meeting_series SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  getMeeting(id: string): MeetingOccurrence | null {
    const row = this.db.prepare("SELECT * FROM meeting_occurrences WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapMeeting(row) : null;
  }

  getMeetingDetails(id: string): MeetingDetails | null {
    const meeting = this.getMeeting(id);
    if (!meeting) return null;
    const series = this.getSeries(meeting.seriesId);
    if (!series) return null;
    return {
      meeting,
      series,
      agenda: this.getAgenda(id),
      rsvps: this.getRsvps(id),
    };
  }

  listUpcoming(guildId: string, limit = 20): MeetingOccurrence[] {
    return this.all(
      this.db.prepare(`
        SELECT * FROM meeting_occurrences
        WHERE guild_id = ? AND status IN ('scheduled','live')
        ORDER BY starts_at ASC LIMIT ?
      `),
      guildId,
      limit,
    ).map(mapMeeting);
  }

  latestMeetingForSeries(seriesId: string): MeetingOccurrence | null {
    const row = this.db.prepare(`
      SELECT * FROM meeting_occurrences WHERE series_id = ? ORDER BY starts_at DESC LIMIT 1
    `).get(seriesId) as Record<string, unknown> | undefined;
    return row ? mapMeeting(row) : null;
  }

  openMeetingForSeries(seriesId: string): MeetingOccurrence | null {
    const row = this.db.prepare(`
      SELECT * FROM meeting_occurrences
      WHERE series_id = ? AND status IN ('scheduled','live') ORDER BY starts_at ASC LIMIT 1
    `).get(seriesId) as Record<string, unknown> | undefined;
    return row ? mapMeeting(row) : null;
  }

  cancelScheduledForSeries(seriesId: string): void {
    this.db.prepare(`
      UPDATE meeting_occurrences SET status = 'canceled', updated_at = ?
      WHERE series_id = ? AND status = 'scheduled'
    `).run(new Date().toISOString(), seriesId);
  }

  listSchedulerMeetings(): MeetingOccurrence[] {
    return this.all(this.db.prepare(`
      SELECT * FROM meeting_occurrences
      WHERE status IN ('scheduled','live') ORDER BY starts_at ASC
    `)).map(mapMeeting);
  }

  setMeetingStatus(id: string, status: MeetingStatus): void {
    this.db.prepare("UPDATE meeting_occurrences SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  setAnnouncementMessage(id: string, messageId: string): void {
    this.db.prepare("UPDATE meeting_occurrences SET announcement_message_id = ?, updated_at = ? WHERE id = ?")
      .run(messageId, new Date().toISOString(), id);
  }

  rescheduleMeeting(id: string, startsAt: string): void {
    this.db.prepare(`
      UPDATE meeting_occurrences SET starts_at = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'
    `).run(startsAt, new Date().toISOString(), id);
    this.db.prepare("DELETE FROM sent_notifications WHERE meeting_id = ?").run(id);
  }

  private insertAgenda(meetingId: string, text: string, userId: string): number {
    const position = Number(
      (this.db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM agenda_items WHERE meeting_id = ?")
        .get(meetingId) as { next: number }).next,
    );
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO agenda_items (meeting_id, position, text, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?)
    `).run(meetingId, position, text, userId, now, now);
    return Number(result.lastInsertRowid);
  }

  addAgendaItem(meetingId: string, text: string, userId: string): number {
    return this.insertAgenda(meetingId, text.trim(), userId);
  }

  getAgenda(meetingId: string): AgendaItem[] {
    return this.all(
      this.db.prepare("SELECT * FROM agenda_items WHERE meeting_id = ? ORDER BY position ASC"),
      meetingId,
    ).map(mapAgenda);
  }

  editAgendaItem(meetingId: string, position: number, text: string): boolean {
    const result = this.db.prepare(`
      UPDATE agenda_items SET text = ?, updated_at = ? WHERE meeting_id = ? AND position = ?
    `).run(text.trim(), new Date().toISOString(), meetingId, position);
    return result.changes > 0;
  }

  setAgendaStatus(meetingId: string, position: number, status: AgendaItem["status"]): boolean {
    const result = this.db.prepare(`
      UPDATE agenda_items SET status = ?, updated_at = ? WHERE meeting_id = ? AND position = ?
    `).run(status, new Date().toISOString(), meetingId, position);
    return result.changes > 0;
  }

  removeAgendaItem(meetingId: string, position: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("DELETE FROM agenda_items WHERE meeting_id = ? AND position = ?")
        .run(meetingId, position);
      if (result.changes) {
        this.db.prepare("UPDATE agenda_items SET position = position - 1 WHERE meeting_id = ? AND position > ?")
          .run(meetingId, position);
      }
      this.db.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertRsvp(meetingId: string, userId: string, response: RsvpResponse): void {
    this.db.prepare(`
      INSERT INTO rsvps (meeting_id, user_id, response, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(meeting_id, user_id) DO UPDATE SET response = excluded.response, updated_at = excluded.updated_at
    `).run(meetingId, userId, response, new Date().toISOString());
  }

  getRsvps(meetingId: string): Rsvp[] {
    return this.all(this.db.prepare("SELECT * FROM rsvps WHERE meeting_id = ? ORDER BY updated_at ASC"), meetingId)
      .map(mapRsvp);
  }

  getSentNotificationKeys(meetingId: string): Set<string> {
    const rows = this.all(
      this.db.prepare("SELECT notification_key FROM sent_notifications WHERE meeting_id = ?"),
      meetingId,
    );
    return new Set(rows.map((row) => String(row.notification_key)));
  }

  markNotificationsSent(meetingId: string, keys: string[]): void {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO sent_notifications (meeting_id, notification_key, sent_at) VALUES (?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const key of keys) statement.run(meetingId, key, now);
  }

  setNotificationPreference(guildId: string, userId: string, mode: UserNotificationMode): void {
    this.db.prepare(`
      INSERT INTO notification_preferences (guild_id, user_id, mode, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
    `).run(guildId, userId, mode, new Date().toISOString());
  }

  getDmRecipients(guildId: string, userIds: string[], importantOnly = false): string[] {
    if (!userIds.length) return [];
    const placeholders = userIds.map(() => "?").join(",");
    const acceptedModes = importantOnly ? ["dm", "important"] : ["dm"];
    const modePlaceholders = acceptedModes.map(() => "?").join(",");
    const rows = this.all(
      this.db.prepare(`
        SELECT user_id FROM notification_preferences
        WHERE guild_id = ? AND user_id IN (${placeholders}) AND mode IN (${modePlaceholders})
      `),
      guildId,
      ...userIds,
      ...acceptedModes,
    );
    return rows.map((row) => String(row.user_id));
  }

  occurrenceCount(seriesId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM meeting_occurrences WHERE series_id = ?")
      .get(seriesId) as { count: number }).count);
  }

  createNextMeeting(meeting: MeetingOccurrence, carryFromMeetingId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insertMeeting(meeting);
      const openItems = this.all(
        this.db.prepare("SELECT text, created_by FROM agenda_items WHERE meeting_id = ? AND status = 'open' ORDER BY position"),
        carryFromMeetingId,
      );
      for (const item of openItems) this.insertAgenda(meeting.id, String(item.text), String(item.created_by));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
