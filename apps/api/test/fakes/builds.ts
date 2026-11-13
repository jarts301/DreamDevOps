import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ImageRegistry, PipelineHost } from '../../src/builds/application/ports.ts';
import type { ImageDetails } from '../../src/builds/domain/image-rules.ts';

/** Keeps pushed images and signatures in memory. */
export class FakeImageRegistry implements ImageRegistry {
  readonly imageHost = 'registry.test';
  readonly images = new Map<string, string>();
  readonly signatures = new Map<string, { payload: Buffer; signature: string }>();
  readonly deleted: string[] = [];
  failing = false;
  /** The settings every received image has, as its configuration would state them. */
  details: ImageDetails = { user: 'app', healthcheck: true, exposedPorts: ['8080/tcp'], sizeBytes: 1_000 };
  /** Makes the registry give back another signature than it was given, as a broken or tampered one would. */
  tamper = false;

  async pushArchive(file: string, repository: string, tag: string): Promise<string> {
    if (this.failing) {
      throw new Error('The registry is unavailable.');
    }
    const digest = `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`;
    this.images.set(`${repository}:${tag}`, digest);
    return digest;
  }

  async inspectArchive(_file: string): Promise<ImageDetails> {
    return this.details;
  }

  async pushSignature(repository: string, digest: string, payload: Buffer, signature: string): Promise<void> {
    this.signatures.set(`${repository}@${digest}`, { payload, signature });
  }

  async readSignature(repository: string, digest: string): Promise<{ payload: Buffer; signature: string } | null> {
    const stored = this.signatures.get(`${repository}@${digest}`) ?? null;
    return stored !== null && this.tamper ? { payload: stored.payload, signature: Buffer.from('forged').toString('base64') } : stored;
  }

  async deleteTag(repository: string, tag: string): Promise<void> {
    this.images.delete(`${repository}:${tag}`);
    this.deleted.push(`${repository}:${tag}`);
  }
}

/** Records pipeline runs instead of starting them, so tests can play the jobs' part. */
export class FakePipelineHost implements PipelineHost {
  /** Each organization's workflows, by file name. */
  readonly pipelines = new Map<string, Readonly<Record<string, string>>>();
  readonly runs: { organization: string; workflow: string; inputs: Readonly<Record<string, string>> }[] = [];

  async ensurePipeline(organization: string, workflows: Readonly<Record<string, string>>): Promise<void> {
    this.pipelines.set(organization, workflows);
  }

  async run(organization: string, workflow: string, inputs: Readonly<Record<string, string>>): Promise<void> {
    this.runs.push({ organization, workflow, inputs });
  }

  /** The one-time token the platform gave a build's run. */
  tokenOf(buildId: string): string | undefined {
    return this.runs.find((run) => run.inputs.build === buildId)?.inputs.token;
  }
}
