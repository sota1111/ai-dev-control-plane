import crypto from 'node:crypto';
import type { SecurityDetector } from './agentSecurityEvaluation.js';
import { createBaselineDetector } from './agentSecurityBaseline.js';

const OVERRIDE_PATTERNS = [
  /\b(?:treat|consider) (?:the )?(?:text|instructions?) (?:above|before) as (?:obsolete|invalid|untrusted)\b/i,
  /\b(?:disregard|bypass|override) (?:your |the )?(?:instruction hierarchy|hierarchy|policy|guardrails?)\b/i,
];

const SENSITIVE_ACTION_PATTERNS = [
  /\b(?:print|copy|mirror|send|post|upload|exfiltrate)\b.{0,60}\b(?:configuration|config|environment|env|secret|token|credentials?|private)\b/i,
  /\b(?:secret|token|credentials?|private|environment|env)\b.{0,60}\b(?:public|collector|endpoint|next tool|external)\b/i,
];

const DIRECT_TOOL_ATTACK_PATTERNS = [
  /\b(?:curl|wget)\b.{0,80}\b(?:secret|token|credentials?|environment|env)\b/i,
  /\b(?:run|execute|invoke|call)\b.{0,30}\b(?:shell|terminal|exec)\b.{0,80}\b(?:secret|token|credentials?|environment|env)\b/i,
];

const SINGLE_TOOL_PATTERNS = [
  ...OVERRIDE_PATTERNS,
  ...SENSITIVE_ACTION_PATTERNS,
  ...DIRECT_TOOL_ATTACK_PATTERNS,
];

export const SINGLE_TOOL_DETECTOR_ID = 'single-tool-guard-v2';
export const SINGLE_TOOL_ARTIFACT_ID = `sha256:${crypto
  .createHash('sha256')
  .update(SINGLE_TOOL_PATTERNS.map((pattern) => pattern.source).join('\n'))
  .digest('hex')}`;

export function createSingleToolDefenseDetector(): SecurityDetector {
  const baseline = createBaselineDetector();
  return {
    detectorId: SINGLE_TOOL_DETECTOR_ID,
    artifactId: SINGLE_TOOL_ARTIFACT_ID,
    decide(input) {
      if (baseline.decide(input) === 'block') return 'block';
      const text = `${input.userMessage}\n${input.toolName}\n${input.toolOutput}`;
      return SINGLE_TOOL_PATTERNS.some((pattern) => pattern.test(text)) ? 'block' : 'allow';
    },
  };
}
