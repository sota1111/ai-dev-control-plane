import { jest } from '@jest/globals';

const mockRunner = { log: jest.fn() };
const mockClassifier = { classifyIntent: jest.fn() };
const mockHandlers = {
  handleStatusIntent: jest.fn(),
  handleQueueIntent: jest.fn(),
  handleCooldownIntent: jest.fn(),
  handleIssueStatusIntent: jest.fn(),
  handleLogSummaryIntent: jest.fn(),
  handleCommentPostIntent: jest.fn(),
  handleRetrySuggestIntent: jest.fn(),
  handleDangerousIntent: jest.fn(),
  handleUnknownIntent: jest.fn(),
};
const mockFollowup = {
  editOriginalInteractionResponse: (jest.fn() as any).mockResolvedValue({ status: 200, body: '{}' }),
};

jest.unstable_mockModule('../runner.js', () => ({ ...mockRunner, default: mockRunner }));
jest.unstable_mockModule('../lib/discordIntentClassifier.js', () => ({ ...mockClassifier, default: mockClassifier }));
jest.unstable_mockModule('../lib/discordIntentHandlers.js', () => ({ ...mockHandlers, default: mockHandlers }));
jest.unstable_mockModule('../lib/discordInteractionFollowup.js', () => ({ ...mockFollowup, default: mockFollowup }));

const askHandler = await import('../lib/discordAskHandler.js');
const { handleAskCommand, handleAskModalSubmit } = askHandler;
const classifyIntent: any = mockClassifier.classifyIntent;
const handlers: any = mockHandlers;
const editOriginalInteractionResponse = mockFollowup.editOriginalInteractionResponse;

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
      
      const components: any = response.body.data.components;
      expect(components).toHaveLength(1);
      expect(components[0].type).toBe(18); // LABEL
      expect(components[0].label).toBe('質問・指示を入力');
      expect(components[0].component.type).toBe(4); // TEXT_INPUT
      expect(components[0].component.custom_id).toBe('ask_input');
    });
  });

  describe('handleAskModalSubmit', () => {
    test('returns immediate ACK and extracts value from type:18 Label payload (New Format)', async () => {
      const interaction = {
        application_id: 'app123',
        token: 'token456',
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
      expect(response.body.data.content).toBe('🔄 リクエストを受け付けました。処理中です…');
      
      await response.followupPromise;
      
      expect(classifyIntent).toHaveBeenCalledWith('今どのタスクを実行中？');
      expect(editOriginalInteractionResponse).toHaveBeenCalledWith('app123', 'token456', 'Mock Status Response');
    });

    test('extracts value from type:1 Action Row payload (Legacy Format)', async () => {
      const interaction = {
        application_id: 'app123',
        token: 'token456',
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
      expect(response.body.data.content).toBe('🔄 リクエストを受け付けました。処理中です…');

      await response.followupPromise;

      expect(classifyIntent).toHaveBeenCalledWith('SOT-123 の最新ログを要約して');
      expect(editOriginalInteractionResponse).toHaveBeenCalledWith('app123', 'token456', 'Mock Log Summary');
    });

    test('returns error for empty input (immediate)', async () => {
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
      expect(response.followupPromise).toBeUndefined();
    });

    test('returns error for too long input (immediate)', async () => {
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
      expect(response.followupPromise).toBeUndefined();
    });

    test('handles background exceptions and edits original response', async () => {
      const interaction = {
        application_id: 'app123',
        token: 'token456',
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

      const runner = mockRunner;
      classifyIntent.mockImplementation(() => { throw new Error('Test Error'); });

      const response = await handleAskModalSubmit(interaction);
      expect(response.body.data.content).toBe('🔄 リクエストを受け付けました。処理中です…');

      await response.followupPromise;
      
      expect(editOriginalInteractionResponse).toHaveBeenCalledWith('app123', 'token456', '❌ エラーが発生しました。');
      expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', expect.stringContaining('handler error: Test Error'));
    });

    describe('logging', () => {
      let runner: any;
      
      beforeEach(() => {
        runner = mockRunner;
        jest.clearAllMocks();
      });

      test('logs modal submit received on entry', async () => {
        const interaction = {
          id: 'interaction-123',
          member: { user: { id: 'user-456' } },
          data: {
            components: [
              { type: 18, component: { custom_id: 'ask_input', value: 'test query' } }
            ]
          }
        };
        classifyIntent.mockReturnValue({ intent: 'STATUS_CHECK', issueId: null, originalText: 'test query' });
        handlers.handleStatusIntent.mockResolvedValue('ok');

        const response = await handleAskModalSubmit(interaction);
        await response.followupPromise;

        expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', 'modal submit received', expect.objectContaining({
          interactionId: 'interaction-123',
          userId: 'user-456',
        }));
      });

      test('logs input extracted with length', async () => {
        const interaction = {
          data: {
            components: [
              { type: 18, component: { custom_id: 'ask_input', value: 'hello world' } }
            ]
          }
        };
        classifyIntent.mockReturnValue({ intent: 'STATUS_CHECK', issueId: null, originalText: 'hello world' });
        handlers.handleStatusIntent.mockResolvedValue('ok');

        const response = await handleAskModalSubmit(interaction);
        await response.followupPromise;

        expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', 'input extracted', expect.objectContaining({
          length: 11,
        }));
      });

      test('logs intent classified with UNKNOWN intent', async () => {
        const interaction = {
          data: {
            components: [
              { type: 18, component: { custom_id: 'ask_input', value: 'わからない質問' } }
            ]
          }
        };
        classifyIntent.mockReturnValue({ intent: 'UNKNOWN', issueId: null, originalText: 'わからない質問' });
        handlers.handleUnknownIntent.mockReturnValue('対応できない依頼です');

        const response = await handleAskModalSubmit(interaction);
        await response.followupPromise;

        expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', 'intent classified', expect.objectContaining({
          intent: 'UNKNOWN',
        }));
      });

      test('logs intent classified with QUEUE_CHECK intent', async () => {
        const interaction = {
          data: {
            components: [
              { type: 18, component: { custom_id: 'ask_input', value: 'キューは？' } }
            ]
          }
        };
        classifyIntent.mockReturnValue({ intent: 'QUEUE_CHECK', issueId: null, originalText: 'キューは？' });
        handlers.handleQueueIntent.mockResolvedValue('queue info');

        const response = await handleAskModalSubmit(interaction);
        await response.followupPromise;

        expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', 'intent classified', expect.objectContaining({
          intent: 'QUEUE_CHECK',
        }));
      });

      test('logs issueId when extracted', async () => {
        const interaction = {
          data: {
            components: [
              { type: 18, component: { custom_id: 'ask_input', value: 'SOT-532 の状態は？' } }
            ]
          }
        };
        classifyIntent.mockReturnValue({ intent: 'ISSUE_STATUS', issueId: 'SOT-532', originalText: 'SOT-532 の状態は？' });
        handlers.handleIssueStatusIntent.mockResolvedValue('issue status');

        const response = await handleAskModalSubmit(interaction);
        await response.followupPromise;

        expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', 'intent classified', expect.objectContaining({
          issueId: 'SOT-532',
        }));
      });

      test('logs handler selected', async () => {
        const interaction = {
          data: {
            components: [
              { type: 18, component: { custom_id: 'ask_input', value: 'status?' } }
            ]
          }
        };
        classifyIntent.mockReturnValue({ intent: 'STATUS_CHECK', issueId: null, originalText: 'status?' });
        handlers.handleStatusIntent.mockResolvedValue('ok');

        const response = await handleAskModalSubmit(interaction);
        await response.followupPromise;

        expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', 'handler selected', expect.objectContaining({
          handler: 'handleStatusIntent',
          intent: 'STATUS_CHECK',
        }));
      });

      test('logs handler completed with responsePreview', async () => {
        const interaction = {
          data: {
            components: [
              { type: 18, component: { custom_id: 'ask_input', value: 'status?' } }
            ]
          }
        };
        classifyIntent.mockReturnValue({ intent: 'STATUS_CHECK', issueId: null, originalText: 'status?' });
        handlers.handleStatusIntent.mockResolvedValue('現在実行中のタスク: なし');

        const response = await handleAskModalSubmit(interaction);
        await response.followupPromise;

        expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', 'handler completed', expect.objectContaining({
          intent: 'STATUS_CHECK',
          responsePreview: JSON.stringify('現在実行中のタスク: なし'),
        }));
      });

      test('logs response sent with mode: deferred', async () => {
        const interaction = {
          data: {
            components: [
              { type: 18, component: { custom_id: 'ask_input', value: 'test' } }
            ]
          }
        };
        classifyIntent.mockReturnValue({ intent: 'STATUS_CHECK', issueId: null, originalText: 'test' });
        handlers.handleStatusIntent.mockResolvedValue('result');

        await handleAskModalSubmit(interaction);

        expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', 'response sent', expect.objectContaining({
          mode: 'deferred',
        }));
      });

      test('logs handler error on background exception', async () => {
        const interaction = {
          data: {
            components: [
              { type: 18, component: { custom_id: 'ask_input', value: 'valid' } }
            ]
          }
        };
        classifyIntent.mockImplementation(() => { throw new Error('Test Error'); });

        const runner = mockRunner;
        const response = await handleAskModalSubmit(interaction);
        await response.followupPromise;

        expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', expect.stringContaining('handler error: Test Error'));
      });
    });
  });

  describe('sanitizeDiscordAskLogText', () => {
    const { sanitizeDiscordAskLogText } = askHandler;

    test('masks token= patterns', () => {
      expect(sanitizeDiscordAskLogText('token=abc123secret')).not.toContain('abc123secret');
      expect(sanitizeDiscordAskLogText('token=abc123secret')).toContain('[MASKED]');
    });

    test('masks secret= patterns', () => {
      expect(sanitizeDiscordAskLogText('secret=mysecretvalue')).toContain('[MASKED]');
    });

    test('masks api_key= patterns', () => {
      expect(sanitizeDiscordAskLogText('api_key=sk-1234567')).toContain('[MASKED]');
    });

    test('masks password= patterns', () => {
      expect(sanitizeDiscordAskLogText('password=hunter2')).toContain('[MASKED]');
    });

    test('masks webhook_url= patterns', () => {
      expect(sanitizeDiscordAskLogText('webhook_url=https://example.com/secret')).toContain('[MASKED]');
    });

    test('preserves non-secret text', () => {
      const text = 'SOT-532 をキューから削除して';
      expect(sanitizeDiscordAskLogText(text)).toBe(text);
    });

    test('truncates text to 300 characters', () => {
      const long = 'a'.repeat(400);
      expect(sanitizeDiscordAskLogText(long)).toHaveLength(300);
    });
  });
});
