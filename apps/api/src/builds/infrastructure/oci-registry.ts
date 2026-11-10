import { createHash } from 'node:crypto';
import { type ImageRegistry, PermanentBuildError, type StoredSignature } from '../application/ports.ts';
import { SIGNATURE_ANNOTATION, SIGNATURE_MEDIA_TYPE, signatureTag } from '../domain/signature.ts';

export interface OciRegistryOptions {
  /** The registry's address, such as http://localhost:3000. */
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
}

const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  OCI_MANIFEST,
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
/** Signatures are small JSON documents. Anything larger isn't one. */
const MAX_SIGNATURE_BLOB = 64 * 1024;

interface Manifest {
  layers?: { mediaType?: string; digest?: string; size?: number; annotations?: Record<string, string> }[];
}

/**
 * Talks to an OCI registry, such as Forgejo's, over the distribution API. It signs in
 * the way Docker does: the registry answers 401 with where to get a token, and the
 * token is fetched with the platform's credentials.
 */
export class OciRegistry implements ImageRegistry {
  readonly host: string;
  readonly #options: OciRegistryOptions;
  readonly #base: string;
  readonly #tokens = new Map<string, string>();

  constructor(options: OciRegistryOptions) {
    this.#options = options;
    const url = new URL(options.url);
    this.host = url.host;
    this.#base = url.origin;
  }

  async digest(repository: string, tag: string): Promise<string> {
    const name = this.#name(repository);
    const path = `/v2/${name}/manifests/${encodeURIComponent(tag)}`;
    const head = await this.#request('HEAD', path, name, { headers: { Accept: MANIFEST_TYPES } });
    await expectOk(head, 'find the published image');
    const digest = head.headers.get('docker-content-digest');
    if (digest !== null && /^sha256:[0-9a-f]{64}$/.test(digest)) {
      return digest;
    }
    // Some registries leave the header out of HEAD answers, so the manifest is hashed instead.
    const get = await this.#request('GET', path, name, { headers: { Accept: MANIFEST_TYPES } });
    await expectOk(get, 'read the published image');
    return `sha256:${createHash('sha256').update(Buffer.from(await get.arrayBuffer())).digest('hex')}`;
  }

  async attachSignature(repository: string, digest: string, signature: StoredSignature): Promise<string> {
    const name = this.#name(repository);
    const tag = signatureTag(digest);
    // Keep signatures already there, as cosign does, so signing twice adds rather than replaces.
    const existing = await this.signatures(repository, digest);
    const all = existing.some(
      (stored) => stored.signature === signature.signature && stored.payload.equals(signature.payload),
    )
      ? existing
      : [...existing, signature];

    const layers = [];
    for (const stored of all) {
      layers.push({
        mediaType: SIGNATURE_MEDIA_TYPE,
        size: stored.payload.length,
        digest: await this.#uploadBlob(name, stored.payload),
        annotations: { [SIGNATURE_ANNOTATION]: stored.signature },
      });
    }
    const config = Buffer.from(
      JSON.stringify({
        architecture: '',
        created: '0001-01-01T00:00:00Z',
        history: [{ created: '0001-01-01T00:00:00Z' }],
        os: '',
        rootfs: { type: 'layers', diff_ids: layers.map((layer) => layer.digest) },
        config: {},
      }),
    );
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: OCI_CONFIG, size: config.length, digest: await this.#uploadBlob(name, config) },
        layers,
      }),
    );
    const response = await this.#request('PUT', `/v2/${name}/manifests/${tag}`, name, {
      headers: { 'Content-Type': OCI_MANIFEST },
      body: manifest,
      push: true,
    });
    await expectOk(response, 'store the signature');
    return tag;
  }

  async signatures(repository: string, digest: string): Promise<StoredSignature[]> {
    const name = this.#name(repository);
    const response = await this.#request('GET', `/v2/${name}/manifests/${signatureTag(digest)}`, name, {
      headers: { Accept: OCI_MANIFEST },
    });
    if (response.status === 404) {
      return [];
    }
    await expectOk(response, 'read the signatures');
    const manifest = (await response.json()) as Manifest;
    const signatures: StoredSignature[] = [];
    for (const layer of manifest.layers ?? []) {
      const value = layer.annotations?.[SIGNATURE_ANNOTATION];
      if (
        layer.mediaType !== SIGNATURE_MEDIA_TYPE ||
        value === undefined ||
        typeof layer.digest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(layer.digest) ||
        (layer.size ?? 0) > MAX_SIGNATURE_BLOB
      ) {
        continue;
      }
      const blob = await this.#request('GET', `/v2/${name}/blobs/${layer.digest}`, name);
      await expectOk(blob, 'read a signature');
      const payload = Buffer.from(await blob.arrayBuffer());
      // The registry could be wrong or tampered with, so the content must match its digest.
      if (payload.length <= MAX_SIGNATURE_BLOB && sha256(payload) === layer.digest) {
        signatures.push({ payload, signature: value });
      }
    }
    return signatures;
  }

  /** Uploads a blob unless the registry has it already, and returns its digest. */
  async #uploadBlob(name: string, content: Buffer): Promise<string> {
    const digest = sha256(content);
    const exists = await this.#request('HEAD', `/v2/${name}/blobs/${digest}`, name, { push: true });
    if (exists.ok) {
      return digest;
    }
    const started = await this.#request('POST', `/v2/${name}/blobs/uploads/`, name, { push: true });
    await expectOk(started, 'start an upload');
    const location = started.headers.get('location');
    if (location === null) {
      throw new Error("The registry didn't say where to upload.");
    }
    const target = new URL(location, this.#base);
    if (target.origin !== this.#base) {
      throw new PermanentBuildError('The registry asked for an upload to another server.');
    }
    target.searchParams.set('digest', digest);
    const finished = await this.#request('PUT', `${target.pathname}${target.search}`, name, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
      push: true,
    });
    await expectOk(finished, 'upload');
    return digest;
  }

  /** The repository's name within the registry: localhost:3000/acme/billing becomes acme/billing. */
  #name(repository: string): string {
    const name = repository.startsWith(`${this.host}/`) ? repository.slice(this.host.length + 1) : '';
    if (!NAME_PATTERN.test(name)) {
      throw new PermanentBuildError(`"${repository}" isn't an image in the platform registry.`);
    }
    return name;
  }

  async #request(
    method: string,
    path: string,
    name: string,
    options: { headers?: Record<string, string>; body?: Buffer; push?: boolean } = {},
  ): Promise<Response> {
    const scope = `repository:${name}:${options.push ? 'pull,push' : 'pull'}`;
    const send = (authorization: string | undefined) =>
      this.#fetch(`${this.#base}${path}`, {
        method,
        headers: { ...options.headers, ...(authorization === undefined ? {} : { Authorization: authorization }) },
        ...(options.body === undefined ? {} : { body: options.body }),
      });

    const cached = this.#tokens.get(scope);
    let response = await send(cached === undefined ? undefined : `Bearer ${cached}`);
    if (response.status !== 401) {
      return response;
    }
    const challenge = response.headers.get('www-authenticate') ?? '';
    await response.body?.cancel();
    if (/^basic/i.test(challenge)) {
      return send(`Basic ${this.#basic()}`);
    }
    const token = await this.#token(challenge, scope);
    this.#tokens.set(scope, token);
    response = await send(`Bearer ${token}`);
    return response;
  }

  /** Fetches a token from where the registry's challenge says, as the Docker token spec describes. */
  async #token(challenge: string, scope: string): Promise<string> {
    const parameters = new Map(
      [...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1]!.toLowerCase(), match[2]!]),
    );
    const realm = parameters.get('realm');
    if (!/^bearer/i.test(challenge) || realm === undefined) {
      throw new PermanentBuildError("The registry asked for a sign-in the platform doesn't support.");
    }
    const url = new URL(realm);
    // The platform's password goes only to the registry's own server.
    if (url.origin !== this.#base) {
      throw new PermanentBuildError('The registry asked for a sign-in at another server.');
    }
    const service = parameters.get('service');
    if (service !== undefined) {
      url.searchParams.set('service', service);
    }
    url.searchParams.set('scope', scope);
    const response = await this.#fetch(url.toString(), { headers: { Authorization: `Basic ${this.#basic()}` } });
    await expectOk(response, 'sign in');
    const body = (await response.json()) as { token?: unknown; access_token?: unknown };
    const token = typeof body.token === 'string' ? body.token : body.access_token;
    if (typeof token !== 'string' || token === '') {
      throw new Error("The registry didn't hand out a token.");
    }
    return token;
  }

  #basic(): string {
    return Buffer.from(`${this.#options.username}:${this.#options.password}`).toString('base64');
  }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(this.#options.timeoutMs ?? 60_000) });
    } catch {
      throw new Error('The image registry could not be reached.');
    }
  }
}

function sha256(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function expectOk(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return;
  }
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) {
    throw new PermanentBuildError(`The registry refused the platform's credentials to ${action}.`);
  }
  throw new Error(`The registry could not ${action} (status ${response.status}).`);
}
