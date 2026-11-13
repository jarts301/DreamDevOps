import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signaturePayload, signatureTag, signPayload, verifyPayload } from '../src/builds/domain/cosign.ts';
import { ForgejoPipelineHost, PIPELINE_FILE, PIPELINE_REPOSITORY } from '../src/builds/infrastructure/forgejo-pipeline-host.ts';
import { OciRegistry } from '../src/builds/infrastructure/oci-registry.ts';
import { ForgejoGitProvider } from '../src/tenancy/infrastructure/forgejo-git-provider.ts';

const BOT = { username: 'test-bot', password: 'fake-dummy-bot-password' };
const ADMIN = { username: 'test-admin', password: 'fake-dummy-admin-password' };
const COSIGN = 'gcr.io/projectsigstore/cosign@sha256:68839b7f13dac5a6744a5d8818e984dd39183374e37855c19e14d623d9bc9037';

/** A tar file in the ustar format, enough for an OCI image layout. */
function tar(files: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

const digestOf = (content: Buffer) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
const blob = (content: Buffer) => [`blobs/sha256/${digestOf(content).slice(7)}`, content] as const;

/** A one-layer image in the OCI layout BuildKit writes. */
function ociArchive(settings: object = {}): { archive: Buffer; manifest: Buffer } {
  const layerTar = tar({ 'hello.txt': Buffer.from('hello from a test image\n') });
  const layer = gzipSync(layerTar);
  const config = Buffer.from(
    JSON.stringify({
      architecture: 'amd64',
      os: 'linux',
      rootfs: { type: 'layers', diff_ids: [digestOf(layerTar)] },
      config: settings,
    }),
  );
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: digestOf(config), size: config.length },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: digestOf(layer), size: layer.length }],
    }),
  );
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: digestOf(manifest), size: manifest.length }],
    }),
  );
  return {
    manifest,
    archive: tar({
      'oci-layout': Buffer.from('{"imageLayoutVersion":"1.0.0"}'),
      'index.json': index,
      ...Object.fromEntries([blob(config), blob(layer), blob(manifest)]),
    }),
  };
}

describe('the registry and pipeline adapters against a real Forgejo', () => {
  let network: StartedNetwork;
  let forgejo: StartedTestContainer;
  let url: string;
  let registry: OciRegistry;
  let folder: string;

  const api = (path: string, init: { method?: string; body?: object } = {}) =>
    fetch(`${url}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });

  /** Runs the real cosign verify, on the same network as Forgejo. */
  const cosignVerify = (image: string, publicKey: string) => {
    writeFileSync(join(folder, 'cosign.pub'), publicKey);
    return spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        network.getName(),
        '-v',
        `${folder}:/keys:ro`,
        COSIGN,
        'verify',
        '--key',
        '/keys/cosign.pub',
        '--insecure-ignore-tlog=true',
        '--allow-insecure-registry=true',
        '--allow-http-registry=true',
        '--registry-username',
        BOT.username,
        '--registry-password',
        BOT.password,
        image,
      ],
      { encoding: 'utf8' },
    );
  };

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'registry-test-'));
    network = await new Network().start();
    forgejo = await new GenericContainer('codeberg.org/forgejo/forgejo:15.0.11')
      .withNetwork(network)
      .withNetworkAliases('forgejo')
      .withEnvironment({
        FORGEJO__security__INSTALL_LOCK: 'true',
        FORGEJO__service__DISABLE_REGISTRATION: 'true',
        FORGEJO__service__DEFAULT_ALLOW_CREATE_ORGANIZATION: 'false',
        // The registry names this address in its sign-in challenge, so cosign on the network can follow it.
        FORGEJO__server__ROOT_URL: 'http://forgejo:3000/',
      })
      .withExposedPorts(3000)
      .withWaitStrategy(Wait.forHttp('/api/healthz', 3000))
      .withStartupTimeout(120_000)
      .start();
    url = `http://${forgejo.getHost()}:${forgejo.getMappedPort(3000)}`;
    for (const [user, admin] of [
      [ADMIN, true],
      [BOT, false],
    ] as const) {
      const result = await forgejo.exec(
        [
          'forgejo',
          'admin',
          'user',
          'create',
          '--config',
          '/data/gitea/conf/app.ini',
          ...(admin ? ['--admin'] : []),
          '--username',
          user.username,
          '--password',
          user.password,
          '--email',
          `${user.username}@example.com`,
          '--must-change-password=false',
        ],
        { user: 'git' },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Creating ${user.username} failed: ${result.output}`);
      }
    }
    await api(`/admin/users/${BOT.username}`, {
      method: 'PATCH',
      body: { login_name: BOT.username, source_id: 0, allow_create_organization: true },
    });
    await new ForgejoGitProvider({ url, ...BOT }).ensureOrganization({
      name: 'acme',
      displayName: 'Acme',
      companyId: '00000000-0000-4000-8000-0000000000c1',
    });
    registry = new OciRegistry({ url, imageHost: 'forgejo:3000', ...BOT });
  }, 240_000);

  afterAll(async () => {
    await forgejo?.stop();
    await network?.stop();
    rmSync(folder, { recursive: true, force: true });
  });

  it('pushes an image, and a Cosign signature that the real cosign verifies', async () => {
    const { archive, manifest } = ociArchive();
    const file = join(folder, 'image.tar');
    writeFileSync(file, archive);

    const digest = await registry.pushArchive(file, 'acme/hello', '1.0.0');
    expect(digest).toBe(digestOf(manifest));
    // Pushing again changes nothing.
    await expect(registry.pushArchive(file, 'acme/hello', '1.0.0')).resolves.toBe(digest);

    const keys = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const payload = signaturePayload('forgejo:3000/acme/hello', digest);
    await registry.pushSignature('acme/hello', digest, payload, signPayload(keys.privateKey, payload));

    const verified = cosignVerify(`forgejo:3000/acme/hello@${digest}`, keys.publicKey);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain(digest);
    // The platform reads it back as cosign does, and gets what it stored.
    const stored = await registry.readSignature('acme/hello', digest);
    expect(stored?.payload).toEqual(payload);
    expect(verifyPayload(keys.publicKey, stored!.payload, stored!.signature)).toBe(true);
    await expect(registry.readSignature('acme/hello', `sha256:${'0'.repeat(64)}`)).resolves.toBeNull();

    const other = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(cosignVerify(`forgejo:3000/acme/hello@${digest}`, other.publicKey).status).not.toBe(0);
  }, 180_000);

  it("reads an image's user, health check and ports before it's pushed", async () => {
    const file = join(folder, 'settings.tar');
    writeFileSync(
      file,
      ociArchive({
        User: 'node',
        Healthcheck: { Test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:8080/health || exit 1'] },
        ExposedPorts: { '8080/tcp': {} },
      }).archive,
    );
    await expect(registry.inspectArchive(file)).resolves.toMatchObject({
      user: 'node',
      healthcheck: true,
      exposedPorts: ['8080/tcp'],
    });

    writeFileSync(file, ociArchive({ Healthcheck: { Test: ['NONE'] } }).archive);
    await expect(registry.inspectArchive(file)).resolves.toMatchObject({ user: '', healthcheck: false, exposedPorts: [] });
  });

  it('deletes a tag', async () => {
    const { archive } = ociArchive();
    const file = join(folder, 'image.tar');
    writeFileSync(file, archive);
    const digest = await registry.pushArchive(file, 'acme/hello', 'feature-gone-1234567');
    const keys = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const payload = signaturePayload('forgejo:3000/acme/hello', digest);
    await registry.pushSignature('acme/hello', digest, payload, signPayload(keys.privateKey, payload));
    const listed = async () =>
      ((await (await api('/packages/acme?type=container')).json()) as { version: string }[]).map((version) => version.version);
    expect(await listed()).toContain(signatureTag(digest));

    for (const tag of ['feature-gone-1234567', signatureTag(digest)]) {
      await registry.deleteTag('acme/hello', tag);
      await registry.deleteTag('acme/hello', tag);
    }

    expect(await listed()).not.toContain('feature-gone-1234567');
    expect(await listed()).not.toContain(signatureTag(digest));
  });

  it('keeps the pipeline repository holding exactly the platform pipeline, and starts runs', async () => {
    const pipelines = new ForgejoPipelineHost({ url, ...BOT });

    const workflows = (build: string) => ({ 'build.yaml': build, 'check.yaml': 'name: check\n' });
    await pipelines.ensurePipeline('acme', workflows('name: image\n# first\n'));
    await pipelines.ensurePipeline('acme', workflows('name: image\n# first\n'));
    await pipelines.ensurePipeline('acme', workflows('name: image\n# second\n'));

    const read = async (path: string) => {
      const response = await api(`/repos/acme/${PIPELINE_REPOSITORY}/contents/${path}?ref=main`);
      return Buffer.from(((await response.json()) as { content: string }).content, 'base64').toString();
    };
    expect(await read(PIPELINE_FILE)).toBe('name: image\n# second\n');
    expect(await read('.forgejo/workflows/check.yaml')).toBe('name: check\n');
    const repository = (await (await api(`/repos/acme/${PIPELINE_REPOSITORY}`)).json()) as { private: boolean };
    expect(repository.private).toBe(true);
  });
});
