import {
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
      .setDescription("Open the private meeting setup wizard"))
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
