import { Logger } from '@nestjs/common';
import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { RepositoryLookup } from '../../source-governance/application/repository-lookup.ts';
import type { CompanyDirectory } from '../../tenancy/application/company-directory.ts';
import type { Builds } from '../application/builds.ts';
import { isValidWebhookSignature, webhookSecret } from '../domain/webhook-signature.ts';
import { type ForgejoPullRequest, toPullRequest } from './forgejo-build-source.ts';

export type WebhookOutcome = 'accepted' | 'ignored' | 'rejected';

export interface WebhookDelivery {
  /** From the X-Forgejo-Event header, such as pull_request. */
  readonly event: string | undefined;
  /** From the X-Forgejo-Signature header. */
  readonly signature: string | undefined;
  /** The exact bytes Forgejo signed. */
  readonly body: Buffer;
}

interface Payload {
  repository?: { full_name?: unknown };
  ref?: unknown;
  ref_type?: unknown;
  sha?: unknown;
  action?: unknown;
  pull_request?: ForgejoPullRequest;
}

const FULL_NAME = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;

/**
 * Receives Forgejo's webhooks. Each repository's deliveries are signed with that
 * repository's own secret, so nothing is trusted until the signature checks out. The
 * company then comes from the platform's own record of who owns the repository.
 */
export class ForgejoWebhooks {
  readonly #logger = new Logger(ForgejoWebhooks.name);
  readonly #companies: CompanyDirectory;
  readonly #repositories: RepositoryLookup;
  readonly #builds: Builds;
  readonly #masterSecret: string;

  constructor(companies: CompanyDirectory, repositories: RepositoryLookup, builds: Builds, masterSecret: string) {
    this.#companies = companies;
    this.#repositories = repositories;
    this.#builds = builds;
    this.#masterSecret = masterSecret;
  }

  async receive(delivery: WebhookDelivery): Promise<WebhookOutcome> {
    let payload: Payload;
    try {
      payload = JSON.parse(delivery.body.toString('utf8')) as Payload;
    } catch {
      return 'rejected';
    }
    const fullName = typeof payload.repository?.full_name === 'string' ? FULL_NAME.exec(payload.repository.full_name) : null;
    if (fullName === null) {
      return 'rejected';
    }
    const [, organization, name] = fullName as unknown as [string, string, string];
    if (!isValidWebhookSignature(webhookSecret(this.#masterSecret, organization, name), delivery.body, delivery.signature)) {
      return 'rejected';
    }

    // Each company's Git organization is named after its slug.
    const company = await this.#companies.findBySlug(organization.toLowerCase());
    if (company?.status !== 'active') {
      return 'ignored';
    }
    return runWithCompany(parseCompanyId(company.id), async () => {
      const repository = await this.#repositories.findByName(organization.toLowerCase(), name.toLowerCase());
      if (repository === null) {
        return 'ignored';
      }
      return this.#dispatch(delivery.event, payload, repository.applicationId);
    });
  }

  async #dispatch(event: string | undefined, payload: Payload, applicationId: string): Promise<WebhookOutcome> {
    if (event === 'create' && payload.ref_type === 'branch' && typeof payload.ref === 'string' && typeof payload.sha === 'string') {
      await this.#builds.branchCreated(applicationId, payload.ref.replace(/^refs\/heads\//, ''), payload.sha);
      return 'accepted';
    }
    if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged === true) {
      const pullRequest = toPullRequest(payload.pull_request);
      if (pullRequest !== null) {
        await this.#builds.pullRequestMerged(applicationId, pullRequest);
        return 'accepted';
      }
    }
    this.#logger.debug(`Ignored a ${event ?? 'nameless'} webhook.`);
    return 'ignored';
  }
}
