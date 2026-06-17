'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getSecret, initSecrets } = require('./config/secrets');

const { DiscordNotifier } = require('./lib/discordNotifier');
const { attemptSessionContinue } = require('./lib/sessionContinue');

export {};

const LOG_DIR = path.join(__dirname, '..', 'docs', 'ai', 'auto_logs');
const LOG_FILE = path.join(LOG_DIR, 'auto_runner.log');

function logger(message: string): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
    const line = `[${timestamp}] [RESUME] ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
    console.log(`[RESUME] ${message}`);
  } catch (err: any) {
    console.error(`[RESUME:LOG_ERROR] ${err.message}`);
  }
}

async function main(): Promise<void> {
  await initSecrets(['DISCORD_WEBHOOK_URL']);
  const args = process.argv.slice(2);
  let paneId: string | null = null;
  let issueId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pane' && args[i + 1]) {
      paneId = args[i + 1];
      i++;
    } else if (args[i] === '--issue' && args[i + 1]) {
      issueId = args[i + 1];
      i++;
    }
  }

  if (!paneId) {
    console.error('Usage: node src/session-continue-cli.ts --pane <paneId> [--issue <issueId>]');
    process.exit(1);
  }

  const webhookUrl = getSecret('DISCORD_WEBHOOK_URL');
  const notifier = new DiscordNotifier(webhookUrl);
  if (webhookUrl) {
    notifier.start();
  }

  const notify = (msg: string) => {
    if (webhookUrl) {
      notifier.add(msg + '\n');
    }
  };

  try {
    const result: { status: string } = await attemptSessionContinue({
      paneId,
      issueId,
      notify,
      logger
    });

    await notifier.stop();

    switch (result.status) {
      case 'sent':
      case 'waiting':
      case 'no_limit':
        process.exit(0);
        break;
      case 'pane_missing':
        process.exit(1);
        break;
      case 'foreground_mismatch':
        process.exit(2);
        break;
      default:
        process.exit(0);
    }
  } catch (err: any) {
    logger(`ERROR: ${err.message}`);
    await notifier.stop();
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
