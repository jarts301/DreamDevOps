import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PermanentBuildError } from '../src/builds/application/ports.ts';
import { SIGNATURE_ANNOTATION, SigningKey, signaturePayload, signatureTag } from '../src/builds/domain/signature.ts';
import { buildFailure, DockerImageBuilder } from '../src/builds/infrastructure/docker-image-builder.ts';
import { DirectoryWorkspace, ForgejoBuildSource, insideFolder } from '../src/builds/infrastructure/forgejo-build-source.ts';
import { OciRegistry } from '../src/builds/infrastructure/oci-registry.ts';
import { loadSigningKey } from '../src/builds/infrastructure/signing-key-file.ts';
import { TrivyImageScanner } from '../src/builds/infrastructure/trivy-image-scanner.ts';

const scratch: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreamdevops-test-'));
  scratch.push(directory);
  return directory;
};
afterAll(() => {
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) => {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const sha256 = (content: Buffer) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

/** A registry that signs people in with tokens, as Forgejo's does. */
class FakeRegistryServer {
  readonly blobs = new Map<string, Buffer>();
  readonly manifests = new Map<string, { body: Buffer; type: string }>();
  readonly tokenRequests: string[] = [];
  realm: string | null = null;
  omitDigestHeader = false;
  server!: Server;
  url!: string;

  async start(): Promise<void> {
    const started = await listen((request, response) => this.#handle(request, response));
    this.server = started.server;
    this.url = started.url;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url!, this.url);
    if (url.pathname === '/v2/token') {
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from('bot:fake-dummy-password').toString('base64')}`);
      this.tokenRequests.push(url.searchParams.get('scope') ?? '');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ token: `token-for-${url.searchParams.get('scope')}` }));
      return;
    }
    const scope = request.method === 'GET' || request.method === 'HEAD' ? 'pull' : 'pull,push';
    const name = /^\/v2\/(.+?)\/(manifests|blobs)\//.exec(url.pathname)?.[1];
    const authorized = name !== undefined && request.headers.authorization?.startsWith(`Bearer token-for-repository:${name}:`);
    if (!authorized || (scope === 'pull,push' && !request.headers.authorization!.endsWith('pull,push'))) {
      response.statusCode = 401;
      response.setHeader(
        'WWW-Authenticate',
        `Bearer realm="${this.realm ?? `${this.url}/v2/token`}",service="container_registry",scope="*"`,
      );
      response.end();
      return;
    }
    const manifest = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname);
    const blob = /^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
    if (manifest !== null && (request.method === 'GET' || request.method === 'HEAD')) {
      const stored = this.manifests.get(`${manifest[1]}:${manifest[2]}`);
      if (stored === undefined) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader('Content-Type', stored.type);
      if (!this.omitDigestHeader) {
        response.setHeader('Docker-Content-Digest', sha256(stored.body));
      }
      response.end(request.method === 'HEAD' ? undefined : stored.body);
      return;
    }
    if (manifest !== null && request.method === 'PUT') {
      const body = await readBody(request);
      const parsed = JSON.parse(body.toString()) as { config: { digest: string }; layers: { digest: string }[] };
      // A real registry refuses a manifest whose blobs it doesn't have.
      for (const digest of [parsed.config.digest, ...parsed.layers.map((layer) => layer.digest)]) {
        expect(this.blobs.has(digest)).toBe(true);
      }
      this.manifests.set(`${manifest[1]}:${manifest[2]}`, { body, type: request.headers['content-type']! });
      response.statusCode = 201;
      response.end();
      return;
    }
    if (blob !== null) {
      const stored = this.blobs.get(blob[2]!);
      response.statusCode = stored === undefined ? 404 : 200;
      response.end(request.method === 'HEAD' ? undefined : stored);
      return;
    }
    if (url.pathname.endsWith('/blobs/uploads/') && request.method === 'POST') {
      response.statusCode = 202;
      response.setHeader('Location', `/v2/${name}/blobs/uploads/session-1?state=x`);
      response.end();
      return;
    }
    if (url.pathname.includes('/blobs/uploads/') && request.method === 'PUT') {
      const body = await readBody(request);
      expect(sha256(body)).toBe(url.searchParams.get('digest'));
      expect(url.searchParams.get('state')).toBe('x');
      this.blobs.set(sha256(body), body);
      response.statusCode = 201;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  }
}

describe('the OCI registry client', () => {
  const server = new FakeRegistryServer();
  let registry: OciRegistry;
  let repository: string;
  const digest = `sha256:${'d'.repeat(64)}`;

  beforeAll(async () => {
    await server.start();
    registry = new OciRegistry({ url: server.url, username: 'bot', password: 'fake-dummy-password' });
    repository = `${registry.host}/acme/billing`;
  });
  afterAll(() => close(server.server));
  afterEach(() => {
    server.realm = null;
    server.omitDigestHeader = false;
  });

  it('finds the digest a tag points to, signing in with a token first', async () => {
    const manifest = Buffer.from('{"schemaVersion":2}');
    server.manifests.set('acme/billing:1.0.0', { body: manifest, type: 'application/vnd.oci.image.manifest.v1+json' });

    expect(await registry.digest(repository, '1.0.0')).toBe(sha256(manifest));
    expect(server.tokenRequests).toContain('repository:acme/billing:pull');
    server.omitDigestHeader = true;
    expect(await registry.digest(repository, '1.0.0')).toBe(sha256(manifest));
  });

  it('stores signatures as cosign does, and reads them back', async () => {
    const key = SigningKey.generate().key;
    const payload = signaturePayload(repository, digest);
    const signature = key.sign(payload);

    const tag = await registry.attachSignature(repository, digest, { payload, signature });

    expect(tag).toBe(signatureTag(digest));
    const stored = JSON.parse(server.manifests.get(`acme/billing:${tag}`)!.body.toString());
    expect(stored).toMatchObject({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json' },
      layers: [
        {
          mediaType: 'application/vnd.dev.cosign.simplesigning.v1+json',
          digest: sha256(payload),
          size: payload.length,
          annotations: { [SIGNATURE_ANNOTATION]: signature },
        },
      ],
    });
    expect(JSON.parse(server.blobs.get(stored.config.digest)!.toString()).rootfs.diff_ids).toEqual([sha256(payload)]);
    expect(await registry.signatures(repository, digest)).toEqual([{ payload, signature }]);
  });

  it('keeps earlier signatures, and adds the same one only once', async () => {
    const otherDigest = `sha256:${'e'.repeat(64)}`;
    const first = { payload: signaturePayload(repository, otherDigest), signature: 'first' };
    const second = { payload: signaturePayload(repository, otherDigest), signature: 'second' };

    await registry.attachSignature(repository, otherDigest, first);
    await registry.attachSignature(repository, otherDigest, second);
    await registry.attachSignature(repository, otherDigest, second);

    expect((await registry.signatures(repository, otherDigest)).map((entry) => entry.signature)).toEqual(['first', 'second']);
  });

  it('ignores a signature whose content does not match its digest', async () => {
    const tamperedDigest = `sha256:${'f'.repeat(64)}`;
    const payload = signaturePayload(repository, tamperedDigest);
    await registry.attachSignature(repository, tamperedDigest, { payload, signature: 'sig' });
    server.blobs.set(sha256(payload), Buffer.from('something else'));

    expect(await registry.signatures(repository, tamperedDigest)).toEqual([]);
  });

  it('has no signatures for an image nobody signed', async () => {
    expect(await registry.signatures(repository, `sha256:${'0'.repeat(64)}`)).toEqual([]);
  });

  it('never sends its password to another server', async () => {
    const fresh = new OciRegistry({ url: server.url, username: 'bot', password: 'fake-dummy-password' });
    server.realm = 'http://attacker.test/token';

    await expect(fresh.digest(`${fresh.host}/acme/other`, '1.0.0')).rejects.toThrow(
      'The registry asked for a sign-in at another server.',
    );
  });

  it('refuses names outside the registry', async () => {
    await expect(registry.digest('registry.elsewhere/acme/billing', '1.0.0')).rejects.toThrow(PermanentBuildError);
  });
});

/** A Forgejo with one repository, enough for the build source. */
class FakeForgejoServer {
  readonly branches = new Map<string, string>([['develop', 'a'.repeat(40)]]);
  readonly tags = new Map<string, string>();
  readonly hooks: { id: number; config: { url: string; secret?: string }; events: string[] }[] = [];
  readonly requests: string[] = [];
  archive = Buffer.alloc(0);
  server!: Server;
  url!: string;

  async start(): Promise<void> {
    const started = await listen(async (request, response) => {
      const url = new URL(request.url!, 'http://forgejo.test');
      const path = url.pathname.replace('/api/v1/repos/acme/billing', '');
      this.requests.push(`${request.method} ${url.pathname}`);
      const body = ['POST', 'PATCH'].includes(request.method!) ? JSON.parse((await readBody(request)).toString()) : null;
      const json = (status: number, value: unknown) => {
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(value));
      };
      if (path.startsWith('/branches/')) {
        const name = decodeURIComponent(path.slice('/branches/'.length));
        const commit = this.branches.get(name);
        return commit === undefined ? json(404, {}) : json(200, { name, commit: { id: commit } });
      }
      if (path === '/branches' && request.method === 'POST') {
        if (this.branches.has(body.new_branch_name)) {
          return json(409, {});
        }
        this.branches.set(body.new_branch_name, this.branches.get(body.old_ref_name)!);
        return json(201, {});
      }
      if (path.startsWith('/tags/')) {
        const commit = this.tags.get(decodeURIComponent(path.slice('/tags/'.length)));
        return commit === undefined ? json(404, {}) : json(200, { commit: { sha: commit } });
      }
      if (path === '/tags' && request.method === 'POST') {
        this.tags.set(body.tag_name, body.target);
        return json(201, {});
      }
      if (path.startsWith('/hooks')) {
        if (request.method === 'GET') {
          return json(200, this.hooks.map(({ id, config, events }) => ({ id, config: { url: config.url }, events })));
        }
        if (request.method === 'POST') {
          expect(body.type).toBe('forgejo');
          this.hooks.push({ id: this.hooks.length + 1, config: body.config, events: body.events });
          return json(201, {});
        }
        const hook = this.hooks.find((candidate) => `/hooks/${candidate.id}` === path)!;
        hook.config = body.config;
        return json(200, {});
      }
      if (path === '/pulls/7') {
        return json(200, {
          number: 7,
          title: 'Login',
          state: 'open',
          merged: false,
          merge_commit_sha: null,
          html_url: 'http://forgejo.test/acme/billing/pulls/7',
          user: { login: 'dev' },
          head: { ref: 'feature/login', sha: 'b'.repeat(40), repo: { full_name: 'acme/billing' } },
          base: { ref: 'develop' },
        });
      }
      if (path.startsWith('/pulls/')) {
        return json(404, {});
      }
      if (path.startsWith('/archive/')) {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(this.archive);
        return;
      }
      json(500, {});
    });
    this.server = started.server;
    this.url = started.url;
  }
}

describe('the Forgejo build source', () => {
  const forgejo = new FakeForgejoServer();
  let source: ForgejoBuildSource;
  const repository = { organization: 'acme', name: 'billing' };

  beforeAll(async () => {
    await forgejo.start();
    source = new ForgejoBuildSource({ url: forgejo.url, username: 'bot', password: 'fake-dummy-password' });
  });
  afterAll(() => close(forgejo.server));

  it('creates branches once, keeping slashes in their names', async () => {
    expect(await source.createBranch(repository, 'release/1.0.0', 'develop')).toEqual({ name: 'release/1.0.0', commit: 'a'.repeat(40) });
    expect(await source.createBranch(repository, 'release/1.0.0', 'develop')).toEqual({ name: 'release/1.0.0', commit: 'a'.repeat(40) });
    expect(forgejo.requests).toContain('GET /api/v1/repos/acme/billing/branches/release/1.0.0');
    expect(await source.branch(repository, 'release/9.9.9')).toBeNull();
  });

  it('reads pull requests', async () => {
    expect(await source.pullRequest(repository, 7)).toEqual({
      number: 7,
      title: 'Login',
      state: 'open',
      merged: false,
      mergeCommit: null,
      head: { branch: 'feature/login', commit: 'b'.repeat(40), repository: 'acme/billing' },
      base: { branch: 'develop' },
      url: 'http://forgejo.test/acme/billing/pulls/7',
      author: 'dev',
    });
    expect(await source.pullRequest(repository, 8)).toBeNull();
  });

  it('tags a commit once, and refuses a tag that points elsewhere', async () => {
    const tag = { name: 'v1.0.0', commit: 'c'.repeat(40), message: 'Release 1.0.0' };
    await source.createTag(repository, tag);
    await source.createTag(repository, tag);
    expect(forgejo.tags.get('v1.0.0')).toBe('c'.repeat(40));

    await expect(source.createTag(repository, { ...tag, commit: 'd'.repeat(40) })).rejects.toThrow(
      'The tag v1.0.0 already exists on another commit.',
    );
  });

  it('creates one webhook, and keeps its secret up to date', async () => {
    await source.ensureWebhook(repository, { url: 'http://api.test/hook', secret: 'one' });
    await source.ensureWebhook(repository, { url: 'http://api.test/hook', secret: 'two' });

    expect(forgejo.hooks).toEqual([
      { id: 1, config: { url: 'http://api.test/hook', content_type: 'json', secret: 'two' }, events: ['create', 'pull_request'] },
    ]);
  });

  it('checks out a commit into its own folder, and removes it afterwards', async () => {
    const folder = temporary();
    mkdirSync(join(folder, 'billing-abc'));
    writeFileSync(join(folder, 'billing-abc', 'Dockerfile'), 'FROM scratch\n');
    forgejo.archive = execFileSync('tar', ['-czf', '-', '-C', folder, 'billing-abc']);

    const workspace = await source.checkout(repository, 'e'.repeat(40));

    expect(await workspace.readFile('Dockerfile')).toBe('FROM scratch\n');
    expect(forgejo.requests).toContain(`GET /api/v1/repos/acme/billing/archive/${'e'.repeat(40)}.tar.gz`);
    await workspace.dispose();
    expect(existsSync(workspace.directory)).toBe(false);
    await expect(source.checkout(repository, 'not-a-commit')).rejects.toThrow(PermanentBuildError);
  });

  // GNU tar, which Git for Windows puts on the PATH, reads an archive named C:\Users\…\source.tar.gz
  // as the file \Users\… on a machine called C, and fails with "Cannot connect to C". A
  // temporary folder under a relative folder named C: does the same on any system. Windows
  // can't name a folder C:, but there every checkout above already unpacks from C:\.
  it.skipIf(process.platform === 'win32')(
    'unpacks the source when its folder looks like a remote address to tar, as C:\\… does on Windows',
    async () => {
      const folder = temporary();
      mkdirSync(join(folder, 'billing-abc'));
      writeFileSync(join(folder, 'billing-abc', 'Dockerfile'), 'FROM scratch\n');
      forgejo.archive = execFileSync('tar', ['-czf', '-', '-C', folder, 'billing-abc']);
      mkdirSync(join(folder, 'C:'));
      const cwd = process.cwd();
      const tmpdir = process.env.TMPDIR;
      process.chdir(folder);
      process.env.TMPDIR = 'C:';
      try {
        const workspace = await source.checkout(repository, 'e'.repeat(40));

        expect(workspace.directory.startsWith('C:')).toBe(true);
        expect(await workspace.readFile('Dockerfile')).toBe('FROM scratch\n');
        await workspace.dispose();
      } finally {
        process.chdir(cwd);
        if (tmpdir === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = tmpdir;
        }
      }
    },
  );

  it('refuses an archive larger than allowed', async () => {
    const small = new ForgejoBuildSource({ url: forgejo.url, username: 'bot', password: 'x', maxArchiveBytes: 10 });
    forgejo.archive = Buffer.alloc(1_000);

    await expect(small.checkout(repository, 'e'.repeat(40))).rejects.toThrow('The source is larger than 0 MB.');
  });
});

/**
 * Windows lets only administrators, or people who turned on Developer Mode, create
 * symbolic links. Elsewhere, and there when allowed, links are tested.
 */
const canCreateSymlinks = (() => {
  const folder = temporary();
  try {
    writeFileSync(join(folder, 'target'), '');
    symlinkSync(join(folder, 'target'), join(folder, 'link'));
    return true;
  } catch {
    return false;
  }
})();

describe('a workspace', () => {
  it('reads only regular files inside its folder', async () => {
    const folder = temporary();
    const outside = join(temporary(), 'secret.txt');
    writeFileSync(outside, 'secret');
    writeFileSync(join(folder, 'Dockerfile'), 'FROM scratch');
    writeFileSync(join(folder, 'huge'), Buffer.alloc(2 * 1024 * 1024));
    const workspace = new DirectoryWorkspace(folder);

    expect(await workspace.readFile('Dockerfile')).toBe('FROM scratch');
    expect(await workspace.readFile(outside)).toBeNull();
    expect(await workspace.readFile('../secret.txt')).toBeNull();
    expect(await workspace.readFile('huge')).toBeNull();
    expect(await workspace.readFile('missing')).toBeNull();
    expect(await workspace.readFile('.')).toBeNull();
  });

  it.skipIf(!canCreateSymlinks)('never follows a link out of its folder', async () => {
    const folder = temporary();
    const outside = join(temporary(), 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(folder, 'link'));

    expect(await new DirectoryWorkspace(folder).readFile('link')).toBeNull();
  });

  it('keeps paths inside the folder by the rules of both Windows and other systems', () => {
    expect(insideFolder('/work/source', 'Dockerfile', posix)).toBe('/work/source/Dockerfile');
    expect(insideFolder('/work/source', 'nested/../Dockerfile', posix)).toBe('/work/source/Dockerfile');
    expect(insideFolder('/work/source', '..file', posix)).toBe('/work/source/..file');
    for (const escape of ['..', '../secret', '/etc/passwd', '.']) {
      expect(insideFolder('/work/source', escape, posix)).toBeNull();
    }
    const windows = 'C:\\work\\source';
    expect(insideFolder(windows, 'Dockerfile', win32)).toBe('C:\\work\\source\\Dockerfile');
    // Another drive or a network share has no relative path, so relative() returns it whole.
    for (const escape of ['..\\secret', 'C:\\Windows\\win.ini', 'D:\\secrets\\key.pem', '\\\\server\\share\\file']) {
      expect(insideFolder(windows, escape, win32)).toBeNull();
    }
  });
});

describe('the signing key file', () => {
  it('is created on a developer machine, and reused', () => {
    const path = join(temporary(), 'nested', 'image-signing.key');

    const created = loadSigningKey(path, { createIfMissing: true });

    expect(loadSigningKey(path, { createIfMissing: true }).fingerprint).toBe(created.fingerprint);
    expect(readFileSync(path, 'utf8')).toContain('BEGIN PRIVATE KEY');
  });

  // Windows has no Unix permissions: Node reports every writable file as 0o666, and the
  // folder's access list decides who can read it.
  it.skipIf(process.platform === 'win32')('is readable only by its owner', () => {
    const path = join(temporary(), 'nested', 'image-signing.key');

    loadSigningKey(path, { createIfMissing: true });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('must already exist elsewhere', () => {
    expect(() => loadSigningKey(join(temporary(), 'missing.key'), { createIfMissing: false })).toThrow(
      /doesn't exist\. Set IMAGE_SIGNING_KEY_FILE/,
    );
  });
});

/**
 * A stand-in for the docker command. It records its arguments and any config file it's
 * given, and answers from a script the test writes.
 */
const fakeDocker = (answers: Record<string, { code?: number; stdout?: string; stderr?: string }>) => {
  const folder = temporary();
  const log = join(folder, 'calls.jsonl');
  const script = join(folder, 'docker');
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const entry = { args };
const config = args[0] === '--config' ? args[1] : null;
if (config) entry.config = JSON.parse(fs.readFileSync(config + '/config.json', 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
const command = (config ? args.slice(2) : args).slice(0, 2).join(' ');
const answers = ${JSON.stringify(answers)};
const answer = answers[command] ?? answers[command.split(' ')[0]] ?? {};
if (answer.stdout) process.stdout.write(answer.stdout);
if (answer.stderr) process.stderr.write(answer.stderr);
if (command.startsWith('save')) fs.writeFileSync(args[args.indexOf('--output') + 1], 'tar');
process.exit(answer.code ?? 0);
`,
  );
  chmodSync(script, 0o755);
  const calls = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; config?: { auths: Record<string, { auth: string }> } });
  return { script, calls };
};

describe.skipIf(process.platform === 'win32')('the Docker image builder', () => {
  const registry = { host: 'registry.test', username: 'bot', password: 'fake-dummy-password' };

  it('builds with labels, from the checked-out folder', async () => {
    const docker = fakeDocker({});
    const builder = new DockerImageBuilder({ registry, buildTimeoutMs: 10_000, docker: docker.script });

    await builder.build({ directory: '/src', image: 'dreamdevops-build:abc', labels: { 'org.opencontainers.image.version': '1.0.0' } });

    expect(docker.calls()[0]!.args).toEqual([
      'build',
      '--file',
      join('/src', 'Dockerfile'),
      '--tag',
      'dreamdevops-build:abc',
      '--label',
      'org.opencontainers.image.version=1.0.0',
      '/src',
    ]);
  });

  it('tells a broken Dockerfile apart from a Docker outage', async () => {
    const broken = new DockerImageBuilder({
      registry,
      buildTimeoutMs: 10_000,
      docker: fakeDocker({ build: { code: 1, stderr: 'step 3/5\nnpm ERR! missing script: build\n' } }).script,
    });
    const down = new DockerImageBuilder({
      registry,
      buildTimeoutMs: 10_000,
      docker: fakeDocker({ build: { code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' } }).script,
    });
    const request = { directory: '/src', image: 'dreamdevops-build:abc', labels: {} };

    await expect(broken.build(request)).rejects.toThrow(PermanentBuildError);
    await expect(broken.build(request)).rejects.toThrow("The image didn't build: step 3/5\nnpm ERR! missing script: build");
    const outage = await down.build(request).catch((error: unknown) => error);
    expect(outage).toBeInstanceOf(Error);
    expect(outage).not.toBeInstanceOf(PermanentBuildError);
  });

  it("says why a step failed, from the step's own output, rather than only where", async () => {
    // What BuildKit prints when a RUN step fails: its log, then the step's last lines
    // again, an excerpt of the Dockerfile, and a summary.
    const stderr = [
      '#12 [build 6/6] RUN cargo build --release --locked',
      '#12 0.512     Updating crates.io index',
      '#12 61.20 error: could not compile `zerocopy` (lib)',
      '#12 ERROR: process "/bin/sh -c cargo build --release --locked" did not complete successfully: exit code: 101',
      '------',
      ' > [build 6/6] RUN cargo build --release --locked:',
      '0.512     Updating crates.io index',
      '61.20 error: could not compile `zerocopy` (lib)',
      '61.20 ',
      '61.20 Caused by:',
      '61.20   process didn\'t exit successfully: `rustc --crate-name zerocopy` (signal: 9, SIGKILL: kill)',
      '------',
      'Dockerfile:13',
      '--------------------',
      '  12 |     # Only the versions in Cargo.lock are built, each checked against its checksum.',
      '  13 | >>> RUN cargo build --release --locked',
      '  14 |',
      '--------------------',
      'ERROR: failed to build: failed to solve: process "/bin/sh -c cargo build --release --locked" did not complete successfully: exit code: 101',
    ].join('\n');

    expect(buildFailure(stderr)).toBe(
      [
        '[build 6/6] RUN cargo build --release --locked',
        '    Updating crates.io index',
        'error: could not compile `zerocopy` (lib)',
        'Caused by:',
        "  process didn't exit successfully: `rustc --crate-name zerocopy` (signal: 9, SIGKILL: kill)",
        'ERROR: failed to build: failed to solve: process "/bin/sh -c cargo build --release --locked" did not complete successfully: exit code: 101',
      ].join('\n'),
    );
    const builder = new DockerImageBuilder({ registry, buildTimeoutMs: 10_000, docker: fakeDocker({ build: { code: 1, stderr } }).script });
    await expect(builder.build({ directory: '/src', image: 'dreamdevops-build:abc', labels: {} })).rejects.toThrow(
      "The image didn't build: [build 6/6] RUN cargo build --release --locked\n",
    );
    // Output Docker didn't repeat, such as from an older Docker, is shown as it ends.
    expect(buildFailure('step 3/5\nnpm ERR! missing script: build\n')).toBe('step 3/5\nnpm ERR! missing script: build');
  });

  it('pushes with its own throwaway credentials, only to the platform registry', async () => {
    const docker = fakeDocker({});
    const builder = new DockerImageBuilder({ registry, buildTimeoutMs: 10_000, docker: docker.script });

    await builder.push('dreamdevops-build:abc', 'registry.test/acme/billing:1.0.0');

    const [tag, push] = docker.calls();
    expect(tag!.args).toEqual(['tag', 'dreamdevops-build:abc', 'registry.test/acme/billing:1.0.0']);
    expect(push!.args.slice(2)).toEqual(['push', 'registry.test/acme/billing:1.0.0']);
    expect(push!.config).toEqual({
      auths: { 'registry.test': { auth: Buffer.from('bot:fake-dummy-password').toString('base64') } },
    });
    // The credentials are gone once the push is done.
    expect(existsSync(push!.args[1]!)).toBe(false);
    await expect(builder.push('dreamdevops-build:abc', 'docker.io/someone/billing:1.0.0')).rejects.toThrow(
      'Images can only be published to the platform registry.',
    );
  });

  it('reads the user, health check, size and ports of an image', async () => {
    const inspect = {
      Size: 1_000,
      Config: { User: 'node', Healthcheck: { Test: ['CMD-SHELL', 'wget ...'] }, ExposedPorts: { '8080/tcp': {} } },
    };
    const builder = new DockerImageBuilder({
      registry,
      buildTimeoutMs: 10_000,
      docker: fakeDocker({ 'image inspect': { stdout: JSON.stringify(inspect) } }).script,
    });

    expect(await builder.inspect('dreamdevops-build:abc')).toEqual({
      user: 'node',
      healthcheck: true,
      sizeBytes: 1_000,
      exposedPorts: ['8080/tcp'],
    });
  });

  it('refuses image names that could be read as options', async () => {
    const builder = new DockerImageBuilder({ registry, buildTimeoutMs: 10_000, docker: fakeDocker({}).script });

    await expect(builder.build({ directory: '/src', image: '--privileged', labels: {} })).rejects.toThrow(PermanentBuildError);
  });

  it('explains when Docker is not installed', async () => {
    const builder = new DockerImageBuilder({ registry, buildTimeoutMs: 10_000, docker: '/nonexistent/docker' });

    await expect(builder.inspect('dreamdevops-build:abc')).rejects.toThrow(
      "Docker isn't installed on the machine that runs the API, so images can't be built.",
    );
  });
});

describe.skipIf(process.platform === 'win32')('the Trivy scanner', () => {
  it('hands the image over as a read-only file, and reads the report', async () => {
    const report = { Results: [{ Vulnerabilities: [{ VulnerabilityID: 'CVE-1', PkgName: 'zlib', InstalledVersion: '1', Severity: 'HIGH' }] }] };
    const docker = fakeDocker({ run: { stdout: JSON.stringify(report) } });
    const scanner = new TrivyImageScanner({ image: 'aquasec/trivy:test', timeoutMs: 120_000, docker: docker.script });

    const result = await scanner.scan('dreamdevops-build:abc');

    expect(result.counts.high).toBe(1);
    const [save, run] = docker.calls();
    expect(save!.args.slice(0, 2)).toEqual(['save', '--output']);
    expect(run!.args).toEqual(
      expect.arrayContaining(['run', '--rm', 'aquasec/trivy:test', 'image', '--input', '/scan/image.tar', '--format', 'json']),
    );
    expect(run!.args.find((arg) => arg.includes('target=/scan'))).toMatch(/,readonly$/);
    // The scanner never gets the Docker engine's socket.
    expect(run!.args.join(' ')).not.toContain('docker.sock');
  });
});
