import type { ImageDetails } from '../domain/image-rules.ts';

export const IMAGE_REGISTRY = Symbol('IMAGE_REGISTRY');
export const PIPELINE_HOST = Symbol('PIPELINE_HOST');

/** Where images are stored, by repository such as company/application. */
export interface ImageRegistry {
  /** The host images are known by, such as localhost:3000. */
  readonly imageHost: string;
  /** Pushes an OCI image layout tar file under a tag. Returns the manifest digest. */
  pushArchive(file: string, repository: string, tag: string): Promise<string>;
  /** Reads an OCI image layout tar file's settings, such as its user and health check, before it's pushed. */
  inspectArchive(file: string): Promise<ImageDetails>;
  /** Stores a Cosign signature next to the image it signs. */
  pushSignature(repository: string, digest: string, payload: Buffer, signature: string): Promise<void>;
  /** Reads back the Cosign signature stored for an image, or null if there's none. */
  readSignature(repository: string, digest: string): Promise<{ payload: Buffer; signature: string } | null>;
  deleteTag(repository: string, tag: string): Promise<void>;
}

/** Runs the platform's pipeline in a company's CI. */
export interface PipelineHost {
  /** Keeps the company's pipeline repository holding exactly the platform's workflows, by file name. */
  ensurePipeline(organization: string, workflows: Readonly<Record<string, string>>): Promise<void>;
  /** Starts one run of a workflow, such as build.yaml. */
  run(organization: string, workflow: string, inputs: Readonly<Record<string, string>>): Promise<void>;
}
