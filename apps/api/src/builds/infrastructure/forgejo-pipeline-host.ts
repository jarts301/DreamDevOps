import type { PipelineHost } from '../application/ports.ts';

export const PIPELINE_REPOSITORY = 'dreamdevops-pipeline';
export const PIPELINE_FOLDER = '.forgejo/workflows';
export const PIPELINE_FILE = `${PIPELINE_FOLDER}/build.yaml`;
const MARKER = 'The DreamDevOps image pipeline. Managed by DreamDevOps; changes are overwritten.';

export interface ForgejoPipelineOptions {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

/**
 * Keeps a pipeline repository in each company's organization, owned by the bot. No
 * team has access to it, so nobody in the company can change the pipeline.
 */
export class ForgejoPipelineHost implements PipelineHost {
  readonly #options: ForgejoPipelineOptions;

  constructor(options: ForgejoPipelineOptions) {
    this.#options = { ...options, url: options.url.replace(/\/$/, '') };
  }

  async ensurePipeline(organization: string, workflows: Readonly<Record<string, string>>): Promise<void> {
    const repository = `/repos/${encodeURIComponent(organization)}/${PIPELINE_REPOSITORY}`;
    let response = await this.#request('GET', repository);
    if (response.status === 404) {
      const created = await this.#request('POST', `/orgs/${encodeURIComponent(organization)}/repos`, {
        name: PIPELINE_REPOSITORY,
        description: MARKER,
        private: true,
        auto_init: true,
        default_branch: 'main',
      });
      if (created.status !== 409) {
        await expectOk(created, 'create the pipeline repository');
      }
      response = await this.#request('GET', repository);
    }
    await expectOk(response, 'read the pipeline repository');
    if (((await response.json()) as { description: string }).description !== MARKER) {
      throw new Error(`A repository named ${PIPELINE_REPOSITORY} exists but isn't the platform's.`);
    }

    for (const [name, workflow] of Object.entries(workflows)) {
      await this.#ensureFile(repository, `${PIPELINE_FOLDER}/${name}`, workflow);
    }
  }

  async #ensureFile(repository: string, path: string, workflow: string): Promise<void> {
    const content = Buffer.from(workflow).toString('base64');
    const current = await this.#request('GET', `${repository}/contents/${path}?ref=main`);
    if (current.status === 404) {
      await expectOk(
        await this.#request('POST', `${repository}/contents/${path}`, {
          branch: 'main',
          content,
          message: `Add the DreamDevOps ${path} workflow`,
        }),
        'add the pipeline',
      );
      return;
    }
    await expectOk(current, 'read the pipeline');
    const file = (await current.json()) as { sha: string; content: string };
    if (Buffer.from(file.content, 'base64').toString('utf8') !== workflow) {
      await expectOk(
        await this.#request('PUT', `${repository}/contents/${path}`, {
          branch: 'main',
          content,
          sha: file.sha,
          message: `Update the DreamDevOps ${path} workflow`,
        }),
        'update the pipeline',
      );
    }
  }

  async run(organization: string, workflow: string, inputs: Readonly<Record<string, string>>): Promise<void> {
    const response = await this.#request(
      'POST',
      `/repos/${encodeURIComponent(organization)}/${PIPELINE_REPOSITORY}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      { ref: 'main', inputs },
    );
    await expectOk(response, 'start the pipeline');
  }

  async #request(method: string, path: string, body?: object): Promise<Response> {
    const credentials = Buffer.from(`${this.#options.username}:${this.#options.password}`).toString('base64');
    try {
      return await fetch(`${this.#options.url}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('The Git service could not be reached.');
    }
  }
}

async function expectOk(response: Response, action: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`The Git service could not ${action} (status ${response.status}).`);
  }
}
