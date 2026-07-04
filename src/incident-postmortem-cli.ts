'use strict';

/**
 * SOT-1520 — thin CLI wrapper around `renderPostmortem`. Reads an IncidentRecord JSON on stdin and
 * writes the postmortem markdown to stdout. Invoked by `scripts/ai/incident_response.sh` (via tsx) so
 * the shell orchestrator does not have to re-implement the postmortem formatting.
 */

import { renderPostmortem, type IncidentRecord } from './lib/incidentResponse.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const rec = JSON.parse(input) as IncidentRecord;
    process.stdout.write(renderPostmortem(rec));
  } catch (err) {
    process.stderr.write(`incident-postmortem-cli: failed to render postmortem: ${(err as Error).message}\n`);
    process.exit(1);
  }
});
