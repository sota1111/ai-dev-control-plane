'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./lib/schedulerCore');
const runner = require('./runner');
const { DiscordNotifier } = require('./lib/discordNotifier');

// Load .env from project root, matching scheduler.sh's behavior
require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  override: false,
});
const { getSecret, initSecrets } = require('./config/secrets');

const args = process.argv.slice(2);
const command = args[0];

/**
 * Returns the PID of the currently running scheduler, or null if not running.
 * Also handles stale PID files.
 */
function getRunningPid() {
  if (!fs.existsSync(core.PID_FILE)) return null;
  const pid = fs.readFileSync(core.PID_FILE, 'utf8').trim();
  try {
    const pidInt = parseInt(pid, 10);
    if (isNaN(pidInt)) return null;
    process.kill(pidInt, 0);
    return pid;
  } catch (e) {
    return null;
  }
}

/**
 * Implements the 'stop' command.
 */
async function stop() {
  const pid = getRunningPid();
  if (pid) {
    process.kill(parseInt(pid, 10), 'SIGTERM');
    // Wait for the PID file to be removed by the process itself
    let removed = false;
    for (let i = 0; i < 50; i++) {
      if (!fs.existsSync(core.PID_FILE)) {
        removed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!removed && fs.existsSync(core.PID_FILE)) {
      fs.unlinkSync(core.PID_FILE);
    }
    console.log(`Scheduler stopped (PID: ${pid})`);
  } else {
    if (fs.existsSync(core.PID_FILE)) {
      console.log('Scheduler not running (stale PID file removed)');
      fs.unlinkSync(core.PID_FILE);
    } else {
      console.log('Scheduler is not running');
    }
  }
}

/**
 * Implements the 'status' command.
 */
function status() {
  const pid = getRunningPid();
  const config = core.getConfig(process.env);
  let linearState = null;
  if (fs.existsSync(core.LINEAR_STATE_FILE)) {
    try {
      linearState = fs.readFileSync(core.LINEAR_STATE_FILE, 'utf8').trim();
    } catch (e) {
      // Ignore
    }
  }

  const lines = core.formatStatusLines({
    running: !!pid,
    pid: pid || (fs.existsSync(core.PID_FILE) ? fs.readFileSync(core.PID_FILE, 'utf8').trim() : null),
    schedulerLog: core.SCHEDULER_LOG,
    linearState,
    hasLinearKey: !!getSecret('LINEAR_API_KEY'),
    checkInterval: config.checkInterval,
    interval: config.interval,
  });
  lines.forEach((line) => console.log(line));
}

/**
 * Implements the '--watch' command.
 */
function watch() {
  const pid = getRunningPid();
  if (pid) {
    console.log(`Stopping existing scheduler (PID: ${pid})...`);
    try {
      process.kill(parseInt(pid, 10), 'SIGTERM');
    } catch (e) {
      // Ignore
    }
    // Simple busy-wait for process to exit
    const start = Date.now();
    while (Date.now() - start < 2000) {
      try {
        process.kill(parseInt(pid, 10), 0);
      } catch (e) {
        break;
      }
    }
  }
  if (fs.existsSync(core.PID_FILE)) {
    fs.unlinkSync(core.PID_FILE);
  }

  if (!fs.existsSync(core.LOG_DIR)) {
    fs.mkdirSync(core.LOG_DIR, { recursive: true });
  }

  // Open log file in append mode
  const logStream = fs.createWriteStream(core.SCHEDULER_LOG, { flags: 'a' });
  const child = spawn('npx', ['tsx', __filename, '--foreground'], {
    detached: true,
    stdio: ['ignore', logStream, logStream],
  });
  child.unref();

  // Wait for the child to write its PID
  setTimeout(() => {
    const newPid = getRunningPid();
    if (!newPid) {
      console.error('Failed to start scheduler');
      process.exit(1);
    }
    console.log(`Scheduler running (PID: ${newPid}). Watching log.`);
    console.log('Ctrl+C to stop scheduler.\n');

    const tail = spawn('tail', ['-f', core.SCHEDULER_LOG], { stdio: 'inherit' });

    const stopWatch = () => {
      console.log(`\nStopping scheduler (PID: ${newPid})...`);
      try {
        process.kill(parseInt(newPid, 10), 'SIGTERM');
      } catch (e) {
        // Ignore
      }
      tail.kill();
      process.exit(0);
    };

    process.on('SIGINT', stopWatch);
    process.on('SIGTERM', stopWatch);
  }, 1000);
}

let currentDrainChild = null;

/**
 * Runs the 'drain' command via runner-cli.ts and streams output.
 */
async function runDrain(notifier) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', path.join(__dirname, 'runner-cli.ts'), 'drain']);
    currentDrainChild = child;

    const handleOutput = (data) => {
      const output = data.toString();
      const lines = output.split('\n');
      lines.forEach((line, index) => {
        // Avoid adding an extra newline if the output ends with one
        if (index === lines.length - 1 && line === '') return;
        const lineWithNewline = line + '\n';
        fs.appendFileSync(core.AUTO_RUNNER_LOG, lineWithNewline);
        fs.appendFileSync(core.SCHEDULER_LOG, lineWithNewline);
        if (notifier) {
          notifier.add(lineWithNewline);
        }
      });
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('close', () => {
      currentDrainChild = null;
      resolve();
    });
  });
}

/**
 * Implements the '--foreground' daemon loop.
 */
async function foreground() {
  if (!fs.existsSync(core.LOG_DIR)) {
    fs.mkdirSync(core.LOG_DIR, { recursive: true });
  }
  fs.writeFileSync(core.PID_FILE, process.pid.toString());

  const config = core.getConfig(process.env);
  let notifier = null;
  if (getSecret('DISCORD_WEBHOOK_URL')) {
    notifier = new DiscordNotifier(getSecret('DISCORD_WEBHOOK_URL'));
    notifier.start(5000);
  }

  const log = (msg) => {
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
    const formatted = `[${timestamp}] [SCHEDULER] ${msg}\n`;
    fs.appendFileSync(core.AUTO_RUNNER_LOG, formatted);
    fs.appendFileSync(core.SCHEDULER_LOG, formatted);
    if (notifier) {
      notifier.add(formatted);
    }
  };

  if (config.webhookMode) {
    log('WEBHOOK_MODE=true: polling disabled. Scheduler exiting.');
    if (fs.existsSync(core.PID_FILE)) {
      fs.unlinkSync(core.PID_FILE);
    }
    process.exit(0);
  }

  let sleepTimer = null;
  let isStopping = false;

  const cleanup = async () => {
    if (isStopping) return;
    isStopping = true;
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    if (currentDrainChild) {
      log(`Scheduler stopping — waiting for current drain to complete (PID: ${currentDrainChild.pid})...`);
      await new Promise((resolve) => currentDrainChild.on('close', resolve));
    }
    if (fs.existsSync(core.PID_FILE)) {
      fs.unlinkSync(core.PID_FILE);
    }
    if (notifier) {
      await notifier.stop();
    }
    log('Scheduler stopped');
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', () => {
    /* Ignore SIGINT to match 'trap "" SIGINT' in Bash */
  });

  if (getSecret('LINEAR_API_KEY')) {
    log(`Scheduler started (PID: ${process.pid}, mode: Linear polling, check_interval: ${config.checkInterval}s)`);
  } else {
    log(`Scheduler started (PID: ${process.pid}, mode: fixed interval fallback, interval: ${config.interval}s)`);
    log('WARNING: LINEAR_API_KEY is not set. Set it to enable Linear-triggered execution.');
  }

  // Recovery: Draining pending queue items from previous run
  if (fs.existsSync(core.QUEUE_FILE)) {
    try {
      const queue = JSON.parse(fs.readFileSync(core.QUEUE_FILE, 'utf8'));
      if (Array.isArray(queue) && queue.length > 0) {
        log('Draining pending queue items from previous run (restart recovery)...');
        await runDrain(notifier);
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  while (!isStopping) {
    if (getSecret('LINEAR_API_KEY')) {
      log(`Next check in ${config.checkInterval}s`);
      await new Promise((resolve) => {
        sleepTimer = setTimeout(resolve, config.checkInterval * 1000);
      });
      sleepTimer = null;
      if (isStopping) break;

      try {
        const query = core.buildActiveIssuesQuery();
        const data = await runner.linearQuery(query);
        const activeIdentifiers = core.parseActiveIdentifiers(data);

        if (activeIdentifiers.length > 0) {
          log('--- Active issues found — enqueuing and draining ---');
          for (const id of activeIdentifiers) {
            log(`Enqueuing: ${id}`);
            // Note: Directly using runner.enqueue to match scheduler.sh calling runner-cli.js enqueue
            runner.enqueue(id, 'scheduler', null, { reason: 'scheduler' });
          }
          await runDrain(notifier);
          log('--- Drain complete ---');
        } else {
          log('No active issues (Todo/In Progress) in Linear, skipping run.');
        }
      } catch (err) {
        log(`Linear API request failed: ${err.message}`);
      }
    } else {
      log(`Next check in ${config.interval}s`);
      await new Promise((resolve) => {
        sleepTimer = setTimeout(resolve, config.interval * 1000);
      });
      sleepTimer = null;
      if (isStopping) break;

      log('--- Fixed interval drain ---');
      await runDrain(notifier);
      log('--- Drain complete ---');
    }
  }
}

/**
 * Default start command (background).
 */
async function start() {
  const pid = getRunningPid();
  if (pid) {
    process.stderr.write(`Scheduler is already running (PID: ${pid})\n`);
    process.exit(1);
  }
  if (fs.existsSync(core.PID_FILE)) {
    fs.unlinkSync(core.PID_FILE);
  }

  if (!fs.existsSync(core.LOG_DIR)) {
    fs.mkdirSync(core.LOG_DIR, { recursive: true });
  }

  const logStream = fs.createWriteStream(core.SCHEDULER_LOG, { flags: 'a' });
  const child = spawn('npx', ['tsx', __filename, '--foreground'], {
    detached: true,
    stdio: ['ignore', logStream, logStream],
  });
  child.unref();

  // Wait a bit and show status
  setTimeout(() => {
    const newPid = getRunningPid();
    const config = core.getConfig(process.env);
    if (newPid) {
      console.log(`Scheduler started (PID: ${newPid})`);
    } else {
      console.log(`Scheduler launched (log: ${core.SCHEDULER_LOG})`);
    }

    if (getSecret('LINEAR_API_KEY')) {
      console.log(`Mode: Linear polling (CHECK_INTERVAL=${config.checkInterval}s)`);
    } else {
      console.log(`Mode: Fixed interval fallback (INTERVAL=${config.interval}s)`);
      console.log('Note: Set LINEAR_API_KEY to enable Linear update detection');
    }
    console.log(`Log: ${core.SCHEDULER_LOG}`);
  }, 1000);
}

async function main() {
  await initSecrets(['LINEAR_API_KEY', 'DISCORD_WEBHOOK_URL']);
  if (command === 'stop') {
    await stop();
  } else if (command === 'status') {
    status();
  } else if (command === '--watch') {
    watch();
  } else if (command === '--foreground') {
    await foreground();
  } else {
    // Default start
    const config = core.getConfig(process.env);
    if (config.webhookMode) {
      console.log('WEBHOOK_MODE=true: ポーリングスケジューラーは無効化されています。');
      console.log('Webhook サーバーを起動してください: npm run start:webhook');
      process.exit(0);
    }
    await start();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  getRunningPid,
  stop,
  status,
  watch,
  runDrain,
  foreground,
  start,
};
