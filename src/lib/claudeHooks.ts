// SOT-1573 — pure decision logic for the .claude/hooks safety hooks.
//
// These functions are intentionally I/O-free so they can be unit tested and reused
// by the thin runtime hook scripts under `.claude/hooks/`. The hooks only take effect
// inside Claude Code sessions (Codex/Antigravity legs are unaffected), so the shell-side
// guards in `scripts/ai/run_*.sh` remain in place as a second layer.

/** A PreToolUse guard outcome. `allow` lets the tool run; `deny`/`ask` map to
 *  Claude Code's permissionDecision. */
export type GuardDecision =
  | { action: 'allow' }
  | { action: 'deny' | 'ask'; reason: string };

/** Tools that write to the filesystem and are subject to protected-path checks. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

/** Remove quoted spans and heredoc bodies so command text that only appears as an
 *  argument or inside a commit message / string literal is not scanned as a command
 *  (e.g. `git commit -m "... git push --force ..."`). Best-effort: obscure quoted
 *  invocations (`bash -c "rm -rf /"`) may be missed here — the shell-side run_*.sh
 *  guards are the authoritative safety net. */
export function stripStringLiterals(command: string): string {
  return command
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?\n[ \t]*\2(?=\s|$)/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/'[^']*'/g, ' ');
}

/** Split a shell command into individual command segments on `;`, `&&`, `||`, `|`
 *  and newlines. `||` is matched before a single `|` so it is not mis-split. */
export function splitCommandSegments(command: string): string[] {
  return stripStringLiterals(command)
    .split(/\n|;|&&|\|\||\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tokenize(segment: string): string[] {
  return segment.split(/\s+/).filter((t) => t.length > 0);
}

/** Return the command tokens of a segment, skipping leading env-var assignments
 *  and `sudo`/`env` wrappers so `FOO=bar sudo rm ...` still resolves to `rm`. */
export function commandTokens(segment: string): string[] {
  const tokens = tokenize(segment);
  let i = 0;
  while (
    i < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === 'sudo' || tokens[i] === 'env')
  ) {
    i++;
  }
  return tokens.slice(i);
}

function baseCommand(token: string | undefined): string {
  return (token ?? '').split('/').pop() ?? '';
}

/** `rm` invoked with BOTH recursive and force flags (rm -rf / -fr / -r -f /
 *  --recursive --force). Requiring both avoids blocking a plain `rm file`. */
export function isRmRecursiveForce(segment: string): boolean {
  const tokens = commandTokens(segment);
  if (baseCommand(tokens[0]) !== 'rm') return false;
  let recursive = false;
  let force = false;
  for (const t of tokens.slice(1)) {
    if (t === '--recursive') recursive = true;
    else if (t === '--force') force = true;
    else if (t.startsWith('-') && !t.startsWith('--') && t.length > 1) {
      const flags = t.slice(1);
      if (/[rR]/.test(flags)) recursive = true;
      if (/f/.test(flags)) force = true;
    }
  }
  return recursive && force;
}

/** `git reset --hard` (discards working-tree/index changes). */
export function isGitResetHard(segment: string): boolean {
  const tokens = commandTokens(segment);
  return baseCommand(tokens[0]) === 'git' && tokens.includes('reset') && tokens.includes('--hard');
}

/** `git push` with a force flag (`--force`, `-f`, `--force-with-lease[=...]`). */
export function isGitForcePush(segment: string): boolean {
  const tokens = commandTokens(segment);
  if (baseCommand(tokens[0]) !== 'git' || !tokens.includes('push')) return false;
  return tokens.some(
    (t) =>
      t === '--force' ||
      t === '-f' ||
      t === '--force-with-lease' ||
      t.startsWith('--force-with-lease='),
  );
}

/** Scan a full Bash command string for any dangerous segment. */
export function isDangerousBashCommand(command: string): { danger: boolean; reason?: string } {
  for (const segment of splitCommandSegments(command)) {
    if (isRmRecursiveForce(segment)) {
      return { danger: true, reason: 'recursive force remove (rm -rf)' };
    }
    if (isGitResetHard(segment)) {
      return { danger: true, reason: 'git reset --hard discards changes' };
    }
    if (isGitForcePush(segment)) {
      return { danger: true, reason: 'git push --force' };
    }
  }
  return { danger: false };
}

/** Paths that must not be modified without explicit human approval
 *  (mirrors CLAUDE.md Safety Rules). Returns a label or null.
 *  Note: `.claude/settings.json` is deliberately NOT protected. */
export function matchesProtectedPath(filePath: string): string | null {
  const p = filePath.replace(/\\/g, '/');
  const base = p.split('/').pop() ?? '';
  if (base === 'package.json') return 'package.json';
  if (/(^|\/)\.devcontainer(\/|$)/.test(p)) return '.devcontainer';
  if (base === 'devcontainer.json' || base === '.devcontainer.json') return 'devcontainer.json';
  if (/(^|\/)config\//.test(p)) return 'config/';
  return null;
}

/** Evaluate a PreToolUse call for the dangerous-command-guard hook. */
export function evaluateDangerousTool(
  toolName: string,
  toolInput: Record<string, unknown> | null | undefined,
): GuardDecision {
  const input = toolInput ?? {};
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const { danger, reason } = isDangerousBashCommand(command);
    if (danger) {
      return {
        action: 'deny',
        reason: `Blocked dangerous command (${reason}). Run it manually with explicit human approval if truly intended.`,
      };
    }
    return { action: 'allow' };
  }
  if (WRITE_TOOLS.has(toolName)) {
    const filePath =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : '';
    const hit = filePath ? matchesProtectedPath(filePath) : null;
    if (hit) {
      return {
        action: 'ask',
        reason: `Write to protected path (${hit}) requires explicit human confirmation (CLAUDE.md Safety Rules).`,
      };
    }
    return { action: 'allow' };
  }
  return { action: 'allow' };
}

/** A lint command to try for a changed file. */
export interface LintCommand {
  cmd: string;
  args: string[];
}

function fileExtension(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** Lightweight lint command(s) for the post-tool-lint hook, keyed by extension.
 *  Empty array = no lightweight lint available (hook is a no-op, never blocks). */
export function lintCommandsForFile(filePath: string): LintCommand[] {
  switch (fileExtension(filePath)) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return [{ cmd: 'node', args: ['--check', filePath] }];
    case '.ts':
    case '.tsx':
      return [
        { cmd: 'node_modules/.bin/eslint', args: ['--no-error-on-unmatched-pattern', filePath] },
      ];
    case '.json':
      return [
        {
          cmd: 'node',
          args: [
            '-e',
            `JSON.parse(require('fs').readFileSync(${JSON.stringify(filePath)}, 'utf8'))`,
          ],
        },
      ];
    default:
      return [];
  }
}

/** Env vars set by the autonomous pipeline. When any is truthy the ask-question-gate
 *  stays silent so it never nags (or blocks) autonomous runs. */
export const AUTONOMOUS_ENV_MARKERS = [
  'RUN_WORKER_DISPATCH',
  'WEBHOOK_ISSUE_ID',
  'WORKER_ROLE',
  'PIPELINE_MODE',
] as const;

function truthy(v: string | undefined): boolean {
  return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

export function isAutonomousEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return AUTONOMOUS_ENV_MARKERS.some((k) => truthy(env[k]));
}

/** Heuristic ambiguity hints for a user prompt (interactive convenience only). */
export function ambiguityHints(prompt: string): string[] {
  const hints: string[] = [];
  const trimmed = prompt.trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
  if (wordCount > 0 && wordCount <= 4) {
    hints.push('The request is very short — consider stating the concrete outcome and scope.');
  }
  if (
    /\b(fix|improve|update|change|refactor|clean\s?up|better|enhance|tweak)\b/i.test(trimmed) &&
    wordCount <= 8
  ) {
    hints.push(
      'Vague verb without a specific target — clarify which file/behavior and the acceptance criterion.',
    );
  }
  if (/\b(etc|and so on|something like|somehow|maybe)\b/i.test(trimmed)) {
    hints.push('Open-ended phrasing — pin down the exact expected result.');
  }
  return hints;
}

/** Build a NON-BLOCKING clarification suggestion, or null when nothing to add.
 *  Always returns null in autonomous mode so the pipeline is never interrupted. */
export function buildQuestionSuggestion(
  prompt: string,
  opts: { autonomous: boolean },
): string | null {
  if (opts.autonomous) return null;
  const hints = ambiguityHints(prompt);
  if (hints.length === 0) return null;
  return [
    '[ask-question-gate] The request may be ambiguous. Before proceeding, consider clarifying:',
    ...hints.map((h) => `- ${h}`),
    '(Non-blocking suggestion — proceeding on a safe default is fine.)',
  ].join('\n');
}
