/** Replacement markers are stable so redacted artifacts remain byte-reproducible. */
export const REDACTED_SECRET = '[REDACTED_SECRET]';
export const REDACTED_EMAIL = '[REDACTED_EMAIL]';
export const REDACTED_PATH = '[REDACTED_PATH]';

const SENSITIVE_KEY =
  /(?:^|[_-])(authorization|cookie|pass(?:word|wd)?|secret|token|api[_-]?key|email)(?:$|[_-])/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HOST_PATH =
  /(?:\/(?:home|Users|workspaces|tmp)\/[^\s"']+|[A-Za-z]:\\(?:Users|workspaces|tmp)\\[^\s"']+)/g;
const TOKEN = /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{8,})\b/g;
const AUTH = /\b(Bearer\s+)[^\s,"']+/gi;
const CLI_SECRET = /((?:--?|\/)(?:password|passwd|secret|token|api[-_]?key)(?:=|\s+))[^\s,"']+/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(EMAIL, REDACTED_EMAIL)
    .replace(HOST_PATH, REDACTED_PATH)
    .replace(TOKEN, REDACTED_SECRET)
    .replace(AUTH, `$1${REDACTED_SECRET}`)
    .replace(CLI_SECRET, `$1${REDACTED_SECRET}`);
}

/** Redact sensitive keys and string content without mutating the caller's value. */
export function redactArtifact<T>(value: T): T {
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return redactSensitiveText(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          key,
          SENSITIVE_KEY.test(key) ? REDACTED_SECRET : visit(child),
        ])
      );
    }
    return item;
  };
  return visit(value) as T;
}

/** Assertion used at persistence boundaries and in leak-regression tests. */
export function assertArtifactRedacted(value: unknown): void {
  const serialized = JSON.stringify(value);
  const redacted = JSON.stringify(redactArtifact(value));
  if (serialized !== redacted)
    throw new Error('artifact contains unredacted sensitive information');
}
