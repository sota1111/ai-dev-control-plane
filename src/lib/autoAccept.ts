import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Autonomous acceptance (design/README.md §37 「自動受け入れと人間確認の例外」).
 *
 * A verified successful run finishes in In Review (the worker-side terminal, unchanged). The control
 * plane then promotes In Review → Done automatically UNLESS the issue is explicitly held for a human:
 *   - a hold label (default `human-review`) is attached, or
 *   - the issue title carries a hold prefix (default `[PLAN]` / `[QUESTION]` — deliverables whose whole
 *     point is a human decision), or
 *   - a `review=human` directive appears in the description or a comment (newest occurrence wins;
 *     `review=auto` re-enables promotion for one issue).
 *
 * Config: config/auto_accept.json. Missing file → defaults (enabled). Unparseable file → DISABLED
 * (fail-closed: acceptance is a safety boundary, so a broken config falls back to human review).
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'auto_accept.json');

export interface AutoAcceptConfig {
  enabled: boolean;
  /** Labels that hold an issue in In Review for a human. */
  holdLabels: string[];
  /** Title prefixes whose deliverable is a human decision (kept in In Review). */
  holdTitlePrefixes: string[];
}

export const DEFAULT_AUTO_ACCEPT_CONFIG: AutoAcceptConfig = {
  enabled: true,
  holdLabels: ['human-review'],
  holdTitlePrefixes: ['[PLAN]', '[QUESTION]'],
};

export function loadAutoAcceptConfig(configPath: string = DEFAULT_CONFIG_PATH): AutoAcceptConfig {
  if (!fs.existsSync(configPath)) return { ...DEFAULT_AUTO_ACCEPT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!raw || typeof raw !== 'object') throw new Error('not an object');
    const cfg: AutoAcceptConfig = {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AUTO_ACCEPT_CONFIG.enabled,
      holdLabels: Array.isArray(raw.hold_labels)
        ? raw.hold_labels.filter((l: unknown): l is string => typeof l === 'string' && l.length > 0)
        : DEFAULT_AUTO_ACCEPT_CONFIG.holdLabels,
      holdTitlePrefixes: Array.isArray(raw.hold_title_prefixes)
        ? raw.hold_title_prefixes.filter((p: unknown): p is string => typeof p === 'string' && p.length > 0)
        : DEFAULT_AUTO_ACCEPT_CONFIG.holdTitlePrefixes,
    };
    return cfg;
  } catch {
    // Fail-closed: acceptance is a safety boundary — a broken config means "human review".
    return { ...DEFAULT_AUTO_ACCEPT_CONFIG, enabled: false };
  }
}

/**
 * Resolve a per-issue `review=` directive from description + comments. `texts` must be ordered
 * oldest → newest; the newest occurrence wins (same convention as the `workers:` directive).
 */
export function resolveReviewDirective(texts: Array<string | null | undefined>): 'human' | 'auto' | null {
  let result: 'human' | 'auto' | null = null;
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(/(?:^|\s)review\s*=\s*(human|auto)\b/gim)) {
      result = match[1].toLowerCase() as 'human' | 'auto';
    }
  }
  return result;
}

export interface HoldDecisionInput {
  title?: string | null;
  labels?: Array<string | null | undefined>;
  /** Description first, then comments oldest → newest. */
  directiveTexts?: Array<string | null | undefined>;
}

export interface HoldDecision {
  hold: boolean;
  reason: string;
}

/** Decide whether an issue must stay in In Review for a human (§37 exception conditions). */
export function shouldHoldForHuman(config: AutoAcceptConfig, input: HoldDecisionInput): HoldDecision {
  const directive = resolveReviewDirective(input.directiveTexts ?? []);
  // The explicit per-issue directive is the strongest signal in both directions.
  if (directive === 'human') return { hold: true, reason: 'review=human directive' };
  if (directive === 'auto') return { hold: false, reason: 'review=auto directive' };

  const labels = (input.labels ?? []).filter((l): l is string => typeof l === 'string');
  const holdLabel = labels.find((l) =>
    config.holdLabels.some((h) => h.toLowerCase() === l.toLowerCase())
  );
  if (holdLabel) return { hold: true, reason: `hold label "${holdLabel}"` };

  const title = (input.title ?? '').trimStart();
  const holdPrefix = config.holdTitlePrefixes.find((p) =>
    title.toLowerCase().startsWith(p.toLowerCase())
  );
  if (holdPrefix) return { hold: true, reason: `hold title prefix "${holdPrefix}"` };

  return { hold: false, reason: 'no hold condition' };
}

// ---------------------------------------------------------------------------------------------
// Auto-accepted markers.
//
// The webhook's premature-Done repair (webhook-server) reverts Done → In Review whenever the issue
// is still queued/running — which is exactly the window in which processCompletedRun promotes the
// issue (the inflight entry is cleared only after post-processing). Mark every promotion here so
// the repair path can tell "our own auto-acceptance" apart from a genuinely premature GitHub Done.

const MARKER_TTL_MS = 15 * 60 * 1000;
const autoAcceptedAt = new Map<string, number>();

export function markAutoAccepted(issueId: string, now: number = Date.now()): void {
  autoAcceptedAt.set(issueId, now);
}

export function wasRecentlyAutoAccepted(issueId: string, now: number = Date.now()): boolean {
  const at = autoAcceptedAt.get(issueId);
  if (at === undefined) return false;
  if (now - at > MARKER_TTL_MS) {
    autoAcceptedAt.delete(issueId);
    return false;
  }
  return true;
}

/** Test helper. */
export function clearAutoAcceptedMarkers(): void {
  autoAcceptedAt.clear();
}
