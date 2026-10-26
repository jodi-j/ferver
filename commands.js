import 'dotenv/config';
import { capitalize, InstallGlobalCommands, InstallGuildCommands } from './utils.js';

// Simple test command
const TEST_COMMAND = {
  name: 'test',
  description: 'Basic command',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Create event via interactive modal + select menus
const CREATE_EVENT_COMMAND = {
  name: 'create-event',
  description: 'Create a band event with a channel, members, and scheduled event',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const ALL_COMMANDS = [TEST_COMMAND, CREATE_EVENT_COMMAND];

const guildId = process.env.GUILD_ID;

if (guildId) {
  InstallGuildCommands(process.env.APP_ID, guildId, ALL_COMMANDS);
} else {
  InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
}
