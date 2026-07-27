import crypto from 'node:crypto';
import type { SecurityDetector } from './agentSecurityEvaluation.js';

const BLOCK_PATTERNS = [
  /\bignore (?:all |the )?(?:previous|prior|system) instructions?\b/i,
  /\breveal (?:the )?(?:system prompt|secret|credentials?)\b/i,
  /\b(?:send|upload|exfiltrate) .{0,40}\b(?:secret|token|credentials?|private)\b/i,
  /\bdo not tell (?:the )?user\b/i,
];

export const BASELINE_DETECTOR_ID = 'keyword-guard-v1';
export const BASELINE_ARTIFACT_ID = `sha256:${crypto
  .createHash('sha256')
  .update(BLOCK_PATTERNS.map((pattern) => pattern.source).join('\n'))
  .digest('hex')}`;

export function createBaselineDetector(): SecurityDetector {
  return {
    detectorId: BASELINE_DETECTOR_ID,
    artifactId: BASELINE_ARTIFACT_ID,
    decide(input) {
      const text = `${input.userMessage}\n${input.toolOutput}`;
      return BLOCK_PATTERNS.some((pattern) => pattern.test(text)) ? 'block' : 'allow';
    },
  };
}
