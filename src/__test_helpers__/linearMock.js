'use strict';

const https = require('https');
const { EventEmitter } = require('events');

/**
 * Mocks https.request to intercept Linear GraphQL API calls.
 */
function installLinearHttpMock() {
  const responses = [];
  const calls = [];
  const originalRequest = https.request;

  https.request.mockImplementation((options, callback) => {
    const { hostname, path, method } = options;
    
    // Only intercept Linear API
    if (hostname !== 'api.linear.app' || path !== '/graphql') {
      // For other requests, we might want to let them through or fail them.
      // Given the constraints, we'll return a mock request that does nothing.
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
        body: parsedBody,
        query: parsedBody.query,
        variables: parsedBody.variables
      };
      calls.push(callInfo);

      const nextResponse = responses.shift();
      const mockRes = new EventEmitter();
      
      if (!nextResponse) {
        mockRes.statusCode = 500;
        if (callback) callback(mockRes);
        mockRes.emit('data', JSON.stringify({ errors: [{ message: 'No mock response queued' }] }));
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
    enqueueRaw(rawBody, status = 200) {
      responses.push({ rawBody, status });
    },
    calls,
    restore() {
      https.request = originalRequest;
    }
  };
}

module.exports = { installLinearHttpMock };
