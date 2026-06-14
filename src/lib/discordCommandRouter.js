'use strict';

const {
  handleStatus,
  handleQueue,
  handleCooldown,
  handlePause,
  handleResume,
  handleReply,
  handleRetry,
} = require('./discordCommandHandlers');
const { handleAskCommand, handleAskModalSubmit, ASK_MODAL_CUSTOM_ID } = require('./discordAskHandler');

// Interaction types
const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
};

// Interaction response types
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
};

/**
 * Route a Discord interaction to the appropriate handler.
 * Returns a response object { status, body }.
 * @param {object} interaction - parsed Discord interaction payload
 * @returns {Promise<{status: number, body: object}>}
 */
async function routeInteraction(interaction) {
  const { type, data } = interaction;

  if (type === InteractionType.PING) {
    return { status: 200, body: { type: InteractionResponseType.PONG } };
  }

  if (type === InteractionType.APPLICATION_COMMAND) {
    const commandName = data && data.name;
    return await handleSlashCommand(commandName, interaction);
  }

  if (type === InteractionType.MODAL_SUBMIT) {
    return await handleModalSubmit(interaction);
  }

  if (type === InteractionType.MESSAGE_COMPONENT) {
    return await handleMessageComponent(interaction);
  }

  return {
    status: 200,
    body: {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '不明なインタラクションタイプです。', flags: 64 },
    },
  };
}

async function handleSlashCommand(commandName, interaction) {
  let result;

  switch (commandName) {
    case 'status':
      result = await handleStatus();
      break;
    case 'queue':
      result = await handleQueue();
      break;
    case 'cooldown':
      result = await handleCooldown();
      break;
    case 'pause':
      result = await handlePause();
      break;
    case 'resume':
      result = await handleResume();
      break;
    case 'reply':
      result = await handleReply(interaction);
      break;
    case 'retry':
      result = await handleRetry(interaction);
      break;
    case 'ask':
      return await handleAskCommand();
    default:
      return {
        status: 200,
        body: {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `不明なコマンド: /${commandName}`, flags: 64 },
        },
      };
  }

  return {
    status: 200,
    body: {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.content, flags: 64 },
    },
  };
}

async function handleModalSubmit(interaction) {
  const customId = interaction.data && interaction.data.custom_id;
  if (customId === ASK_MODAL_CUSTOM_ID) {
    return await handleAskModalSubmit(interaction);
  }
  return {
    status: 200,
    body: {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '不明なモーダルです。', flags: 64 },
    },
  };
}

async function handleMessageComponent(interaction) {
  // Will be implemented in SOT-532
  return {
    status: 200,
    body: {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'コンポーネント処理は準備中です。', flags: 64 },
    },
  };
}

module.exports = {
  routeInteraction,
  InteractionType,
  InteractionResponseType,
};
