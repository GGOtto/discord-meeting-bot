import { describeRecurrence } from "./recurrence.js";
import type { AgendaItem, MeetingDetails, RsvpResponse } from "./types.js";

export interface DiscordMessage {
  content?: string | null;
  embeds?: Record<string, unknown>[];
  components?: Record<string, unknown>[];
  allowed_mentions?: { parse: string[]; roles: string[]; users: string[] };
  flags?: number;
}

const STATUS_LABELS: Record<MeetingDetails["meeting"]["status"], string> = {
  scheduled: "Scheduled",
  live: "Live now",
  completed: "Completed",
  canceled: "Canceled",
  skipped: "Skipped",
};

export function discordTimestamp(iso: string, style: "F" | "R" = "F"): string {
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>`;
}

export function agendaText(items: AgendaItem[]): string {
  if (!items.length) return "*No agenda items yet — anyone can add one.*";
  const text = items.map((item) => `${item.status === "done" ? "✅" : "⬜"} **${item.position}.** ${item.text}`).join("\n");
  return text.length > 1024 ? `${text.slice(0, 1018)}…` : text;
}

function rsvpList(details: MeetingDetails, response: RsvpResponse): string {
  const users = details.rsvps.filter((rsvp) => rsvp.response === response).map((rsvp) => `<@${rsvp.userId}>`);
  return users.length ? users.join(", ").slice(0, 1024) : "—";
}

function button(customId: string, label: string, style: number, emoji?: string, disabled = false): Record<string, unknown> {
  return {
    type: 2, custom_id: customId, label, style, disabled,
    ...(emoji ? { emoji: { name: emoji } } : {}),
  };
}

export function rsvpRow(details: MeetingDetails): Record<string, unknown> {
  const disabled = ["completed", "canceled", "skipped"].includes(details.meeting.status);
  return {
    type: 1,
    components: [
      button(`rsvp:going:${details.meeting.id}`, "Going", 3, "✅", disabled),
      button(`rsvp:maybe:${details.meeting.id}`, "Maybe", 2, "🤔", disabled),
      button(`rsvp:no:${details.meeting.id}`, "Can't", 2, "❌", disabled),
    ],
  };
}

export function meetingMessage(details: MeetingDetails): DiscordMessage {
  const { meeting, series, agenda } = details;
  const disabled = ["completed", "canceled", "skipped"].includes(meeting.status);
  const row = rsvpRow(details);
  (row.components as Record<string, unknown>[]).push(
    button(`agenda-add:${meeting.id}`, "Add agenda", 1, "➕", disabled),
    button(`agenda-edit:${meeting.id}`, "Edit agenda", 1, "✏️", disabled),
  );
  return {
    embeds: [{
      color: meeting.status === "live" ? 0x57f287 : meeting.status === "canceled" ? 0xed4245 : 0x5865f2,
      title: `${meeting.status === "live" ? "🔴 " : ""}${series.title}`,
      description: `**${STATUS_LABELS[meeting.status]}** · ${discordTimestamp(meeting.startsAt)} (${discordTimestamp(meeting.startsAt, "R")})`,
      fields: [
        { name: "Voice room", value: `<#${meeting.voiceChannelId}>`, inline: true },
        { name: "Duration", value: `${meeting.durationMinutes} minutes`, inline: true },
        { name: "Repeats", value: describeRecurrence(series), inline: true },
        { name: "Reminder audience", value: meeting.notifyRoleId === null ? "No ping" : meeting.notifyRoleId === meeting.guildId ? "@everyone" : `<@&${meeting.notifyRoleId}>`, inline: true },
        { name: "Agenda", value: agendaText(agenda), inline: false },
        { name: `✅ Going (${details.rsvps.filter((r) => r.response === "going").length})`, value: rsvpList(details, "going"), inline: true },
        { name: `🤔 Maybe (${details.rsvps.filter((r) => r.response === "maybe").length})`, value: rsvpList(details, "maybe"), inline: true },
        { name: `❌ Can't (${details.rsvps.filter((r) => r.response === "no").length})`, value: rsvpList(details, "no"), inline: true },
      ],
      footer: { text: `Meeting ${meeting.id} · Series ${series.id} · Agenda edits are open to everyone` },
    }],
    components: [row],
  };
}

export function liveMeetingMessage(details: MeetingDetails): DiscordMessage {
  const going = details.rsvps.filter((rsvp) => rsvp.response === "going").map((rsvp) => `<@${rsvp.userId}>`);
  return {
    embeds: [{
      color: 0x57f287,
      title: `🔴 ${details.series.title} is starting`,
      description: `Join <#${details.meeting.voiceChannelId}>`,
      fields: [
        { name: "Agenda", value: agendaText(details.agenda) },
        { name: `RSVP'd Going (${going.length})`, value: going.join(", ").slice(0, 1024) || "—" },
      ],
      footer: { text: `Use /agenda done as topics are completed · Meeting ${details.meeting.id}` },
    }],
  };
}

export function reminderMessage(details: MeetingDetails, label: string): DiscordMessage {
  return {
    embeds: [{
      color: 0xfee75c,
      title: `⏰ ${details.series.title} · ${label}`,
      description: `${discordTimestamp(details.meeting.startsAt)} · <#${details.meeting.voiceChannelId}>`,
      fields: [{ name: "Current agenda", value: agendaText(details.agenda) }],
      footer: { text: `Meeting ${details.meeting.id}` },
    }],
    components: [rsvpRow(details)],
  };
}

export function allowedMentions(
  roleId: string | null,
  guildId: string,
): { parse: string[]; roles: string[]; users: string[] } {
  if (!roleId) return { parse: [], roles: [], users: [] };
  if (roleId === guildId) return { parse: ["everyone"], roles: [], users: [] };
  return { parse: [], roles: [roleId], users: [] };
}

export function roleMention(roleId: string, guildId: string): string {
  return roleId === guildId ? "@everyone" : `<@&${roleId}>`;
}
