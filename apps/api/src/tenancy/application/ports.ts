export const GIT_HOSTING = Symbol('GIT_HOSTING');
export const APPLICATION_TYPES = Symbol('APPLICATION_TYPES');

/** The kinds of application a company can register. The Application Catalog provides them. */
export interface ApplicationTypes {
  has(key: string): boolean;
  /** The scaffolds an application of the type can start from, or none. */
  scaffoldsOf(key: string): readonly { readonly key: string; readonly name: string }[];
}

export const SCAFFOLD_RENDERER = Symbol('SCAFFOLD_RENDERER');

export interface RepositoryFile {
  /** Relative to the repository's root, with "/" between folders. */
  readonly path: string;
  readonly content: string;
}

/** Makes a scaffold's files for one application. The Application Catalog provides it. */
export interface ScaffoldRenderer {
  render(
    key: string,
    variables: { readonly name: string; readonly slug: string; readonly description: string },
  ): Promise<readonly RepositoryFile[]>;
}

export interface GitOrganizationRequest {
  /** The company's slug. */
  readonly name: string;
  /** The company's name. */
  readonly displayName: string;
  /** Recorded on the organization, so a retry recognizes one it created itself. */
  readonly companyId: string;
}

export interface GitOrganization {
  readonly name: string;
  readonly url: string;
}

/** Where companies keep their code. Forgejo today. */
export interface GitHosting {
  /**
   * Creates the company's private organization, or brings one it created before up to
   * date. Safe to call any number of times.
   *
   * Throws ProvisioningError when trying again can't help, and anything else when it might.
   */
  ensureOrganization(request: GitOrganizationRequest): Promise<GitOrganization>;

  /**
   * Deletes the organization DreamDevOps created for the company. An organization that
   * is already gone, or that belongs to someone else, needs nothing, so that's success.
   * Safe to call any number of times.
   *
   * Throws ProvisioningError while the organization still has repositories, so code is
   * never deleted without someone choosing to, and anything else when trying again might help.
   */
  eraseOrganization(request: GitOrganizationErasure): Promise<void>;

  /**
   * Creates a private repository in the organization, with a first commit on main so it's
   * never empty, or finds the one already there. Either way, it sets the repository's
   * topics. Safe to call any number of times.
   */
  ensureRepository(request: GitRepositoryRequest): Promise<GitRepository>;

  /**
   * Adds the files to main as one commit, replacing any Git hosting made with the
   * repository, such as its README. It does this only while the repository has just its
   * first commit, so it never changes code someone has added, and calling it again does no harm.
   */
  addInitialFiles(request: GitInitialFiles): Promise<'added' | 'skipped'>;

  /** Deletes a repository. One that's already gone needs nothing. */
  eraseRepository(request: { readonly organization: string; readonly name: string }): Promise<void>;
}

export interface GitRepositoryRequest {
  readonly organization: string;
  /** The application's slug. */
  readonly name: string;
  readonly description: string;
  /** Shown in Git hosting, such as the application's type and scaffold. */
  readonly topics: readonly string[];
}

export interface GitRepository {
  readonly name: string;
  readonly url: string;
}

export interface GitInitialFiles {
  readonly organization: string;
  readonly repository: string;
  readonly files: readonly RepositoryFile[];
  readonly message: string;
}

export interface GitOrganizationErasure {
  readonly name: string;
  /** Only an organization recorded as this company's is deleted. */
  readonly companyId: string;
}

/**
 * Provisioning can't succeed until someone changes something, such as a name that is
 * already taken. The message is safe to show to a Platform Admin.
 */
export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningError';
  }
}
