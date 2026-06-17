'use strict';

export {};

const ISSUE_ID_PATTERN = /\bSOT-\d+\b/i;

// Dangerous patterns that must always be rejected
const DANGEROUS_PATTERNS = [
  /\.env/i,
  /api.?key/i,
  /token/i,
  /webhook.*url/i,
  /secret/i,
  /password/i,
  /credential/i,
  /auth.*key/i,
  /private.*key/i,
  /access.*key/i,
  /rm\s+-rf/i,
  /exec\s*\(/i,
  /shell/i,
  /eval\s*\(/i,
  /child_process/i,
  /require\s*\(/i,
  /import\s+/i,
  /fs\./i,
  /process\./i,
  /delete\s+file/i,
  /ファイル削除/,
  /コマンド実行/,
  /シェル/,
  /環境変数.*(表示|見せ|出して|教えて)/,
  /トークン.*(表示|見せ|出して|教えて)/,
  /キー.*(表示|見せ|出して|教えて)/,
];

// Intent keywords (order matters — checked top to bottom)
const INTENT_PATTERNS = [
  {
    intent: 'STATUS_CHECK',
    patterns: [
      /実行中/,
      /何.*タスク/,
      /タスク.*実行/,
      /今.*動いて/,
      /状態.*確認/,
      /ステータス/,
      /status/i,
      /ロック/,
      /lock/i,
      /実行状態/,
    ],
  },
  {
    intent: 'QUEUE_CHECK',
    patterns: [
      /キュー/,
      /queue/i,
      /待機/,
      /残.*タスク/,
      /次.*実行/,
      /積.*んで/,
    ],
  },
  {
    intent: 'COOLDOWN_CHECK',
    patterns: [
      /cooldown/i,
      /usage.?limit/i,
      /復帰/,
      /いつ.*再開/,
      /再開.*いつ/,
      /制限.*(いつ|何時)/,
      /待機.*時間/,
    ],
  },
  {
    intent: 'LOG_SUMMARY',
    patterns: [
      /ログ.*要約/,
      /要約.*ログ/,
      /最新.*ログ/,
      /log.*要約/i,
      /summarize.*log/i,
      /ログ.*見せ/,
      /ログ.*確認/,
    ],
  },
  {
    intent: 'COMMENT_POST',
    patterns: [
      /返信/,
      /コメント.*投稿/,
      /投稿.*コメント/,
      /reply/i,
      /comment/i,
      /伝えて/,
    ],
  },
  {
    intent: 'RETRY_SUGGEST',
    patterns: [
      /再実行/,
      /retry/i,
      /再試行/,
      /もう一度.*実行/,
      /再.*キュー/,
    ],
  },
  {
    intent: 'ISSUE_STATUS',
    patterns: [
      /何.*止まって/,
      /止まっている/,
      /なぜ.*止/,
      /どうなって/,
      /進捗/,
      /issue.*状態/i,
      /状態.*確認/,
    ],
  },
];

/**
 * Check if input contains dangerous patterns that should always be rejected.
 */
function isDangerous(text: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(text));
}

/**
 * Extract SOT-xxx issue ID from text. Returns null if not found.
 */
function extractIssueId(text: string): string | null {
  const match = text.match(ISSUE_ID_PATTERN);
  return match ? match[0].toUpperCase() : null;
}

interface IntentResult {
  intent: string;
  issueId: string | null;
  originalText: string;
}

/**
 * Classify natural language input into an intent.
 * @param {string} text - user input
 * @returns {IntentResult}
 */
function classifyIntent(text: string): IntentResult {
  const originalText = text;
  const issueId = extractIssueId(text);

  if (isDangerous(text)) {
    return { intent: 'DANGEROUS', issueId: null, originalText };
  }

  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some(p => p.test(text))) {
      // For intents that require an issue ID, fall back to UNKNOWN if not found
      if (['LOG_SUMMARY', 'COMMENT_POST', 'RETRY_SUGGEST', 'ISSUE_STATUS'].includes(intent) && !issueId) {
        continue; // try next intent
      }
      return { intent, issueId, originalText };
    }
  }

  // If an issue ID is present but no specific intent matched, check for issue status
  if (issueId) {
    return { intent: 'ISSUE_STATUS', issueId, originalText };
  }

  return { intent: 'UNKNOWN', issueId: null, originalText };
}

module.exports = { classifyIntent, isDangerous, extractIssueId };
