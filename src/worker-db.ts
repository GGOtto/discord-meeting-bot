import type {
  AgendaItem,
  MeetingDetails,
  MeetingOccurrence,
  MeetingSeries,
  MeetingStatus,
  Rsvp,
  RsvpResponse,
  SeriesStatus,
} from "./types.js";

export type D1Value = string | number | null;

export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta?: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

type Row = Record<string, unknown>;

function jsonArray(value: unknown): number[] {
  if (typeof value !== "string") return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === "number") : [];
}

function mapSeries(row: Row): MeetingSeries {
  return {
    id: String(row.id), guildId: String(row.guild_id), title: String(row.title), creatorId: String(row.creator_id),
    voiceChannelId: String(row.voice_channel_id), announcementChannelId: String(row.announcement_channel_id),
    notifyRoleId: row.notify_role_id === null ? null : String(row.notify_role_id), timezone: String(row.timezone),
    localTime: String(row.local_time), firstDate: String(row.first_date), frequency: row.frequency as MeetingSeries["frequency"],
    intervalCount: Number(row.interval_count), weekdays: jsonArray(row.weekdays_json),
    monthDay: row.month_day === null ? null : Number(row.month_day), durationMinutes: Number(row.duration_minutes),
    notificationPreset: row.notification_preset as MeetingSeries["notificationPreset"],
    endsOn: row.ends_on === null ? null : String(row.ends_on),
    occurrenceLimit: row.occurrence_limit === null ? null : Number(row.occurrence_limit),
    status: row.status as MeetingSeries["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapMeeting(row: Row): MeetingOccurrence {
  return {
    id: String(row.id), seriesId: String(row.series_id), guildId: String(row.guild_id), startsAt: String(row.starts_at),
    durationMinutes: Number(row.duration_minutes), status: row.status as MeetingOccurrence["status"],
    announcementChannelId: String(row.announcement_channel_id),
    announcementMessageId: row.announcement_message_id === null ? null : String(row.announcement_message_id),
    voiceChannelId: String(row.voice_channel_id), notifyRoleId: row.notify_role_id === null ? null : String(row.notify_role_id),
    notificationPreset: row.notification_preset as MeetingOccurrence["notificationPreset"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapAgenda(row: Row): AgendaItem {
  return {
    id: Number(row.id), meetingId: String(row.meeting_id), position: Number(row.position), text: String(row.text),
    status: row.status as AgendaItem["status"], createdBy: String(row.created_by),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapRsvp(row: Row): Rsvp {
  return {
    meetingId: String(row.meeting_id), userId: String(row.user_id), response: row.response as RsvpResponse,
    updatedAt: String(row.updated_at),
  };
}

export class WorkerDatabase {
  constructor(readonly db: D1Database) {}

  private async all(statement: D1PreparedStatement): Promise<Row[]> {
    return (await statement.all<Row>()).results ?? [];
  }

  private insertMeeting(meeting: MeetingOccurrence): D1PreparedStatement {
    return this.db.prepare(`
      INSERT INTO meeting_occurrences (
        id, series_id, guild_id, starts_at, duration_minutes, status,
        announcement_channel_id, announcement_message_id, voice_channel_id,
        notify_role_id, notification_preset, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      meeting.id, meeting.seriesId, meeting.guildId, meeting.startsAt, meeting.durationMinutes, meeting.status,
      meeting.announcementChannelId, meeting.announcementMessageId, meeting.voiceChannelId, meeting.notifyRoleId,
      meeting.notificationPreset, meeting.createdAt, meeting.updatedAt,
    );
  }

  async createSeries(series: MeetingSeries, meeting: MeetingOccurrence): Promise<void> {
    await this.db.batch([
      this.db.prepare(`
        INSERT INTO meeting_series (
          id, guild_id, title, creator_id, voice_channel_id, announcement_channel_id,
          notify_role_id, timezone, local_time, first_date, frequency, interval_count,
          weekdays_json, month_day, duration_minutes, notification_preset, ends_on,
          occurrence_limit, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        series.id, series.guildId, series.title, series.creatorId, series.voiceChannelId,
        series.announcementChannelId, series.notifyRoleId, series.timezone, series.localTime,
        series.firstDate, series.frequency, series.intervalCount, JSON.stringify(series.weekdays),
        series.monthDay, series.durationMinutes, series.notificationPreset, series.endsOn,
        series.occurrenceLimit, series.status, series.createdAt, series.updatedAt,
      ),
      this.insertMeeting(meeting),
    ]);
  }

  async getSeries(id: string): Promise<MeetingSeries | null> {
    const row = await this.db.prepare("SELECT * FROM meeting_series WHERE id = ?").bind(id).first<Row>();
    return row ? mapSeries(row) : null;
  }

  async listSeries(guildId: string, limit = 25): Promise<MeetingSeries[]> {
    return (await this.all(this.db.prepare(
      "SELECT * FROM meeting_series WHERE guild_id = ? AND status != 'stopped' ORDER BY created_at DESC LIMIT ?",
    ).bind(guildId, limit))).map(mapSeries);
  }

  async setSeriesStatus(id: string, status: SeriesStatus): Promise<void> {
    await this.db.prepare("UPDATE meeting_series SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, new Date().toISOString(), id).run();
  }

  async getMeeting(id: string): Promise<MeetingOccurrence | null> {
    const row = await this.db.prepare("SELECT * FROM meeting_occurrences WHERE id = ?").bind(id).first<Row>();
    return row ? mapMeeting(row) : null;
  }

  async getMeetingDetails(id: string): Promise<MeetingDetails | null> {
    const meeting = await this.getMeeting(id);
    if (!meeting) return null;
    const [series, agenda, rsvps] = await Promise.all([
      this.getSeries(meeting.seriesId), this.getAgenda(id), this.getRsvps(id),
    ]);
    return series ? { meeting, series, agenda, rsvps } : null;
  }

  async listUpcoming(guildId: string, limit = 20): Promise<MeetingOccurrence[]> {
    return (await this.all(this.db.prepare(`
      SELECT * FROM meeting_occurrences
      WHERE guild_id = ? AND status IN ('scheduled','live')
      ORDER BY starts_at ASC LIMIT ?
    `).bind(guildId, limit))).map(mapMeeting);
  }

  async latestMeetingForSeries(seriesId: string): Promise<MeetingOccurrence | null> {
    const row = await this.db.prepare(
      "SELECT * FROM meeting_occurrences WHERE series_id = ? ORDER BY starts_at DESC LIMIT 1",
    ).bind(seriesId).first<Row>();
    return row ? mapMeeting(row) : null;
  }

  async openMeetingForSeries(seriesId: string): Promise<MeetingOccurrence | null> {
    const row = await this.db.prepare(`
      SELECT * FROM meeting_occurrences
      WHERE series_id = ? AND status IN ('scheduled','live') ORDER BY starts_at ASC LIMIT 1
    `).bind(seriesId).first<Row>();
    return row ? mapMeeting(row) : null;
  }

  async cancelScheduledForSeries(seriesId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE meeting_occurrences SET status = 'canceled', updated_at = ?
      WHERE series_id = ? AND status = 'scheduled'
    `).bind(new Date().toISOString(), seriesId).run();
  }

  async listSchedulerMeetings(): Promise<MeetingOccurrence[]> {
    return (await this.all(this.db.prepare(`
      SELECT * FROM meeting_occurrences WHERE status IN ('scheduled','live') ORDER BY starts_at ASC
    `))).map(mapMeeting);
  }

  async setMeetingStatus(id: string, status: MeetingStatus): Promise<void> {
    await this.db.prepare("UPDATE meeting_occurrences SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, new Date().toISOString(), id).run();
  }

  async claimMeetingStatus(id: string, from: MeetingStatus, to: MeetingStatus): Promise<boolean> {
    const result = await this.db.prepare(
      "UPDATE meeting_occurrences SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
    ).bind(to, new Date().toISOString(), id, from).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  async setAnnouncementMessage(id: string, messageId: string): Promise<void> {
    await this.db.prepare(
      "UPDATE meeting_occurrences SET announcement_message_id = ?, updated_at = ? WHERE id = ?",
    ).bind(messageId, new Date().toISOString(), id).run();
  }

  async rescheduleMeeting(id: string, startsAt: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`
        UPDATE meeting_occurrences SET starts_at = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'
      `).bind(startsAt, new Date().toISOString(), id),
      this.db.prepare("DELETE FROM sent_notifications WHERE meeting_id = ?").bind(id),
    ]);
  }

  async addAgendaItem(meetingId: string, text: string, userId: string): Promise<number> {
    const row = await this.db.prepare(
      "SELECT COALESCE(MAX(position), 0) + 1 AS next FROM agenda_items WHERE meeting_id = ?",
    ).bind(meetingId).first<{ next: number }>();
    const position = Number(row?.next ?? 1);
    const now = new Date().toISOString();
    const result = await this.db.prepare(`
      INSERT INTO agenda_items (meeting_id, position, text, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?)
    `).bind(meetingId, position, text.trim(), userId, now, now).run();
    return Number(result.meta?.last_row_id ?? 0);
  }

  async getAgenda(meetingId: string): Promise<AgendaItem[]> {
    return (await this.all(this.db.prepare(
      "SELECT * FROM agenda_items WHERE meeting_id = ? ORDER BY position ASC",
    ).bind(meetingId))).map(mapAgenda);
  }

  async editAgendaItem(meetingId: string, position: number, text: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE agenda_items SET text = ?, updated_at = ? WHERE meeting_id = ? AND position = ?
    `).bind(text.trim(), new Date().toISOString(), meetingId, position).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  async setAgendaStatus(meetingId: string, position: number, status: AgendaItem["status"]): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE agenda_items SET status = ?, updated_at = ? WHERE meeting_id = ? AND position = ?
    `).bind(status, new Date().toISOString(), meetingId, position).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  async removeAgendaItem(meetingId: string, position: number): Promise<boolean> {
    const existing = await this.db.prepare(
      "SELECT id FROM agenda_items WHERE meeting_id = ? AND position = ?",
    ).bind(meetingId, position).first<{ id: number }>();
    if (!existing) return false;
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM agenda_items WHERE meeting_id = ? AND position = ?").bind(meetingId, position),
      this.db.prepare("UPDATE agenda_items SET position = position - 1 WHERE meeting_id = ? AND position > ?")
        .bind(meetingId, position),
    ]);
    return Number(results[0]?.meta?.changes ?? 0) > 0;
  }

  async upsertRsvp(meetingId: string, userId: string, response: RsvpResponse): Promise<void> {
    await this.db.prepare(`
      INSERT INTO rsvps (meeting_id, user_id, response, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(meeting_id, user_id) DO UPDATE SET response = excluded.response, updated_at = excluded.updated_at
    `).bind(meetingId, userId, response, new Date().toISOString()).run();
  }

  async getRsvps(meetingId: string): Promise<Rsvp[]> {
    return (await this.all(this.db.prepare(
      "SELECT * FROM rsvps WHERE meeting_id = ? ORDER BY updated_at ASC",
    ).bind(meetingId))).map(mapRsvp);
  }

  async getSentNotificationKeys(meetingId: string): Promise<Set<string>> {
    const rows = await this.all(this.db.prepare(
      "SELECT notification_key FROM sent_notifications WHERE meeting_id = ?",
    ).bind(meetingId));
    return new Set(rows.map((row) => String(row.notification_key)));
  }

  async markNotificationsSent(meetingId: string, keys: string[]): Promise<void> {
    const now = new Date().toISOString();
    await this.db.batch(keys.map((key) => this.db.prepare(`
      INSERT OR IGNORE INTO sent_notifications (meeting_id, notification_key, sent_at) VALUES (?, ?, ?)
    `).bind(meetingId, key, now)));
  }

  async occurrenceCount(seriesId: string): Promise<number> {
    const row = await this.db.prepare(
      "SELECT COUNT(*) AS count FROM meeting_occurrences WHERE series_id = ?",
    ).bind(seriesId).first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async createNextMeeting(meeting: MeetingOccurrence, carryFromMeetingId: string): Promise<void> {
    const openItems = await this.all(this.db.prepare(`
      SELECT text, created_by FROM agenda_items
      WHERE meeting_id = ? AND status = 'open' ORDER BY position
    `).bind(carryFromMeetingId));
    const statements = [this.insertMeeting(meeting)];
    const now = new Date().toISOString();
    openItems.forEach((item, index) => statements.push(this.db.prepare(`
      INSERT INTO agenda_items (meeting_id, position, text, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?)
    `).bind(meeting.id, index + 1, String(item.text), String(item.created_by), now, now)));
    await this.db.batch(statements);
  }

  async saveDraft(id: string, userId: string, guildId: string, draft: unknown, createdAt: number): Promise<void> {
    await this.db.prepare(`
      INSERT INTO meeting_drafts (id, user_id, guild_id, draft_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET draft_json = excluded.draft_json, updated_at = excluded.updated_at
    `).bind(id, userId, guildId, JSON.stringify(draft), createdAt, Date.now()).run();
  }

  async getDraft<T>(id: string, userId: string, guildId: string): Promise<T | null> {
    const row = await this.db.prepare(`
      SELECT draft_json, created_at FROM meeting_drafts WHERE id = ? AND user_id = ? AND guild_id = ?
    `).bind(id, userId, guildId).first<{ draft_json: string; created_at: number }>();
    if (!row) return null;
    if (Date.now() - Number(row.created_at) > 60 * 60_000) {
      await this.deleteDraft(id);
      return null;
    }
    return JSON.parse(row.draft_json) as T;
  }

  async deleteDraft(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM meeting_drafts WHERE id = ?").bind(id).run();
  }
}
