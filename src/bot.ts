import {
  Client,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type SendableChannels,
} from "discord.js";
import { DateTime } from "luxon";
import type { Config } from "./config.js";
import { registerCommands } from "./commands.js";
import { MeetingDatabase } from "./database.js";
import { createId } from "./ids.js";
import { dueReminderRules, mostRelevantReminder } from "./notifications.js";
import { firstOccurrenceIso, nextOccurrenceIso, parseWeekdays, validateSchedule } from "./recurrence.js";
import { agendaText, liveMeetingEmbed, meetingMessage, reminderEmbed, rsvpButtons } from "./presentation.js";
import type {
  Frequency,
  MeetingDetails,
  MeetingOccurrence,
  MeetingSeries,
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

function roleMention(roleId: string, guildId: string): string {
  return roleId === guildId ? "@everyone" : `<@&${roleId}>`;
}

function audienceMentions(roleId: string | null, guildId: string) {
  if (!roleId) return { parse: [] as "everyone"[], roles: [] as string[], users: [] as string[] };
  if (roleId === guildId) return { parse: ["everyone"] as "everyone"[], roles: [] as string[], users: [] as string[] };
  return { parse: [] as "everyone"[], roles: [roleId], users: [] as string[] };
}

function input(customId: string, label: string, value: string, required = true, maxLength = 100): TextInputBuilder {
  const item = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(required)
    .setMaxLength(maxLength);
  if (value) item.setValue(value);
  return item;
}

export class MeetingBot {
  readonly client: Client;
  private scheduler?: NodeJS.Timeout;
  private tickRunning = false;
  private readonly drafts = new Map<string, SeriesDraft>();

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
      if (interaction.isChannelSelectMenu()) return await this.handleDraftChannelSelect(interaction);
      if (interaction.isRoleSelectMenu()) return await this.handleDraftRoleSelect(interaction);
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
    const draft: SeriesDraft = {
      id: createId("draft"),
      userId: interaction.user.id,
      guildId: interaction.guildId!,
      title: "",
      firstDate: "",
      localTime: "10:00",
      timezone: this.config.defaultTimezone,
      durationMinutes: 60,
      frequency: "weekly",
      intervalCount: 1,
      weekdaysText: "",
      endsOn: "",
      occurrenceLimit: null,
      voiceChannelId: null,
      announcementChannelId: interaction.channel?.isTextBased() ? interaction.channelId : null,
      notifyRoleId: interaction.guildId!,
      createdAt: Date.now(),
    };
    this.drafts.set(draft.id, draft);
    await interaction.reply({ ...this.draftSummary(draft), ...ephemeral });
  }

  private requireDraft(id: string, userId: string, guildId: string | null): SeriesDraft {
    const draft = this.drafts.get(id);
    if (!draft || draft.userId !== userId || draft.guildId !== guildId || Date.now() - draft.createdAt > 60 * 60_000) {
      if (draft) this.drafts.delete(id);
      throw new Error("That setup draft expired. Run /series create to start again");
    }
    return draft;
  }

  private draftSummary(draft: SeriesDraft) {
    const audience = draft.notifyRoleId === null
      ? "No ping"
      : draft.notifyRoleId === draft.guildId ? "@everyone" : `<@&${draft.notifyRoleId}>`;
    const recurrence = draft.frequency === "once"
      ? "One time"
      : `${draft.frequency}, every ${draft.intervalCount}${draft.weekdaysText ? ` · ${draft.weekdaysText}` : ""}${draft.endsOn ? ` · through ${draft.endsOn}` : ""}${draft.occurrenceLimit ? ` · ${draft.occurrenceLimit} occurrences` : ""}`;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("Create a meeting series")
      .setDescription("This setup is private. Nothing is posted until you choose **Publish**.")
      .addFields(
        { name: "Meeting", value: draft.title ? `**${draft.title}**\n${draft.firstDate || "Date needed"} at ${draft.localTime} · ${draft.timezone}\n${draft.durationMinutes} minutes` : "Choose **Details**", inline: false },
        { name: "Repeats", value: recurrence, inline: true },
        { name: "Channels", value: `${draft.voiceChannelId ? `<#${draft.voiceChannelId}>` : "Voice channel needed"}\n${draft.announcementChannelId ? `<#${draft.announcementChannelId}>` : "Announcement channel needed"}`, inline: true },
        { name: "Audience", value: audience, inline: true },
        { name: "Notifications", value: "A quiet card when published, then reminders at **8 hours** and **10 minutes**. Reminders use the audience above and always include RSVP buttons.", inline: false },
      )
      .setFooter({ text: "RSVPs stay open through the meeting. Agenda edits update the card silently." });
    const main = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`draft:details:${draft.id}`).setLabel("Details").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`draft:recurrence:${draft.id}`).setLabel("Recurrence").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`draft:channels:${draft.id}`).setLabel("Channels").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`draft:audience:${draft.id}`).setLabel("Audience").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`draft:publish:${draft.id}`).setLabel("Publish").setStyle(ButtonStyle.Success),
    );
    const cancel = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`draft:cancel:${draft.id}`).setLabel("Cancel setup").setStyle(ButtonStyle.Danger),
    );
    return { embeds: [embed], components: [main, cancel] };
  }

  private draftChannelView(draft: SeriesDraft) {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("Choose channels")
      .setDescription("Choose where the meeting happens and where its card and reminders should appear.");
    const voice = new ChannelSelectMenuBuilder()
      .setCustomId(`draft-channel-voice:${draft.id}`)
      .setPlaceholder(draft.voiceChannelId ? "Change voice channel" : "Choose voice channel")
      .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice);
    const announcements = new ChannelSelectMenuBuilder()
      .setCustomId(`draft-channel-announcement:${draft.id}`)
      .setPlaceholder(draft.announcementChannelId ? "Change announcement channel" : "Choose announcement channel")
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
    const back = new ButtonBuilder().setCustomId(`draft:back:${draft.id}`).setLabel("Back").setStyle(ButtonStyle.Secondary);
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(voice),
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(announcements),
        new ActionRowBuilder<ButtonBuilder>().addComponents(back),
      ],
    };
  }

  private draftAudienceView(draft: SeriesDraft) {
    const current = draft.notifyRoleId === null ? "No ping" : draft.notifyRoleId === draft.guildId ? "@everyone" : `<@&${draft.notifyRoleId}>`;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("Choose the reminder audience")
      .setDescription(`Current choice: **${current}**\n\nOnly this audience can be pinged. The bot never pings individual RSVPs.`);
    return {
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`draft:everyone:${draft.id}`).setLabel("@everyone").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`draft:choose-role:${draft.id}`).setLabel("Choose a role").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`draft:no-ping:${draft.id}`).setLabel("No ping").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`draft:back:${draft.id}`).setLabel("Back").setStyle(ButtonStyle.Secondary),
      )],
    };
  }

  private draftRoleView(draft: SeriesDraft) {
    return {
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Choose one role").setDescription("That role will be pinged at 8 hours and 10 minutes, and for cancellations or reschedules.")],
      components: [
        new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
          new RoleSelectMenuBuilder().setCustomId(`draft-role:${draft.id}`).setPlaceholder("Choose a role"),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`draft:audience:${draft.id}`).setLabel("Back").setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }

  private async publishDraft(interaction: ButtonInteraction, draft: SeriesDraft): Promise<void> {
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
    this.database.createSeries(series, meeting);
    await this.publishMeeting(meeting.id);
    this.drafts.delete(draft.id);
    await interaction.update({
      content: `Created **${series.title}**. Its quiet meeting card is now in <#${series.announcementChannelId}>.`,
      embeds: [], components: [],
    });
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
        { name: "Notifications", value: "The meeting card is quiet. Reminders at 8 hours and 10 minutes ping the chosen role (default @everyone), or nobody when No ping is selected. Individual people are never pinged." },
      );
    await interaction.reply({ embeds: [embed], ...ephemeral });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith("draft:")) return this.handleDraftButton(interaction);
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

  private async handleDraftButton(interaction: ButtonInteraction): Promise<void> {
    const [, action, draftId] = interaction.customId.split(":");
    if (!action || !draftId) throw new Error("Invalid setup button");
    const draft = this.requireDraft(draftId, interaction.user.id, interaction.guildId);
    if (action === "cancel") {
      this.drafts.delete(draft.id);
      await interaction.update({ content: "Meeting setup canceled. Nothing was posted.", embeds: [], components: [] });
      return;
    }
    if (action === "back") return void await interaction.update(this.draftSummary(draft));
    if (action === "channels") return void await interaction.update(this.draftChannelView(draft));
    if (action === "audience") return void await interaction.update(this.draftAudienceView(draft));
    if (action === "choose-role") return void await interaction.update(this.draftRoleView(draft));
    if (action === "everyone") {
      draft.notifyRoleId = draft.guildId;
      return void await interaction.update(this.draftSummary(draft));
    }
    if (action === "no-ping") {
      draft.notifyRoleId = null;
      return void await interaction.update(this.draftSummary(draft));
    }
    if (action === "publish") return this.publishDraft(interaction, draft);
    if (action === "details") {
      const modal = new ModalBuilder().setCustomId(`draft-details-modal:${draft.id}`).setTitle("Meeting details").addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(input("title", "Meeting name", draft.title, true, 100)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(input("date", "First date (YYYY-MM-DD)", draft.firstDate, true, 10)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(input("time", "Time (24-hour HH:mm)", draft.localTime, true, 5)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(input("timezone", "Timezone", draft.timezone, true, 100)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(input("duration", "Duration in minutes", String(draft.durationMinutes), true, 4)),
      );
      await interaction.showModal(modal);
      return;
    }
    if (action === "recurrence") {
      const modal = new ModalBuilder().setCustomId(`draft-recurrence-modal:${draft.id}`).setTitle("Recurrence").addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(input("frequency", "once, daily, weekly, or monthly", draft.frequency, true, 7)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(input("every", "Repeat every…", String(draft.intervalCount), true, 2)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(input("weekdays", "Weekdays (example: mon,wed,fri)", draft.weekdaysText, false, 40)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(input("ends-on", "Optional ending date (YYYY-MM-DD)", draft.endsOn, false, 10)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(input("ends-after", "Optional number of occurrences", draft.occurrenceLimit ? String(draft.occurrenceLimit) : "", false, 3)),
      );
      await interaction.showModal(modal);
      return;
    }
    throw new Error("Unknown setup action");
  }

  private async handleDraftChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
    const [action, draftId] = interaction.customId.split(":");
    if (!draftId) throw new Error("Invalid channel choice");
    const draft = this.requireDraft(draftId, interaction.user.id, interaction.guildId);
    const channelId = interaction.values[0];
    if (!channelId) throw new Error("Choose a channel");
    if (action === "draft-channel-voice") draft.voiceChannelId = channelId;
    else if (action === "draft-channel-announcement") draft.announcementChannelId = channelId;
    else throw new Error("Unknown channel choice");
    await interaction.update(this.draftChannelView(draft));
  }

  private async handleDraftRoleSelect(interaction: RoleSelectMenuInteraction): Promise<void> {
    const [action, draftId] = interaction.customId.split(":");
    if (action !== "draft-role" || !draftId) throw new Error("Invalid role choice");
    const draft = this.requireDraft(draftId, interaction.user.id, interaction.guildId);
    const roleId = interaction.values[0];
    if (!roleId) throw new Error("Choose a role");
    draft.notifyRoleId = roleId;
    await interaction.update(this.draftSummary(draft));
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [action, meetingId] = interaction.customId.split(":");
    if (!meetingId || !interaction.guildId) throw new Error("Invalid form");
    if (action === "draft-details-modal" || action === "draft-recurrence-modal") {
      const draft = this.requireDraft(meetingId, interaction.user.id, interaction.guildId);
      if (action === "draft-details-modal") {
        const durationMinutes = Number(interaction.fields.getTextInputValue("duration"));
        if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 1440) {
          throw new Error("Duration must be a whole number from 5 to 1440 minutes");
        }
        const title = interaction.fields.getTextInputValue("title").trim();
        const firstDate = interaction.fields.getTextInputValue("date").trim();
        const localTime = interaction.fields.getTextInputValue("time").trim();
        const timezone = interaction.fields.getTextInputValue("timezone").trim();
        validateSchedule(firstDate, localTime, timezone);
        draft.title = title;
        draft.firstDate = firstDate;
        draft.localTime = localTime;
        draft.timezone = timezone;
        draft.durationMinutes = durationMinutes;
      } else {
        const frequency = interaction.fields.getTextInputValue("frequency").trim().toLowerCase();
        if (!["once", "daily", "weekly", "monthly"].includes(frequency)) {
          throw new Error("Frequency must be once, daily, weekly, or monthly");
        }
        const intervalCount = Number(interaction.fields.getTextInputValue("every"));
        if (!Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 52) {
          throw new Error("Repeat every must be a whole number from 1 to 52");
        }
        const weekdaysText = interaction.fields.getTextInputValue("weekdays").trim();
        if (frequency === "weekly") parseWeekdays(weekdaysText);
        else if (weekdaysText) throw new Error("Weekdays are only used for weekly meetings");
        const endsOn = interaction.fields.getTextInputValue("ends-on").trim();
        const endsAfterText = interaction.fields.getTextInputValue("ends-after").trim();
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
      await interaction.deferUpdate();
      await interaction.editReply(this.draftSummary(draft));
      return;
    }
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
    const message = await channel.send({
      ...meetingMessage(details),
      allowedMentions: { parse: [], roles: [], users: [] },
    });
    this.database.setAnnouncementMessage(id, message.id);
  }

  private async refreshMeetingPost(id: string): Promise<void> {
    const details = this.database.getMeetingDetails(id);
    if (!details?.meeting.announcementMessageId) return;
    try {
      const channel = await this.getTextChannel(details.meeting.announcementChannelId);
      const message = await channel.messages.fetch(details.meeting.announcementMessageId);
      await message.edit({ content: null, ...meetingMessage(details), allowedMentions: { parse: [], roles: [], users: [] } });
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
    await destination.send({ embeds: [liveMeetingEmbed(details, voiceUserIds)], allowedMentions: { parse: [], roles: [], users: [] } });
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
    const channel = await this.getTextChannel(details.meeting.announcementChannelId);
    const roleId = details.meeting.notifyRoleId;
    const mention = roleId ? `${roleMention(roleId, details.meeting.guildId)} ` : "";
    await channel.send({
      content: `${mention}⚠️ **${details.series.title}:** ${text}`,
      allowedMentions: audienceMentions(roleId, details.meeting.guildId),
    });
  }

  private async sendReminder(details: MeetingDetails, minutes: number, mention: "none" | "role"): Promise<void> {
    const roleId = mention === "role" ? details.meeting.notifyRoleId : null;
    const content = roleId ? roleMention(roleId, details.meeting.guildId) : undefined;
    const channel = await this.getTextChannel(details.meeting.announcementChannelId);
    await channel.send({
      ...(content ? { content } : {}),
      embeds: [reminderEmbed(details, reminderLabel(minutes))],
      components: [rsvpButtons(details)],
      allowedMentions: audienceMentions(roleId, details.meeting.guildId),
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
        } catch (error) {
          console.error(`Scheduler failed for meeting ${meeting.id}`, error);
        }
      }
    } finally {
      this.tickRunning = false;
    }
  }
}
