import {
  ambiguityHints,
  buildQuestionSuggestion,
  evaluateDangerousTool,
  isAutonomousEnv,
  isDangerousBashCommand,
  isGitForcePush,
  isGitResetHard,
  isRmRecursiveForce,
  lintCommandsForFile,
  matchesProtectedPath,
  splitCommandSegments,
} from '../lib/claudeHooks.js';

// SOT-1573 — unit tests for the .claude/hooks safety-hook decision logic.

describe('dangerous-command-guard: Bash detection', () => {
  it('blocks rm -rf and its flag variants', () => {
    for (const cmd of [
      'rm -rf /tmp/x',
      'rm -fr build',
      'rm -r -f dir',
      'rm --recursive --force dir',
      'sudo rm -rf /var/tmp/y',
      'FOO=bar rm -rf z',
    ]) {
      expect(isRmRecursiveForce(cmd)).toBe(true);
      expect(isDangerousBashCommand(cmd).danger).toBe(true);
    }
  });

  it('allows plain rm and recursive-only / force-only rm', () => {
    for (const cmd of ['rm file.txt', 'rm -r dir', 'rm -f file', 'rm -i note']) {
      expect(isRmRecursiveForce(cmd)).toBe(false);
      expect(isDangerousBashCommand(cmd).danger).toBe(false);
    }
  });

  it('blocks git reset --hard and git force-push variants', () => {
    expect(isGitResetHard('git reset --hard HEAD~1')).toBe(true);
    expect(isGitForcePush('git push --force origin main')).toBe(true);
    expect(isGitForcePush('git push -f')).toBe(true);
    expect(isGitForcePush('git push origin main --force-with-lease')).toBe(true);
    expect(isGitForcePush('git push origin main --force-with-lease=main:abc')).toBe(true);
    expect(isDangerousBashCommand('git reset --hard').danger).toBe(true);
    expect(isDangerousBashCommand('git push --force').danger).toBe(true);
  });

  it('allows ordinary commands to pass through', () => {
    for (const cmd of [
      'ls -la',
      'git status',
      'git push origin main',
      'git reset HEAD file',
      'npm test',
      'echo rm -rf just-a-string',
    ]) {
      expect(isDangerousBashCommand(cmd).danger).toBe(false);
    }
  });

  it('detects a dangerous segment inside a chained command', () => {
    expect(isDangerousBashCommand('cd build && rm -rf *').danger).toBe(true);
    expect(splitCommandSegments('a && b | c ; d').length).toBe(4);
  });

  it('does not flag dangerous strings that only appear inside quotes/heredoc text', () => {
    // e.g. a commit message that mentions the commands it is documenting.
    expect(isDangerousBashCommand('git commit -m "deny git push --force and rm -rf"').danger).toBe(
      false,
    );
    expect(isDangerousBashCommand("echo 'rm -rf /'").danger).toBe(false);
    const heredoc = "git commit -m \"$(cat <<'EOF'\nblock rm -rf build\ngit reset --hard\nEOF\n)\"";
    expect(isDangerousBashCommand(heredoc).danger).toBe(false);
  });

  it('evaluateDangerousTool denies dangerous Bash and allows safe Bash', () => {
    expect(evaluateDangerousTool('Bash', { command: 'rm -rf /tmp/x' }).action).toBe('deny');
    expect(evaluateDangerousTool('Bash', { command: 'ls' }).action).toBe('allow');
  });
});

describe('dangerous-command-guard: protected-path writes', () => {
  it('flags protected paths', () => {
    expect(matchesProtectedPath('package.json')).toBe('package.json');
    expect(matchesProtectedPath('/repo/config/worker_roles.json')).toBe('config/');
    expect(matchesProtectedPath('.devcontainer/Dockerfile')).toBe('.devcontainer');
    expect(matchesProtectedPath('/repo/.devcontainer/devcontainer.json')).toBe('.devcontainer');
    expect(matchesProtectedPath('devcontainer.json')).toBe('devcontainer.json');
  });

  it('does NOT flag ordinary files or .claude/settings.json', () => {
    expect(matchesProtectedPath('src/index.ts')).toBeNull();
    expect(matchesProtectedPath('.claude/settings.json')).toBeNull();
    expect(matchesProtectedPath('docs/config-notes.md')).toBeNull();
  });

  it('asks for confirmation on a protected write via a write tool', () => {
    expect(evaluateDangerousTool('Write', { file_path: 'package.json' }).action).toBe('ask');
    expect(evaluateDangerousTool('Edit', { file_path: 'config/x.json' }).action).toBe('ask');
    expect(evaluateDangerousTool('Write', { file_path: 'src/a.ts' }).action).toBe('allow');
  });

  it('ignores unrelated tools', () => {
    expect(evaluateDangerousTool('Read', { file_path: 'package.json' }).action).toBe('allow');
  });
});

describe('post-tool-lint: lint command mapping', () => {
  it('maps JS/JSON/TS extensions and no-ops otherwise', () => {
    expect(lintCommandsForFile('a.js')).toEqual([{ cmd: 'node', args: ['--check', 'a.js'] }]);
    expect(lintCommandsForFile('a.mjs')[0].args).toContain('--check');
    expect(lintCommandsForFile('a.ts')[0].cmd).toBe('node_modules/.bin/eslint');
    expect(lintCommandsForFile('pkg.json')[0].cmd).toBe('node');
    expect(lintCommandsForFile('README.md')).toEqual([]);
    expect(lintCommandsForFile('Makefile')).toEqual([]);
  });
});

describe('ask-question-gate: non-blocking clarification', () => {
  it('detects ambiguity in short/vague prompts', () => {
    expect(ambiguityHints('fix it').length).toBeGreaterThan(0);
    expect(ambiguityHints('make it better somehow').length).toBeGreaterThan(0);
  });

  it('stays quiet on a clear, specific prompt', () => {
    const clear =
      'Add a unit test in src/__tests__ that asserts computeShoppingList excludes seasonings';
    expect(buildQuestionSuggestion(clear, { autonomous: false })).toBeNull();
  });

  it('returns a suggestion interactively but NEVER in autonomous mode', () => {
    expect(buildQuestionSuggestion('fix it', { autonomous: false })).not.toBeNull();
    expect(buildQuestionSuggestion('fix it', { autonomous: true })).toBeNull();
  });

  it('isAutonomousEnv reads pipeline env markers', () => {
    expect(isAutonomousEnv({})).toBe(false);
    expect(isAutonomousEnv({ WORKER_ROLE: 'implementation' })).toBe(true);
    expect(isAutonomousEnv({ RUN_WORKER_DISPATCH: '1' })).toBe(true);
    expect(isAutonomousEnv({ PIPELINE_MODE: '0' })).toBe(false);
  });
});
