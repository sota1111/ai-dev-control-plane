import https from 'node:https';
import { getSecret } from '../config/secrets.js';
import { getPriorityRank } from './queueOrdering.js';
import { isTerminalState, isHoldState } from './issueState.js';
import type { IssueQueueMetadata } from '../runner.js';

/**
 * Linear GraphQL API access + issue metadata/state helpers, extracted from runner.ts (SOT-935 R3).
 * Shared primitives owned by runner.ts (log / LINEAR_API_URL / LONG_RUN_LABEL) and the queue helper
 * removeFromQueue are injected once at module init via configureLinearApi() to avoid a circular
 * import. getSecret / https / getPriorityRank / isTerminalState / isHoldState are imported directly.
 * Injection is safe: configured at runner.ts import time, used only at runtime.
 */
export interface LinearApiDeps {
  log: (tag: string, message: string, context?: Record<string, any>) => void;
  linearApiUrl: string;
  longRunLabel: string;
  removeFromQueue: (issueId: string) => void;
}

let deps: LinearApiDeps | null = null;

export function configureLinearApi(d: LinearApiDeps): void {
  deps = d;
}

function requireDeps(): LinearApiDeps {
  if (!deps) {
    throw new Error('linearApi not configured: call configureLinearApi() first');
  }
  return deps;
}

export interface IssueMeta {
  identifier: string | null;
  title: string | null;
  description: string | null;
  projectName: string | null;
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  isLongRun?: boolean;
}

// Marker embedded in the auto-finalization comment so we never finalize a parent twice.
const PARENT_FINALIZED_MARKER = '<!-- auto-parent-finalized -->';

export async function linearQuery(query: string, variables: Record<string, any> = {}): Promise<any> {
  const { linearApiUrl } = requireDeps();
  const apiKey = getSecret('LINEAR_API_KEY');
  if (!apiKey) throw new Error('LINEAR_API_KEY not set');

  const body = JSON.stringify({ query, variables });

  return new Promise((resolve, reject) => {
    const url = new URL(linearApiUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey
      },
      timeout: 10000
    };

    const req = https.request(options, (res: any) => {
      let data = '';
      res.on('data', (chunk: any) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) {
            reject(new Error(json.errors[0].message));
          } else {
            resolve(json.data);
          }
        } catch (e: any) {
          reject(new Error(`Failed to parse Linear API response: ${e.message}`));
        }
      });
    });

    req.on('error', (err: any) => { reject(err); });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Linear API timeout'));
    });
    req.write(body);
    req.end();
  });
}

// Linear issue が属するプロジェクト名を取得する。取得不能・未設定時は null（never throws）。
export async function getIssueProjectName(issueId: string): Promise<string | null> {
  const { log } = requireDeps();
  try {
    const data: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { project { name } } }',
      { id: issueId }
    );
    const name = data?.issue?.project?.name;
    return typeof name === 'string' && name.trim() !== '' ? name : null;
  } catch (err: any) {
    log('RUNNER', `getIssueProjectName failed: ${err.message}`, { issue: issueId });
    return null;
  }
}

// Linear が割り当てる git branch 名（gitBranchName）を取得する（never throws）。
// SOT-933 の concurrency-lane 導出で、RUNNER_SERIALIZE_SCOPE=branch のとき同一 branch を直列に
// 弾くために使う。取得失敗時は null（呼び出し側は repo lane にフォールバック＝より直列で安全）。
export async function getIssueGitBranch(issueId: string): Promise<string | null> {
  const { log } = requireDeps();
  try {
    const data: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { branchName } }',
      { id: issueId }
    );
    const branch = data?.issue?.branchName;
    return typeof branch === 'string' && branch.trim() !== '' ? branch : null;
  } catch (err: any) {
    log('RUNNER', `getIssueGitBranch failed: ${err.message}`, { issue: issueId });
    return null;
  }
}

// Linear issue の identifier/title/description/プロジェクト名を1クエリで取得する（never throws）。
export async function getIssueMeta(issueId: string): Promise<IssueMeta> {
  const { log } = requireDeps();
  try {
    const data: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { identifier title description project { name } } }',
      { id: issueId }
    );
    const issue = data?.issue ?? {};
    const projectName = issue?.project?.name;
    return {
      identifier: typeof issue.identifier === 'string' ? issue.identifier : null,
      title: typeof issue.title === 'string' ? issue.title : null,
      description: typeof issue.description === 'string' ? issue.description : null,
      projectName:
        typeof projectName === 'string' && projectName.trim() !== '' ? projectName : null,
    };
  } catch (err: any) {
    log('RUNNER', `getIssueMeta failed: ${err.message}`, { issue: issueId });
    return { identifier: null, title: null, description: null, projectName: null };
  }
}

export async function getIssueQueueMetadata(issueId: string): Promise<IssueQueueMetadata | null> {
  const { log } = requireDeps();
  try {
    const query = `
      query($id: String!) {
        issue(id: $id) {
          id
          identifier
          priority
          priorityLabel
          archivedAt
          createdAt
          updatedAt
          state { type name }
          parent { id identifier }
        }
      }
    `;
    const data: any = await linearQuery(query, { id: issueId });
    if (!data.issue) return null;
    const issue = data.issue;
    return {
      id: issue.id,
      identifier: issue.identifier,
      priority: issue.priority ?? null,
      priorityLabel: issue.priorityLabel ?? null,
      priorityRank: getPriorityRank(issue.priority),
      parentIssueId: issue.parent?.id ?? null,
      parentIssueIdentifier: issue.parent?.identifier ?? null,
      stateType: issue.state?.type ?? null,
      stateName: issue.state?.name ?? null,
      archivedAt: issue.archivedAt ?? null,
      createdAt: issue.createdAt ?? null,
      updatedAt: issue.updatedAt ?? null
    };
  } catch (err: any) {
    log('RUNNER', `getIssueQueueMetadata failed: ${err.message}`, { issue: issueId });
    return null;
  }
}

export async function hasPendingIssues(): Promise<boolean> {
  try {
    const query = '{ issues(filter: { state: { type: { in: ["unstarted","started"] } } }, first: 1) { nodes { id } } }';
    const data: any = await linearQuery(query);
    return !!(data.issues?.nodes?.length > 0);
  } catch (err) {
    // Fail safe: don't block execution
    return false;
  }
}

/**
 * Fetch active (unstarted/started) issues.
 *
 * SOT-1438 / P3: pass `{ excludeHold: true }` from the reaper / bootstrap scan path so hold-state
 * issues (In Review) are excluded at the QUERY layer instead of being fetched and then per-item
 * `isHoldState`-skipped by every consumer (that per-item skip logged ~6,430 no-op lines). In Review
 * shares the `started` state type with In Progress, so it can't be dropped by `type`; we exclude it
 * by workflow-state name in the GraphQL filter, plus a JS `isHoldState` filter as a belt-and-suspenders
 * guard. Display / queue-sync callers keep the default (In Review included) so nothing else changes.
 */
export async function fetchActiveIssues(
  first: number = 50,
  opts: { excludeHold?: boolean } = {}
): Promise<IssueQueueMetadata[]> {
  const excludeHold = opts.excludeHold === true;
  // In Review (hold) exclusion is name-based because its state type is "started" like In Progress.
  const stateFilter = excludeHold
    ? 'state: { type: { in: ["unstarted","started"] }, name: { nin: ["In Review"] } }'
    : 'state: { type: { in: ["unstarted","started"] } }';
  const query = `
    query($first: Int!) {
      issues(filter: { ${stateFilter} }, first: $first) {
        nodes {
          id
          identifier
          title
          url
          priority
          priorityLabel
          archivedAt
          createdAt
          updatedAt
          state { type name }
          parent { id identifier }
        }
      }
    }
  `;
  const data: any = await linearQuery(query, { first });
  return (data.issues?.nodes || [])
    .filter((issue: any) => !issue.archivedAt)
    .filter((issue: any) => !excludeHold || !isHoldState(issue.state))
    .map((issue: any) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      priority: issue.priority ?? null,
      priorityLabel: issue.priorityLabel ?? null,
      priorityRank: getPriorityRank(issue.priority),
      parentIssueId: issue.parent?.id ?? null,
      parentIssueIdentifier: issue.parent?.identifier ?? null,
      stateType: issue.state?.type ?? null,
      stateName: issue.state?.name ?? null,
      archivedAt: issue.archivedAt ?? null,
      createdAt: issue.createdAt ?? null,
      updatedAt: issue.updatedAt ?? null
    }));
}

export async function setIssueInProgress(issueId: string): Promise<void> {
  const { log } = requireDeps();
  try {
    const issueData: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { id state { type } team { id } } }',
      { id: issueId }
    );
    if (!issueData.issue) return;
    if (issueData.issue.state?.type === 'started') {
      log('WEBHOOK', `setIssueInProgress: ${issueId} already started, skip`);
      return;
    }
    const { id: uuid, team } = issueData.issue;
    const statesData: any = await linearQuery(
      'query($teamId: String!) { workflowStates(filter: { team: { id: { eq: $teamId } }, type: { eq: "started" } }, first: 1) { nodes { id name } } }',
      { teamId: team.id }
    );
    const stateId = statesData.workflowStates?.nodes[0]?.id;
    if (!stateId) {
      log('WEBHOOK', `setIssueInProgress: no started state found for team ${team.id}`);
      return;
    }
    await linearQuery(
      'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
      { id: uuid, stateId }
    );
    log('WEBHOOK', `setIssueInProgress: ${issueId} updated to In Progress`);
  } catch (err: any) {
    log('ERROR', `setIssueInProgress failed: ${err.message}`, { issue: issueId });
  }
}

// When a CHILD issue reaches a terminal state, advance its parent to In Review if all
// of the parent's children are now terminal. Child issues are processed in independent
// Linear-webhook single-issue runs, so without this nobody returns to finalize the
// parent and it stays stuck In Progress (see SOT-840 / SOT-829). Fail-open: never throws.
export async function finalizeParentIfChildrenComplete(childIdentifier: string, parentId: string | null): Promise<boolean> {
  const { log } = requireDeps();
  if (!parentId) return false;
  try {
    const data: any = await linearQuery(
      `query($id: String!) {
        issue(id: $id) {
          id
          identifier
          state { name type }
          team { id }
          children(first: 100) { nodes { identifier state { name type } } }
        }
      }`,
      { id: parentId }
    );
    const parent = data.issue;
    if (!parent) {
      log('WEBHOOK', `finalizeParent: parent ${parentId} not found, skip`, { issue: childIdentifier });
      return false;
    }

    if (isTerminalState(parent.state)) {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} already terminal (${parent.state?.name}), skip`, { issue: parent.identifier });
      return false;
    }
    if ((parent.state?.name || '').toLowerCase() === 'in review') {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} already In Review, skip`, { issue: parent.identifier });
      return false;
    }

    const children = parent.children?.nodes || [];
    if (children.length === 0) {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} has no children, skip`, { issue: parent.identifier });
      return false;
    }

    const pending = children.filter((c: any) => !isTerminalState(c.state));
    if (pending.length > 0) {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} has non-terminal children: ${pending.map((c: any) => c.identifier).join(',')}, skip`, { issue: parent.identifier });
      return false;
    }

    // Idempotency: bail if we already posted the finalization marker.
    const commentsData: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body } } } }',
      { id: parent.id }
    );
    const existingComments = commentsData.issue?.comments?.nodes || [];
    if (existingComments.some((c: any) => (c.body || '').includes(PARENT_FINALIZED_MARKER))) {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} already finalized (marker present), skip`, { issue: parent.identifier });
      return false;
    }

    // Resolve the team's "In Review" workflow state by name (both In Progress and In
    // Review are type "started", so we must match on name, not type).
    const statesData: any = await linearQuery(
      'query($teamId: String!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } } }',
      { teamId: parent.team.id }
    );
    const stateNodes = statesData.workflowStates?.nodes || [];
    const reviewState = stateNodes.find((s: any) => (s.name || '').toLowerCase() === 'in review');
    if (!reviewState) {
      log('WEBHOOK', `finalizeParent: no In Review state for team ${parent.team.id}, skip`, { issue: parent.identifier });
      return false;
    }

    await linearQuery(
      'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
      { id: parent.id, stateId: reviewState.id }
    );

    const childList = children.map((c: any) => `- ${c.identifier} (${c.state?.name})`).join('\n');
    const body = `${PARENT_FINALIZED_MARKER}
## 親Issue自動ファイナライズ

全ての子Issueが完了したため、親Issueを **In Review** に更新しました（trigger: ${childIdentifier} 完了）。

### 子Issue
${childList}

人間のレビュー後に Done へ移行してください。`;
    await linearQuery(
      'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }',
      { issueId: parent.id, body }
    );

    log('WEBHOOK', `finalizeParent: ${parent.identifier} -> In Review (all ${children.length} children terminal, trigger ${childIdentifier})`, { issue: parent.identifier });
    return true;
  } catch (err: any) {
    log('ERROR', `finalizeParentIfChildrenComplete failed: ${err.message}`, { issue: parentId || '' });
    return false;
  }
}

export async function getIssueExecutionEligibility(issueId: string): Promise<EligibilityResult> {
  const { log, longRunLabel, removeFromQueue } = requireDeps();
  try {
    const query = `
      query($id: String!) {
        issue(id: $id) {
          id
          identifier
          archivedAt
          state { name type }
          labels { nodes { name } }
        }
      }
    `;
    const data: any = await linearQuery(query, { id: issueId });

    if (!data.issue) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'issue not found before run' };
    }

    const { archivedAt, state } = data.issue;
    const isLongRun = (data.issue.labels?.nodes || []).some((l: any) => l && l.name === longRunLabel);

    if (archivedAt) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'archived issue before run' };
    }

    const isTerminal = isTerminalState(state);

    if (isTerminal) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'terminal state before run' };
    }

    // In Review は人間のレビュー待ちの保留状態。自動実行の対象外とし、キューからも除去する
    // （reaper が "started" 扱いで再投入し続けるのを防ぐ）。
    if (isHoldState(state)) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'hold state (In Review) before run' };
    }

    return { eligible: true, isLongRun };
  } catch (err: any) {
    // Fail open for execution, fail closed for long-run: if Linear API is unavailable, allow
    // execution to proceed but on the normal synchronous path (isLongRun stays undefined/false).
    log('ERROR', `getIssueExecutionEligibility failed: ${err.message}`, { issue: issueId });
    return { eligible: true };
  }
}
