/** The Forgejo teams in each company's organization. Every team covers every repository. */
export type TeamKey = 'developers' | 'tech-leads' | 'readers';

export interface TeamDefinition {
  readonly key: TeamKey;
  readonly description: string;
  readonly permission: 'read' | 'write';
}

export const TEAMS: readonly TeamDefinition[] = [
  { key: 'tech-leads', description: 'Push code and approve pull requests. Managed by DreamDevOps.', permission: 'write' },
  { key: 'developers', description: 'Push code and open pull requests. Managed by DreamDevOps.', permission: 'write' },
  { key: 'readers', description: 'Read code. Managed by DreamDevOps.', permission: 'read' },
];

/**
 * The team a member belongs in, from their role's permissions. Approving pull requests
 * comes first, so a Tech Lead isn't also put with the developers.
 */
export function teamFor(permissions: readonly string[]): TeamKey {
  if (permissions.includes('pull-requests:approve')) {
    return 'tech-leads';
  }
  if (permissions.includes('code:push')) {
    return 'developers';
  }
  return 'readers';
}

export interface BranchRule {
  /** A branch name, or a pattern such as release/*. */
  readonly pattern: string;
  /** Who may push directly: nobody, or only the platform bot, which creates release branches. */
  readonly directPush: 'nobody' | 'platform';
  /** Approvals a pull request needs, from the approving team. */
  readonly requiredApprovals: number;
  readonly approvingTeam: TeamKey;
}

export interface GitFlowPolicy {
  readonly defaultBranch: string;
  readonly branches: readonly BranchRule[];
  /** Tag patterns only the platform bot may create, such as version tags. */
  readonly platformTags: readonly string[];
}

/**
 * The branch rules that make Git Flow the only path to production. feature/* branches
 * have no rule, so developers push to them freely. Required test checks are added once
 * the build step can run them.
 */
export const GIT_FLOW: GitFlowPolicy = {
  defaultBranch: 'develop',
  branches: [
    { pattern: 'main', directPush: 'nobody', requiredApprovals: 1, approvingTeam: 'tech-leads' },
    { pattern: 'develop', directPush: 'nobody', requiredApprovals: 1, approvingTeam: 'tech-leads' },
    { pattern: 'release/*', directPush: 'platform', requiredApprovals: 1, approvingTeam: 'tech-leads' },
    { pattern: 'hotfix/*', directPush: 'platform', requiredApprovals: 1, approvingTeam: 'tech-leads' },
  ],
  platformTags: ['v*'],
};

export interface TeamChange {
  readonly team: TeamKey;
  readonly username: string;
}

/**
 * The changes that bring the teams in line with the company's members. Anyone in a
 * team who shouldn't be is removed, including people added by hand in Forgejo.
 */
export function planTeamChanges(
  desired: ReadonlyMap<string, TeamKey>,
  current: ReadonlyMap<TeamKey, readonly string[]>,
): { add: TeamChange[]; remove: TeamChange[] } {
  const add: TeamChange[] = [];
  const remove: TeamChange[] = [];
  for (const { key } of TEAMS) {
    const members = new Set((current.get(key) ?? []).map((name) => name.toLowerCase()));
    for (const username of members) {
      if (desired.get(username) !== key) {
        remove.push({ team: key, username });
      }
    }
    for (const [username, team] of desired) {
      if (team === key && !members.has(username)) {
        add.push({ team: key, username });
      }
    }
  }
  return { add, remove };
}
