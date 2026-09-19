import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { describeRecurrence } from "./recurrence.js";
import type { AgendaItem, MeetingDetails, RsvpResponse } from "./types.js";

const STATUS_LABELS: Record<MeetingDetails["meeting"]["status"], string> = {
  scheduled: "Scheduled",
  live: "Live now",
  completed: "Completed",
  canceled: "Canceled",
  skipped: "Skipped",
};

function discordTimestamp(iso: string, style: "F" | "R" = "F"): string {
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>`;
}

export function agendaText(items: AgendaItem[]): string {
  if (!items.length) return "*No agenda items yet — anyone can add one.*";
  const lines = items.map((item) => `${item.status === "done" ? "✅" : "⬜"} **${item.position}.** ${item.text}`);
  const text = lines.join("\n");
  return text.length > 1024 ? `${text.slice(0, 1018)}…` : text;
}

function rsvpList(details: MeetingDetails, response: RsvpResponse): string {
  const users = details.rsvps.filter((rsvp) => rsvp.response === response).map((rsvp) => `<@${rsvp.userId}>`);
  return users.length ? users.join(", ").slice(0, 1024) : "—";
}

export function meetingMessage(details: MeetingDetails): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const { meeting, series, agenda } = details;
  const embed = new EmbedBuilder()
    .setColor(meeting.status === "live" ? 0x57f287 : meeting.status === "canceled" ? 0xed4245 : 0x5865f2)
    .setTitle(`${meeting.status === "live" ? "🔴 " : ""}${series.title}`)
    .setDescription(`**${STATUS_LABELS[meeting.status]}** · ${discordTimestamp(meeting.startsAt)} (${discordTimestamp(meeting.startsAt, "R")})`)
    .addFields(
      { name: "Voice room", value: `<#${meeting.voiceChannelId}>`, inline: true },
      { name: "Duration", value: `${meeting.durationMinutes} minutes`, inline: true },
      { name: "Repeats", value: describeRecurrence(series), inline: true },
      { name: "Agenda", value: agendaText(agenda), inline: false },
      { name: `✅ Going (${details.rsvps.filter((r) => r.response === "going").length})`, value: rsvpList(details, "going"), inline: true },
      { name: `🤔 Maybe (${details.rsvps.filter((r) => r.response === "maybe").length})`, value: rsvpList(details, "maybe"), inline: true },
      { name: `❌ Can't (${details.rsvps.filter((r) => r.response === "no").length})`, value: rsvpList(details, "no"), inline: true },
    )
    .setFooter({ text: `Meeting ${meeting.id} · Series ${series.id} · Agenda edits are open to everyone` });

  const disabled = ["completed", "canceled", "skipped"].includes(meeting.status);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rsvp:going:${meeting.id}`).setLabel("Going").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`rsvp:maybe:${meeting.id}`).setLabel("Maybe").setEmoji("🤔").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`rsvp:no:${meeting.id}`).setLabel("Can't").setEmoji("❌").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`agenda-add:${meeting.id}`).setLabel("Add agenda").setEmoji("➕").setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`agenda-edit:${meeting.id}`).setLabel("Edit agenda").setEmoji("✏️").setStyle(ButtonStyle.Primary).setDisabled(disabled),
  );
  return { embeds: [embed], components: [row] };
}

export function liveMeetingEmbed(details: MeetingDetails, voiceUserIds: string[]): EmbedBuilder {
  const going = details.rsvps.filter((rsvp) => rsvp.response === "going").map((rsvp) => `<@${rsvp.userId}>`);
  const inRoom = voiceUserIds.map((id) => `<@${id}>`);
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`🔴 ${details.series.title} is starting`)
    .setDescription(`Join <#${details.meeting.voiceChannelId}>`)
    .addFields(
      { name: "Agenda", value: agendaText(details.agenda) },
      { name: `In the room (${inRoom.length})`, value: inRoom.join(", ").slice(0, 1024) || "No one yet", inline: true },
      { name: `RSVP'd Going (${going.length})`, value: going.join(", ").slice(0, 1024) || "—", inline: true },
    )
    .setFooter({ text: `Use /agenda done as topics are completed · Meeting ${details.meeting.id}` });
}

export function reminderEmbed(details: MeetingDetails, label: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`⏰ ${details.series.title} · ${label}`)
    .setDescription(`${discordTimestamp(details.meeting.startsAt)} · <#${details.meeting.voiceChannelId}>`)
    .addFields({ name: "Current agenda", value: agendaText(details.agenda) })
    .setFooter({ text: `Meeting ${details.meeting.id}` });
}
