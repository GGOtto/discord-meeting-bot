import {
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import type { Config } from "./config.js";

const seriesIdOption = (option: import("discord.js").SlashCommandStringOption) =>
  option.setName("series").setDescription("Series ID").setRequired(true).setAutocomplete(true);

const meetingIdOption = (option: import("discord.js").SlashCommandStringOption) =>
  option.setName("meeting").setDescription("Meeting ID").setRequired(true).setAutocomplete(true);

export const commands = [
  new SlashCommandBuilder()
    .setName("series")
    .setDescription("Create and manage recurring meeting series")
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand
      .setName("create")
      .setDescription("Create a meeting or recurring series")
      .addStringOption((option) => option.setName("title").setDescription("Meeting name").setRequired(true).setMaxLength(100))
      .addStringOption((option) => option.setName("first-date").setDescription("First date as YYYY-MM-DD").setRequired(true))
      .addStringOption((option) => option.setName("time").setDescription("Local time as 24-hour HH:mm").setRequired(true))
      .addStringOption((option) => option.setName("timezone").setDescription("IANA timezone, such as America/Los_Angeles").setRequired(true))
      .addChannelOption((option) => option
        .setName("voice-channel")
        .setDescription("Voice channel where the meeting happens")
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(true))
      .addChannelOption((option) => option
        .setName("announcement-channel")
        .setDescription("Channel for the meeting card and reminders")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true))
      .addStringOption((option) => option
        .setName("frequency")
        .setDescription("How often the meeting repeats")
        .setRequired(true)
        .addChoices(
          { name: "One time", value: "once" },
          { name: "Daily", value: "daily" },
          { name: "Weekly", value: "weekly" },
          { name: "Monthly", value: "monthly" },
        ))
      .addIntegerOption((option) => option.setName("every").setDescription("Repeat every N days/weeks/months (default 1)").setMinValue(1).setMaxValue(52))
      .addStringOption((option) => option.setName("weekdays").setDescription("For weekly meetings: mon,wed,fri"))
      .addIntegerOption((option) => option.setName("duration").setDescription("Duration in minutes (default 60)").setMinValue(5).setMaxValue(1440))
      .addStringOption((option) => option
        .setName("notifications")
        .setDescription("Notification level (default Balanced)")
        .addChoices(
          { name: "Quiet", value: "quiet" },
          { name: "Balanced", value: "balanced" },
          { name: "High visibility", value: "high" },
        ))
      .addRoleOption((option) => option.setName("notify-role").setDescription("Role invited and optionally mentioned by reminders"))
      .addStringOption((option) => option.setName("first-agenda-item").setDescription("Optional first agenda item").setMaxLength(500))
      .addStringOption((option) => option.setName("ends-on").setDescription("Optional final local date as YYYY-MM-DD"))
      .addIntegerOption((option) => option.setName("ends-after").setDescription("Optional maximum number of occurrences").setMinValue(1).setMaxValue(500)))
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List active meeting series"))
    .addSubcommand((subcommand) => subcommand.setName("pause").setDescription("Pause future occurrences").addStringOption(seriesIdOption))
    .addSubcommand((subcommand) => subcommand.setName("resume").setDescription("Resume a paused series").addStringOption(seriesIdOption))
    .addSubcommand((subcommand) => subcommand.setName("stop").setDescription("Permanently stop a series").addStringOption(seriesIdOption)),

  new SlashCommandBuilder()
    .setName("meeting")
    .setDescription("View and manage individual meetings")
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List upcoming meetings"))
    .addSubcommand((subcommand) => subcommand.setName("show").setDescription("Show a meeting").addStringOption(meetingIdOption))
    .addSubcommand((subcommand) => subcommand.setName("start").setDescription("Start a meeting now").addStringOption(meetingIdOption))
    .addSubcommand((subcommand) => subcommand.setName("end").setDescription("End a live meeting and publish the next one").addStringOption(meetingIdOption))
    .addSubcommand((subcommand) => subcommand.setName("cancel").setDescription("Cancel this occurrence").addStringOption(meetingIdOption))
    .addSubcommand((subcommand) => subcommand.setName("skip").setDescription("Skip this occurrence and publish the next one").addStringOption(meetingIdOption))
    .addSubcommand((subcommand) => subcommand
      .setName("reschedule")
      .setDescription("Reschedule this occurrence only")
      .addStringOption(meetingIdOption)
      .addStringOption((option) => option.setName("date").setDescription("New local date as YYYY-MM-DD").setRequired(true))
      .addStringOption((option) => option.setName("time").setDescription("New local time as HH:mm").setRequired(true))),

  new SlashCommandBuilder()
    .setName("agenda")
    .setDescription("Collaboratively edit a meeting agenda")
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand
      .setName("add")
      .setDescription("Add an agenda item")
      .addStringOption(meetingIdOption)
      .addStringOption((option) => option.setName("item").setDescription("Agenda item").setRequired(true).setMaxLength(500)))
    .addSubcommand((subcommand) => subcommand
      .setName("edit")
      .setDescription("Edit an agenda item")
      .addStringOption(meetingIdOption)
      .addIntegerOption((option) => option.setName("number").setDescription("Agenda item number").setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName("item").setDescription("Replacement text").setRequired(true).setMaxLength(500)))
    .addSubcommand((subcommand) => subcommand
      .setName("remove")
      .setDescription("Remove an agenda item")
      .addStringOption(meetingIdOption)
      .addIntegerOption((option) => option.setName("number").setDescription("Agenda item number").setRequired(true).setMinValue(1)))
    .addSubcommand((subcommand) => subcommand
      .setName("done")
      .setDescription("Mark an agenda item discussed so it does not roll forward")
      .addStringOption(meetingIdOption)
      .addIntegerOption((option) => option.setName("number").setDescription("Agenda item number").setRequired(true).setMinValue(1)))
    .addSubcommand((subcommand) => subcommand
      .setName("reopen")
      .setDescription("Reopen a completed agenda item")
      .addStringOption(meetingIdOption)
      .addIntegerOption((option) => option.setName("number").setDescription("Agenda item number").setRequired(true).setMinValue(1)))
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription("Show an agenda").addStringOption(meetingIdOption)),

  new SlashCommandBuilder()
    .setName("notifications")
    .setDescription("Set your personal meeting notification preference")
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand
      .setName("set")
      .setDescription("Choose how the bot should notify you")
      .addStringOption((option) => option
        .setName("mode")
        .setDescription("Your preference")
        .setRequired(true)
        .addChoices(
          { name: "Channel only", value: "channel" },
          { name: "Channel + direct messages", value: "dm" },
          { name: "Direct messages for important changes only", value: "important" },
          { name: "No personal notifications", value: "off" },
        ))),

  new SlashCommandBuilder()
    .setName("meeting-help")
    .setDescription("Show how to use the meeting bot")
    .setDMPermission(false),
].map((command) => command.toJSON());

export async function registerCommands(config: Config): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.token);
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
    console.log(`Registered ${commands.length} commands in development guild ${config.guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log(`Registered ${commands.length} global commands`);
  }
}
