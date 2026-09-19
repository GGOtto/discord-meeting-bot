import { DateTime } from "luxon";
import { dueReminderRules, mostRelevantReminder } from "./notifications.js";
import { firstOccurrenceIso, nextOccurrenceIso, parseWeekdays, validateSchedule } from "./recurrence.js";
import type { Frequency, MeetingDetails, MeetingOccurrence, MeetingSeries, RsvpResponse } from "./types.js";
import { WorkerDatabase, type D1Database } from "./worker-db.js";
import {
  agendaText,
  allowedMentions,
  liveMeetingMessage,
  meetingMessage,
  reminderMessage,
  roleMention,
  type DiscordMessage,
} from "./worker-presentation.js";

interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_CLIENT_ID: string;
  DEFAULT_TIMEZONE?: string;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface InteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  focused?: boolean;
  options?: InteractionOption[];
}

interface InteractionComponent {
  custom_id?: string;
  value?: string;
  components?: InteractionComponent[];
}

interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: {
    permissions?: string;
    user: { id: string };
  };
  user?: { id: string };
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    values?: string[];
    options?: InteractionOption[];
    components?: InteractionComponent[];
  };
}

interface SeriesDraft {
  id: string;
  userId: string;
  guildId: string;
  title: string;
  firstDate: string;
  localTime: string;
  timezone: string;
  durationMinutes: number;
  frequency: Frequency;
  intervalCount: number;
  weekdaysText: string;
  endsOn: string;
  occurrenceLimit: number | null;
  voiceChannelId: string | null;
  announcementChannelId: string | null;
  notifyRoleId: string | null;
  createdAt: number;
}

const RESPONSE = {
  pong: 1,
  message: 4,
  deferredUpdate: 6,
  update: 7,
  autocomplete: 8,
  modal: 9,
} as const;

const EPHEMERAL = 1 << 6;
const MANAGE_EVENTS = 1n << 33n;

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function messageResponse(data: DiscordMessage, ephemeral = false): Response {
  return response({ type: RESPONSE.message, data: { ...data, ...(ephemeral ? { flags: EPHEMERAL } : {}) } });
}

function updateResponse(data: DiscordMessage): Response {
  return response({ type: RESPONSE.update, data });
}

function errorResponse(error: unknown): Response {
  const text = error instanceof Error ? error.message : "Something went wrong";
  console.error("Interaction failed", error);
  return messageResponse({ content: `⚠️ ${text}` }, true);
}

function createId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `${prefix}_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function userId(interaction: DiscordInteraction): string {
  const id = interaction.member?.user.id ?? interaction.user?.id;
  if (!id) throw new Error("Could not identify the Discord user");
  return id;
}

function guildId(interaction: DiscordInteraction): string {
  if (!interaction.guild_id) throw new Error("This command only works in a server");
  return interaction.guild_id;
}

function hasManageEvents(interaction: DiscordInteraction): boolean {
  try {
    return (BigInt(interaction.member?.permissions ?? "0") & MANAGE_EVENTS) === MANAGE_EVENTS;
  } catch {
    return false;
  }
}

function commandOptions(interaction: DiscordInteraction): { subcommand: string; values: Map<string, string | number | boolean> } {
  const root = interaction.data?.options?.[0];
  const values = new Map<string, string | number | boolean>();
  for (const option of root?.options ?? []) {
    if (option.value !== undefined) values.set(option.name, option.value);
  }
  return { subcommand: root?.name ?? "", values };
}

function requiredString(values: Map<string, string | number | boolean>, name: string): string {
  const value = values.get(name);
  if (typeof value !== "string" || !value) throw new Error(`Missing ${name}`);
  return value;
}

function modalValues(interaction: DiscordInteraction): Map<string, string> {
  const values = new Map<string, string>();
  for (const row of interaction.data?.components ?? []) {
    for (const item of row.components ?? []) {
      if (item.custom_id && item.value !== undefined) values.set(item.custom_id, item.value);
    }
  }
  return values;
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) throw new Error("Invalid Discord signature");
  const bytes = new Uint8Array(value.length / 2);
  value.match(/.{2}/g)!.forEach((byte, index) => { bytes[index] = Number.parseInt(byte, 16); });
  return bytes;
}

async function verifyRequest(request: Request, body: ArrayBuffer, publicKey: string): Promise<boolean> {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexBytes(publicKey).buffer, { name: "Ed25519" }, false, ["verify"]);
    const timestampBytes = new TextEncoder().encode(timestamp);
    const message = new Uint8Array(timestampBytes.length + body.byteLength);
    message.set(timestampBytes);
    message.set(new Uint8Array(body), timestampBytes.length);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, hexBytes(signature).buffer, message.buffer);
  } catch (error) {
    console.error("Could not verify Discord signature", error);
    return false;
  }
}

async function discordApi<T>(env: Env, path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${env.DISCORD_TOKEN}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const result = await fetch(`https://discord.com/api/v10${path}`, { ...init, headers });
  if (!result.ok) {
    const details = await result.text();
    throw new Error(`Discord API ${result.status}: ${details.slice(0, 300)}`);
  }
  if (result.status === 204) return undefined as T;
  return await result.json() as T;
}

async function sendChannelMessage(env: Env, channelId: string, message: DiscordMessage): Promise<{ id: string }> {
  return discordApi(env, `/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify(message) });
}

async function editChannelMessage(env: Env, channelId: string, messageId: string, message: DiscordMessage): Promise<void> {
  await discordApi(env, `/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH", body: JSON.stringify(message),
  });
}

function reminderLabel(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return `in ${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `in ${minutes} minutes`;
}

function textInput(customId: string, label: string, value: string, required = true, maxLength = 100): Record<string, unknown> {
  return {
    type: 4, custom_id: customId, label, style: 1, required, max_length: maxLength,
    ...(value ? { value } : {}),
  };
}

function actionRow(...components: Record<string, unknown>[]): Record<string, unknown> {
  return { type: 1, components };
}

function button(customId: string, label: string, style: number): Record<string, unknown> {
  return { type: 2, custom_id: customId, label, style };
}

function draftSummary(draft: SeriesDraft): DiscordMessage {
  const audience = draft.notifyRoleId === null ? "No ping" : draft.notifyRoleId === draft.guildId ? "@everyone" : `<@&${draft.notifyRoleId}>`;
  const recurrence = draft.frequency === "once"
    ? "One time"
    : `${draft.frequency}, every ${draft.intervalCount}${draft.weekdaysText ? ` · ${draft.weekdaysText}` : ""}${draft.endsOn ? ` · through ${draft.endsOn}` : ""}${draft.occurrenceLimit ? ` · ${draft.occurrenceLimit} occurrences` : ""}`;
  return {
    embeds: [{
      color: 0x5865f2,
      title: "Create a meeting series",
      description: "This setup is private. Nothing is posted until you choose **Publish**.",
      fields: [
        { name: "Meeting", value: draft.title ? `**${draft.title}**\n${draft.firstDate || "Date needed"} at ${draft.localTime} · ${draft.timezone}\n${draft.durationMinutes} minutes` : "Choose **Details**", inline: false },
        { name: "Repeats", value: recurrence, inline: true },
        { name: "Channels", value: `${draft.voiceChannelId ? `<#${draft.voiceChannelId}>` : "Voice channel needed"}\n${draft.announcementChannelId ? `<#${draft.announcementChannelId}>` : "Announcement channel needed"}`, inline: true },
        { name: "Audience", value: audience, inline: true },
        { name: "Notifications", value: "A quiet card when published, then reminders at **8 hours** and **10 minutes**. Reminders use the audience above and always include RSVP buttons.", inline: false },
      ],
      footer: { text: "RSVPs stay open through the meeting. Agenda edits update the card silently." },
    }],
    components: [
      actionRow(
        button(`draft:details:${draft.id}`, "Details", 1),
        button(`draft:recurrence:${draft.id}`, "Recurrence", 2),
        button(`draft:channels:${draft.id}`, "Channels", 2),
        button(`draft:audience:${draft.id}`, "Audience", 2),
        button(`draft:publish:${draft.id}`, "Publish", 3),
      ),
      actionRow(button(`draft:cancel:${draft.id}`, "Cancel setup", 4)),
    ],
  };
}

function draftChannelView(draft: SeriesDraft): DiscordMessage {
  return {
    embeds: [{ color: 0x5865f2, title: "Choose channels", description: "Choose where the meeting happens and where its card and reminders should appear." }],
    components: [
      actionRow({
        type: 8, custom_id: `draft-channel-voice:${draft.id}`,
        placeholder: draft.voiceChannelId ? "Change voice channel" : "Choose voice channel",
        channel_types: [2, 13], min_values: 1, max_values: 1,
      }),
      actionRow({
        type: 8, custom_id: `draft-channel-announcement:${draft.id}`,
        placeholder: draft.announcementChannelId ? "Change announcement channel" : "Choose announcement channel",
        channel_types: [0, 5], min_values: 1, max_values: 1,
      }),
      actionRow(button(`draft:back:${draft.id}`, "Back", 2)),
    ],
  };
}

function draftAudienceView(draft: SeriesDraft): DiscordMessage {
  const current = draft.notifyRoleId === null ? "No ping" : draft.notifyRoleId === draft.guildId ? "@everyone" : `<@&${draft.notifyRoleId}>`;
  return {
    embeds: [{ color: 0x5865f2, title: "Choose the reminder audience", description: `Current choice: **${current}**\n\nOnly this audience can be pinged. The bot never pings individual RSVPs.` }],
    components: [actionRow(
      button(`draft:everyone:${draft.id}`, "@everyone", 1),
      button(`draft:choose-role:${draft.id}`, "Choose a role", 2),
      button(`draft:no-ping:${draft.id}`, "No ping", 2),
      button(`draft:back:${draft.id}`, "Back", 2),
    )],
  };
}

function draftRoleView(draft: SeriesDraft): DiscordMessage {
  return {
    embeds: [{ color: 0x5865f2, title: "Choose one role", description: "That role will be pinged at 8 hours and 10 minutes, and for cancellations or reschedules." }],
    components: [
      actionRow({ type: 6, custom_id: `draft-role:${draft.id}`, placeholder: "Choose a role", min_values: 1, max_values: 1 }),
      actionRow(button(`draft:audience:${draft.id}`, "Back", 2)),
    ],
  };
}

async function requireDraft(db: WorkerDatabase, interaction: DiscordInteraction, id: string): Promise<SeriesDraft> {
  const draft = await db.getDraft<SeriesDraft>(id, userId(interaction), guildId(interaction));
  if (!draft) throw new Error("That setup draft expired. Run /series create to start again");
  return draft;
}

async function requireMeeting(db: WorkerDatabase, id: string, expectedGuildId: string): Promise<MeetingDetails> {
  const details = await db.getMeetingDetails(id);
  if (!details || details.meeting.guildId !== expectedGuildId) throw new Error("Meeting not found");
  return details;
}

function isOrganizer(interaction: DiscordInteraction, details: MeetingDetails): boolean {
  return userId(interaction) === details.series.creatorId || hasManageEvents(interaction);
}

async function publishMeeting(env: Env, db: WorkerDatabase, id: string): Promise<void> {
  const details = await db.getMeetingDetails(id);
  if (!details) throw new Error("Meeting not found");
  const message = await sendChannelMessage(env, details.meeting.announcementChannelId, {
    ...meetingMessage(details), allowed_mentions: allowedMentions(null, details.meeting.guildId),
  });
  await db.setAnnouncementMessage(id, message.id);
}

async function refreshMeetingPost(env: Env, db: WorkerDatabase, id: string): Promise<void> {
  const details = await db.getMeetingDetails(id);
  if (!details?.meeting.announcementMessageId) return;
  try {
    await editChannelMessage(env, details.meeting.announcementChannelId, details.meeting.announcementMessageId, {
      content: null, ...meetingMessage(details), allowed_mentions: allowedMentions(null, details.meeting.guildId),
    });
  } catch (error) {
    console.warn(`Could not refresh meeting post ${id}`, error);
  }
}

async function ensureNextMeeting(
  env: Env,
  db: WorkerDatabase,
  series: MeetingSeries,
  afterMeeting?: MeetingOccurrence,
): Promise<MeetingOccurrence | null> {
  if (series.status !== "active" || series.frequency === "once") return null;
  const existing = await db.openMeetingForSeries(series.id);
  if (existing) return existing;
  const previous = afterMeeting ?? await db.latestMeetingForSeries(series.id);
  if (!previous) return null;
  if (series.occurrenceLimit && await db.occurrenceCount(series.id) >= series.occurrenceLimit) {
    await db.setSeriesStatus(series.id, "stopped");
    return null;
  }
  const startsAt = nextOccurrenceIso(series, previous.startsAt);
  if (!startsAt) {
    await db.setSeriesStatus(series.id, "stopped");
    return null;
  }
  const now = new Date().toISOString();
  const meeting: MeetingOccurrence = {
    id: createId("mtg"), seriesId: series.id, guildId: series.guildId, startsAt,
    durationMinutes: series.durationMinutes, status: "scheduled",
    announcementChannelId: series.announcementChannelId, announcementMessageId: null,
    voiceChannelId: series.voiceChannelId, notifyRoleId: series.notifyRoleId,
    notificationPreset: series.notificationPreset, createdAt: now, updatedAt: now,
  };
  await db.createNextMeeting(meeting, previous.id);
  await publishMeeting(env, db, meeting.id);
  return meeting;
}

async function startMeeting(env: Env, db: WorkerDatabase, id: string): Promise<void> {
  const before = await db.getMeetingDetails(id);
  if (!before || before.meeting.status !== "scheduled") return;
  if (!await db.claimMeetingStatus(id, "scheduled", "live")) return;
  const details = (await db.getMeetingDetails(id))!;
  try {
    await sendChannelMessage(env, details.meeting.voiceChannelId, {
      ...liveMeetingMessage(details), allowed_mentions: allowedMentions(null, details.meeting.guildId),
    });
  } catch (error) {
    console.warn("Could not post in voice room; using announcement channel", error);
    await sendChannelMessage(env, details.meeting.announcementChannelId, {
      ...liveMeetingMessage(details), allowed_mentions: allowedMentions(null, details.meeting.guildId),
    });
  }
  await refreshMeetingPost(env, db, id);
}

async function finishMeeting(env: Env, db: WorkerDatabase, id: string): Promise<void> {
  const details = await db.getMeetingDetails(id);
  if (!details || !["live", "scheduled"].includes(details.meeting.status)) return;
  if (!await db.claimMeetingStatus(id, details.meeting.status, "completed")) return;
  await refreshMeetingPost(env, db, id);
  await ensureNextMeeting(env, db, details.series, details.meeting);
}

async function sendImportantChange(env: Env, details: MeetingDetails, text: string): Promise<void> {
  const roleId = details.meeting.notifyRoleId;
  const mention = roleId ? `${roleMention(roleId, details.meeting.guildId)} ` : "";
  await sendChannelMessage(env, details.meeting.announcementChannelId, {
    content: `${mention}⚠️ **${details.series.title}:** ${text}`,
    allowed_mentions: allowedMentions(roleId, details.meeting.guildId),
  });
}

async function sendReminder(env: Env, details: MeetingDetails, minutes: number): Promise<void> {
  const roleId = details.meeting.notifyRoleId;
  await sendChannelMessage(env, details.meeting.announcementChannelId, {
    ...(roleId ? { content: roleMention(roleId, details.meeting.guildId) } : {}),
    ...reminderMessage(details, reminderLabel(minutes)),
    allowed_mentions: allowedMentions(roleId, details.meeting.guildId),
  });
}

async function handleSeriesCommand(
  interaction: DiscordInteraction,
  env: Env,
  db: WorkerDatabase,
): Promise<Response> {
  const { subcommand, values } = commandOptions(interaction);
  const currentGuildId = guildId(interaction);
  if (subcommand === "create") {
    const draft: SeriesDraft = {
      id: createId("draft"), userId: userId(interaction), guildId: currentGuildId,
      title: "", firstDate: "", localTime: "10:00",
      timezone: env.DEFAULT_TIMEZONE?.trim() || "America/Los_Angeles",
      durationMinutes: 60, frequency: "weekly", intervalCount: 1, weekdaysText: "",
      endsOn: "", occurrenceLimit: null, voiceChannelId: null,
      announcementChannelId: interaction.channel_id ?? null, notifyRoleId: currentGuildId,
      createdAt: Date.now(),
    };
    await db.saveDraft(draft.id, draft.userId, draft.guildId, draft, draft.createdAt);
    return messageResponse(draftSummary(draft), true);
  }
  if (subcommand === "list") {
    const series = await db.listSeries(currentGuildId);
    const description = series.length
      ? series.map((item) => `**${item.title}** · \`${item.id}\` · ${item.status} · ${item.frequency}`).join("\n")
      : "No active meeting series yet.";
    return messageResponse({ embeds: [{ title: "Meeting series", description }] }, true);
  }

  const seriesId = requiredString(values, "series");
  const series = await db.getSeries(seriesId);
  if (!series || series.guildId !== currentGuildId) throw new Error("Meeting series not found");
  if (userId(interaction) !== series.creatorId && !hasManageEvents(interaction)) {
    throw new Error("Only the organizer or a server event manager can change this series");
  }
  if (subcommand === "pause") await db.setSeriesStatus(series.id, "paused");
  if (subcommand === "stop") {
    const scheduled = await db.openMeetingForSeries(series.id);
    await db.setSeriesStatus(series.id, "stopped");
    await db.cancelScheduledForSeries(series.id);
    if (scheduled?.status === "scheduled") await refreshMeetingPost(env, db, scheduled.id);
  }
  if (subcommand === "resume") {
    if (series.status === "stopped") throw new Error("A stopped series cannot be resumed");
    await db.setSeriesStatus(series.id, "active");
    await ensureNextMeeting(env, db, { ...series, status: "active" });
  }
  const state = subcommand === "stop" ? "stopped" : subcommand === "pause" ? "paused" : "active";
  return messageResponse({ content: `Series **${series.title}** is now **${state}**.` }, true);
}

async function handleMeetingCommand(
  interaction: DiscordInteraction,
  env: Env,
  db: WorkerDatabase,
): Promise<Response> {
  const { subcommand, values } = commandOptions(interaction);
  const currentGuildId = guildId(interaction);
  if (subcommand === "list") {
    const meetings = await db.listUpcoming(currentGuildId);
    const lines = await Promise.all(meetings.map(async (meeting) => {
      const details = await db.getMeetingDetails(meeting.id);
      const unix = Math.floor(new Date(meeting.startsAt).getTime() / 1000);
      return `**${details?.series.title ?? "Meeting"}** · <t:${unix}:F> · \`${meeting.id}\``;
    }));
    return messageResponse({
      embeds: [{ title: "Upcoming meetings", description: lines.join("\n") || "No upcoming meetings." }],
    }, true);
  }

  const id = requiredString(values, "meeting");
  const details = await requireMeeting(db, id, currentGuildId);
  if (subcommand === "show") return messageResponse(meetingMessage(details), true);
  if (!isOrganizer(interaction, details)) throw new Error("Only the organizer or a server event manager can do that");
  if (subcommand === "start") {
    await startMeeting(env, db, id);
    return messageResponse({ content: "Meeting started and the agenda was posted in the voice room's chat." }, true);
  }
  if (subcommand === "end") {
    await finishMeeting(env, db, id);
    return messageResponse({ content: "Meeting ended. Unfinished agenda items were carried into the next occurrence." }, true);
  }
  if (subcommand === "cancel" || subcommand === "skip") {
    const status = subcommand === "skip" ? "skipped" : "canceled";
    await db.setMeetingStatus(id, status);
    await refreshMeetingPost(env, db, id);
    const changed = await requireMeeting(db, id, currentGuildId);
    await sendImportantChange(env, changed, `This meeting was **${status}**.`);
    await ensureNextMeeting(env, db, details.series, details.meeting);
    return messageResponse({ content: `Meeting ${status}. The recurring series remains active.` }, true);
  }
  if (subcommand === "reschedule") {
    if (details.meeting.status !== "scheduled") throw new Error("Only scheduled meetings can be rescheduled");
    const date = requiredString(values, "date");
    const time = requiredString(values, "time");
    const startsAt = firstOccurrenceIso(date, time, details.series.timezone);
    if (new Date(startsAt).getTime() <= Date.now()) throw new Error("The new meeting time must be in the future");
    await db.rescheduleMeeting(id, startsAt);
    await refreshMeetingPost(env, db, id);
    const changed = await requireMeeting(db, id, currentGuildId);
    await sendImportantChange(env, changed, `The meeting was rescheduled to <t:${Math.floor(new Date(startsAt).getTime() / 1000)}:F>.`);
    return messageResponse({ content: "Meeting rescheduled. This change affects only this occurrence." }, true);
  }
  throw new Error("Unknown meeting action");
}

async function handleAgendaCommand(
  interaction: DiscordInteraction,
  env: Env,
  db: WorkerDatabase,
): Promise<Response> {
  const { subcommand, values } = commandOptions(interaction);
  const id = requiredString(values, "meeting");
  const details = await requireMeeting(db, id, guildId(interaction));
  if (["completed", "canceled", "skipped"].includes(details.meeting.status) && subcommand !== "list") {
    throw new Error("That meeting's agenda is closed");
  }
  if (subcommand === "list") {
    return messageResponse({ embeds: [{ title: details.series.title, description: agendaText(details.agenda) }] }, true);
  }
  let changed = false;
  if (subcommand === "add") {
    await db.addAgendaItem(id, requiredString(values, "item"), userId(interaction));
    changed = true;
  }
  const position = Number(values.get("number"));
  if (subcommand === "edit") changed = await db.editAgendaItem(id, position, requiredString(values, "item"));
  if (subcommand === "remove") changed = await db.removeAgendaItem(id, position);
  if (subcommand === "done") changed = await db.setAgendaStatus(id, position, "done");
  if (subcommand === "reopen") changed = await db.setAgendaStatus(id, position, "open");
  if (!changed) throw new Error("Agenda item not found");
  await refreshMeetingPost(env, db, id);
  return messageResponse({ content: "Agenda updated." }, true);
}

function helpResponse(): Response {
  return messageResponse({
    embeds: [{
      color: 0x5865f2,
      title: "Meeting bot help",
      description: "Recurring meetings with collaborative agendas and low-noise reminders.",
      fields: [
        { name: "Create", value: "Use `/series create`. Weekly schedules can use multiple days such as `mon,wed,fri`." },
        { name: "RSVP", value: "Use the buttons on a meeting card." },
        { name: "Agenda", value: "Anyone can use the agenda buttons or `/agenda add`, `/agenda edit`, and `/agenda done`. Unfinished items roll forward." },
        { name: "During the meeting", value: "The bot posts the agenda and RSVP attendance in the voice room's text chat. It never records or listens." },
        { name: "Notifications", value: "The meeting card is quiet. Reminders at 8 hours and 10 minutes ping the chosen role (default @everyone), or nobody when No ping is selected. Individual people are never pinged." },
      ],
    }],
  }, true);
}

async function handleCommand(interaction: DiscordInteraction, env: Env, db: WorkerDatabase): Promise<Response> {
  switch (interaction.data?.name) {
    case "series": return handleSeriesCommand(interaction, env, db);
    case "meeting": return handleMeetingCommand(interaction, env, db);
    case "agenda": return handleAgendaCommand(interaction, env, db);
    case "meeting-help": return helpResponse();
    default: throw new Error("Unknown command");
  }
}

async function handleAutocomplete(interaction: DiscordInteraction, db: WorkerDatabase): Promise<Response> {
  const currentGuildId = guildId(interaction);
  const root = interaction.data?.options?.[0];
  const focused = root?.options?.find((option) => option.focused);
  const query = typeof focused?.value === "string" ? focused.value.toLowerCase() : "";
  if (interaction.data?.name === "series") {
    const choices = (await db.listSeries(currentGuildId))
      .filter((series) => `${series.id} ${series.title}`.toLowerCase().includes(query))
      .slice(0, 25)
      .map((series) => ({ name: `${series.title} · ${series.id}`.slice(0, 100), value: series.id }));
    return response({ type: RESPONSE.autocomplete, data: { choices } });
  }
  const meetings = await db.listUpcoming(currentGuildId, 25);
  const choices: { name: string; value: string }[] = [];
  for (const meeting of meetings) {
    const details = await db.getMeetingDetails(meeting.id);
    if (!`${meeting.id} ${details?.series.title ?? ""}`.toLowerCase().includes(query)) continue;
    choices.push({
      name: `${details?.series.title ?? "Meeting"} · ${DateTime.fromISO(meeting.startsAt).toFormat("LLL d")} · ${meeting.id}`.slice(0, 100),
      value: meeting.id,
    });
  }
  return response({ type: RESPONSE.autocomplete, data: { choices } });
}

async function publishDraft(
  interaction: DiscordInteraction,
  env: Env,
  db: WorkerDatabase,
  draft: SeriesDraft,
): Promise<Response> {
  if (!draft.title || !draft.firstDate) throw new Error("Open Details and enter a meeting name and first date");
  if (!draft.voiceChannelId || !draft.announcementChannelId) throw new Error("Open Channels and choose both channels");
  if (draft.endsOn && draft.occurrenceLimit) throw new Error("Choose either an ending date or a number of occurrences, not both");
  const firstLocal = validateSchedule(draft.firstDate, draft.localTime, draft.timezone);
  if (firstLocal.toMillis() <= Date.now()) throw new Error("The first meeting must be in the future");
  if (draft.endsOn) {
    validateSchedule(draft.endsOn, draft.localTime, draft.timezone);
    if (draft.endsOn < draft.firstDate) throw new Error("The ending date cannot be before the first meeting");
  }
  const weekdays = draft.frequency === "weekly" ? parseWeekdays(draft.weekdaysText) : [];
  if (draft.frequency === "weekly" && !weekdays.length) weekdays.push(firstLocal.weekday);
  if (draft.frequency === "weekly" && !weekdays.includes(firstLocal.weekday)) {
    throw new Error("The first date must fall on one of the selected weekdays");
  }
  const now = new Date().toISOString();
  const series: MeetingSeries = {
    id: createId("ser"), guildId: draft.guildId, title: draft.title, creatorId: draft.userId,
    voiceChannelId: draft.voiceChannelId, announcementChannelId: draft.announcementChannelId,
    notifyRoleId: draft.notifyRoleId, timezone: draft.timezone, localTime: draft.localTime,
    firstDate: draft.firstDate, frequency: draft.frequency, intervalCount: draft.intervalCount,
    weekdays, monthDay: draft.frequency === "monthly" ? firstLocal.day : null,
    durationMinutes: draft.durationMinutes, notificationPreset: "balanced",
    endsOn: draft.endsOn || null, occurrenceLimit: draft.occurrenceLimit,
    status: "active", createdAt: now, updatedAt: now,
  };
  const meeting: MeetingOccurrence = {
    id: createId("mtg"), seriesId: series.id, guildId: series.guildId,
    startsAt: firstOccurrenceIso(series.firstDate, series.localTime, series.timezone),
    durationMinutes: series.durationMinutes, status: "scheduled",
    announcementChannelId: series.announcementChannelId, announcementMessageId: null,
    voiceChannelId: series.voiceChannelId, notifyRoleId: series.notifyRoleId,
    notificationPreset: "balanced", createdAt: now, updatedAt: now,
  };
  await db.createSeries(series, meeting);
  await publishMeeting(env, db, meeting.id);
  await db.deleteDraft(draft.id);
  return updateResponse({
    content: `Created **${series.title}**. Its quiet meeting card is now in <#${series.announcementChannelId}>.`,
    embeds: [], components: [],
  });
}

async function handleDraftButton(
  interaction: DiscordInteraction,
  env: Env,
  db: WorkerDatabase,
  customId: string,
): Promise<Response> {
  const [, action, draftId] = customId.split(":");
  if (!action || !draftId) throw new Error("Invalid setup button");
  const draft = await requireDraft(db, interaction, draftId);
  if (action === "cancel") {
    await db.deleteDraft(draft.id);
    return updateResponse({ content: "Meeting setup canceled. Nothing was posted.", embeds: [], components: [] });
  }
  if (action === "back") return updateResponse(draftSummary(draft));
  if (action === "channels") return updateResponse(draftChannelView(draft));
  if (action === "audience") return updateResponse(draftAudienceView(draft));
  if (action === "choose-role") return updateResponse(draftRoleView(draft));
  if (action === "everyone" || action === "no-ping") {
    draft.notifyRoleId = action === "everyone" ? draft.guildId : null;
    await db.saveDraft(draft.id, draft.userId, draft.guildId, draft, draft.createdAt);
    return updateResponse(draftSummary(draft));
  }
  if (action === "publish") return publishDraft(interaction, env, db, draft);
  if (action === "details") {
    return response({
      type: RESPONSE.modal,
      data: {
        custom_id: `draft-details-modal:${draft.id}`, title: "Meeting details",
        components: [
          actionRow(textInput("title", "Meeting name", draft.title, true, 100)),
          actionRow(textInput("date", "First date (YYYY-MM-DD)", draft.firstDate, true, 10)),
          actionRow(textInput("time", "Time (24-hour HH:mm)", draft.localTime, true, 5)),
          actionRow(textInput("timezone", "Timezone", draft.timezone, true, 100)),
          actionRow(textInput("duration", "Duration in minutes", String(draft.durationMinutes), true, 4)),
        ],
      },
    });
  }
  if (action === "recurrence") {
    return response({
      type: RESPONSE.modal,
      data: {
        custom_id: `draft-recurrence-modal:${draft.id}`, title: "Recurrence",
        components: [
          actionRow(textInput("frequency", "once, daily, weekly, or monthly", draft.frequency, true, 7)),
          actionRow(textInput("every", "Repeat every…", String(draft.intervalCount), true, 2)),
          actionRow(textInput("weekdays", "Weekdays (example: mon,wed,fri)", draft.weekdaysText, false, 40)),
          actionRow(textInput("ends-on", "Optional ending date (YYYY-MM-DD)", draft.endsOn, false, 10)),
          actionRow(textInput("ends-after", "Optional number of occurrences", draft.occurrenceLimit ? String(draft.occurrenceLimit) : "", false, 3)),
        ],
      },
    });
  }
  throw new Error("Unknown setup action");
}

async function handleButton(
  interaction: DiscordInteraction,
  env: Env,
  db: WorkerDatabase,
  ctx: ExecutionContextLike,
): Promise<Response> {
  const customId = interaction.data?.custom_id ?? "";
  if (customId.startsWith("draft:")) return handleDraftButton(interaction, env, db, customId);
  const [action, value, idFromThird] = customId.split(":");
  if (action === "rsvp") {
    const id = idFromThird;
    if (!id) throw new Error("Invalid RSVP button");
    const details = await requireMeeting(db, id, guildId(interaction));
    if (["completed", "canceled", "skipped"].includes(details.meeting.status)) throw new Error("RSVPs are closed");
    await db.upsertRsvp(id, userId(interaction), value as RsvpResponse);
    ctx.waitUntil(refreshMeetingPost(env, db, id));
    return response({ type: RESPONSE.deferredUpdate });
  }
  if ((action === "agenda-add" || action === "agenda-edit") && value) {
    const details = await requireMeeting(db, value, guildId(interaction));
    if (["completed", "canceled", "skipped"].includes(details.meeting.status)) throw new Error("That agenda is closed");
    const components = [];
    if (action === "agenda-edit") {
      components.push(actionRow(textInput("position", "Agenda item number", "", true, 3)));
    }
    components.push(actionRow({ ...textInput("text", action === "agenda-add" ? "Agenda item" : "New text", "", true, 500), style: 2 }));
    return response({
      type: RESPONSE.modal,
      data: {
        custom_id: `${action}-modal:${value}`,
        title: action === "agenda-add" ? "Add an agenda item" : "Edit an agenda item",
        components,
      },
    });
  }
  throw new Error("Unknown button");
}

async function handleSelect(interaction: DiscordInteraction, db: WorkerDatabase): Promise<Response> {
  const customId = interaction.data?.custom_id ?? "";
  const [action, draftId] = customId.split(":");
  if (!draftId) throw new Error("Invalid selection");
  const draft = await requireDraft(db, interaction, draftId);
  const selected = interaction.data?.values?.[0];
  if (!selected) throw new Error("Choose an option");
  if (action === "draft-channel-voice") {
    draft.voiceChannelId = selected;
    await db.saveDraft(draft.id, draft.userId, draft.guildId, draft, draft.createdAt);
    return updateResponse(draftChannelView(draft));
  }
  if (action === "draft-channel-announcement") {
    draft.announcementChannelId = selected;
    await db.saveDraft(draft.id, draft.userId, draft.guildId, draft, draft.createdAt);
    return updateResponse(draftChannelView(draft));
  }
  if (action === "draft-role") {
    draft.notifyRoleId = selected;
    await db.saveDraft(draft.id, draft.userId, draft.guildId, draft, draft.createdAt);
    return updateResponse(draftSummary(draft));
  }
  throw new Error("Unknown selection");
}

async function handleModal(
  interaction: DiscordInteraction,
  env: Env,
  db: WorkerDatabase,
  ctx: ExecutionContextLike,
): Promise<Response> {
  const [action, targetId] = (interaction.data?.custom_id ?? "").split(":");
  if (!action || !targetId) throw new Error("Invalid form");
  const values = modalValues(interaction);
  if (action === "draft-details-modal" || action === "draft-recurrence-modal") {
    const draft = await requireDraft(db, interaction, targetId);
    if (action === "draft-details-modal") {
      const durationMinutes = Number(values.get("duration"));
      if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 1440) {
        throw new Error("Duration must be a whole number from 5 to 1440 minutes");
      }
      const title = (values.get("title") ?? "").trim();
      const firstDate = (values.get("date") ?? "").trim();
      const localTime = (values.get("time") ?? "").trim();
      const timezone = (values.get("timezone") ?? "").trim();
      validateSchedule(firstDate, localTime, timezone);
      draft.title = title;
      draft.firstDate = firstDate;
      draft.localTime = localTime;
      draft.timezone = timezone;
      draft.durationMinutes = durationMinutes;
    } else {
      const frequency = (values.get("frequency") ?? "").trim().toLowerCase();
      if (!["once", "daily", "weekly", "monthly"].includes(frequency)) {
        throw new Error("Frequency must be once, daily, weekly, or monthly");
      }
      const intervalCount = Number(values.get("every"));
      if (!Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 52) {
        throw new Error("Repeat every must be a whole number from 1 to 52");
      }
      const weekdaysText = (values.get("weekdays") ?? "").trim();
      if (frequency === "weekly") parseWeekdays(weekdaysText);
      else if (weekdaysText) throw new Error("Weekdays are only used for weekly meetings");
      const endsOn = (values.get("ends-on") ?? "").trim();
      const endsAfterText = (values.get("ends-after") ?? "").trim();
      if (endsOn && endsAfterText) throw new Error("Choose either an ending date or a number of occurrences, not both");
      const occurrenceLimit = endsAfterText ? Number(endsAfterText) : null;
      if (occurrenceLimit !== null && (!Number.isInteger(occurrenceLimit) || occurrenceLimit < 1 || occurrenceLimit > 500)) {
        throw new Error("Occurrences must be a whole number from 1 to 500");
      }
      draft.frequency = frequency as Frequency;
      draft.intervalCount = intervalCount;
      draft.weekdaysText = weekdaysText;
      draft.endsOn = endsOn;
      draft.occurrenceLimit = occurrenceLimit;
    }
    await db.saveDraft(draft.id, draft.userId, draft.guildId, draft, draft.createdAt);
    return updateResponse(draftSummary(draft));
  }

  const details = await requireMeeting(db, targetId, guildId(interaction));
  if (["completed", "canceled", "skipped"].includes(details.meeting.status)) throw new Error("That agenda is closed");
  const text = (values.get("text") ?? "").trim();
  if (action === "agenda-add-modal") await db.addAgendaItem(targetId, text, userId(interaction));
  else if (action === "agenda-edit-modal") {
    const position = Number(values.get("position"));
    if (!Number.isInteger(position) || position < 1) throw new Error("Enter a valid agenda item number");
    if (!await db.editAgendaItem(targetId, position, text)) throw new Error("Agenda item not found");
  } else throw new Error("Unknown agenda form");
  ctx.waitUntil(refreshMeetingPost(env, db, targetId));
  return messageResponse({ content: "Agenda updated." }, true);
}

async function runScheduler(env: Env): Promise<void> {
  const db = new WorkerDatabase(env.DB);
  const now = new Date();
  for (const meeting of await db.listSchedulerMeetings()) {
    try {
      const startsAt = new Date(meeting.startsAt).getTime();
      const endsAt = startsAt + meeting.durationMinutes * 60_000;
      if (meeting.status === "scheduled" && endsAt <= now.getTime()) {
        await finishMeeting(env, db, meeting.id);
        continue;
      }
      if (meeting.status === "scheduled" && startsAt <= now.getTime()) {
        await startMeeting(env, db, meeting.id);
        continue;
      }
      if (meeting.status === "live" && endsAt <= now.getTime()) {
        await finishMeeting(env, db, meeting.id);
        continue;
      }
      if (meeting.status !== "scheduled") continue;
      const details = await db.getMeetingDetails(meeting.id);
      if (!details) continue;
      const sent = await db.getSentNotificationKeys(meeting.id);
      const due = dueReminderRules(meeting.notificationPreset, meeting.startsAt, now, sent);
      const reminder = mostRelevantReminder(due);
      if (reminder) {
        await sendReminder(env, details, reminder.minutesBefore);
        await db.markNotificationsSent(meeting.id, due.map((rule) => rule.key));
      }
    } catch (error) {
      console.error(`Scheduler failed for meeting ${meeting.id}`, error);
    }
  }
}

async function handleInteraction(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContextLike,
): Promise<Response> {
  if (interaction.type === 1) return response({ type: RESPONSE.pong });
  const db = new WorkerDatabase(env.DB);
  try {
    if (interaction.type === 2) return await handleCommand(interaction, env, db);
    if (interaction.type === 4) return await handleAutocomplete(interaction, db);
    if (interaction.type === 3) {
      if (interaction.data?.component_type === 2) return await handleButton(interaction, env, db, ctx);
      if ([6, 8].includes(interaction.data?.component_type ?? 0)) return await handleSelect(interaction, db);
    }
    if (interaction.type === 5) return await handleModal(interaction, env, db, ctx);
    throw new Error("Unknown interaction");
  } catch (error) {
    return errorResponse(error);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    if (request.method === "GET") {
      return response({ ok: true, service: "discord-meeting-bot", runtime: "cloudflare-workers" });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = await request.arrayBuffer();
    if (!await verifyRequest(request, body, env.DISCORD_PUBLIC_KEY)) {
      return new Response("Invalid request signature", { status: 401 });
    }
    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(new TextDecoder().decode(body)) as DiscordInteraction;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    return handleInteraction(interaction, env, ctx);
  },

  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(runScheduler(env));
  },
};

export const testable = {
  draftSummary,
  runScheduler,
  verifyRequest,
};
