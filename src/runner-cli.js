'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const runner = require('./runner');
const { parseUsageLimitResetEpoch } = require('./lib/usageLimitParser');

const [,, command, ...args] = process.argv;

async function main() {
  switch (command) {
    case 'parse-usage-limit-epoch': {
      let input = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) {
        input += chunk;
      }
      const epoch = parseUsageLimitResetEpoch(input);
      if (epoch !== null) {
        process.stdout.write(String(epoch));
        process.exit(0);
      } else {
        process.exit(1);
      }
      break;
    }
    case 'notify-usage-limit': {
      const epoch = parseInt(args[0], 10);
      if (isNaN(epoch)) {
        process.stderr.write('Usage: runner-cli.js notify-usage-limit <epochSeconds>\n');
        process.exit(1);
      }
      await runner.notifyUsageLimitToAllActiveIssues(epoch);
      break;
    }
    case 'remove-usage-limit-label': {
      await runner.removeUsageLimitLabelFromAllIssues();
      break;
    }
    default: {
      process.stderr.write(`Unknown command: ${command}\nAvailable: parse-usage-limit-epoch, notify-usage-limit, remove-usage-limit-label\n`);
      process.exit(1);
    }
  }
}

main().catch(err => {
  process.stderr.write(`runner-cli error: ${err.message}\n`);
  process.exit(1);
});
