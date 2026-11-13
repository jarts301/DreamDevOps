import { createHash } from 'node:crypto';
import type { ImageRegistry } from '../application/ports.ts';
import type { ImageDetails } from '../domain/image-rules.ts';
import { SIGNATURE_ANNOTATION, SIGNATURE_MEDIA_TYPE, signatureTag } from '../domain/cosign.ts';
import { type Descriptor, OciArchive, toWebStream } from './oci-archive.ts';

export interface RegistryOptions {
  /** Where the API reaches the registry, such as http://localhost:3000. */
  readonly url: string;
  /** The host images are known by, such as localhost:3000. */
  readonly imageHost: string;
  readonly username: string;
  readonly password: string;
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
];

/**
 * Pushes images and Cosign signatures to Forgejo's container registry, with the bot's
 * account. Builds never get these credentials: the platform pushes for them.
 */
export class OciRegistry implements ImageRegistry {
  readonly #options: RegistryOptions;
  readonly imageHost: string;

  constructor(options: RegistryOptions) {
    this.#options = { ...options, url: options.url.replace(/\/$/, '') };
    this.imageHost = options.imageHost;
  }

  async pushArchive(file: string, repository: string, tag: string): Promise<string> {
    const archive = await OciArchive.open(file);
    const token = await this.#token(repository);
    return this.#pushManifest(archive, repository, await archive.root(), tag, token);
  }

  async inspectArchive(file: string): Promise<ImageDetails> {
    return (await OciArchive.open(file)).details();
  }

  async readSignature(repository: string, digest: string): Promise<{ payload: Buffer; signature: string } | null> {
    const token = await this.#token(repository);
    const response = await fetch(`${this.#options.url}/v2/${repository}/manifests/${signatureTag(digest)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.manifest.v1+json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) {
      return null;
    }
    await expectOk(response, 'read the signature');
    const manifest = (await response.json()) as {
      layers?: { mediaType: string; digest: string; annotations?: Record<string, string> }[];
    };
    const layer = manifest.layers?.find((candidate) => candidate.mediaType === SIGNATURE_MEDIA_TYPE);
    const signature = layer?.annotations?.[SIGNATURE_ANNOTATION];
    if (layer === undefined || signature === undefined) {
      return null;
    }
    const blob = await fetch(`${this.#options.url}/v2/${repository}/blobs/${layer.digest}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    await expectOk(blob, 'read the signed payload');
    const payload = Buffer.from(await blob.arrayBuffer());
    // The registry is trusted to store, not to answer truthfully: the payload must be what its digest says.
    return sha256(payload) === layer.digest ? { payload, signature } : null;
  }

  async pushSignature(repository: string, digest: string, payload: Buffer, signature: string): Promise<void> {
    const token = await this.#token(repository);
    const payloadDigest = sha256(payload);
    const config = Buffer.from(
      JSON.stringify({
        architecture: '',
        created: '0001-01-01T00:00:00Z',
        history: [{ created: '0001-01-01T00:00:00Z' }],
        os: '',
        rootfs: { type: 'layers', diff_ids: [payloadDigest] },
        config: {},
      }),
    );
    await this.#pushBlob(repository, sha256(config), config, token);
    await this.#pushBlob(repository, payloadDigest, payload, token);
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', size: config.length, digest: sha256(config) },
        layers: [
          {
            mediaType: SIGNATURE_MEDIA_TYPE,
            size: payload.length,
            digest: payloadDigest,
            annotations: { [SIGNATURE_ANNOTATION]: signature },
          },
        ],
      }),
    );
    await this.#putManifest(repository, signatureTag(digest), manifest, 'application/vnd.oci.image.manifest.v1+json', token);
  }

  async deleteTag(repository: string, tag: string): Promise<void> {
    const [owner, name] = repository.split('/');
    const credentials = Buffer.from(`${this.#options.username}:${this.#options.password}`).toString('base64');
    const response = await fetch(
      `${this.#options.url}/api/v1/packages/${encodeURIComponent(owner!)}/container/${encodeURIComponent(name!)}/${encodeURIComponent(tag)}`,
      { method: 'DELETE', headers: { Authorization: `Basic ${credentials}` }, signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`The registry could not delete the image (status ${response.status}).`);
    }
  }

  async #pushManifest(
    archive: OciArchive,
    repository: string,
    descriptor: Descriptor,
    reference: string,
    token: string,
  ): Promise<string> {
    const bytes = await archive.blob(descriptor);
    const manifest = JSON.parse(bytes.toString('utf8')) as {
      mediaType?: string;
      config?: Descriptor;
      layers?: Descriptor[];
      manifests?: Descriptor[];
    };
    if (manifest.manifests !== undefined) {
      for (const child of manifest.manifests) {
        await this.#pushManifest(archive, repository, child, child.digest, token);
      }
    } else {
      for (const blob of [manifest.config!, ...(manifest.layers ?? [])]) {
        await this.#pushBlobStream(repository, blob, archive, token);
      }
    }
    const mediaType = manifest.mediaType ?? descriptor.mediaType;
    if (!MANIFEST_TYPES.includes(mediaType)) {
      throw new Error(`The image has an unsupported manifest type: ${mediaType}.`);
    }
    return this.#putManifest(repository, reference, bytes, mediaType, token);
  }

  async #pushBlobStream(repository: string, blob: Descriptor, archive: OciArchive, token: string): Promise<void> {
    if (await this.#hasBlob(repository, blob.digest, token)) {
      return;
    }
    const location = await this.#startUpload(repository, token);
    const response = await fetch(withDigest(location, blob.digest), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(blob.size),
      },
      body: toWebStream(archive.blobStream(blob)),
      duplex: 'half',
      signal: AbortSignal.timeout(600_000),
    } as RequestInit);
    await expectOk(response, 'upload an image layer');
  }

  async #pushBlob(repository: string, digest: string, content: Buffer, token: string): Promise<void> {
    if (await this.#hasBlob(repository, digest, token)) {
      return;
    }
    const location = await this.#startUpload(repository, token);
    const response = await fetch(withDigest(location, digest), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: content,
      signal: AbortSignal.timeout(60_000),
    });
    await expectOk(response, 'upload a blob');
  }

  async #hasBlob(repository: string, digest: string, token: string): Promise<boolean> {
    const response = await fetch(`${this.#options.url}/v2/${repository}/blobs/${digest}`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok;
  }

  async #startUpload(repository: string, token: string): Promise<string> {
    const response = await fetch(`${this.#options.url}/v2/${repository}/blobs/uploads/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    await expectOk(response, 'start an upload');
    const location = response.headers.get('location');
    if (location === null) {
      throw new Error('The registry did not say where to upload.');
    }
    return this.#sameOrigin(location);
  }

  async #putManifest(
    repository: string,
    reference: string,
    bytes: Buffer,
    mediaType: string,
    token: string,
  ): Promise<string> {
    const response = await fetch(`${this.#options.url}/v2/${repository}/manifests/${reference}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mediaType },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    });
    await expectOk(response, 'store the image manifest');
    const digest = sha256(bytes);
    const reported = response.headers.get('docker-content-digest');
    if (reported !== null && reported !== digest) {
      throw new Error('The registry stored a different manifest than was sent.');
    }
    return digest;
  }

  /** Signs in to the registry as the bot, following its token challenge. */
  async #token(repository: string): Promise<string> {
    const challenge = await fetch(`${this.#options.url}/v2/`, { signal: AbortSignal.timeout(30_000) });
    const header = challenge.headers.get('www-authenticate') ?? '';
    const realm = /realm="([^"]+)"/.exec(header)?.[1];
    if (realm === undefined) {
      throw new Error('The registry did not ask for a sign-in the platform understands.');
    }
    const service = /service="([^"]+)"/.exec(header)?.[1] ?? '';
    const url = new URL(this.#sameOrigin(realm));
    url.searchParams.set('service', service);
    url.searchParams.set('scope', `repository:${repository}:pull,push`);
    const credentials = Buffer.from(`${this.#options.username}:${this.#options.password}`).toString('base64');
    const response = await fetch(url, { headers: { Authorization: `Basic ${credentials}` }, signal: AbortSignal.timeout(30_000) });
    await expectOk(response, 'sign in');
    const body = (await response.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (token === undefined) {
      throw new Error('The registry did not return a token.');
    }
    return token;
  }

  /** The registry names its own public address in links; requests go to the configured one. */
  #sameOrigin(link: string): string {
    const target = new URL(link, this.#options.url);
    const base = new URL(this.#options.url);
    target.protocol = base.protocol;
    target.host = base.host;
    return target.toString();
  }
}

function withDigest(location: string, digest: string): string {
  const url = new URL(location);
  url.searchParams.set('digest', digest);
  return url.toString();
}

function sha256(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function expectOk(response: Response, action: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`The registry could not ${action} (status ${response.status}).`);
  }
}
