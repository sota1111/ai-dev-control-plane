import https from 'node:https';
import * as runner from '../runner.js';

const DISCORD_MAX_LENGTH = 1990;

/**
 * Truncate text to Discord max length and append '…' if truncated.
 */
function truncateContent(text: string): string {
  if (typeof text !== 'string') return '';
  if (text.length <= DISCORD_MAX_LENGTH) return text;
  return text.slice(0, DISCORD_MAX_LENGTH) + '…';
}

interface FollowupResponse {
  status: number;
  body: string;
}

/**
 * PATCH @original; resolves { status, body }. Never throws.
 */
export async function editOriginalInteractionResponse(applicationId: string | undefined, interactionToken: string | undefined, content: string): Promise<FollowupResponse> {
  if (!applicationId || !interactionToken) {
    runner.log('DISCORD_ASK', 'Missing applicationId or interactionToken for followup', { applicationId, interactionToken: !!interactionToken });
    return { status: 0, body: '' };
  }

  const payload = {
    content: truncateContent(content)
  };

  const executePatch = (): Promise<FollowupResponse> => new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'discord.com',
      path: `/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res: any) => {
      let responseBody = '';
      res.on('data', (chunk: string) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });

    req.on('error', (err: any) => {
      runner.log('DISCORD_ASK', `Followup request error: ${err.message}`);
      resolve({ status: 0, body: '' });
    });

    req.write(body);
    req.end();
  });

  let result = await executePatch();

  // Retry ONCE if rate limited (429)
  if (result.status === 429) {
    try {
      const json = JSON.parse(result.body);
      const waitMs = (parseFloat(json.retry_after) || 5) * 1000;
      runner.log('DISCORD_ASK', `Rate limited (429), waiting ${waitMs}ms before retry`);
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (_) {
      await new Promise((r) => setTimeout(r, 5000));
    }
    result = await executePatch();
  }

  return result;
}
