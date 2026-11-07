/** A domain event made from a Forgejo webhook, before it's tied to an application. */
export interface TranslatedEvent {
  readonly eventType: 'CodePushed' | 'BranchCreated' | 'BranchDeleted' | 'PullRequestUpdated' | 'PullRequestMerged';
  readonly payload: Readonly<Record<string, unknown>>;
}

const NO_COMMIT = /^0+$/;
const COMMIT = /^[0-9a-f]{40,64}$/;

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
const text = (value: unknown): string | null => (typeof value === 'string' && value.length <= 300 ? value : null);

/** The repository a webhook is about, as organization and name. */
export function repositoryOf(payload: unknown): { organization: string; name: string } | null {
  const repository = record(record(payload)?.repository);
  const fullName = text(repository?.full_name);
  const [organization, name, ...rest] = fullName?.split('/') ?? [];
  return organization && name && rest.length === 0 ? { organization, name } : null;
}

/**
 * Turns a Forgejo webhook into the events other modules react to. Anything else, such
 * as tag pushes, which only the platform makes, is ignored.
 */
export function translate(event: string, payload: unknown): TranslatedEvent[] {
  const body = record(payload);
  if (body === null) {
    return [];
  }
  switch (event) {
    case 'push':
      return translatePush(body);
    case 'create':
    case 'delete':
      return translateRef(event, body);
    case 'pull_request':
      return translatePullRequest(body);
    default:
      return [];
  }
}

function translatePush(body: Json): TranslatedEvent[] {
  const ref = text(body.ref);
  const before = text(body.before);
  const after = text(body.after);
  if (ref === null || !ref.startsWith('refs/heads/') || before === null || after === null) {
    return [];
  }
  const branch = ref.slice('refs/heads/'.length);
  if (NO_COMMIT.test(after)) {
    return [{ eventType: 'BranchDeleted', payload: { branch } }];
  }
  if (!COMMIT.test(after)) {
    return [];
  }
  const pusher = record(body.pusher);
  return [
    {
      eventType: 'CodePushed',
      payload: {
        branch,
        before: NO_COMMIT.test(before) ? null : before,
        after,
        commits: Array.isArray(body.commits) ? body.commits.length : 0,
        // Git usernames are Keycloak user IDs, never names or emails.
        pushedBy: text(pusher?.login) ?? text(pusher?.username),
      },
    },
  ];
}

function translateRef(event: 'create' | 'delete', body: Json): TranslatedEvent[] {
  // Forgejo sends the full reference here, such as refs/heads/feature/x.
  const branch = text(body.ref)?.replace(/^refs\/heads\//, '') ?? null;
  if (body.ref_type !== 'branch' || branch === null || branch === '') {
    return [];
  }
  if (event === 'delete') {
    return [{ eventType: 'BranchDeleted', payload: { branch } }];
  }
  const commit = text(body.sha);
  return [{ eventType: 'BranchCreated', payload: { branch, commit: commit !== null && COMMIT.test(commit) ? commit : null } }];
}

function translatePullRequest(body: Json): TranslatedEvent[] {
  const pull = record(body.pull_request);
  const number = typeof body.number === 'number' ? body.number : pull?.number;
  const head = text(record(pull?.head)?.ref);
  const base = text(record(pull?.base)?.ref);
  if (pull === null || typeof number !== 'number' || head === null || base === null) {
    return [];
  }
  // Opening, reopening or pushing to a pull request needs its newest commit checked.
  const headCommit = text(record(pull.head)?.sha);
  if (
    (body.action === 'opened' || body.action === 'reopened' || body.action === 'synchronized') &&
    headCommit !== null &&
    COMMIT.test(headCommit)
  ) {
    return [{ eventType: 'PullRequestUpdated', payload: { number, head, base, headCommit } }];
  }
  const mergeCommit = text(pull.merge_commit_sha);
  if (body.action === 'closed' && pull.merged === true && mergeCommit !== null && COMMIT.test(mergeCommit)) {
    return [{ eventType: 'PullRequestMerged', payload: { number, head, base, mergeCommit } }];
  }
  return [];
}
