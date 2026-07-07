#!/usr/bin/env -S node --import tsx
// SOT-1573 — PreToolUse guard: block dangerous Bash commands and gate writes to
// protected paths. Runs only in Claude Code sessions; the shell-side guards in
// scripts/ai/run_*.sh remain as a second layer. Decision logic lives in
// src/lib/claudeHooks.ts (unit tested).

import { evaluateDangerousTool } from '../../src/lib/claudeHooks.js';
import { parseHookInput, readStdin } from './lib/hookRuntime.js';

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput = (input.tool_input as Record<string, unknown> | undefined) ?? {};

  const decision = evaluateDangerousTool(toolName, toolInput);
  if (decision.action === 'allow') {
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.action,
        permissionDecisionReason: decision.reason,
      },
    }),
  );
  process.exit(0);
}

void main();
