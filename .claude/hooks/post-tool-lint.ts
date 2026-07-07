#!/usr/bin/env -S node --import tsx
// SOT-1573 — PostToolUse hook: run a lightweight lint on the file just edited/written.
// NON-BLOCKING by design (always exits 0) — this is an interactive-session convenience;
// the autonomous pipeline's verification role is the authoritative check.

import { spawnSync } from 'node:child_process';
import { lintCommandsForFile } from '../../src/lib/claudeHooks.js';
import { parseHookInput, readStdin } from './lib/hookRuntime.js';

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  const toolInput = (input.tool_input as Record<string, unknown> | undefined) ?? {};
  const filePath =
    typeof toolInput.file_path === 'string'
      ? toolInput.file_path
      : typeof toolInput.notebook_path === 'string'
        ? toolInput.notebook_path
        : '';

  if (!filePath) {
    process.exit(0);
  }

  for (const { cmd, args } of lintCommandsForFile(filePath)) {
    try {
      const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
      if (result.status && result.status !== 0) {
        const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
        process.stderr.write(
          `[post-tool-lint] ${cmd} reported issues in ${filePath}:\n${detail}\n`,
        );
      }
    } catch {
      // Best-effort only — never block the session on a lint failure.
    }
  }

  process.exit(0);
}

void main();
