import { describe, expect, it } from 'vitest';
import { ProvisioningError } from '../src/tenancy/application/ports.ts';
import { ForgejoGitHosting } from '../src/tenancy/infrastructure/forgejo-git-hosting.ts';

const COMPANY_ID = '4707316c-b477-41ae-b8eb-0ddd1ef86f79';
const REQUEST = { name: 'acme', displayName: 'Acme Corp', companyId: COMPANY_ID };
const MANAGED = `Managed by DreamDevOps for company ${COMPANY_ID}.`;

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | undefined;
}

/** Answers requests in order, as Forgejo would, and records what was asked. */
const forgejo = (...answers: (readonly [number, object?] | Error)[]) => {
  const calls: Call[] = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error(`Unexpected request: ${init.method} ${url}`);
    }
    if (answer instanceof Error) {
      throw answer;
    }
    const [status, body] = answer;
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const hosting = new ForgejoGitHosting({
    url: 'http://git.test/',
    username: 'platform-admin',
    password: 'fake-dummy-token',
    fetch: fetchStub,
  });
  return { hosting, calls };
};

describe('ForgejoGitHosting', () => {
  it('creates a private organization that records its company', async () => {
    const { hosting, calls } = forgejo([404], [201, { full_name: 'Acme Corp' }]);

    const organization = await hosting.ensureOrganization(REQUEST);

    expect(organization).toEqual({ name: 'acme', url: 'http://git.test/acme' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET http://git.test/api/v1/orgs/acme',
      'POST http://git.test/api/v1/orgs',
    ]);
    expect(calls[1]!.body).toEqual({
      username: 'acme',
      full_name: 'Acme Corp',
      description: MANAGED,
      visibility: 'private',
      repo_admin_change_team_access: false,
    });
  });

  it('signs every request in with the configured account', async () => {
    const { hosting, calls } = forgejo([404], [201, {}]);

    await hosting.ensureOrganization(REQUEST);

    const expected = `Basic ${Buffer.from('platform-admin:fake-dummy-token').toString('base64')}`;
    expect(calls.every((call) => call.headers['Authorization'] === expected)).toBe(true);
  });

  it('takes over an organization it created before, without changing anything', async () => {
    const { hosting, calls } = forgejo([200, { full_name: 'Acme Corp', description: MANAGED }]);

    await expect(hosting.ensureOrganization(REQUEST)).resolves.toEqual({ name: 'acme', url: 'http://git.test/acme' });

    expect(calls).toHaveLength(1);
  });

  it("brings its organization's display name up to date", async () => {
    const { hosting, calls } = forgejo([200, { full_name: 'Old Name', description: MANAGED }], [200, {}]);

    await hosting.ensureOrganization(REQUEST);

    expect(calls[1]).toMatchObject({ method: 'PATCH', url: 'http://git.test/api/v1/orgs/acme' });
    expect(calls[1]!.body).toEqual({ full_name: 'Acme Corp' });
  });

  it("refuses an organization that isn't its own", async () => {
    const { hosting, calls } = forgejo([200, { full_name: 'Someone', description: 'Their own org' }]);

    await expect(hosting.ensureOrganization(REQUEST)).rejects.toThrow(ProvisioningError);
    expect(calls).toHaveLength(1);
  });

  it("refuses another company's organization with the same name", async () => {
    const other = 'Managed by DreamDevOps for company 99999999-b477-41ae-b8eb-0ddd1ef86f79.';
    const { hosting } = forgejo([200, { full_name: 'Acme', description: other }]);

    await expect(hosting.ensureOrganization(REQUEST)).rejects.toThrow(ProvisioningError);
  });

  it.each([409, 422])('reports a name Forgejo refuses with %i as needing someone to act', async (status) => {
    const { hosting } = forgejo([404], [status, { message: 'user already exists [name: acme]' }]);

    const failure = hosting.ensureOrganization(REQUEST);

    await expect(failure).rejects.toThrow(ProvisioningError);
    await expect(failure).rejects.toThrow(
      'Git hosting refused the organization name "acme". It\'s reserved or already used by an account. ' +
        'Free the name in Git hosting and retry, or close this company and create it with another slug.',
    );
  });

  it.each([401, 403])('reports refused credentials (%i) without revealing them', async (status) => {
    const { hosting } = forgejo([status]);

    const failure = hosting.ensureOrganization(REQUEST);

    await expect(failure).rejects.toThrow(ProvisioningError);
    await expect(failure).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining('token') }));
  });

  it.each([500, 502, 503])('treats %i as worth trying again', async (status) => {
    const { hosting } = forgejo([404], [status]);

    const failure = hosting.ensureOrganization(REQUEST);

    await expect(failure).rejects.toThrow(`Forgejo answered ${status} to POST /orgs.`);
    await expect(failure).rejects.not.toBeInstanceOf(ProvisioningError);
  });

  it('treats an unreachable server as worth trying again', async () => {
    const { hosting } = forgejo(new TypeError('fetch failed'));

    const failure = hosting.ensureOrganization(REQUEST);

    await expect(failure).rejects.toThrow('fetch failed');
    await expect(failure).rejects.not.toBeInstanceOf(ProvisioningError);
  });

  it('gives up on a display name it could not update, so it is tried again', async () => {
    const { hosting } = forgejo([200, { full_name: 'Old Name', description: MANAGED }], [500]);

    await expect(hosting.ensureOrganization(REQUEST)).rejects.toThrow('Forgejo answered 500 to PATCH /orgs/:name.');
  });

  it("keeps the organization's name out of errors, which reach logs and job records", async () => {
    const { hosting } = forgejo([503]);

    await expect(hosting.ensureOrganization(REQUEST)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('acme') }),
    );
  });

  describe('repositories', () => {
    const REPOSITORY = {
      organization: 'acme',
      name: 'billing',
      description: 'Bills customers.',
      topics: ['typescript-backend', 'nestjs'],
    };
    const FILES = {
      organization: 'acme',
      repository: 'billing',
      message: 'Start from the DreamDevOps NestJS scaffold',
      files: [
        { path: 'README.md', content: '# Billing\n' },
        { path: 'src/main.ts', content: 'console.log("ü");\n' },
      ],
    };
    const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

    it('creates a private repository whose first commit Forgejo makes, and sets its topics', async () => {
      const { hosting, calls } = forgejo([404], [201, { empty: false }], [204]);

      await expect(hosting.ensureRepository(REPOSITORY)).resolves.toEqual({
        name: 'billing',
        url: 'http://git.test/acme/billing',
      });
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        'GET http://git.test/api/v1/repos/acme/billing',
        'POST http://git.test/api/v1/orgs/acme/repos',
        'PUT http://git.test/api/v1/repos/acme/billing/topics',
      ]);
      expect(calls[1]!.body).toEqual({
        name: 'billing',
        description: 'Bills customers.',
        private: true,
        auto_init: true,
        readme: 'Default',
        default_branch: 'main',
      });
      expect(calls[2]!.body).toEqual({ topics: ['typescript-backend', 'nestjs'] });
    });

    it('finds a repository that is already there, and brings its topics up to date', async () => {
      const { hosting, calls } = forgejo([200, {}], [204]);

      await hosting.ensureRepository(REPOSITORY);

      expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    });

    it('finds a repository someone made at the same moment', async () => {
      const { hosting } = forgejo([404], [409], [204]);

      await expect(hosting.ensureRepository(REPOSITORY)).resolves.toMatchObject({ name: 'billing' });
    });

    it('reports a name Forgejo refuses as needing someone to act', async () => {
      const { hosting } = forgejo([404], [422]);

      await expect(hosting.ensureRepository(REPOSITORY)).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('adds the files as one commit, replacing the README Forgejo made', async () => {
      const { hosting, calls } = forgejo(
        [200, [{ sha: 'first' }]],
        [200, [{ path: 'README.md', sha: 'readme-sha', type: 'file' }, { path: 'docs', sha: 'tree', type: 'dir' }]],
        [201, { commit: { sha: 'second' } }],
      );

      await expect(hosting.addInitialFiles(FILES)).resolves.toBe('added');

      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        'GET http://git.test/api/v1/repos/acme/billing/commits?sha=main&limit=2&stat=false&verification=false&files=false',
        'GET http://git.test/api/v1/repos/acme/billing/contents?ref=main',
        'POST http://git.test/api/v1/repos/acme/billing/contents',
      ]);
      expect(calls[2]!.body).toEqual({
        branch: 'main',
        message: 'Start from the DreamDevOps NestJS scaffold',
        author: { name: 'DreamDevOps', email: 'noreply@dreamdevops.invalid' },
        committer: { name: 'DreamDevOps', email: 'noreply@dreamdevops.invalid' },
        files: [
          { operation: 'update', path: 'README.md', content: base64('# Billing\n'), sha: 'readme-sha' },
          { operation: 'create', path: 'src/main.ts', content: base64('console.log("ü");\n') },
        ],
      });
    });

    it('leaves a repository with commits of its own as it is', async () => {
      const { hosting, calls } = forgejo([200, [{ sha: 'theirs' }, { sha: 'first' }]]);

      await expect(hosting.addInitialFiles(FILES)).resolves.toBe('skipped');
      expect(calls).toHaveLength(1);
    });

    it('creates every file in a repository Forgejo says has no commits', async () => {
      const { hosting, calls } = forgejo([409, { message: 'Git Repository is empty.' }], [201]);

      await expect(hosting.addInitialFiles(FILES)).resolves.toBe('added');
      expect((calls[1]!.body as { files: { operation: string }[] }).files.map((file) => file.operation)).toEqual([
        'create',
        'create',
      ]);
    });

    it('treats files another run added at the same moment as added', async () => {
      const { hosting } = forgejo([200, [{}]], [200, []], [422], [200, [{}, {}]]);

      await expect(hosting.addInitialFiles(FILES)).resolves.toBe('skipped');
    });

    it('reports files Forgejo refuses as needing someone to act', async () => {
      const { hosting } = forgejo([200, [{}]], [200, []], [422], [200, [{}]]);

      await expect(hosting.addInitialFiles(FILES)).rejects.toThrow(
        new ProvisioningError("Git hosting refused the application's starting files."),
      );
    });

    it('treats a failure to add files as worth trying again, without naming the repository', async () => {
      const { hosting } = forgejo([200, [{}]], [200, []], [500]);

      const failure = hosting.addInitialFiles(FILES);

      await expect(failure).rejects.toThrow('Forgejo answered 500 to POST /repos/:owner/:name/contents.');
      await expect(failure).rejects.not.toBeInstanceOf(ProvisioningError);
    });

    it.each([204, 404])('erases a repository, which answers %i', async (status) => {
      const { hosting, calls } = forgejo([status]);

      await hosting.eraseRepository({ organization: 'acme', name: 'billing' });

      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['DELETE http://git.test/api/v1/repos/acme/billing']);
    });
  });

  describe('erasing', () => {
    const ERASURE = { name: 'acme', companyId: COMPANY_ID };

    it('deletes its own organization once it has no repositories', async () => {
      const { hosting, calls } = forgejo([200, { description: MANAGED }], [200, []], [204]);

      await hosting.eraseOrganization(ERASURE);

      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        'GET http://git.test/api/v1/orgs/acme',
        'GET http://git.test/api/v1/orgs/acme/repos?limit=1',
        'DELETE http://git.test/api/v1/orgs/acme',
      ]);
    });

    it('treats an organization that is already gone as erased', async () => {
      const { hosting, calls } = forgejo([404]);

      await hosting.eraseOrganization(ERASURE);

      expect(calls).toHaveLength(1);
    });

    it.each([
      ['someone else', 'Their own org'],
      ['another company', 'Managed by DreamDevOps for company 99999999-b477-41ae-b8eb-0ddd1ef86f79.'],
    ])('never deletes an organization that belongs to %s', async (_owner, description) => {
      const { hosting, calls } = forgejo([200, { description }]);

      await hosting.eraseOrganization(ERASURE);

      expect(calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('keeps an organization that still has repositories, and says so', async () => {
      const { hosting, calls } = forgejo([200, { description: MANAGED }], [200, [{ name: 'website' }]]);

      await expect(hosting.eraseOrganization(ERASURE)).rejects.toThrow(
        new ProvisioningError(
          'The Git organization still has repositories. Delete or move them in Git hosting, then retry.',
        ),
      );
      expect(calls.map((call) => call.method)).not.toContain('DELETE');
    });

    it('treats a failed delete as worth trying again', async () => {
      const { hosting } = forgejo([200, { description: MANAGED }], [200, []], [500]);

      const failure = hosting.eraseOrganization(ERASURE);

      await expect(failure).rejects.toThrow('Forgejo answered 500 to DELETE /orgs/:name.');
      await expect(failure).rejects.not.toBeInstanceOf(ProvisioningError);
    });
  });
});
