import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ImageDetails } from '../domain/image-rules.ts';

const BLOCK = 512;

interface Entry {
  readonly offset: number;
  readonly size: number;
}

/** The part of an OCI image configuration the platform's rules look at. */
interface ContainerConfig {
  readonly User?: string;
  readonly Healthcheck?: { readonly Test?: readonly string[] };
  readonly ExposedPorts?: Readonly<Record<string, unknown>>;
}

export interface Descriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
}

/**
 * Reads an OCI image layout from a tar file, as BuildKit's type=oci output writes it,
 * without unpacking it. Blobs are read straight from their place in the file.
 */
export class OciArchive {
  readonly #file: string;
  readonly #entries: ReadonlyMap<string, Entry>;

  private constructor(file: string, entries: ReadonlyMap<string, Entry>) {
    this.#file = file;
    this.#entries = entries;
  }

  static async open(file: string): Promise<OciArchive> {
    const handle = await open(file, 'r');
    try {
      return new OciArchive(file, await indexEntries(handle));
    } finally {
      await handle.close();
    }
  }

  /** The top manifest or index the archive holds. */
  async root(): Promise<Descriptor> {
    const index = JSON.parse((await this.#read('index.json')).toString('utf8')) as { manifests?: Descriptor[] };
    const root = index.manifests?.[0];
    if (root === undefined || index.manifests!.length !== 1) {
      throw new InvalidArchiveError('The image archive must hold exactly one image.');
    }
    return root;
  }

  /**
   * The image's settings, from its configuration, and its size. For an index of several
   * platforms, the first image's, as they're built from the same Dockerfile.
   */
  async details(): Promise<ImageDetails> {
    let descriptor = await this.root();
    let manifest = JSON.parse((await this.blob(descriptor)).toString('utf8')) as {
      config?: Descriptor;
      layers?: Descriptor[];
      manifests?: Descriptor[];
    };
    if (manifest.manifests !== undefined) {
      descriptor = manifest.manifests.find((child) => !child.mediaType.includes('index')) ?? manifest.manifests[0]!;
      manifest = JSON.parse((await this.blob(descriptor)).toString('utf8')) as typeof manifest;
    }
    if (manifest.config === undefined) {
      throw new InvalidArchiveError('The image has no configuration.');
    }
    const config = (JSON.parse((await this.blob(manifest.config)).toString('utf8')) as { config?: ContainerConfig }).config ?? {};
    const healthcheck = config.Healthcheck?.Test ?? [];
    return {
      user: config.User ?? '',
      // A health check of NONE turns off one set by a base image.
      healthcheck: healthcheck.length > 0 && healthcheck[0] !== 'NONE',
      exposedPorts: Object.keys(config.ExposedPorts ?? {}).sort(),
      sizeBytes: (manifest.layers ?? []).reduce((total, layer) => total + layer.size, manifest.config.size),
    };
  }

  /** A small blob, such as a manifest, checked against its digest. */
  async blob(descriptor: Descriptor): Promise<Buffer> {
    const content = await this.#read(blobPath(descriptor.digest));
    const actual = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (actual !== descriptor.digest) {
      throw new InvalidArchiveError(`A blob doesn't match its digest ${descriptor.digest}.`);
    }
    return content;
  }

  /** A blob as a stream, for layers that may be large. */
  blobStream(descriptor: Descriptor): Readable {
    const entry = this.#entry(blobPath(descriptor.digest));
    if (entry.size !== descriptor.size) {
      throw new InvalidArchiveError(`A blob isn't the size its manifest says.`);
    }
    return createReadStream(this.#file, { start: entry.offset, end: entry.offset + entry.size - 1 });
  }

  async #read(name: string): Promise<Buffer> {
    const entry = this.#entry(name);
    if (entry.size > 16 * 1024 * 1024) {
      throw new InvalidArchiveError(`${name} is too large to read whole.`);
    }
    const handle = await open(this.#file, 'r');
    try {
      const buffer = Buffer.alloc(entry.size);
      await handle.read(buffer, 0, entry.size, entry.offset);
      return buffer;
    } finally {
      await handle.close();
    }
  }

  #entry(name: string): Entry {
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      throw new InvalidArchiveError(`The image archive has no ${name}.`);
    }
    return entry;
  }
}

export class InvalidArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArchiveError';
  }
}

function blobPath(digest: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (match === null) {
    throw new InvalidArchiveError(`${digest} is not a sha256 digest.`);
  }
  return `blobs/sha256/${match[1]}`;
}

/** Lists a tar file's regular files, with where each one's data starts. */
async function indexEntries(handle: FileHandle): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  const { size: total } = await handle.stat();
  const header = Buffer.alloc(BLOCK);
  let position = 0;
  let longName: string | null = null;

  while (position + BLOCK <= total) {
    await handle.read(header, 0, BLOCK, position);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const size = parseInt(field(header, 124, 12) || '0', 8);
    const type = String.fromCharCode(header[156]!);
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const dataStart = position + BLOCK;
    longName = null;

    if (type === 'x' || type === 'L') {
      const data = Buffer.alloc(size);
      await handle.read(data, 0, size, dataStart);
      longName = type === 'L' ? data.toString('utf8').replace(/\0.*$/s, '') : paxPath(data);
    } else if (type === '0' || type === '\0') {
      entries.set(name.replace(/^\.\//, ''), { offset: dataStart, size });
    }
    position = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

function field(header: Buffer, start: number, length: number): string {
  return header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '').trim();
}

/** A pax header's path, which names the next entry when it's too long for the header. */
function paxPath(data: Buffer): string | null {
  for (const record of data.toString('utf8').split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match !== null) {
      return match[1]!;
    }
  }
  return null;
}

/** Turns a Node stream into one fetch can send. */
export function toWebStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}
