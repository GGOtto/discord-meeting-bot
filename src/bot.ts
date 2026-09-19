import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction,
  type SendableChannels,
} from "discord.js";
import { DateTime } from "luxon";
import type { Config } from "./config.js";
import { registerCommands } from "./commands.js";
import { MeetingDatabase } from "./database.js";
import { createId } from "./ids.js";
import { dueReminderRules, mostRelevantReminder } from "./notifications.js";
import { firstOccurrenceIso, nextOccurrenceIso, parseWeekdays, validateSchedule } from "./recurrence.js";
import { agendaText, liveMeetingEmbed, meetingMessage, reminderEmbed } from "./presentation.js";
import type {
  MeetingDetails,
  MeetingOccurrence,
  MeetingSeries,
  NotificationPreset,
  RsvpResponse,
} from "./types.js";

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

function reminderLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `in ${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes >= 60 && minutes % 60 === 0) return `in ${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `in ${minutes} minutes`;
}

function isOrganizer(interaction: ChatInputCommandInteraction, details: MeetingDetails): boolean {
  if (interaction.user.id === details.series.creatorId) return true;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents));
}

function invitedRoleId(details: MeetingDetails): string {
  return details.meeting.notifyRoleId ?? details.meeting.guildId;
}

function roleMention(roleId: string, guildId: string): string {
  return roleId === guildId ? "@everyone" : `<@&${roleId}>`;
}

export class MeetingBot {
  readonly client: Client;
  private scheduler?: NodeJS.Timeout;
  private tickRunning = false;

  constructor(
    private readonly config: Config,
    private readonly database: MeetingDatabase,
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });
  }

  async start(): Promise<void> {
    await registerCommands(this.config);
    this.client.once(Events.ClientReady, () => {
      console.log(`Meeting bot ready as ${this.client.user?.tag ?? "unknown"}`);
      void this.tick();
      this.scheduler = setInterval(() => void this.tick(), this.config.schedulerIntervalMs);
    });
    this.client.on("interactionCreate", (interaction) => void this.handleInteraction(interaction));
    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    if (this.scheduler) clearInterval(this.scheduler);
    this.client.destroy();
    this.database.close();
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isAutocomplete()) return await this.handleAutocomplete(interaction);
      if (interaction.isButton()) return await this.handleButton(interaction);
      if (interaction.isModalSubmit()) return await this.handleModal(interaction);
      if (interaction.isChatInputCommand()) return await this.handleCommand(interaction);
    } catch (error) {
      console.error("Interaction failed", error);
      const message = error instanceof Error ? error.message : "Something went wrong";
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) await interaction.followUp({ content: `⚠️ ${message}`, ...ephemeral }).catch(() => undefined);
        else await interaction.reply({ content: `⚠️ ${message}`, ...ephemeral }).catch(() => undefined);
      }
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (!interaction.guildId) return interaction.respond([]);
    const focused = interaction.options.getFocused().toLowerCase();
    if (interaction.commandName === "series") {
      const choices = this.database.listSeries(interaction.guildId)
        .filter((series) => `${series.id} ${series.title}`.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((series) => ({ name: `${series.title} · ${series.id}`, value: series.id }));
      return interaction.respond(choices);
    }
    const choices = this.database.listUpcoming(interaction.guildId, 25)
      .map((meeting) => ({ meeting, details: this.database.getMeetingDetails(meeting.id) }))
      .filter(({ meeting, details }) => `${meeting.id} ${details?.series.title ?? ""}`.toLowerCase().includes(focused))
      .map(({ meeting, details }) => ({
        name: `${details?.series.title ?? "Meeting"} · ${DateTime.fromISO(meeting.startsAt).toFormat("LLL d")} · ${meeting.id}`.slice(0, 100),
        value: meeting.id,
      }));
    await interaction.respond(choices);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) throw new Error("This command only works in a server");
    switch (interaction.commandName) {
      case "series": return this.handleSeriesCommand(interaction);
      case "meeting": return this.handleMeetingCommand(interaction);
      case "agenda": return this.handleAgendaCommand(interaction);
      case "meeting-help": return this.handleHelp(interaction);
      default: throw new Error("Unknown command");
    }
  }

  private async handleSeriesCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "create") return this.createSeries(interaction);
    if (subcommand === "list") {
      const series = this.database.listSeries(interaction.guildId!);
      const description = series.length
        ? series.map((item) => `**${item.title}** · \`${item.id}\` · ${item.status} · ${item.frequency}`).join("\n")
        : "No active meeting series yet.";
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Meeting series").setDescription(description)], ...ephemeral });
      return;
    }

    const seriesId = interaction.options.getString("series", true);
    const series = this.database.getSeries(seriesId);
    if (!series || series.guildId !== interaction.guildId) throw new Error("Meeting series not found");
    if (interaction.user.id !== series.creatorId && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) {
      throw new Error("Only the organizer or a server event manager can change this series");
    }
    if (subcommand === "pause") this.database.setSeriesStatus(series.id, "paused");
    if (subcommand === "stop") {
      const scheduled = this.database.openMeetingForSeries(series.id);
      this.database.setSeriesStatus(series.id, "stopped");
      this.database.cancelScheduledForSeries(series.id);
      if (scheduled?.status === "scheduled") await this.refreshMeetingPost(scheduled.id);
    }
    if (subcommand === "resume") {
      if (series.status === "stopped") throw new Error("A stopped series cannot be resumed");
      this.database.setSeriesStatus(series.id, "active");
      await this.ensureNextMeeting({ ...series, status: "active" });
    }
    await interaction.reply({ content: `Series **${series.title}** is now **${subcommand === "stop" ? "stopped" : subcommand === "pause" ? "paused" : "active"}**.`, ...ephemeral });
  }

  private async createSeries(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply(ephemeral);
    const title = interaction.options.getString("title", true).trim();
    const firstDate = interaction.options.getString("first-date", true);
    const localTime = interaction.options.getString("time", true);
    const timezone = interaction.options.getString("timezone", true);
    const frequency = interaction.options.getString("frequency", true) as MeetingSeries["frequency"];
    const voiceChannel = interaction.options.getChannel("voice-channel", true);
    const announcementChannel = interaction.options.getChannel("announcement-channel", true);
    const role = interaction.options.getRole("notify-role");
    const intervalCount = interaction.options.getInteger("every") ?? 1;
    const durationMinutes = interaction.options.getInteger("duration") ?? 60;
    const notificationPreset = (interaction.options.getString("notifications") ?? "balanced") as NotificationPreset;
    const endsOn = interaction.options.getString("ends-on");
    const occurrenceLimit = interaction.options.getInteger("ends-after");
    if (endsOn && occurrenceLimit) throw new Error("Choose either ends-on or ends-after, not both");
    const firstLocal = validateSchedule(firstDate, localTime, timezone);
    if (firstLocal.toMillis() <= Date.now()) throw new Error("The first meeting must be in the future");
    if (endsOn) {
      validateSchedule(endsOn, localTime, timezone);
      if (endsOn < firstDate) throw new Error("The ending date cannot be before the first meeting");
    }
    const weekdays = frequency === "weekly"
      ? (parseWeekdays(interaction.options.getString("weekdays")) || [])
      : [];
    if (frequency === "weekly" && !weekdays.length) weekdays.push(firstLocal.weekday);
    if (frequency === "weekly" && !weekdays.includes(firstLocal.weekday)) {
      throw new Error("The first date must fall on one of the selected weekdays");
    }
    if (frequency !== "weekly" && interaction.options.getString("weekdays")) {
      throw new Error("The weekdays option is only used with weekly meetings");
    }
    const now = new Date().toISOString();
    const series: MeetingSeries = {
      id: createId("ser"), guildId: interaction.guildId!, title, creatorId: interaction.user.id,
      voiceChannelId: voiceChannel.id, announcementChannelId: announcementChannel.id,
      notifyRoleId: role?.id ?? interaction.guildId!, timezone, localTime, firstDate, frequency, intervalCount,
      weekdays, monthDay: frequency === "monthly" ? firstLocal.day : null, durationMinutes,
      notificationPreset, endsOn, occurrenceLimit, status: "active", createdAt: now, updatedAt: now,
    };
    const meeting: MeetingOccurrence = {
      id: createId("mtg"), seriesId: series.id, guildId: series.guildId,
      startsAt: firstOccurrenceIso(firstDate, localTime, timezone), durationMinutes,
      status: "scheduled", announcementChannelId: series.announcementChannelId,
      announcementMessageId: null, voiceChannelId: series.voiceChannelId,
      notifyRoleId: series.notifyRoleId, notificationPreset, createdAt: now, updatedAt: now,
    };
    this.database.createSeries(series, meeting, interaction.options.getString("first-agenda-item") ?? undefined);
    await this.publishMeeting(meeting.id);
    await interaction.editReply(`Created **${title}**. Meeting ID: \`${meeting.id}\` · Series ID: \`${series.id}\``);
  }

  private async handleMeetingCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "list") {
      const meetings = this.database.listUpcoming(interaction.guildId!);
      const description = meetings.length
        ? meetings.map((meeting) => {
          const details = this.database.getMeetingDetails(meeting.id);
          const unix = Math.floor(new Date(meeting.startsAt).getTime() / 1000);
          return `**${details?.series.title ?? "Meeting"}** · <t:${unix}:F> · \`${meeting.id}\``;
        }).join("\n")
        : "No upcoming meetings.";
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Upcoming meetings").setDescription(description)], ...ephemeral });
      return;
    }

    const id = interaction.options.getString("meeting", true);
    const details = this.requireMeeting(id, interaction.guildId!);
    if (subcommand === "show") {
      await interaction.reply({ ...meetingMessage(details), ...ephemeral });
      return;
    }
    if (!isOrganizer(interaction, details)) throw new Error("Only the organizer or a server event manager can do that");
    await interaction.deferReply(ephemeral);
    if (subcommand === "start") {
      await this.startMeeting(details.meeting.id);
      await interaction.editReply("Meeting started and the agenda was posted in the voice room's chat.");
      return;
    }
    if (subcommand === "end") {
      await this.finishMeeting(details.meeting.id, "completed");
      await interaction.editReply("Meeting ended. Unfinished agenda items were carried into the next occurrence.");
      return;
    }
    if (subcommand === "cancel" || subcommand === "skip") {
      const status = subcommand === "skip" ? "skipped" : "canceled";
      this.database.setMeetingStatus(details.meeting.id, status);
      await this.refreshMeetingPost(details.meeting.id);
      await this.sendImportantChange(this.requireMeeting(id, interaction.guildId!), `This meeting was **${status}**.`);
      await this.ensureNextMeeting(details.series, details.meeting);
      await interaction.editReply(`Meeting ${status}. The recurring series remains active.`);
      return;
    }
    if (subcommand === "reschedule") {
      if (details.meeting.status !== "scheduled") throw new Error("Only scheduled meetings can be rescheduled");
      const date = interaction.options.getString("date", true);
      const time = interaction.options.getString("time", true);
      const startsAt = firstOccurrenceIso(date, time, details.series.timezone);
      if (new Date(startsAt).getTime() <= Date.now()) throw new Error("The new meeting time must be in the future");
      this.database.rescheduleMeeting(id, startsAt);
      await this.refreshMeetingPost(id);
      await this.sendImportantChange(this.requireMeeting(id, interaction.guildId!), `The meeting was rescheduled to <t:${Math.floor(new Date(startsAt).getTime() / 1000)}:F>.`);
      await interaction.editReply("Meeting rescheduled. This change affects only this occurrence.");
    }
  }

  private async handleAgendaCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    const id = interaction.options.getString("meeting", true);
    const details = this.requireMeeting(id, interaction.guildId!);
    if (["completed", "canceled", "skipped"].includes(details.meeting.status) && subcommand !== "list") {
      throw new Error("That meeting's agenda is closed");
    }
    if (subcommand === "list") {
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle(details.series.title).setDescription(agendaText(details.agenda))], ...ephemeral });
      return;
    }
    let changed = false;
    if (subcommand === "add") {
      this.database.addAgendaItem(id, interaction.options.getString("item", true), interaction.user.id);
      changed = true;
    }
    const number = interaction.options.getInteger("number");
    if (subcommand === "edit") changed = this.database.editAgendaItem(id, number!, interaction.options.getString("item", true));
    if (subcommand === "remove") changed = this.database.removeAgendaItem(id, number!);
    if (subcommand === "done") changed = this.database.setAgendaStatus(id, number!, "done");
    if (subcommand === "reopen") changed = this.database.setAgendaStatus(id, number!, "open");
    if (!changed) throw new Error("Agenda item not found");
    await this.refreshMeetingPost(id);
    await interaction.reply({ content: "Agenda updated.", ...ephemeral });
  }

  private async handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("Meeting bot help")
      .setDescription("Recurring meetings with collaborative agendas and low-noise reminders.")
      .addFields(
        { name: "Create", value: "Use `/series create`. Weekly schedules can use multiple days such as `mon,wed,fri`." },
        { name: "RSVP", value: "Use the buttons on a meeting card." },
        { name: "Agenda", value: "Anyone can use the agenda buttons or `/agenda add`, `/agenda edit`, and `/agenda done`. Unfinished items roll forward." },
        { name: "During the meeting", value: "The bot posts the agenda and attendance in the voice room's text chat. It never records or listens." },
        { name: "Notifications", value: "All notices stay in the announcement channel. Balanced sends a quiet 24-hour reminder and pings attendees at 10 minutes." },
      );
    await interaction.reply({ embeds: [embed], ...ephemeral });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const [action, value, idFromThird] = interaction.customId.split(":");
    if (action === "rsvp") {
      const id = idFromThird;
      if (!id || !interaction.guildId) throw new Error("Invalid RSVP button");
      const details = this.requireMeeting(id, interaction.guildId);
      if (["completed", "canceled", "skipped"].includes(details.meeting.status)) throw new Error("RSVPs are closed");
      this.database.upsertRsvp(id, interaction.user.id, value as RsvpResponse);
      await interaction.deferUpdate();
      await this.refreshMeetingPost(id);
      return;
    }
    if ((action === "agenda-add" || action === "agenda-edit") && value) {
      const details = this.requireMeeting(value, interaction.guildId!);
      if (["completed", "canceled", "skipped"].includes(details.meeting.status)) throw new Error("That agenda is closed");
      const modal = new ModalBuilder()
        .setCustomId(`${action}-modal:${value}`)
        .setTitle(action === "agenda-add" ? "Add an agenda item" : "Edit an agenda item");
      if (action === "agenda-edit") {
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("position").setLabel("Agenda item number").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3),
        ));
      }
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("text").setLabel(action === "agenda-add" ? "Agenda item" : "New text").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
      ));
      await interaction.showModal(modal);
    }
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [action, meetingId] = interaction.customId.split(":");
    if (!meetingId || !interaction.guildId) throw new Error("Invalid agenda form");
    const details = this.requireMeeting(meetingId, interaction.guildId);
    if (["completed", "canceled", "skipped"].includes(details.meeting.status)) throw new Error("That agenda is closed");
    const text = interaction.fields.getTextInputValue("text").trim();
    if (action === "agenda-add-modal") this.database.addAgendaItem(meetingId, text, interaction.user.id);
    else if (action === "agenda-edit-modal") {
      const position = Number(interaction.fields.getTextInputValue("position"));
      if (!Number.isInteger(position) || position < 1) throw new Error("Enter a valid agenda item number");
      if (!this.database.editAgendaItem(meetingId, position, text)) throw new Error("Agenda item not found");
    } else throw new Error("Unknown agenda form");
    await interaction.reply({ content: "Agenda updated.", ...ephemeral });
    await this.refreshMeetingPost(meetingId);
  }

  private requireMeeting(id: string, guildId: string): MeetingDetails {
    const details = this.database.getMeetingDetails(id);
    if (!details || details.meeting.guildId !== guildId) throw new Error("Meeting not found");
    return details;
  }

  private async getTextChannel(id: string): Promise<SendableChannels> {
    const channel = await this.client.channels.fetch(id);
    if (!channel?.isTextBased() || !channel.isSendable()) throw new Error("The bot cannot send messages in the selected channel");
    return channel;
  }

  private async publishMeeting(id: string): Promise<void> {
    const details = this.database.getMeetingDetails(id);
    if (!details) throw new Error("Meeting not found");
    const channel = await this.getTextChannel(details.meeting.announcementChannelId);
    const roleId = invitedRoleId(details);
    const mentionEveryone = roleId === details.meeting.guildId;
    const message = await channel.send({
      content: `${roleMention(roleId, details.meeting.guildId)} New meeting scheduled`,
      ...meetingMessage(details),
      allowedMentions: {
        parse: mentionEveryone ? ["everyone"] : [],
        roles: mentionEveryone ? [] : [roleId],
        users: [],
      },
    });
    this.database.setAnnouncementMessage(id, message.id);
  }

  private async refreshMeetingPost(id: string): Promise<void> {
    const details = this.database.getMeetingDetails(id);
    if (!details?.meeting.announcementMessageId) return;
    try {
      const channel = await this.getTextChannel(details.meeting.announcementChannelId);
      const message = await channel.messages.fetch(details.meeting.announcementMessageId);
      await message.edit(meetingMessage(details));
    } catch (error) {
      console.warn(`Could not refresh meeting post ${id}`, error);
    }
  }

  private async startMeeting(id: string): Promise<void> {
    let details = this.database.getMeetingDetails(id);
    if (!details || details.meeting.status !== "scheduled") return;
    this.database.setMeetingStatus(id, "live");
    details = this.database.getMeetingDetails(id)!;
    const voiceChannel = await this.client.channels.fetch(details.meeting.voiceChannelId);
    const voiceUserIds = voiceChannel?.isVoiceBased()
      ? [...voiceChannel.members.values()].filter((member: GuildMember) => !member.user.bot).map((member: GuildMember) => member.id)
      : [];
    const destination = voiceChannel?.isTextBased() && voiceChannel.isSendable()
      ? voiceChannel
      : await this.getTextChannel(details.meeting.announcementChannelId);
    await destination.send({ embeds: [liveMeetingEmbed(details, voiceUserIds)] });
    await this.refreshMeetingPost(id);
  }

  private async finishMeeting(id: string, status: "completed"): Promise<void> {
    const details = this.database.getMeetingDetails(id);
    if (!details || !["live", "scheduled"].includes(details.meeting.status)) return;
    this.database.setMeetingStatus(id, status);
    await this.refreshMeetingPost(id);
    await this.ensureNextMeeting(details.series, details.meeting);
  }

  private async ensureNextMeeting(series: MeetingSeries, afterMeeting?: MeetingOccurrence): Promise<MeetingOccurrence | null> {
    if (series.status !== "active" || series.frequency === "once") return null;
    const existing = this.database.openMeetingForSeries(series.id);
    if (existing) return existing;
    const previous = afterMeeting ?? this.database.latestMeetingForSeries(series.id);
    if (!previous) return null;
    if (series.occurrenceLimit && this.database.occurrenceCount(series.id) >= series.occurrenceLimit) {
      this.database.setSeriesStatus(series.id, "stopped");
      return null;
    }
    const startsAt = nextOccurrenceIso(series, previous.startsAt);
    if (!startsAt) {
      this.database.setSeriesStatus(series.id, "stopped");
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
    this.database.createNextMeeting(meeting, previous.id);
    await this.publishMeeting(meeting.id);
    return meeting;
  }

  private async sendImportantChange(details: MeetingDetails, text: string): Promise<void> {
    const attendeeIds = details.rsvps.filter((rsvp) => rsvp.response !== "no").map((rsvp) => rsvp.userId);
    const channel = await this.getTextChannel(details.meeting.announcementChannelId);
    const mentions = attendeeIds.map((id) => `<@${id}>`).join(" ");
    await channel.send({
      content: `${mentions ? `${mentions} ` : ""}⚠️ **${details.series.title}:** ${text}`,
      allowedMentions: { users: attendeeIds, roles: [] },
    });
  }

  private async sendReminder(details: MeetingDetails, minutes: number, mention: "none" | "attendees" | "role-and-attendees"): Promise<void> {
    const attendeeIds = details.rsvps.filter((rsvp) => rsvp.response !== "no").map((rsvp) => rsvp.userId);
    const inviteRoleId = invitedRoleId(details);
    const roleIds = mention === "role-and-attendees" && inviteRoleId !== details.meeting.guildId ? [inviteRoleId] : [];
    const mentionEveryone = mention === "role-and-attendees" && inviteRoleId === details.meeting.guildId;
    const userMentions = mention === "none" ? [] : attendeeIds;
    const content = [
      ...(mentionEveryone ? ["@everyone"] : roleIds.map((id) => `<@&${id}>`)),
      ...userMentions.map((id) => `<@${id}>`),
    ].join(" ") || undefined;
    const channel = await this.getTextChannel(details.meeting.announcementChannelId);
    await channel.send({
      ...(content ? { content } : {}),
      embeds: [reminderEmbed(details, reminderLabel(minutes))],
      allowedMentions: { parse: mentionEveryone ? ["everyone"] : [], roles: roleIds, users: userMentions },
    });
  }

  private async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      const now = new Date();
      for (const meeting of this.database.listSchedulerMeetings()) {
        try {
          const startsAt = new Date(meeting.startsAt).getTime();
          if (meeting.status === "scheduled" && startsAt + meeting.durationMinutes * 60_000 <= now.getTime()) {
            // If the bot was offline for the whole meeting, advance the series without posting a stale live alert.
            await this.finishMeeting(meeting.id, "completed");
            continue;
          }
          if (meeting.status === "scheduled" && startsAt <= now.getTime()) {
            await this.startMeeting(meeting.id);
            continue;
          }
          if (meeting.status === "live" && startsAt + meeting.durationMinutes * 60_000 <= now.getTime()) {
            await this.finishMeeting(meeting.id, "completed");
            continue;
          }
          if (meeting.status !== "scheduled") continue;
          const details = this.database.getMeetingDetails(meeting.id);
          if (!details) continue;
          const sent = this.database.getSentNotificationKeys(meeting.id);
          const due = dueReminderRules(meeting.notificationPreset, meeting.startsAt, now, sent);
          const reminder = mostRelevantReminder(due);
          if (reminder) {
            await this.sendReminder(details, reminder.minutesBefore, reminder.mention);
            this.database.markNotificationsSent(meeting.id, due.map((rule) => rule.key));
          }
          const emptyAgendaDue = meeting.notificationPreset !== "quiet"
            && !details.agenda.length
            && now.getTime() >= startsAt - 24 * 60 * 60_000
            && !sent.has("empty-agenda-24h");
          if (emptyAgendaDue) {
            const channel = await this.getTextChannel(details.meeting.announcementChannelId);
            await channel.send({
              content: `<@${details.series.creatorId}> 📝 **${details.series.title}** starts within 24 hours and has no agenda items yet.`,
              allowedMentions: { users: [details.series.creatorId], roles: [] },
            });
            this.database.markNotificationsSent(meeting.id, ["empty-agenda-24h"]);
          }
        } catch (error) {
          console.error(`Scheduler failed for meeting ${meeting.id}`, error);
        }
      }
    } finally {
      this.tickRunning = false;
    }
  }
}
