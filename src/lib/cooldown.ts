import fs from 'node:fs';

/**
 * Usage-limit cooldown + Linear label/comment helpers extracted from runner.ts (SOT-935 R2).
 * Shared primitives (log / linearQuery / LOG_DIR / COOLDOWN_FILE / USAGE_LIMIT_FILE /
 * USAGE_LIMIT_RETRY_BUFFER_SECONDS) are owned by runner.ts and injected once at module init via
 * configureCooldown() to avoid a circular import. Injection is safe: configured at runner.ts import
 * time, used only at runtime.
 */
export interface CooldownDeps {
  logDir: string;
  cooldownFile: string;
  usageLimitFile: string;
  usageLimitRetryBufferSeconds: number;
  log: (tag: string, message: string, context?: Record<string, any>) => void;
  linearQuery: (query: string, variables?: Record<string, any>) => Promise<any>;
}

let deps: CooldownDeps | null = null;

export function configureCooldown(d: CooldownDeps): void {
  deps = d;
}

function requireDeps(): CooldownDeps {
  if (!deps) {
    throw new Error('cooldown not configured: call configureCooldown() first');
  }
  return deps;
}

export interface CooldownState {
  retryAt: string;
  issueId: string | null;
  issueIdentifier?: string | null;
  reason?: string | null;
  limitType?: string | null;
  active?: boolean;
}

export interface CooldownOptions {
  issueId?: string | null;
  issueIdentifier?: string | null;
  resetAt?: string | null;
  bufferSeconds?: number;
  reason?: string;
  limitType?: string;
}

export function buildUsageLimitCommentBody(resetEpoch: number): string {
  const date = new Date(resetEpoch * 1000);
  const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const iso = jstDate.toISOString();
  const jstTime = `${iso.substring(0, 10)} ${iso.substring(11, 16)} JST`;
  return `usage-limit: Next auto run: ${jstTime}`;
}

export async function postUsageLimitComment(issueId: string, resetEpoch: number): Promise<void> {
  const { log, linearQuery } = requireDeps();
  try {
    const getIssue: any = await linearQuery('query($id: String!) { issue(id: $id) { id } }', { id: issueId });
    if (!getIssue.issue) return;
    const uuid = getIssue.issue.id;

    const body = buildUsageLimitCommentBody(resetEpoch);

    // Check for duplicate comment before posting
    let existingComments: any[] = [];
    try {
      const commentsData: any = await linearQuery(
        'query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body } } } }',
        { id: uuid }
      );
      existingComments = commentsData.issue?.comments?.nodes || [];
    } catch (err: any) {
      log('WARN', `postUsageLimitComment: could not fetch comments, proceeding to post. ${err.message}`, { issue: issueId });
    }

    if (existingComments.some(c => c.body === body)) {
      log('RUNNER', 'usage-limit comment already exists, skipped', { issue: issueId, body });
      return;
    }

    await linearQuery(`
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `, { issueId: uuid, body });
  } catch (err: any) {
    log('ERROR', `postUsageLimitComment failed: ${err.message}`, { issue: issueId });
  }
}

export async function addUsageLimitLabel(issueId: string): Promise<void> {
  const { log, linearQuery } = requireDeps();
  try {
    const issueData: any = await linearQuery('query($id: String!) { issue(id: $id) { id labelIds team { id } } }', { id: issueId });
    if (!issueData.issue) return;
    const { id: uuid, labelIds, team } = issueData.issue;
    const teamId = team.id;

    const labelsData: any = await linearQuery('query { issueLabels(filter: { name: { eq: "usage-limit" } }) { nodes { id } } }');
    let labelId = labelsData.issueLabels.nodes[0]?.id;

    if (!labelId) {
      const createLabelData: any = await linearQuery(`
        mutation($name: String!, $teamId: String!, $color: String!) {
          issueLabelCreate(input: { name: $name, teamId: $teamId, color: $color }) {
            issueLabel { id }
          }
        }
      `, { name: 'usage-limit', teamId, color: '#FF6B6B' });
      labelId = createLabelData.issueLabelCreate.issueLabel.id;
    }

    if (!labelIds.includes(labelId)) {
      await linearQuery(`
        mutation($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) {
            success
          }
        }
      `, { id: uuid, labelIds: [...labelIds, labelId] });
    }
  } catch (err: any) {
    log('ERROR', `addUsageLimitLabel failed: ${err.message}`, { issue: issueId });
  }
}

export async function removeUsageLimitLabel(issueId: string): Promise<void> {
  const { log, linearQuery } = requireDeps();
  try {
    const issueData: any = await linearQuery('query($id: String!) { issue(id: $id) { id labelIds } }', { id: issueId });
    if (!issueData.issue) return;
    const { id: uuid, labelIds } = issueData.issue;

    const labelsData: any = await linearQuery('query { issueLabels(filter: { name: { eq: "usage-limit" } }) { nodes { id } } }');
    const labelId = labelsData.issueLabels.nodes[0]?.id;

    if (labelId && labelIds.includes(labelId)) {
      const filteredIds = labelIds.filter((id: string) => id !== labelId);
      await linearQuery(`
        mutation($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) {
            success
          }
        }
      `, { id: uuid, labelIds: filteredIds });
    }
  } catch (err: any) {
    log('ERROR', `removeUsageLimitLabel failed: ${err.message}`, { issue: issueId });
  }
}

/**
 * Issue が Done（完了）に到達したときに `check` ラベルを付与する。
 * 人間が完了Issueを確認した後、手動でラベルを外す運用（SOT-908）。
 * ラベルが無ければ作成し、既に付いていれば何もしない（冪等）。
 */
export async function addCheckLabel(issueId: string): Promise<void> {
  const { log, linearQuery } = requireDeps();
  try {
    const issueData: any = await linearQuery('query($id: String!) { issue(id: $id) { id labelIds team { id } } }', { id: issueId });
    if (!issueData.issue) return;
    const { id: uuid, labelIds, team } = issueData.issue;
    const teamId = team.id;

    const labelsData: any = await linearQuery('query { issueLabels(filter: { name: { eq: "check" } }) { nodes { id } } }');
    let labelId = labelsData.issueLabels.nodes[0]?.id;

    if (!labelId) {
      const createLabelData: any = await linearQuery(`
        mutation($name: String!, $teamId: String!, $color: String!) {
          issueLabelCreate(input: { name: $name, teamId: $teamId, color: $color }) {
            issueLabel { id }
          }
        }
      `, { name: 'check', teamId, color: '#4CB782' });
      labelId = createLabelData.issueLabelCreate.issueLabel.id;
    }

    if (!labelIds.includes(labelId)) {
      await linearQuery(`
        mutation($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) {
            success
          }
        }
      `, { id: uuid, labelIds: [...labelIds, labelId] });
      log('RUNNER', 'check label added (issue Done)', { issue: issueId });
    }
  } catch (err: any) {
    log('ERROR', `addCheckLabel failed: ${err.message}`, { issue: issueId });
  }
}

export function setUsageLimitCooldownUntil(retryAt: string, issueIdOrOptions: string | CooldownOptions | null = null): void {
  const { logDir, cooldownFile, usageLimitFile, usageLimitRetryBufferSeconds, log } = requireDeps();
  // Accept both old signature (retryAt, issueId) and new (retryAt, { issueId, issueIdentifier, resetAt, bufferSeconds, reason, limitType })
  let issueId: string | null = null;
  let issueIdentifier: string | null = null;
  let resetAt: string | null = null;
  let bufferSeconds = usageLimitRetryBufferSeconds;
  let reason = 'usage_limit';
  let limitType = 'session_limit';

  if (typeof issueIdOrOptions === 'string') {
    issueId = issueIdOrOptions; // backward compat
  } else if (issueIdOrOptions && typeof issueIdOrOptions === 'object') {
    issueId = issueIdOrOptions.issueId || null;
    issueIdentifier = issueIdOrOptions.issueIdentifier || null;
    resetAt = issueIdOrOptions.resetAt || null;
    bufferSeconds = issueIdOrOptions.bufferSeconds != null ? issueIdOrOptions.bufferSeconds : usageLimitRetryBufferSeconds;
    reason = issueIdOrOptions.reason || 'usage_limit';
    limitType = issueIdOrOptions.limitType || 'session_limit';
  }

  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const now = new Date().toISOString();

    // Write to new COOLDOWN_FILE with rich structure
    const cooldownData = {
      active: true,
      until: retryAt,
      detectedAt: now,
      sourceIssueId: issueId,
      sourceIssueIdentifier: issueIdentifier,
      resetAt: resetAt,
      bufferSeconds: bufferSeconds,
      reason: reason,
      limitType: limitType
    };
    const cooldownTmp = cooldownFile + '.tmp';
    fs.writeFileSync(cooldownTmp, JSON.stringify(cooldownData, null, 2));
    fs.renameSync(cooldownTmp, cooldownFile);

    // Also write backward-compat USAGE_LIMIT_FILE so old scheduler.sh can still read it
    const legacyData = { retryAt, issueId };
    const legacyTmp = usageLimitFile + '.tmp';
    fs.writeFileSync(legacyTmp, JSON.stringify(legacyData, null, 2));
    fs.renameSync(legacyTmp, usageLimitFile);

    log('RUNNER', 'usage limit cooldown set', { retryAt, issueId: issueId || undefined, issueIdentifier: issueIdentifier || undefined });
  } catch (err: any) {
    log('ERROR', `setUsageLimitCooldownUntil failed: ${err.message}`);
  }
}

export function clearUsageLimitCooldown(): void {
  const { cooldownFile, usageLimitFile, log } = requireDeps();
  try {
    if (fs.existsSync(cooldownFile)) {
      fs.unlinkSync(cooldownFile);
    }
    if (fs.existsSync(usageLimitFile)) {
      fs.unlinkSync(usageLimitFile);
    }
    log('RUNNER', 'usage limit cooldown cleared');
  } catch (err: any) {
    log('ERROR', `clearUsageLimitCooldown failed: ${err.message}`);
  }
}

export function getUsageLimitCooldownUntil(nowMs: number = Date.now()): CooldownState | null {
  const { cooldownFile, usageLimitFile, log } = requireDeps();
  // Try new COOLDOWN_FILE first
  if (fs.existsSync(cooldownFile)) {
    try {
      const content = fs.readFileSync(cooldownFile, 'utf8');
      const state = JSON.parse(content);
      const retryAt = state.until || state.retryAt || null;
      if (!retryAt) {
        clearUsageLimitCooldown();
        return null;
      }
      const retryAtMs = new Date(retryAt).getTime();
      if (isNaN(retryAtMs) || retryAtMs <= nowMs) {
        clearUsageLimitCooldown();
        return null;
      }
      return {
        retryAt,
        issueId: state.sourceIssueId || null,
        issueIdentifier: state.sourceIssueIdentifier || null,
        reason: state.reason || null,
        limitType: state.limitType || null,
        active: true
      };
    } catch (err: any) {
      log('ERROR', `getUsageLimitCooldownUntil: COOLDOWN_FILE parse failed: ${err.message}`);
      // Fall through to legacy file
    }
  }

  // Fall back to legacy USAGE_LIMIT_FILE
  try {
    if (!fs.existsSync(usageLimitFile)) return null;
    const content = fs.readFileSync(usageLimitFile, 'utf8');
    const state = JSON.parse(content);

    let retryAt: string | null = null;
    let issueId: string | null = null;
    if (typeof state === 'string') {
      retryAt = state;
    } else {
      retryAt = state.retryAt;
      issueId = state.issueId;
    }

    if (!retryAt) return null;
    const retryAtMs = new Date(retryAt).getTime();
    if (isNaN(retryAtMs)) {
      clearUsageLimitCooldown();
      return null;
    }
    if (retryAtMs <= nowMs) {
      clearUsageLimitCooldown();
      return null;
    }
    return { retryAt, issueId: issueId || null };
  } catch (err: any) {
    log('ERROR', `getUsageLimitCooldownUntil failed: ${err.message}`);
    return null;
  }
}
