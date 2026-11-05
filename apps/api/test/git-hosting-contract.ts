import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type GitHosting, ProvisioningError } from '../src/tenancy/application/ports.ts';

export interface GitHostingHarness {
  readonly hosting: GitHosting;
  /** Creates an account that isn't an organization, so an organization can't take its name. */
  addAccount(name: string): Promise<void>;
  /** The organization's display name as Git hosting stores it, or null if there is none. */
  displayNameOf(name: string): Promise<string | null>;
  /** Adds a repository to an organization, with commits of someone's own. */
  addRepository(organization: string, repository: string): Promise<void>;
  /** A repository's topics, or null if there is no repository. */
  topicsOf(organization: string, repository: string): Promise<readonly string[] | null>;
  /** A file on a repository's main branch, or null if there is none. */
  fileOf(organization: string, repository: string, path: string): Promise<string | null>;
}

let counter = 0;
/** A new name per test, so tests against a shared Git hosting don't meet. */
const newName = () => {
  counter += 1;
  return `contract-${Date.now().toString(36)}-${counter}`;
};

/** Every GitHosting must pass these, so the fake can't drift from Forgejo. */
export function describeGitHostingContract(name: string, getHarness: () => GitHostingHarness): void {
  describe(`GitHosting contract: ${name}`, () => {
    it('creates an organization for a company', async () => {
      const { hosting, displayNameOf } = getHarness();
      const orgName = newName();

      const organization = await hosting.ensureOrganization({
        name: orgName,
        displayName: 'Acme Corporation',
        companyId: randomUUID(),
      });

      expect(organization.name).toBe(orgName);
      expect(organization.url).toMatch(new RegExp(`/${orgName}$`));
      await expect(displayNameOf(orgName)).resolves.toBe('Acme Corporation');
    });

    it('can be asked again for the same company without harm', async () => {
      const { hosting } = getHarness();
      const request = { name: newName(), displayName: 'Acme', companyId: randomUUID() };

      const first = await hosting.ensureOrganization(request);
      const second = await hosting.ensureOrganization(request);

      expect(second).toEqual(first);
    });

    it("updates the organization's display name", async () => {
      const { hosting, displayNameOf } = getHarness();
      const request = { name: newName(), displayName: 'Acme', companyId: randomUUID() };
      await hosting.ensureOrganization(request);

      await hosting.ensureOrganization({ ...request, displayName: 'Acme Renamed' });

      await expect(displayNameOf(request.name)).resolves.toBe('Acme Renamed');
    });

    it("refuses another company's organization", async () => {
      const { hosting, displayNameOf } = getHarness();
      const orgName = newName();
      await hosting.ensureOrganization({ name: orgName, displayName: 'Owner', companyId: randomUUID() });

      await expect(
        hosting.ensureOrganization({ name: orgName, displayName: 'Intruder', companyId: randomUUID() }),
      ).rejects.toBeInstanceOf(ProvisioningError);
      await expect(displayNameOf(orgName)).resolves.toBe('Owner');
    });

    it("erases a company's organization, and can be asked again", async () => {
      const { hosting, displayNameOf } = getHarness();
      const request = { name: newName(), displayName: 'Acme', companyId: randomUUID() };
      await hosting.ensureOrganization(request);

      await hosting.eraseOrganization(request);
      await hosting.eraseOrganization(request);

      await expect(displayNameOf(request.name)).resolves.toBeNull();
    });

    it('erases nothing of an organization that belongs to someone else', async () => {
      const { hosting, displayNameOf } = getHarness();
      const orgName = newName();
      await hosting.ensureOrganization({ name: orgName, displayName: 'Owner', companyId: randomUUID() });

      await hosting.eraseOrganization({ name: orgName, companyId: randomUUID() });

      await expect(displayNameOf(orgName)).resolves.toBe('Owner');
    });

    it('treats an organization that never existed as erased', async () => {
      const { hosting } = getHarness();

      await expect(hosting.eraseOrganization({ name: newName(), companyId: randomUUID() })).resolves.toBeUndefined();
    });

    it('refuses to erase an organization that still has repositories', async () => {
      const { hosting, displayNameOf, addRepository } = getHarness();
      const request = { name: newName(), displayName: 'Acme', companyId: randomUUID() };
      await hosting.ensureOrganization(request);
      await addRepository(request.name, 'website');

      await expect(hosting.eraseOrganization(request)).rejects.toBeInstanceOf(ProvisioningError);
      await expect(displayNameOf(request.name)).resolves.toBe('Acme');
    });

    it('creates a repository with a first commit, adds the starting files once, and erases it', async () => {
      const { hosting, fileOf, topicsOf } = getHarness();
      const organization = newName();
      await hosting.ensureOrganization({ name: organization, displayName: 'Acme', companyId: randomUUID() });
      const request = { organization, name: 'billing-api', description: 'Bills customers.', topics: ['typescript-backend'] };

      const created = await hosting.ensureRepository(request);
      expect(created.name).toBe('billing-api');
      expect(created.url).toMatch(new RegExp(`/${organization}/billing-api$`));
      // Git hosting made the first commit, so the repository is never empty.
      await expect(fileOf(organization, 'billing-api', 'README.md')).resolves.not.toBeNull();

      const files = [
        { path: 'README.md', content: '# Billing API\n' },
        { path: 'src/about.json', content: '{ "name": "Billing API" }\n' },
        { path: 'src/app/main.ts', content: 'console.log("hello");\n' },
      ];
      await expect(hosting.addInitialFiles({ organization, repository: 'billing-api', files, message: 'Start' })).resolves.toBe(
        'added',
      );
      await expect(
        hosting.addInitialFiles({
          organization,
          repository: 'billing-api',
          files: [{ path: 'README.md', content: 'Replaced\n' }],
          message: 'Again',
        }),
      ).resolves.toBe('skipped');

      await expect(fileOf(organization, 'billing-api', 'README.md')).resolves.toBe('# Billing API\n');
      await expect(fileOf(organization, 'billing-api', 'src/app/main.ts')).resolves.toBe('console.log("hello");\n');

      // Asking again finds it, and brings its topics up to date.
      await expect(hosting.ensureRepository({ ...request, topics: ['typescript-backend', 'nestjs'] })).resolves.toEqual(created);
      await expect(topicsOf(organization, 'billing-api')).resolves.toEqual(['typescript-backend', 'nestjs']);

      await hosting.eraseRepository({ organization, name: 'billing-api' });
      await hosting.eraseRepository({ organization, name: 'billing-api' });
      await expect(topicsOf(organization, 'billing-api')).resolves.toBeNull();
      // With its repository gone, the organization can go too.
      await hosting.eraseOrganization({ name: organization, companyId: 'x' });
    });

    it('leaves a repository someone has committed to as it is', async () => {
      const { hosting, fileOf, addRepository } = getHarness();
      const organization = newName();
      await hosting.ensureOrganization({ name: organization, displayName: 'Acme', companyId: randomUUID() });
      await addRepository(organization, 'theirs');
      const before = await fileOf(organization, 'theirs', 'README.md');

      await hosting.ensureRepository({ organization, name: 'theirs', description: 'x', topics: [] });
      await expect(
        hosting.addInitialFiles({
          organization,
          repository: 'theirs',
          files: [{ path: 'README.md', content: 'Ours\n' }],
          message: 'Start',
        }),
      ).resolves.toBe('skipped');

      await expect(fileOf(organization, 'theirs', 'README.md')).resolves.toBe(before);
    });

    it('refuses a name an account already uses', async () => {
      const { hosting, addAccount } = getHarness();
      const orgName = newName();
      await addAccount(orgName);

      await expect(
        hosting.ensureOrganization({ name: orgName, displayName: 'Acme', companyId: randomUUID() }),
      ).rejects.toBeInstanceOf(ProvisioningError);
    });
  });
}
