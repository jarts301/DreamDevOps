import { createDomainEvent, currentCompanyId, describeError } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type pg from 'pg';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import type { RepositoryLookup } from '../../source-governance/application/repository-lookup.ts';
import { finishStep } from '../../shared/progress.ts';
import {
  failures,
  initialSteps,
  STEP_NAMES,
  type StepKey,
  type StepOutcome,
  type StepRecord,
} from '../domain/pipeline.ts';
import type { SigningKey } from '../domain/signature.ts';
import { findBuild, readyRepository } from './build-records.ts';
import {
  type BuildSource,
  type ImageBuilder,
  type ImageRegistry,
  type ImageScanner,
  PermanentBuildError,
} from './ports.ts';
import { BuildImageStep } from './steps/build-image-step.ts';
import { CheckoutStep } from './steps/checkout-step.ts';
import { InspectStep } from './steps/inspect-step.ts';
import type { BuildContext, PipelineStep } from './steps/pipeline-step.ts';
import { PublishStep } from './steps/publish-step.ts';
import { ScanStep } from './steps/scan-step.ts';
import { SignStep } from './steps/sign-step.ts';
import { TagStep } from './steps/tag-step.ts';
import { ValidateStep } from './steps/validate-step.ts';
import { VerifyStep } from './steps/verify-step.ts';

/** The queue that runs builds. Each job is one build. */
export const BUILD_QUEUE = 'builds.run';

export interface BuildJob {
  readonly companyId: string;
  readonly buildId: string;
}

export interface BuildPipelineOptions {
  /** Runs before a build is marked as failed. A failed check never runs again. */
  readonly maxAttempts: number;
  /** Forgejo's address in browsers, recorded in each image as where its source lives. */
  readonly sourceUrl: string;
}

export interface PipelineDependencies {
  readonly repositories: RepositoryLookup;
  readonly source: BuildSource;
  readonly builder: ImageBuilder;
  readonly scanner: ImageScanner;
  readonly registry: ImageRegistry;
  readonly key: SigningKey;
}

/**
 * Every step a build can have. Which of them a build runs, and in what order, is up to
 * stepsFor in the domain. To add a step, write it in steps/, add it here, and add its key there.
 */
export function defaultSteps(
  database: TenantDatabase,
  dependencies: PipelineDependencies,
  options: BuildPipelineOptions,
): PipelineStep[] {
  const { source, builder, scanner, registry, key } = dependencies;
  return [
    new CheckoutStep(source),
    new ValidateStep(database, source),
    new BuildImageStep(builder, options.sourceUrl),
    new InspectStep(builder),
    new ScanStep(scanner),
    new PublishStep(builder, registry, database),
    new SignStep(registry, key),
    new VerifyStep(registry, key),
    new TagStep(source),
  ];
}

/** A check failed, or something else means trying again can't help. */
class StepFailed extends Error {
  readonly outcome: StepOutcome;

  constructor(summary: string, outcome: StepOutcome = {}) {
    super(summary);
    this.name = 'StepFailed';
    this.outcome = { ...outcome, summary };
  }
}

/**
 * Runs a build's steps in order: get the source, validate it, build, check and scan the
 * image, publish it, sign it, verify the signature and, for a release, tag it in Git.
 * Progress is saved after every step, so people can follow it.
 *
 * A failed check stops the build for good. Anything else, such as an unreachable
 * registry, is tried again from the start, so a retry never relies on anything the
 * last attempt left behind.
 */
export class BuildPipeline {
  readonly #database: TenantDatabase;
  readonly #pool: pg.Pool;
  readonly #catalog: ApplicationCatalog;
  readonly #repositories: RepositoryLookup;
  readonly #builder: ImageBuilder;
  readonly #registry: ImageRegistry;
  readonly #options: BuildPipelineOptions;
  readonly #steps: ReadonlyMap<StepKey, PipelineStep>;

  constructor(
    database: TenantDatabase,
    pool: pg.Pool,
    catalog: ApplicationCatalog,
    dependencies: PipelineDependencies,
    options: BuildPipelineOptions,
  ) {
    this.#database = database;
    this.#pool = pool;
    this.#catalog = catalog;
    this.#repositories = dependencies.repositories;
    this.#builder = dependencies.builder;
    this.#registry = dependencies.registry;
    this.#options = options;
    this.#steps = new Map(defaultSteps(database, dependencies, options).map((step) => [step.key, step]));
  }

  /**
   * Runs one build, in its company. Throws to have the job tried again later. Only one
   * worker runs a build at a time: the lock is held by a database session, so it's
   * released if the worker dies.
   */
  async run(buildId: string): Promise<void> {
    const client = await this.#pool.connect();
    const lockKey = `builds:run:${buildId}`;
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [lockKey],
      );
      if (!rows[0]?.locked) {
        return;
      }
      try {
        await this.#run(buildId);
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
      }
    } finally {
      client.release();
    }
  }

  async #run(buildId: string): Promise<void> {
    const build = await this.#database.transaction((tx) => findBuild(tx, buildId));
    if (build === null || build.status === 'succeeded' || build.status === 'failed') {
      return;
    }
    const application = await this.#catalog.get(build.application_id);
    const repository = await readyRepository(this.#repositories, build.application_id);
    const imageRepository = `${this.#registry.host}/${repository.organization}/${application.slug}`;
    const context: BuildContext = {
      build,
      application,
      repository,
      imageRepository,
      image: `${imageRepository}:${build.version}`,
      localImage: `dreamdevops-build:${build.id}`,
      workspace: null,
      digest: null,
    };

    const steps: StepRecord[] = initialSteps(build.kind);
    const attempt = await this.#start(build.id, steps);
    let current = 0;
    try {
      for (; current < steps.length; current += 1) {
        const key = steps[current]!.key;
        steps[current] = { ...steps[current]!, status: 'running', startedAt: new Date().toISOString() };
        await this.#saveSteps(build.id, steps);
        const outcome = await this.#steps.get(key)!.run(context);
        const failing = failures(outcome.checks ?? []);
        if (failing.length > 0) {
          throw new StepFailed(
            outcome.summary ?? (failing.length === 1 ? `Failed: ${failing[0]!.name}.` : `${failing.length} checks failed.`),
            outcome,
          );
        }
        steps[current] = finishStep(steps[current]!, outcome.skipped ? 'skipped' : 'passed', outcome);
        await this.#saveSteps(build.id, steps);
      }
      await this.#succeed(context, steps);
    } catch (error) {
      const permanent = error instanceof StepFailed || error instanceof PermanentBuildError;
      const final = permanent || attempt >= this.#options.maxAttempts;
      const reason = describeError(error);
      const outcome =
        error instanceof StepFailed
          ? error.outcome
          : { summary: final ? reason : `${reason} Trying again (attempt ${attempt} of ${this.#options.maxAttempts}).` };
      const step = steps[current];
      if (step !== undefined) {
        steps[current] = finishStep(step, 'failed', outcome);
      }
      await this.#fail(context, steps, step?.key ?? null, reason, final);
      if (!final) {
        throw error;
      }
    } finally {
      await context.workspace?.dispose().catch(() => {});
      await this.#builder.remove([context.localImage, context.image]).catch(() => {});
    }
  }

  /** Marks the build as running, from the first step, and returns which attempt this is. */
  async #start(buildId: string, steps: readonly StepRecord[]): Promise<number> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<{ attempts: number }>(
        `UPDATE builds.builds
         SET status = 'running', attempts = attempts + 1, steps = $2, last_error = NULL,
             started_at = coalesce(started_at, now()), updated_at = now()
         WHERE id = $1
         RETURNING attempts`,
        [buildId, JSON.stringify(steps)],
      );
      return rows[0]!.attempts;
    });
  }

  async #saveSteps(buildId: string, steps: readonly StepRecord[]): Promise<void> {
    await this.#database.transaction((tx) =>
      tx.query('UPDATE builds.builds SET steps = $2, updated_at = now() WHERE id = $1', [buildId, JSON.stringify(steps)]),
    );
  }

  async #succeed(context: BuildContext, steps: readonly StepRecord[]): Promise<void> {
    const { build } = context;
    await this.#database.transaction(async (tx) => {
      await tx.query(
        `UPDATE builds.builds SET status = 'succeeded', steps = $2, finished_at = now(), updated_at = now() WHERE id = $1`,
        [build.id, JSON.stringify(steps)],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'BuildSucceeded',
          companyId: currentCompanyId(),
          payload: {
            buildId: build.id,
            applicationId: build.application_id,
            name: context.application.name,
            kind: build.kind,
            version: build.version,
            image: context.image,
            digest: context.digest,
          },
        }),
      ]);
    });
  }

  async #fail(
    context: BuildContext,
    steps: readonly StepRecord[],
    step: StepKey | null,
    reason: string,
    final: boolean,
  ): Promise<void> {
    const { build } = context;
    await this.#database.transaction(async (tx) => {
      await tx.query(
        `UPDATE builds.builds
         SET status = $2, steps = $3, last_error = $4, finished_at = CASE WHEN $2 = 'failed' THEN now() END,
             updated_at = now()
         WHERE id = $1`,
        [build.id, final ? 'failed' : 'queued', JSON.stringify(steps), reason],
      );
      if (final) {
        await appendToOutbox(tx, [
          createDomainEvent({
            eventType: 'BuildFailed',
            companyId: currentCompanyId(),
            payload: {
              buildId: build.id,
              applicationId: build.application_id,
              name: context.application.name,
              kind: build.kind,
              version: build.version,
              step: step === null ? null : STEP_NAMES[step],
              reason,
            },
          }),
        ]);
      }
    });
  }
}
