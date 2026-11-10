import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { PageActivity } from '../../core/page-activity';
import { SessionService } from '../../core/session.service';
import { type Application, CatalogApi } from '../catalog/catalog.api';
import { buildStatusName, buildTone, isActive, kindName } from './build-labels';
import { BuildProgress } from './build-progress';
import { type Build, BuildsApi, type FeaturePullRequest, type SigningKey, type Versions } from './builds.api';

/** How often the page refreshes while a build is queued or running. */
const REFRESH_MS = 2_000;

/**
 * Each application's versioned images: development images of feature pull requests,
 * release and hotfix candidates, and signed releases, with every build's progress.
 */
@Component({
  selector: 'app-builds',
  imports: [DatePipe, BuildProgress, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Builds</h1>
    <p class="lead">
      Versioned, scanned and signed images of your applications, from feature pull requests, release and hotfix
      branches, and releases merged into main.
    </p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="alert alert-success" role="status">{{ message }}</p>
    }

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else if (applications().length === 0) {
      <p class="empty-state">No application has a repository yet. Register one on the Applications page first.</p>
    } @else {
      <section class="card" aria-labelledby="application-heading">
        <h2 id="application-heading" class="visually-hidden">Application</h2>
        <label class="field-inline">
          <span>Application</span>
          <select [value]="selectedId()" (change)="choose($event)">
            @for (application of applications(); track application.id) {
              <option [value]="application.id" [selected]="application.id === selectedId()">{{ application.name }}</option>
            }
          </select>
        </label>
      </section>

      @if (versions(); as current) {
        <section class="card" aria-labelledby="versions-heading">
          <h2 id="versions-heading">Versions</h2>
          @if (current.onMain === null) {
            <p>Nothing is released yet.</p>
          } @else if (current.published === current.onMain) {
            <p>
              The latest release is <strong>{{ current.onMain }}</strong>, published and signed.
            </p>
          } @else {
            <p>
              Main has <strong>{{ current.onMain }}</strong>, but its image isn't published yet.
              @if (current.published) {
                The latest published release is {{ current.published }}.
              }
            </p>
          }

          @if (current.lines.length > 0) {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">In progress</th>
                    <th scope="col">Latest candidate</th>
                    @if (canRelease()) {
                      <th scope="col"><span class="visually-hidden">Actions</span></th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (line of current.lines; track line.branch) {
                    <tr>
                      <td>
                        {{ line.kind === 'release' ? 'Release' : 'Hotfix' }} {{ line.version }}
                        <p class="cell-note"><code>{{ line.branch }}</code></p>
                      </td>
                      <td>
                        @if (line.latestCandidate; as candidate) {
                          {{ candidate.version }}
                          <span class="status" [attr.data-tone]="buildTone(candidate.status)">
                            {{ buildStatusName(candidate.status) }}
                          </span>
                        } @else {
                          <span class="muted">None</span>
                        }
                      </td>
                      @if (canRelease()) {
                        <td class="cell-actions">
                          <button
                            type="button"
                            class="button"
                            [attr.aria-label]="'Build a new candidate from ' + line.branch"
                            [disabled]="working()"
                            (click)="buildCandidate(line.branch)"
                          >
                            Build new candidate
                          </button>
                        </td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="cell-note">
              Merging a release or hotfix branch into main builds, signs and tags its release.
            </p>
          }

          @if (canRelease()) {
            @let releasing = inProgress(current, 'release');
            @let hotfixing = inProgress(current, 'hotfix');
            <div class="button-row versions-actions">
              @if (!releasing) {
                <button type="button" class="button button-primary" [disabled]="working()" (click)="startRelease('minor')">
                  Start release {{ current.next.minor }}
                </button>
                <button type="button" class="button" [disabled]="working()" (click)="startRelease('major')">
                  Start major release {{ current.next.major }}
                </button>
              }
              @if (current.next.hotfix && !hotfixing) {
                <button type="button" class="button" [disabled]="working()" (click)="startHotfix()">
                  Start hotfix {{ current.next.hotfix }}
                </button>
              }
            </div>
            @if (releasing) {
              <p class="cell-note">Only one release runs at a time. Merge {{ releasing }} into main before starting another.</p>
            }
            @if (hotfixing) {
              <p class="cell-note">Only one hotfix runs at a time. Merge {{ hotfixing }} into main before starting another.</p>
            }
            <p class="cell-note">
              A release branches from develop, and a hotfix from main. Creating the branch builds its first candidate.
            </p>
          }
        </section>
      }

      <section class="card" aria-labelledby="pull-requests-heading">
        <h2 id="pull-requests-heading">Feature pull requests</h2>
        @if (pullRequestsError(); as message) {
          <p class="muted">{{ message }}</p>
        } @else if (pullRequests().length === 0) {
          <p class="muted">No open pull requests from feature branches into develop.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Pull request</th>
                  <th scope="col">Development image</th>
                  @if (canBuildFeatures()) {
                    <th scope="col"><span class="visually-hidden">Actions</span></th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (pullRequest of pullRequests(); track pullRequest.number) {
                  @let latest = latestImageOf(pullRequest);
                  <tr>
                    <td>
                      <a [href]="pullRequest.url" target="_blank" rel="noopener">#{{ pullRequest.number }}</a>
                      {{ pullRequest.title }}
                      <p class="cell-note"><code>{{ pullRequest.branch }}</code></p>
                    </td>
                    <td>
                      @if (latest) {
                        {{ latest.version }}
                        <span class="status" [attr.data-tone]="buildTone(latest.status)">
                          {{ buildStatusName(latest.status) }}
                        </span>
                        @if (latest.commit !== pullRequest.commit) {
                          <p class="cell-note">Newer commits are waiting to be built.</p>
                        }
                      } @else {
                        <span class="muted">None yet</span>
                      }
                    </td>
                    @if (canBuildFeatures()) {
                      <td class="cell-actions">
                        <button
                          type="button"
                          class="button"
                          [attr.aria-label]="'Build a development image of pull request ' + pullRequest.number"
                          [disabled]="working() || (latest !== null && latest.commit === pullRequest.commit && latest.status !== 'failed')"
                          (click)="buildPullRequest(pullRequest)"
                        >
                          Build image
                        </button>
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section class="card" aria-labelledby="builds-heading">
        <h2 id="builds-heading">Builds</h2>
        @if (builds().length === 0) {
          <p class="muted">No builds yet.</p>
        } @else {
          <ul class="build-list">
            @for (build of builds(); track build.id) {
              <li class="build-row">
                <div class="build-row-header">
                  <div>
                    <strong>{{ build.version }}</strong>&ngsp;
                    <span class="status">{{ kindName(build.kind) }}</span>&ngsp;
                    <span class="status" [attr.data-tone]="buildTone(build.status)">{{ buildStatusName(build.status) }}</span>
                    <p class="cell-note">
                      #{{ build.number }} from <code>{{ build.branch }}</code>
                      @if (build.pullRequest !== null) {
                        (pull request #{{ build.pullRequest }})
                      }
                      at <code>{{ build.commit.slice(0, 12) }}</code>,
                      {{ build.createdAt | date: 'medium' }}
                      @if (build.requestedBy?.displayName; as requester) {
                        by {{ requester }}
                      }
                    </p>
                  </div>
                  <div class="button-row">
                    @if (build.status === 'succeeded' && canDeploy()) {
                      <a
                        class="button"
                        routerLink="/environments"
                        [queryParams]="{ application: build.applicationId }"
                        [attr.aria-label]="'Deploy ' + build.version"
                      >
                        Deploy
                      </a>
                    }
                    <button
                      type="button"
                      class="button"
                      [attr.aria-expanded]="isExpanded(build)"
                      [attr.aria-label]="(isExpanded(build) ? 'Hide progress of ' : 'Show progress of ') + build.version"
                      (click)="toggle(build)"
                    >
                      {{ isExpanded(build) ? 'Hide progress' : 'Show progress' }}
                    </button>
                  </div>
                </div>
                @if (isExpanded(build)) {
                  <app-build-progress
                    [build]="build"
                    [canRetry]="canRetry(build)"
                    [working]="working()"
                    (retry)="retry($event)"
                  />
                }
              </li>
            }
          </ul>
        }
      </section>

      @if (signingKey(); as key) {
        <section class="card" aria-labelledby="signing-heading">
          <h2 id="signing-heading">Check signatures yourself</h2>
          <p>
            Every published image is signed with the platform's key, using {{ key.algorithm }}. Save this public key
            as <code>dreamdevops-images.pub</code>, then check any image with cosign.
          </p>
          <p class="cell-note">Key fingerprint: <code>{{ key.fingerprint }}</code></p>
          <details>
            <summary>Public key</summary>
            <pre class="code-block">{{ key.publicKey }}</pre>
          </details>
          <pre class="code-block">cosign verify --key dreamdevops-images.pub --insecure-ignore-tlog=true &lt;image&gt;&#64;&lt;digest&gt;</pre>
        </section>
      }
    }
  `,
})
export class Builds implements OnInit, OnDestroy {
  readonly #api = inject(BuildsApi);
  readonly #catalog = inject(CatalogApi);
  readonly #session = inject(SessionService);
  readonly #route = inject(ActivatedRoute);
  readonly #router = inject(Router);
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;
  #pollFailed = false;

  protected readonly applications = signal<Application[]>([]);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly versions = signal<Versions | null>(null);
  protected readonly builds = signal<Build[]>([]);
  protected readonly pullRequests = signal<FeaturePullRequest[]>([]);
  protected readonly pullRequestsError = signal<string | null>(null);
  protected readonly signingKey = signal<SigningKey | null>(null);
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly loading = signal(true);
  readonly #activity = new PageActivity('clear-on-failure');
  protected readonly working = this.#activity.working;
  protected readonly error = this.#activity.error;
  protected readonly notice = this.#activity.notice;

  protected readonly kindName = kindName;
  protected readonly buildStatusName = buildStatusName;
  protected readonly buildTone = buildTone;
  protected readonly canRelease = computed(() => {
    this.#session.user();
    return this.#session.can('releases:start');
  });
  /** Images are deployed from the Environments page, by people who deploy anywhere. */
  protected readonly canDeploy = computed(() => {
    this.#session.user();
    return this.#session.can('deployments-test:run') || this.#session.can('deployments-production:run');
  });
  protected readonly canBuildFeatures = computed(() => {
    this.#session.user();
    return this.#session.can('feature-images:build');
  });

  async ngOnInit(): Promise<void> {
    await this.#activity.run(async () => {
      const [applications, repositories] = await Promise.all([this.#catalog.list('active'), this.#catalog.repositories()]);
      const ready = new Set(repositories.filter((repository) => repository.status === 'ready').map((repository) => repository.applicationId));
      const buildable = applications.filter((application) => ready.has(application.id));
      this.applications.set(buildable);
      const requested = this.#route.snapshot.queryParamMap.get('application');
      this.selectedId.set(buildable.find((application) => application.id === requested)?.id ?? buildable[0]?.id ?? null);
    });
    this.loading.set(false);
    // The public key isn't needed to use the page, so a failure only hides its card.
    this.#api.signingKey().then(
      (key) => this.signingKey.set(key),
      () => this.signingKey.set(null),
    );
    await this.#open();
  }

  ngOnDestroy(): void {
    this.#destroyed = true;
    clearTimeout(this.#refreshTimer);
  }

  protected async choose(event: Event): Promise<void> {
    const id = (event.target as HTMLSelectElement).value;
    this.selectedId.set(id);
    this.notice.set(null);
    this.expanded.set(new Set());
    await this.#router.navigate([], { queryParams: { application: id }, replaceUrl: true });
    await this.#open();
  }

  protected isExpanded(build: Build): boolean {
    return this.expanded().has(build.id);
  }

  protected toggle(build: Build): void {
    const next = new Set(this.expanded());
    if (!next.delete(build.id)) {
      next.add(build.id);
    }
    this.expanded.set(next);
  }

  protected canRetry(build: Build): boolean {
    return build.kind === 'development' ? this.canBuildFeatures() : this.canRelease();
  }

  /** A pull request's newest development image, from the build list when it's there, so it stays current. */
  protected latestImageOf(pullRequest: FeaturePullRequest): FeaturePullRequest['latestBuild'] {
    const fresh = this.builds().find((build) => build.kind === 'development' && build.pullRequest === pullRequest.number);
    return fresh === undefined
      ? pullRequest.latestBuild
      : { id: fresh.id, version: fresh.version, status: fresh.status, commit: fresh.commit };
  }

  /** The branch of the release or hotfix in progress, if there is one. */
  protected inProgress(versions: Versions, kind: 'release' | 'hotfix'): string | null {
    return versions.lines.find((line) => line.kind === kind)?.branch ?? null;
  }


  protected async startRelease(bump: 'minor' | 'major'): Promise<void> {
    await this.#act(async (applicationId) => {
      const build = await this.#api.startRelease(applicationId, bump);
      return `Release started on ${build.branch}. Its first candidate, ${build.version}, is being built.`;
    });
  }

  protected async startHotfix(): Promise<void> {
    await this.#act(async (applicationId) => {
      const build = await this.#api.startHotfix(applicationId);
      return `Hotfix started on ${build.branch}. Its first candidate, ${build.version}, is being built.`;
    });
  }

  protected async buildCandidate(branch: string): Promise<void> {
    await this.#act(async (applicationId) => {
      const build = await this.#api.buildCandidate(applicationId, branch);
      return `${build.version} is being built from ${branch}.`;
    });
  }

  protected async buildPullRequest(pullRequest: FeaturePullRequest): Promise<void> {
    await this.#act(async (applicationId) => {
      const build = await this.#api.buildPullRequest(applicationId, pullRequest.number);
      return `${build.version} is being built from pull request #${pullRequest.number}.`;
    });
  }

  protected async retry(build: Build): Promise<void> {
    await this.#act(async () => {
      await this.#api.retry(build.id);
      this.expanded.set(new Set([...this.expanded(), build.id]));
      return `${build.version} is being built again.`;
    });
  }

  /** Loads the chosen application, after checking for merges the platform may have missed. */
  async #open(): Promise<void> {
    const applicationId = this.selectedId();
    if (applicationId === null) {
      return;
    }
    // Finding missed merges is a convenience, so a failure here doesn't stop the page.
    await this.#api.sync(applicationId).catch(() => undefined);
    await this.#activity.run(async () => {
      await Promise.all([this.#refresh(), this.#loadPullRequests()]);
      // The newest build is opened, so its progress shows without a click.
      const newest = this.builds()[0];
      if (newest !== undefined && this.expanded().size === 0) {
        this.expanded.set(new Set([newest.id]));
      }
    });
  }

  async #loadPullRequests(): Promise<void> {
    const applicationId = this.selectedId();
    if (applicationId === null) {
      return;
    }
    try {
      this.pullRequests.set(await this.#api.pullRequests(applicationId));
      this.pullRequestsError.set(null);
    } catch (error) {
      this.pullRequests.set([]);
      this.pullRequestsError.set(errorMessage(error));
    }
  }

  /**
   * Reloads builds and versions, and keeps reloading builds while any is queued or running.
   * Versions, which ask the Git tool about branches, reload only when a build's status
   * changes, since that's when they can change.
   */
  async #refresh(options: { versions?: 'always' | 'when-changed' } = {}): Promise<void> {
    clearTimeout(this.#refreshTimer);
    const applicationId = this.selectedId();
    if (applicationId === null || this.#destroyed) {
      return;
    }
    const before = statuses(this.builds());
    const builds = await this.#api.builds(applicationId);
    const changed = options.versions !== 'when-changed' || statuses(builds) !== before;
    const versions = changed ? await this.#api.versions(applicationId) : this.versions();
    // The person may have chosen another application while this was loading.
    if (applicationId !== this.selectedId()) {
      return;
    }
    this.builds.set(builds);
    this.versions.set(versions);
    if (builds.some((build) => isActive(build.status))) {
      this.#schedule(REFRESH_MS);
    }
  }

  /**
   * Polling doesn't mark the page as busy, so buttons don't flicker while a build runs.
   * If a refresh fails, it says so and tries again a little later.
   */
  #schedule(delayMs: number): void {
    if (this.#destroyed) {
      return;
    }
    this.#refreshTimer = setTimeout(async () => {
      try {
        await this.#refresh({ versions: 'when-changed' });
        if (this.#pollFailed) {
          this.#pollFailed = false;
          this.error.set(null);
        }
      } catch (error) {
        this.#pollFailed = true;
        this.error.set(errorMessage(error));
        this.#schedule(REFRESH_MS * 5);
      }
    }, delayMs);
  }

  async #act(work: (applicationId: string) => Promise<string>): Promise<void> {
    const applicationId = this.selectedId();
    if (applicationId === null) {
      return;
    }
    await this.#activity.run(async () => {
      const message = await work(applicationId);
      this.notice.set(message);
      await this.#refresh();
      const newest = this.builds()[0];
      if (newest !== undefined) {
        this.expanded.set(new Set([...this.expanded(), newest.id]));
      }
      await this.#loadPullRequests();
    });
  }
}

/** A fingerprint of every build's status, to tell when one changed. */
function statuses(builds: readonly Build[]): string {
  return builds.map((build) => `${build.id}:${build.status}`).join(',');
}
