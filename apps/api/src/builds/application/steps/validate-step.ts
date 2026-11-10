import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { INTEGRATION_BRANCH, isFeatureBranch, parseLineBranch, PRODUCTION_BRANCH } from '../../domain/branches.ts';
import { checkDockerfile } from '../../domain/dockerfile-policy.ts';
import { type Check, failed, failures, passed, type StepOutcome, warning } from '../../domain/pipeline.ts';
import { compareVersions, coreVersion, formatVersion, parseVersion } from '../../domain/versions.ts';
import { VersionHistory } from '../build-records.ts';
import type { BuildSource } from '../ports.ts';
import type { BuildContext, PipelineStep } from './pipeline-step.ts';

/** Checks the version, what asked for the build, and the Dockerfile, before anything is built. */
export class ValidateStep implements PipelineStep {
  readonly key = 'validate';
  readonly #database: TenantDatabase;
  readonly #source: BuildSource;

  constructor(database: TenantDatabase, source: BuildSource) {
    this.#database = database;
    this.#source = source;
  }

  async run(context: BuildContext): Promise<StepOutcome> {
    const checks: Check[] = [...(await this.#versionChecks(context)), ...(await this.#triggerChecks(context))];

    const dockerfile = await context.workspace!.readFile('Dockerfile');
    if (dockerfile === null) {
      checks.push(failed('The repository has a Dockerfile', 'Add a Dockerfile at the top of the repository.'));
    } else {
      checks.push(passed('The repository has a Dockerfile'), ...checkDockerfile(dockerfile));
    }
    checks.push(
      (await context.workspace!.readFile('.dockerignore')) === null
        ? warning(
            'The repository has a .dockerignore file',
            'Without one, every file is sent to the build, which is slower and can put unwanted files in the image.',
          )
        : passed('The repository has a .dockerignore file'),
    );
    const failedCount = failures(checks).length;
    const warnings = checks.filter((check) => check.outcome === 'warning').length;
    const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
    return {
      summary:
        failedCount > 0
          ? `${plural(failedCount, 'check')} failed.`
          : `${plural(checks.length - warnings, 'check')} passed${warnings === 0 ? '' : `, with ${plural(warnings, 'warning')}`}.`,
      checks,
    };
  }

  async #versionChecks(context: BuildContext): Promise<Check[]> {
    const { build } = context;
    const version = parseVersion(build.version);
    if (version === null) {
      return [failed('The version is valid', `${build.version} isn't a semantic version.`)];
    }
    const checks = [passed('The version is valid', `${build.version} is a semantic version and an image tag.`)];
    if (build.kind === 'development') {
      return checks;
    }
    // Releases and their candidates must come after what's on main, so versions only go up.
    const history = await this.#database.transaction((tx) => VersionHistory.load(tx, build.application_id));
    const onMain = history.onMain({ except: build.id });
    const core = parseVersion(coreVersion(version))!;
    if (onMain !== null && compareVersions(core, onMain) <= 0) {
      checks.push(
        failed(
          'The version is newer than the latest release',
          `${coreVersion(version)} isn't newer than ${formatVersion(onMain)}, which is already on ${PRODUCTION_BRANCH}.`,
        ),
      );
    } else {
      checks.push(
        passed(
          'The version is newer than the latest release',
          onMain === null ? 'This is the first release.' : `${coreVersion(version)} comes after ${formatVersion(onMain)}.`,
        ),
      );
    }
    return checks;
  }

  /** Checks that what asked for the build still holds, as the Git tool sees it now. */
  async #triggerChecks(context: BuildContext): Promise<Check[]> {
    const { build, repository } = context;
    if (build.kind === 'development') {
      const pullRequest = await this.#source.pullRequest(repository, build.pull_request!);
      const ownRepository = `${repository.organization}/${repository.name}`;
      return [
        pullRequest?.state === 'open'
          ? passed('The pull request is open', `#${build.pull_request}: ${pullRequest.title}`)
          : failed('The pull request is open', `Pull request #${build.pull_request} was closed before the build started.`),
        isFeatureBranch(build.branch) && pullRequest?.head.repository === ownRepository
          ? passed('It comes from a feature branch of this repository', build.branch)
          : failed('It comes from a feature branch of this repository', `${build.branch} isn't one.`),
        pullRequest?.base.branch === INTEGRATION_BRANCH
          ? passed(`It targets ${INTEGRATION_BRANCH}`)
          : failed(`It targets ${INTEGRATION_BRANCH}`, `It targets ${pullRequest?.base.branch ?? 'nothing'}.`),
      ];
    }
    if (build.kind === 'release') {
      const pullRequest = await this.#source.pullRequest(repository, build.pull_request!);
      const line = parseLineBranch(build.branch);
      return [
        pullRequest?.merged === true && pullRequest.base.branch === PRODUCTION_BRANCH
          ? passed(`The pull request was merged into ${PRODUCTION_BRANCH}`, `#${build.pull_request} merged ${build.branch}.`)
          : failed(
              `The pull request was merged into ${PRODUCTION_BRANCH}`,
              `Pull request #${build.pull_request} isn't merged into ${PRODUCTION_BRANCH}.`,
            ),
        line !== null && formatVersion(line.version) === build.version
          ? passed('The branch is named after the version', build.branch)
          : failed('The branch is named after the version', `${build.branch} doesn't name ${build.version}.`),
        pullRequest?.mergeCommit === build.commit_sha
          ? passed('The commit is the merge commit', build.commit_sha.slice(0, 12))
          : failed('The commit is the merge commit', 'The commit being built isn\'t the one the merge made.'),
      ];
    }
    const branch = await this.#source.branch(repository, build.branch);
    return [
      branch === null
        ? failed('The branch still exists', `${build.branch} was deleted.`)
        : passed('The branch still exists', build.branch),
    ];
  }
}
