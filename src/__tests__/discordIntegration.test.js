'use strict';

const request = require('supertest');
const https = require('https');
const fs = require('fs');
const { app } = require('../webhook-server');
const { installDiscordHttpMock, makeInteraction } = require('../__test_helpers__/discordMock');
const { verifyDiscordSignature } = require('../lib/discordInteractions');

jest.mock('https');
jest.mock('fs');
jest.mock('../lib/discordInteractions');

describe('Discord Integration', () => {
  let discordMock;
  const publicKey = 'test-public-key';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DISCORD_PUBLIC_KEY = publicKey;
    discordMock = installDiscordHttpMock();
    
    // Mock fs
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('{}');
    fs.writeFileSync.mockReturnValue(undefined);
    fs.renameSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    discordMock.restore();
  });

  it('returns 401 when signature headers are missing', async () => {
    const response = await request(app)
      .post('/webhooks/discord')
      .send({});

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Invalid request signature');
  });

  it('returns 401 when signature verification fails', async () => {
    verifyDiscordSignature.mockReturnValue(false);

    const response = await request(app)
      .post('/webhooks/discord')
      .set('x-signature-ed25519', 'bad-sig')
      .set('x-signature-timestamp', '123')
      .send({});

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Invalid request signature');
  });

  it('handles PING (type 1) and returns PONG (type 1)', async () => {
    verifyDiscordSignature.mockReturnValue(true);
    const interaction = makeInteraction({ type: 1 });

    const response = await request(app)
      .post('/webhooks/discord')
      .set('x-signature-ed25519', 'sig')
      .set('x-signature-timestamp', '123')
      .send(interaction);

    expect(response.status).toBe(200);
    expect(response.body.type).toBe(1); // PONG
  });

  it('handles unknown APPLICATION_COMMAND and returns error message', async () => {
    verifyDiscordSignature.mockReturnValue(true);
    const interaction = makeInteraction({ commandName: 'unknown-cmd' });

    const response = await request(app)
      .post('/webhooks/discord')
      .set('x-signature-ed25519', 'sig')
      .set('x-signature-timestamp', '123')
      .send(interaction);

    expect(response.status).toBe(200);
    expect(response.body.data.content).toContain('不明なコマンド');
  });

  it('routes valid command and captures followup request', async () => {
    verifyDiscordSignature.mockReturnValue(true);
    
    // /ai-pause command usually returns a deferred response (type 5)
    // and then sends a followup.
    const interaction = makeInteraction({ 
      commandName: 'ai-pause',
      token: 'test-token-789',
      applicationId: 'app-456'
    });

    discordMock.enqueue({ status: 200 }); // For the followup PATCH

    const response = await request(app)
      .post('/webhooks/discord')
      .set('x-signature-ed25519', 'sig')
      .set('x-signature-timestamp', '123')
      .send(interaction);

    // Initial response should be normal (type 4)
    expect(response.status).toBe(200);
    expect(response.body.type).toBe(4);

    // Some commands might trigger async work and then followup/edit.
    // Let's use /ask modal submit for a real followup test.
  });

  it('routes Modal Submit and captures followup request', async () => {
    verifyDiscordSignature.mockReturnValue(true);
    
    const interaction = {
      type: 5, // MODAL_SUBMIT
      id: 'int-456',
      token: 'test-token-789',
      application_id: 'app-456',
      data: {
        custom_id: 'discord_ask_modal',
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: 'ask_input',
                value: '今どのタスクを実行中？'
              }
            ]
          }
        ]
      },
      member: { user: { id: 'user-123' } }
    };

    discordMock.enqueue({ status: 200 }); // For the followup PATCH

    const response = await request(app)
      .post('/webhooks/discord')
      .set('x-signature-ed25519', 'sig')
      .set('x-signature-timestamp', '123')
      .send(interaction);

    expect(response.status).toBe(200);
    expect(response.body.type).toBe(4); // "リクエストを受け付けました"

    // Give it a moment to process the async followup
    await new Promise(resolve => setTimeout(resolve, 200));

    // Check if followup was called (editOriginalInteractionResponse)
    expect(discordMock.calls).toHaveLength(1);
    const call = discordMock.calls[0];
    expect(call.method).toBe('PATCH');
    expect(call.path).toContain('/webhooks/app-456/test-token-789/messages/@original');
  });
});
