#!/usr/bin/env -S node --import tsx
// SOT-1573 — UserPromptSubmit hook: on an ambiguous request, surface a NON-BLOCKING
// clarification suggestion as extra context. Interactive-session only: it stays fully
// silent in autonomous mode (CLAUDE.md SOT-1421/P4 "proceed on a safe default") and
// always exits 0, so it can never stop an autonomous run.

import { buildQuestionSuggestion, isAutonomousEnv } from '../../src/lib/claudeHooks.js';
import { parseHookInput, readStdin } from './lib/hookRuntime.js';

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';

  const suggestion = buildQuestionSuggestion(prompt, { autonomous: isAutonomousEnv() });
  if (suggestion) {
    // For UserPromptSubmit, stdout is added to the model's context (non-blocking).
    process.stdout.write(`${suggestion}\n`);
  }

  process.exit(0);
}

void main();
