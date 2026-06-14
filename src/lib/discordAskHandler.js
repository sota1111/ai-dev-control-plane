'use strict';

const { classifyIntent } = require('./discordIntentClassifier');
const {
  handleStatusIntent,
  handleQueueIntent,
  handleCooldownIntent,
  handleIssueStatusIntent,
  handleLogSummaryIntent,
  handleCommentPostIntent,
  handleRetrySuggestIntent,
  handleDangerousIntent,
  handleUnknownIntent,
} = require('./discordIntentHandlers');

const ASK_MODAL_CUSTOM_ID = 'discord_ask_modal';
const ASK_INPUT_CUSTOM_ID = 'ask_input';
const MAX_INPUT_LENGTH = 500;

/**
 * Handle /ask slash command — returns a modal response.
 */
async function handleAskCommand() {
  return {
    status: 200,
    body: {
      type: 9, // MODAL
      data: {
        custom_id: ASK_MODAL_CUSTOM_ID,
        title: 'ai-dev-control-plane に質問・指示',
        components: [
          {
            type: 1, // ACTION_ROW
            components: [
              {
                type: 4, // TEXT_INPUT
                custom_id: ASK_INPUT_CUSTOM_ID,
                label: '質問・指示を入力',
                style: 2, // PARAGRAPH
                placeholder: '例: 今どのタスクを実行中？/ SOT-123 の最新ログを要約して',
                required: true,
                max_length: MAX_INPUT_LENGTH,
              },
            ],
          },
        ],
      },
    },
  };
}

/**
 * Handle modal submit for /ask — classify intent and execute.
 */
async function handleAskModalSubmit(interaction) {
  // Extract input from modal components
  const components = interaction.data && interaction.data.components || [];
  let inputText = '';
  for (const row of components) {
    if (row.type === 1 && row.components) {
      for (const comp of row.components) {
        if (comp.custom_id === ASK_INPUT_CUSTOM_ID) {
          inputText = (comp.value || '').trim();
        }
      }
    }
  }

  if (!inputText) {
    return {
      status: 200,
      body: {
        type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
        data: { content: '❌ 入力が空です。', flags: 64 },
      },
    };
  }

  if (inputText.length > MAX_INPUT_LENGTH) {
    return {
      status: 200,
      body: {
        type: 4,
        data: { content: `❌ 入力が長すぎます（最大${MAX_INPUT_LENGTH}文字）。`, flags: 64 },
      },
    };
  }

  const { intent, issueId, originalText } = classifyIntent(inputText);

  let responseContent;

  switch (intent) {
    case 'STATUS_CHECK':
      responseContent = await handleStatusIntent();
      break;
    case 'QUEUE_CHECK':
      responseContent = await handleQueueIntent();
      break;
    case 'COOLDOWN_CHECK':
      responseContent = await handleCooldownIntent();
      break;
    case 'ISSUE_STATUS':
      responseContent = await handleIssueStatusIntent(issueId);
      break;
    case 'LOG_SUMMARY':
      responseContent = await handleLogSummaryIntent(issueId);
      break;
    case 'COMMENT_POST':
      responseContent = await handleCommentPostIntent(issueId, originalText);
      break;
    case 'RETRY_SUGGEST':
      responseContent = await handleRetrySuggestIntent(issueId);
      break;
    case 'DANGEROUS':
      responseContent = handleDangerousIntent();
      break;
    case 'UNKNOWN':
    default:
      responseContent = handleUnknownIntent(originalText);
      break;
  }

  return {
    status: 200,
    body: {
      type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
      data: { content: responseContent, flags: 64 },
    },
  };
}

module.exports = {
  handleAskCommand,
  handleAskModalSubmit,
  ASK_MODAL_CUSTOM_ID,
};
