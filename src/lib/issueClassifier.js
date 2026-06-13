'use strict';

// Task types
const TYPES = {
  IMPLEMENT: 'IMPLEMENT',
  FIX: 'FIX',
  DEBUG: 'DEBUG',
  PLAN: 'PLAN',
  DOC: 'DOC',
  REVIEW: 'REVIEW',
  SECURITY: 'SECURITY',
};

// Worker assignments
const WORKERS = {
  gemini: 'gemini',
  codex: 'codex',
  claude: 'claude-code',
};

// Worker selection per type
const TYPE_TO_WORKER = {
  IMPLEMENT: WORKERS.gemini,
  FIX:       WORKERS.codex,
  DEBUG:     WORKERS.codex,
  PLAN:      WORKERS.claude,
  DOC:       WORKERS.codex,   // small docs → codex; large → gemini (caller decides)
  REVIEW:    WORKERS.codex,
  SECURITY:  WORKERS.codex,
};

/**
 * @param {Object} issue
 * @param {string} issue.id
 * @param {string} issue.title
 * @param {string} [issue.description]
 * @param {string[]} [issue.labels]   - array of label names
 * @param {string} [issue.status]
 * @returns {{ type: string, worker: string, reason: string }}
 */
function classifyIssue(issue) {
  const title = issue.title || '';
  const description = issue.description || '';
  const labels = issue.labels || [];
  const text = (title + ' ' + description).toLowerCase();

  // 1. Title prefix rules (highest priority)
  if (title.startsWith('[IMPLEMENT]')) {
    return { type: TYPES.IMPLEMENT, worker: TYPE_TO_WORKER.IMPLEMENT, reason: 'Title prefix [IMPLEMENT]' };
  }
  if (title.startsWith('[DEBUG]')) {
    return { type: TYPES.DEBUG, worker: TYPE_TO_WORKER.DEBUG, reason: 'Title prefix [DEBUG]' };
  }
  if (title.startsWith('[FIX]')) {
    return { type: TYPES.FIX, worker: TYPE_TO_WORKER.FIX, reason: 'Title prefix [FIX]' };
  }
  if (title.startsWith('[PLAN]')) {
    return { type: TYPES.PLAN, worker: TYPE_TO_WORKER.PLAN, reason: 'Title prefix [PLAN]' };
  }
  if (title.startsWith('[REVIEW]')) {
    return { type: TYPES.REVIEW, worker: TYPE_TO_WORKER.REVIEW, reason: 'Title prefix [REVIEW]' };
  }
  if (title.startsWith('[DOC]')) {
    return { type: TYPES.DOC, worker: TYPE_TO_WORKER.DOC, reason: 'Title prefix [DOC]' };
  }

  // 2. Control-plane / orchestration detection → PLAN/claude-code
  const planKeywords = [
    'usage-limit', 'queue', 'lock', 'webhook', 'scheduler',
    'claude code', 'worker routing', '自動分類', 'ルーティング',
    '委譲', 'orchestrat'
  ];
  if (planKeywords.some(k => text.includes(k.toLowerCase()))) {
    return { type: TYPES.PLAN, worker: TYPE_TO_WORKER.PLAN, reason: 'Control-plane / orchestration keyword detected' };
  }
  const repoUrlMatches = description.match(/github\.com\/sota1111\/[^\s]+/g);
  if (repoUrlMatches && new Set(repoUrlMatches).size >= 2) {
    return { type: TYPES.PLAN, worker: TYPE_TO_WORKER.PLAN, reason: 'Multiple repository URLs detected' };
  }

  // 3. Security-related → SECURITY/codex
  const securityKeywords = [
    'secret', 'credential', 'permission', 'セキュリティ',
    '認証', '権限', 'env var', 'devcontainer'
  ];
  if (securityKeywords.some(k => text.includes(k.toLowerCase()))) {
    return { type: TYPES.SECURITY, worker: TYPE_TO_WORKER.SECURITY, reason: 'Security-related keyword detected' };
  }

  // 4. Review / diff analysis → REVIEW/codex
  const reviewKeywords = ['review', 'diff', 'pr', 'pull request', 'レビュー', '差分'];
  if (reviewKeywords.some(k => text.includes(k.toLowerCase()))) {
    return { type: TYPES.REVIEW, worker: TYPE_TO_WORKER.REVIEW, reason: 'Review / diff analysis keyword detected' };
  }

  // 5. Bug/debug/test failure → DEBUG/codex
  const debugKeywords = [
    'bug', 'fix', 'error', 'fail', 'lint', 'typecheck',
    'test failure', 'バグ', '修正', 'エラー', 'テスト失敗',
    'デバッグ', 'ログ解析'
  ];
  if (debugKeywords.some(k => text.includes(k.toLowerCase())) || labels.includes('bug') || labels.includes('debug')) {
    return { type: TYPES.DEBUG, worker: TYPE_TO_WORKER.DEBUG, reason: 'Bug/debug/test failure detected' };
  }

  // 6. Documentation → DOC/codex
  const docKeywords = ['readme', 'claude.md', '.env.example', 'doc', 'ドキュメント'];
  if (docKeywords.some(k => text.includes(k.toLowerCase()))) {
    return { type: TYPES.DOC, worker: TYPE_TO_WORKER.DOC, reason: 'Documentation keyword detected' };
  }

  // 7. Default: IMPLEMENT/gemini
  return { type: TYPES.IMPLEMENT, worker: TYPE_TO_WORKER.IMPLEMENT, reason: 'Default classification' };
}

module.exports = { classifyIssue, TYPES, WORKERS, TYPE_TO_WORKER };
