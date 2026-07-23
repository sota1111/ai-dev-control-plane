import https from 'node:https';
import { getSecret } from '../config/secrets.js';
import { getPriorityRank } from './queueOrdering.js';
import { isTerminalState, isHoldState, isChildComplete } from './issueState.js';
import * as appEnv from '../config/env.js';
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
const PARENT_RESUMED_MARKER = '<!-- auto-parent-resumed -->';

type IssueRelationNode = { id?: string; type?: string };

/** Remove `blocks` edges while preserving related/duplicate links. Linear uses the same relation
 * type for both directions; incoming edges are exposed through `inverseRelations`. Best-effort so
 * cleanup failure never prevents the state transition itself. */
async function removeBlockingRelations(
  issueId: string,
  relations: IssueRelationNode[] = [],
  inverseRelations: IssueRelationNode[] = []
): Promise<number> {
  const { log } = requireDeps();
  const relationIds = [...relations, ...inverseRelations]
    .filter((relation) => relation?.type === 'blocks' && typeof relation.id === 'string' && relation.id)
    .map((relation) => relation.id as string);

  let removed = 0;
  for (const relationId of new Set(relationIds)) {
    try {
      await linearQuery(
        'mutation($id: String!) { issueRelationDelete(id: $id) { success } }',
        { id: relationId },
        { retries: 0 }
      );
      removed++;
    } catch (err: any) {
      log('ERROR', `removeBlockingRelations: failed to delete relation ${relationId}: ${err.message}`, { issue: issueId });
    }
  }
  if (removed > 0) {
    log('WEBHOOK', `removeBlockingRelations: removed ${removed} stale relation(s)`, { issue: issueId });
  }
  return removed;
}

// SOT-1440 / P7: mark transient (retryable) transport errors so linearQuery can retry them with
// backoff. GraphQL user/validation errors are marked NON-transient (permanent) and never retried.
class LinearTransientError extends Error {
  transient = true;
}

/**
 * Classify whether an error thrown by linearQueryOnce is transient (worth retrying). Transient =
 * transport-level: timeout, socket reset/hang-up, DNS, or 5xx/429. GraphQL validation/user errors
 * (json.errors) are NOT transient.
 */
function isTransientLinearError(err: any): boolean {
  if (err instanceof LinearTransientError) return true;
  const msg = String(err?.message || err || '').toLowerCase();
  return /timeout|socket hang up|econnreset|econnrefused|etimedout|enotfound|eai_again|network|502|503|504|429|rate limit|too many requests/.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function linearQueryOnce(query: string, variables: Record<string, any>): Promise<any> {
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
        // Retry on 5xx / 429 status even when a body is returned.
        if (res.statusCode && (res.statusCode >= 500 || res.statusCode === 429)) {
          reject(new LinearTransientError(`Linear API HTTP ${res.statusCode}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.errors) {
            reject(new Error(json.errors[0].message)); // GraphQL error = permanent, not retried
          } else {
            resolve(json.data);
          }
        } catch (e: any) {
          reject(new Error(`Failed to parse Linear API response: ${e.message}`));
        }
      });
    });

    req.on('error', (err: any) => { reject(new LinearTransientError(err?.message || 'socket error')); });
    req.on('timeout', () => {
      req.destroy();
      reject(new LinearTransientError('Linear API timeout'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Execute a Linear GraphQL query/mutation. SOT-1440 / P7: transient transport failures (timeout,
 * socket, 5xx, 429) are retried with exponential backoff + jitter (LINEAR_RETRY_MAX / _BASE_MS).
 * GraphQL validation errors are permanent and returned immediately (never retried). Callers that
 * must not retry a non-idempotent mutation on timeout can pass `{ retries: 0 }`.
 *
 * Note on idempotency: the retried writes here (state/label updates) are idempotent; the only
 * non-idempotent write (comment creation) is duplicate-guarded by its callers (postUsageLimitComment
 * / the parent-finalized marker), so a rare double-post is already prevented.
 */
export async function linearQuery(
  query: string,
  variables: Record<string, any> = {},
  opts: { retries?: number } = {}
): Promise<any> {
  const maxRetries = opts.retries !== undefined ? Math.max(0, opts.retries) : appEnv.linearRetryMax();
  const baseMs = appEnv.linearRetryBaseMs();
  let attempt = 0;
  // Try once, then up to maxRetries more times on transient errors.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await linearQueryOnce(query, variables);
    } catch (err: any) {
      if (attempt >= maxRetries || !isTransientLinearError(err)) throw err;
      // Exponential backoff with full jitter: delay ∈ [0, base * 2^attempt].
      const delay = Math.floor(Math.random() * (baseMs * Math.pow(2, attempt)));
      try {
        requireDeps().log('LINEAR', `transient error (${err.message}); retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
      } catch { /* deps/log optional */ }
      await sleep(delay);
      attempt++;
    }
  }
}

/**
 * SOT-1440 / P7: sanitize an issue's labelIds before writing them back via issueUpdate(labelIds).
 * Drops falsy/empty/non-string ids and de-duplicates, which prevents "invalid id" / duplicate
 * errors when reading an issue's labelIds and re-submitting them with an added label.
 */
export function sanitizeLabelIds(ids: any[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
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
          inverseRelations { nodes { type relatedIssue { id identifier } } }
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
      updatedAt: issue.updatedAt ?? null,
      blockedByIssueIds: blockingIssueIds(issue)
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
          inverseRelations { nodes { type relatedIssue { id identifier } } }
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
      updatedAt: issue.updatedAt ?? null,
      blockedByIssueIds: blockingIssueIds(issue)
    }));
}

function blockingIssueIds(issue: any): string[] {
  return (issue.inverseRelations?.nodes || [])
    .filter((relation: any) => relation.type === 'blocks')
    .flatMap((relation: any) => [relation.relatedIssue?.id, relation.relatedIssue?.identifier])
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
}

export async function setIssueInProgress(issueId: string): Promise<void> {
  const { log } = requireDeps();
  try {
    const issueData: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { id state { name type } team { id } } }',
      { id: issueId }
    );
    if (!issueData.issue) return;
    // SOT-1590: never drag a finished issue back to In Progress. The early pipeline-start transition
    // may be handed a Done/Canceled/Duplicate issue (e.g. a stale queue entry); reopening it would be
    // wrong. isTerminalState also guards the Discord `/recover` caller for free.
    if (isTerminalState(issueData.issue.state)) {
      log('WEBHOOK', `setIssueInProgress: ${issueId} is terminal (${issueData.issue.state?.name ?? issueData.issue.state?.type}), skip`);
      return;
    }
    if (issueData.issue.state?.type === 'started') {
      log('WEBHOOK', `setIssueInProgress: ${issueId} already started, skip`);
      return;
    }
    const { id: uuid, team } = issueData.issue;
    // SOT-1591: resolve the target state by NAME ("In Progress"), symmetric to setIssueInReview.
    // In Progress AND In Review are BOTH type "started", so grabbing the first `type:"started"` state
    // (`first:1`) can return "In Review" instead — which mislabels every pipeline-started issue as
    // In Review and breaks the SOT-1460 "usage-limit label only on In Progress" guard. Match by name.
    const statesData: any = await linearQuery(
      'query($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } } }',
      { teamId: team.id }
    );
    const progressState = (statesData.workflowStates?.nodes || []).find(
      (s: any) => (s.name || '').toLowerCase() === 'in progress'
    );
    const stateId = progressState?.id;
    if (!stateId) {
      log('WEBHOOK', `setIssueInProgress: no In Progress state for team ${team.id}, skip`);
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

/**
 * Advance an issue to "In Review" IF it is still in an active (non-terminal, non-hold) state. A
 * completed autonomous run must never leave an issue in Todo/In Progress — otherwise the webhook-reaper
 * repeatedly re-enqueues it as a "stranded active issue" (false positive) and the pipeline loops,
 * re-posting the same comments (SOT-1438 loop). Idempotent / fail-open: does nothing and never throws
 * when the issue is missing, already terminal, or already In Review. Returns true only when it moved
 * the issue. `commentBody`, when given, is posted after the transition.
 */
export async function setIssueInReview(issueId: string, commentBody?: string): Promise<boolean> {
  const { log } = requireDeps();
  try {
    const data: any = await linearQuery(
      `query($id: String!) {
        issue(id: $id) {
          id
          state { name type }
          team { id }
          relations { nodes { id type } }
          inverseRelations { nodes { id type } }
        }
      }`,
      { id: issueId }
    );
    const issue = data.issue;
    if (!issue) return false;
    if (isTerminalState(issue.state)) return false;
    if ((issue.state?.name || '').toLowerCase() === 'in review') {
      await removeBlockingRelations(issueId, issue.relations?.nodes, issue.inverseRelations?.nodes);
      return false;
    }
    // SOT-1560: skip any hold state (In Review OR On Hold). A circuit-breaker-halted issue is parked in
    // On Hold; the post-run ensure-issue-reviewed step must NOT drag it back to In Review, or the halt
    // would be undone and the re-run loop would resume.
    if (isHoldState(issue.state)) return false;

    // In Progress と In Review はどちらも type "started" のため、name で In Review を解決する。
    const statesData: any = await linearQuery(
      'query($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } } }',
      { teamId: issue.team.id }
    );
    const reviewState = (statesData.workflowStates?.nodes || []).find(
      (s: any) => (s.name || '').toLowerCase() === 'in review'
    );
    if (!reviewState) {
      log('WEBHOOK', `setIssueInReview: no In Review state for team ${issue.team.id}, skip`, { issue: issueId });
      return false;
    }

    await linearQuery(
      'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
      { id: issue.id, stateId: reviewState.id }
    );
    await removeBlockingRelations(issueId, issue.relations?.nodes, issue.inverseRelations?.nodes);
    if (commentBody) {
      await linearQuery(
        'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }',
        { issueId: issue.id, body: commentBody }
      );
    }
    log('WEBHOOK', `setIssueInReview: ${issueId} -> In Review`, { issue: issueId });
    return true;
  } catch (err: any) {
    log('ERROR', `setIssueInReview failed: ${err.message}`, { issue: issueId });
    return false;
  }
}

/**
 * SOT-1560 — move an issue to **On Hold** (circuit-breaker halt). Unlike In Review (human review), On
 * Hold marks a pipeline stopped by a safety stop-condition; every scanner (`fetchActiveIssues`
 * excludeHold / reaper / `/recover` re-scan) treats On Hold as a hold state (see `isHoldState`) and
 * therefore stops re-running the halted issue — which is the whole point of the breaker (kill the
 * runaway re-run loop). `commentBody`, when given, is posted after the transition. Fail-open: returns
 * false (never throws) when there is no On Hold state / already terminal / issue missing.
 */
export async function setIssueOnHold(issueId: string, commentBody?: string): Promise<boolean> {
  const { log } = requireDeps();
  try {
    const data: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { id state { name type } team { id } } }',
      { id: issueId }
    );
    const issue = data.issue;
    if (!issue) return false;
    if (isTerminalState(issue.state)) return false;
    if ((issue.state?.name || '').toLowerCase() === 'on hold') return false;

    const statesData: any = await linearQuery(
      'query($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } } }',
      { teamId: issue.team.id }
    );
    const holdState = (statesData.workflowStates?.nodes || []).find(
      (s: any) => (s.name || '').toLowerCase() === 'on hold'
    );
    if (!holdState) {
      log('WEBHOOK', `setIssueOnHold: no On Hold state for team ${issue.team.id}, skip`, { issue: issueId });
      return false;
    }

    await linearQuery(
      'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
      { id: issue.id, stateId: holdState.id }
    );
    if (commentBody) {
      await linearQuery(
        'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }',
        { issueId: issue.id, body: commentBody }
      );
    }
    log('WEBHOOK', `setIssueOnHold: ${issueId} -> On Hold`, { issue: issueId });
    return true;
  } catch (err: any) {
    log('ERROR', `setIssueOnHold failed: ${err.message}`, { issue: issueId });
    return false;
  }
}

// When a CHILD issue reaches a completed state (terminal Done/Canceled OR In Review),
// advance its parent if all of the parent's children are now complete. A parent explicitly
// parked On Hold is resumed to Todo because its children were prerequisites; other active
// parents are finalized to In Review because their children were the deliverables. Child
// issues are processed in independent Linear-webhook single-issue runs, so without this
// nobody returns to finalize the parent and it stays stuck in Todo/In Progress (see
// SOT-840 / SOT-829 / SOT-1551). Fail-open: never throws.
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
          relations { nodes { id type } }
          inverseRelations { nodes { id type } }
        }
      }`,
      { id: parentId }
    );
    const parent = data.issue;
    if (!parent) {
      log('WEBHOOK', `finalizeParent: parent ${parentId} not found, skip`, { issue: childIdentifier });
      return false;
    }

    // Some Linear workspaces model On Hold with type=completed. It is still a resumable
    // hold state, not a finished parent, so let the resume branch below handle it.
    if (isTerminalState(parent.state) && !isHoldState(parent.state)) {
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

    // A child is "complete" for finalization when it is terminal (Done/Canceled) OR In Review
    // (hold). Implementation children in this harness stop at In Review, not Done, so counting
    // only terminal children would leave the parent stuck in Todo/In Progress (SOT-1551).
    const pending = children.filter((c: any) => !isChildComplete(c.state));
    if (pending.length > 0) {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} has incomplete children: ${pending.map((c: any) => c.identifier).join(',')}, skip`, { issue: parent.identifier });
      return false;
    }

    const resumeParent = (parent.state?.name || '').toLowerCase() === 'on hold';
    const marker = resumeParent ? PARENT_RESUMED_MARKER : PARENT_FINALIZED_MARKER;

    // Idempotency: bail if we already posted the applicable transition marker.
    const commentsData: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body } } } }',
      { id: parent.id }
    );
    const existingComments = commentsData.issue?.comments?.nodes || [];
    if (existingComments.some((c: any) => (c.body || '').includes(marker))) {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} already ${resumeParent ? 'resumed' : 'finalized'} (marker present), skip`, { issue: parent.identifier });
      return false;
    }

    // Resolve the target by name. Todo causes the normal Issue webhook path to enqueue a
    // resumed parent; In Review remains the terminal handoff for decomposition-only parents.
    const statesData: any = await linearQuery(
      'query($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } } }',
      { teamId: parent.team.id }
    );
    const stateNodes = statesData.workflowStates?.nodes || [];
    const targetName = resumeParent ? 'todo' : 'in review';
    const targetState = stateNodes.find((s: any) => (s.name || '').toLowerCase() === targetName);
    if (!targetState) {
      log('WEBHOOK', `finalizeParent: no ${resumeParent ? 'Todo' : 'In Review'} state for team ${parent.team.id}, skip`, { issue: parent.identifier });
      return false;
    }

    await linearQuery(
      'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
      { id: parent.id, stateId: targetState.id }
    );
    if (!resumeParent) {
      await removeBlockingRelations(parent.identifier, parent.relations?.nodes, parent.inverseRelations?.nodes);
    }

    const childList = children.map((c: any) => `- ${c.identifier} (${c.state?.name})`).join('\n');
    const body = resumeParent ? `${PARENT_RESUMED_MARKER}
## 親Issue自動再開

全ての前提子Issueが完了したため、親Issueを **Todo** に戻しました（trigger: ${childIdentifier} 完了）。通常の webhook 実行キューから自動再開します。

### 子Issue
${childList}` : `${PARENT_FINALIZED_MARKER}
## 親Issue自動ファイナライズ

全ての子Issueが完了したため、親Issueを **In Review** に更新しました（trigger: ${childIdentifier} 完了）。

### 子Issue
${childList}

人間のレビュー後に Done へ移行してください。`;
    await linearQuery(
      'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }',
      { issueId: parent.id, body }
    );

    log('WEBHOOK', `finalizeParent: ${parent.identifier} -> ${resumeParent ? 'Todo (resume)' : 'In Review'} (all ${children.length} children complete, trigger ${childIdentifier})`, { issue: parent.identifier });
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
