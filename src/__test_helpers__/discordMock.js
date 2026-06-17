'use strict';

import https from 'node:https';
import { EventEmitter } from 'node:events';

/**
 * Mocks https.request to intercept Discord API calls.
 */
export function installDiscordHttpMock() {
  const responses = [];
  const calls = [];
  const originalRequest = https.request;

  https.request.mockImplementation((options, callback) => {
    const { hostname, path, method } = options;
    
    // Intercept Discord API (discord.com or webhooks)
    if (hostname !== 'discord.com' && !path.includes('discord.com')) {
      const mockReq = new EventEmitter();
      mockReq.write = () => {};
      mockReq.end = () => {};
      return mockReq;
    }

    const mockReq = new EventEmitter();
    let requestBody = '';

    mockReq.write = (chunk) => {
      requestBody += chunk.toString();
    };

    mockReq.end = () => {
      let parsedBody;
      try {
        parsedBody = JSON.parse(requestBody);
      } catch (e) {
        parsedBody = { raw: requestBody, error: 'JSON_PARSE_ERROR' };
      }
      
      const callInfo = {
        hostname,
        path,
        method,
        headers: options.headers,
        body: parsedBody
      };
      calls.push(callInfo);

      const nextResponse = responses.shift();
      const mockRes = new EventEmitter();
      
      if (!nextResponse) {
        mockRes.statusCode = 200; // Default success for Discord webhooks
        if (callback) callback(mockRes);
        mockRes.emit('end');
        return;
      }

      mockRes.statusCode = nextResponse.status || 200;
      if (callback) callback(mockRes);

      if (nextResponse.body) {
        mockRes.emit('data', JSON.stringify(nextResponse.body));
      } else if (nextResponse.rawBody) {
        mockRes.emit('data', nextResponse.rawBody);
      }
      
      mockRes.emit('end');
    };

    return mockReq;
  });

  return {
    enqueue(body, status = 200) {
      responses.push({ body, status });
    },
    calls,
    restore() {
      https.request = originalRequest;
    }
  };
}

/**
 * Factory for Discord interaction bodies.
 */
export function makeInteraction({ type = 2, commandName, options = [], token = 'test-token', applicationId = 'app-123', customId } = {}) {
  const interaction = {
    id: 'int-123',
    application_id: applicationId,
    type: type, // 1: PING, 2: APPLICATION_COMMAND, 3: MESSAGE_COMPONENT
    token: token,
    version: 1,
    data: {
      id: 'cmd-123',
      name: commandName,
      options: options,
      custom_id: customId
    },
    member: {
      user: {
        id: 'user-123',
        username: 'testuser'
      }
    }
  };

  if (type === 1) {
    delete interaction.data;
    delete interaction.member;
  }

  return interaction;
}
