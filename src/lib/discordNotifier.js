'use strict';
const https = require('https');

const MAX_LENGTH = 1990;

function splitChunks(text) {
  const chunks = [];
  while (text.length > 0) {
    chunks.push(text.slice(0, MAX_LENGTH));
    text = text.slice(MAX_LENGTH);
  }
  return chunks;
}

function postToDiscord(webhookUrl, content) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content });
    const url = new URL(webhookUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.write(body);
    req.end();
  });
}

async function sendWithRetry(webhookUrl, content) {
  const result = await postToDiscord(webhookUrl, content);
  if (result.status === 429) {
    try {
      const json = JSON.parse(result.body);
      const waitMs = (parseFloat(json.retry_after) || 5) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (_) {
      await new Promise((r) => setTimeout(r, 5000));
    }
    await postToDiscord(webhookUrl, content);
  }
}

class DiscordNotifier {
  constructor(webhookUrl) {
    this._url = webhookUrl;
    this._buffer = [];
    this._timer = null;
  }

  start(intervalMs = 5000) {
    this._timer = setInterval(() => this.flush(), intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return this.flush();
  }

  add(text) {
    if (text) this._buffer.push(text);
  }

  async flush() {
    if (this._buffer.length === 0) return;
    const text = this._buffer.join('');
    this._buffer = [];
    if (!this._url) return;
    const chunks = splitChunks(text);
    for (const chunk of chunks) {
      await sendWithRetry(this._url, chunk);
    }
  }
}

module.exports = { DiscordNotifier };
