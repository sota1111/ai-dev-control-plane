'use strict';

const https = require('https');
const { editOriginalInteractionResponse } = require('../lib/discordInteractionFollowup');
const runner = require('../runner');

jest.mock('https');
jest.mock('../runner', () => ({
  log: jest.fn(),
}));

describe('discordInteractionFollowup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends PATCH request to Discord API', async () => {
    const mockReq = {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
    https.request.mockReturnValue(mockReq);

    const promise = editOriginalInteractionResponse('app123', 'token456', 'Hello');

    const responseCallback = https.request.mock.calls[0][1];
    const mockRes = {
      statusCode: 200,
      on: jest.fn((event, cb) => {
        if (event === 'end') cb();
      }),
    };
    responseCallback(mockRes);

    const result = await promise;
    expect(result.status).toBe(200);
    expect(https.request).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'discord.com',
        path: '/api/v10/webhooks/app123/token456/messages/@original',
        method: 'PATCH',
      }),
      expect.any(Function)
    );
    expect(mockReq.write).toHaveBeenCalledWith(JSON.stringify({ content: 'Hello' }));
  });

  test('truncates content to 1990 characters', async () => {
    const mockReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    https.request.mockReturnValue(mockReq);

    const longContent = 'a'.repeat(2000);
    const promise = editOriginalInteractionResponse('app', 'token', longContent);

    const responseCallback = https.request.mock.calls[0][1];
    responseCallback({ statusCode: 200, on: (event, cb) => { if (event === 'end') cb(); } });

    await promise;
    const writtenBody = JSON.parse(mockReq.write.mock.calls[0][0]);
    expect(writtenBody.content).toHaveLength(1991); // 1990 + '…'
    expect(writtenBody.content.endsWith('…')).toBe(true);
  });

  test('retries once on 429', async () => {
    const mockReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    https.request.mockReturnValue(mockReq);

    const promise = editOriginalInteractionResponse('app', 'token', 'test');

    // First call returns 429
    const responseCallback1 = https.request.mock.calls[0][1];
    const mockRes1 = {
      statusCode: 429,
      on: jest.fn((event, cb) => {
        if (event === 'data') cb(JSON.stringify({ retry_after: 0.1 }));
        if (event === 'end') cb();
      }),
    };
    responseCallback1(mockRes1);

    // Wait for setTimeout
    await new Promise(r => setTimeout(r, 200));

    // Second call returns 200
    const responseCallback2 = https.request.mock.calls[1][1];
    const mockRes2 = {
      statusCode: 200,
      on: jest.fn((event, cb) => {
        if (event === 'end') cb();
      }),
    };
    responseCallback2(mockRes2);

    const result = await promise;
    expect(result.status).toBe(200);
    expect(https.request).toHaveBeenCalledTimes(2);
    expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', expect.stringContaining('Rate limited'));
  });

  test('returns status 0 on request error', async () => {
    const mockReq = {
      on: jest.fn((event, cb) => {
        if (event === 'error') cb(new Error('Network error'));
      }),
      write: jest.fn(),
      end: jest.fn(),
    };
    https.request.mockReturnValue(mockReq);

    const result = await editOriginalInteractionResponse('app', 'token', 'test');
    expect(result.status).toBe(0);
    expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', expect.stringContaining('Followup request error'));
  });

  test('logs and returns status 0 if applicationId or interactionToken is missing', async () => {
    const result = await editOriginalInteractionResponse(null, 'token', 'test');
    expect(result.status).toBe(0);
    expect(runner.log).toHaveBeenCalledWith('DISCORD_ASK', 'Missing applicationId or interactionToken for followup', expect.any(Object));
  });
});
