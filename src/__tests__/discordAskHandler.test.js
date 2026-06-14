'use strict';

jest.mock('../runner', () => ({
  log: jest.fn(),
}));

jest.mock('../lib/discordIntentClassifier', () => ({
  classifyIntent: jest.fn(),
}));

jest.mock('../lib/discordIntentHandlers', () => ({
  handleStatusIntent: jest.fn(),
  handleQueueIntent: jest.fn(),
  handleCooldownIntent: jest.fn(),
  handleIssueStatusIntent: jest.fn(),
  handleLogSummaryIntent: jest.fn(),
  handleCommentPostIntent: jest.fn(),
  handleRetrySuggestIntent: jest.fn(),
  handleDangerousIntent: jest.fn(),
  handleUnknownIntent: jest.fn(),
}));

const { handleAskCommand, handleAskModalSubmit } = require('../lib/discordAskHandler');
const { classifyIntent } = require('../lib/discordIntentClassifier');
const handlers = require('../lib/discordIntentHandlers');

describe('discordAskHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('handleAskCommand', () => {
    test('returns type:18 Label modal response', async () => {
      const response = await handleAskCommand();
      expect(response.status).toBe(200);
      expect(response.body.type).toBe(9); // MODAL
      expect(response.body.data.custom_id).toBe('discord_ask_modal');
      
      const components = response.body.data.components;
      expect(components).toHaveLength(1);
      expect(components[0].type).toBe(18); // LABEL
      expect(components[0].label).toBe('質問・指示を入力');
      expect(components[0].component.type).toBe(4); // TEXT_INPUT
      expect(components[0].component.custom_id).toBe('ask_input');
    });
  });

  describe('handleAskModalSubmit', () => {
    test('extracts value from type:18 Label payload (New Format)', async () => {
      const interaction = {
        data: {
          custom_id: 'discord_ask_modal',
          components: [
            {
              type: 18,
              label: '質問・指示を入力',
              component: {
                type: 4,
                custom_id: 'ask_input',
                value: '今どのタスクを実行中？'
              }
            }
          ]
        }
      };

      classifyIntent.mockReturnValue({ intent: 'STATUS_CHECK', issueId: null, originalText: '今どのタスクを実行中？' });
      handlers.handleStatusIntent.mockResolvedValue('Mock Status Response');

      const response = await handleAskModalSubmit(interaction);
      
      expect(response.body.type).toBe(4);
      expect(response.body.data.content).toBe('Mock Status Response');
      expect(classifyIntent).toHaveBeenCalledWith('今どのタスクを実行中？');
    });

    test('extracts value from type:1 Action Row payload (Legacy Format)', async () => {
      const interaction = {
        data: {
          custom_id: 'discord_ask_modal',
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: 'ask_input',
                  value: ' SOT-123 の最新ログを要約して '
                }
              ]
            }
          ]
        }
      };

      classifyIntent.mockReturnValue({ intent: 'LOG_SUMMARY', issueId: 'SOT-123', originalText: 'SOT-123 の最新ログを要約して' });
      handlers.handleLogSummaryIntent.mockResolvedValue('Mock Log Summary');

      const response = await handleAskModalSubmit(interaction);
      
      expect(response.body.type).toBe(4);
      expect(response.body.data.content).toBe('Mock Log Summary');
      expect(classifyIntent).toHaveBeenCalledWith('SOT-123 の最新ログを要約して');
    });

    test('returns error for empty input', async () => {
      const interaction = {
        data: {
          components: [
            {
              type: 18,
              component: {
                custom_id: 'ask_input',
                value: '   '
              }
            }
          ]
        }
      };

      const response = await handleAskModalSubmit(interaction);
      expect(response.body.data.content).toContain('入力が空です');
    });

    test('returns error for too long input', async () => {
      const interaction = {
        data: {
          components: [
            {
              type: 18,
              component: {
                custom_id: 'ask_input',
                value: 'a'.repeat(501)
              }
            }
          ]
        }
      };

      const response = await handleAskModalSubmit(interaction);
      expect(response.body.data.content).toContain('入力が長すぎます');
    });

    test('handles exceptions and logs them', async () => {
      const interaction = {
        data: {
          components: [
            {
              type: 18,
              component: {
                custom_id: 'ask_input',
                value: 'valid'
              }
            }
          ]
        }
      };

      const runner = require('../runner');
      classifyIntent.mockImplementation(() => { throw new Error('Test Error'); });

      const response = await handleAskModalSubmit(interaction);
      
      expect(response.body.data.content).toContain('エラーが発生しました');
      expect(runner.log).toHaveBeenCalledWith('DISCORD', expect.stringContaining('handleAskModalSubmit error: Test Error'));
    });
  });
});
