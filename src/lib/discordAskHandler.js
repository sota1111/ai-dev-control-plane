'use strict';

const runner = require('../runner');
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

const LOG_PREVIEW_LENGTH = 300;
const SECRET_PATTERN = /(?:token|secret|api[_\s-]?key|password|webhook[_\s-]?url|bot[_\s-]?token|public[_\s-]?key|application[_\s-]?id)\s*[=:]\s*\S+/gi;

function sanitizeDiscordAskLogText(text) {
  if (typeof text !== 'string') return String(text ?? '');
  return text
    .replace(SECRET_PATTERN, (match) => {
      const eqIdx = match.search(/[=:]/);
      return eqIdx >= 0 ? match.slice(0, eqIdx + 1) + '[MASKED]' : '[MASKED]';
    })
    .slice(0, LOG_PREVIEW_LENGTH);
}

/**
 * Handle /ask slash command — returns a modal response.
 */
async function handleAskCommand() {
  try {
    return {
      status: 200,
      body: {
        type: 9, // MODAL
        data: {
          custom_id: ASK_MODAL_CUSTOM_ID,
          title: 'ai-dev-control-plane に質問・指示',
          components: [
            {
              type: 18, // LABEL
              label: '質問・指示を入力',
              description: '例: 今どのタスクを実行中？',
              component: {
                type: 4, // TEXT_INPUT
                custom_id: ASK_INPUT_CUSTOM_ID,
                style: 2, // PARAGRAPH
                placeholder: '例: SOT-123 の最新ログを要約して',
                required: true,
                max_length: MAX_INPUT_LENGTH,
              },
            },
          ],
        },
      },
    };
  } catch (err) {
    runner.log('DISCORD', `handleAskCommand error: ${err.message}`);
    return {
      status: 200,
      body: {
        type: 4,
        data: { content: '❌ エラーが発生しました。', flags: 64 },
      },
    };
  }
}

/**
 * Handle modal submit for /ask — classify intent and execute.
 */
async function handleAskModalSubmit(interaction) {
  try {
    const interactionId = interaction && interaction.id ? interaction.id : 'unknown';
    const userId = interaction && interaction.member && interaction.member.user
      ? interaction.member.user.id
      : (interaction && interaction.user ? interaction.user.id : 'unknown');
    runner.log('DISCORD_ASK', 'modal submit received', { interactionId, userId });

    // Extract input from modal components
    const components = interaction.data && interaction.data.components || [];
    let inputText = '';

    for (const row of components) {
      // New format: type:18 Label
      if (row.component && row.component.custom_id === ASK_INPUT_CUSTOM_ID) {
        inputText = (row.component.value || '').trim();
        break;
      }
      // Legacy format: type:1 Action Row
      if (Array.isArray(row.components)) {
        for (const comp of row.components) {
          if (comp.custom_id === ASK_INPUT_CUSTOM_ID) {
            inputText = (comp.value || '').trim();
            break;
          }
        }
      }
      if (inputText) break;
    }

    const safeText = sanitizeDiscordAskLogText(inputText);
    runner.log('DISCORD_ASK', 'input extracted', { length: inputText.length, text: JSON.stringify(safeText) });

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
    runner.log('DISCORD_ASK', 'intent classified', { intent, issueId: issueId || 'none' });

    let responseContent;

    const HANDLER_NAMES = {
      STATUS_CHECK: 'handleStatusIntent',
      QUEUE_CHECK: 'handleQueueIntent',
      COOLDOWN_CHECK: 'handleCooldownIntent',
      ISSUE_STATUS: 'handleIssueStatusIntent',
      LOG_SUMMARY: 'handleLogSummaryIntent',
      COMMENT_POST: 'handleCommentPostIntent',
      RETRY_SUGGEST: 'handleRetrySuggestIntent',
      DANGEROUS: 'handleDangerousIntent',
      UNKNOWN: 'handleUnknownIntent',
    };
    const handlerName = HANDLER_NAMES[intent] || 'handleUnknownIntent';
    runner.log('DISCORD_ASK', 'handler selected', { handler: handlerName, intent });

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

    const responsePreview = sanitizeDiscordAskLogText(typeof responseContent === 'string' ? responseContent : '');
    runner.log('DISCORD_ASK', 'handler completed', { intent, responsePreview: JSON.stringify(responsePreview) });

    const result = {
      status: 200,
      body: {
        type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
        data: { content: responseContent, flags: 64 },
      },
    };
    runner.log('DISCORD_ASK', 'response sent', { mode: 'direct', status: result.status });
    return result;
  } catch (err) {
    runner.log('DISCORD_ASK', `handler error: ${err.message}`);
    return {
      status: 200,
      body: {
        type: 4,
        data: { content: '❌ エラーが発生しました。', flags: 64 },
      },
    };
  }
}

module.exports = {
  handleAskCommand,
  handleAskModalSubmit,
  ASK_MODAL_CUSTOM_ID,
  sanitizeDiscordAskLogText,
};
