import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, type OnDestroy, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { SessionService } from '../../core/session.service';
import { type Application, CatalogApi, type Repository } from '../catalog/catalog.api';
import { type Build, type BuildKind, type BuildStatus, DeliveryApi, type Release, type ReleaseKind } from './delivery.api';

const STATUS_LABELS: Readonly<Record<BuildStatus, string>> = {
  queued: 'Waiting',
  running: 'Building',
  succeeded: 'Ready',
  failed: 'Failed',
  deleted: 'Deleted',
};

const KIND_LABELS: Readonly<Record<BuildKind, string>> = {
  feature: 'Feature',
  rc: 'Release candidate',
  final: 'Final',
  check: 'Pull request check',
};

const RELEASE_STATUS: Readonly<Record<Release['status'], string>> = {
  open: 'Open',
  merged: 'Merged, building the final image',
  published: 'Published',
};

/** How often the page refreshes while a build is running or a release is open. */
const REFRESH_MS = 5_000;

/** One application: its repository, versions, builds and releases. */
@Component({
  selector: 'app-application-detail',
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p><a routerLink="/applications">← Applications</a></p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="alert alert-success" role="status">{{ message }}</p>
    }

    @if (application(); as app) {
      <h1>{{ app.name }}</h1>
      <p class="lead">
        {{ app.type.name }} · <code>{{ app.slug }}</code>
        @if (repository(); as repo) {
          @if (repo.status === 'ready') {
            · <a [href]="repo.url" target="_blank" rel="noopener">{{ repo.fullName }}</a>
          }
        }
      </p>

      @if (canBuildFeatures()) {
        <section class="card" aria-labelledby="feature-heading">
          <h2 id="feature-heading">Build a feature image</h2>
          @if (featureBranches().length === 0) {
            <p class="muted">There are no feature/* branches yet. Push one, then build it here.</p>
          } @else {
            <form class="form-row" [formGroup]="featureForm" (ngSubmit)="buildFeature()">
              <label class="field">
                <span>Branch</span>
                <select formControlName="branch">
                  @for (branch of featureBranches(); track branch) {
                    <option [value]="branch">{{ branch }}</option>
                  }
                </select>
              </label>
              <button type="submit" class="button button-primary" [disabled]="featureForm.invalid || working()">
                Build image
              </button>
            </form>
            <p class="cell-note">
              Feature images are signed with the test key, so only test environments accept them.
            </p>
          }
        </section>
      }

      <section class="card" aria-labelledby="releases-heading">
        <h2 id="releases-heading">Releases</h2>
        @if (canStartReleases()) {
          <form class="form-row" [formGroup]="releaseForm" (ngSubmit)="startRelease()">
            <label class="field">
              <span>Kind</span>
              <select formControlName="kind" (change)="suggest()">
                <option value="release">Release, from develop</option>
                <option value="hotfix">Hotfix, from main</option>
              </select>
            </label>
            <label class="field">
              <span>Version</span>
              <input type="text" formControlName="version" autocomplete="off" required />
            </label>
            <button type="submit" class="button button-primary" [disabled]="releaseForm.invalid || working()">
              Start
            </button>
          </form>
          <p class="cell-note">
            The platform cuts the branch and opens its pull request into main. Each new commit on it gets a
            release candidate image. The pull request merges once a Tech Lead approves, the tests pass and the
            newest commit has an RC image.
          </p>
        }
        @if (releases().length === 0) {
          <p class="muted">No releases yet.</p>
        }
        @for (release of releases(); track release.id) {
          <div class="release">
            <h3>
              {{ release.kind === 'release' ? 'Release' : 'Hotfix' }} {{ release.version }}
              <span class="status" [attr.data-status]="release.status === 'published' ? 'active' : null">
                {{ releaseStatus(release) }}
              </span>
            </h3>
            <ul class="ability-list">
              @for (candidate of release.candidates; track candidate.number) {
                <li>
                  <code>{{ candidate.tag }}</code> on <code>{{ candidate.commit.slice(0, 7) }}</code>:
                  {{ candidate.buildStatus ? statusLabel(candidate.buildStatus) : 'Waiting' }}
                </li>
              }
              @if (release.finalBuildStatus; as status) {
                <li>
                  Final image <code>{{ release.version }}</code>: {{ statusLabel(status) }}
                  @if (status === 'failed' && canStartReleases()) {
                    <button type="button" class="button" [disabled]="working()" (click)="rebuild(release)">
                      Build it again
                    </button>
                  }
                </li>
              }
              @if (release.mergeBackPullRequest !== null && repository()?.url; as url) {
                <li>
                  <a [href]="url + '/pulls/' + release.mergeBackPullRequest" target="_blank" rel="noopener">
                    Merge back into develop (#{{ release.mergeBackPullRequest }})
                  </a>
                </li>
              }
            </ul>
          </div>
        }
      </section>

      <section class="card" aria-labelledby="versions-heading">
        <h2 id="versions-heading">Versions</h2>
        <p class="cell-note">Signed images that passed every check. Deploy them by digest.</p>
        @if (versions().length === 0) {
          <p class="muted">No versions yet.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Image</th>
                  <th scope="col">Signed with</th>
                  <th scope="col">Vulnerabilities</th>
                  <th scope="col">Built</th>
                </tr>
              </thead>
              <tbody>
                @for (version of versions(); track version.id) {
                  <tr>
                    <td><code>{{ version.tag }}</code></td>
                    <td>{{ kindLabel(version.kind) }}</td>
                    <td>
                      <code>{{ version.imageRef }}</code>
                      <p class="cell-note"><code>{{ version.digest }}</code></p>
                    </td>
                    <td>{{ version.signedWith === 'release' ? 'Release key' : 'Test key' }}</td>
                    <td>
                      {{ vulnerabilities(version) }}
                      <p class="cell-note">
                        <a [href]="'/api/v1/company/builds/' + version.id + '/sbom'" download>SBOM</a>
                      </p>
                    </td>
                    <td>{{ version.createdAt | date: 'medium' }}</td>
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
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Image tag</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">Started</th>
                </tr>
              </thead>
              <tbody>
                @for (build of builds(); track build.id) {
                  <tr>
                    <td>
                      <code>{{ build.tag }}</code>
                      @if (build.branch) {
                        <p class="cell-note">{{ build.branch }} at <code>{{ build.commit.slice(0, 7) }}</code></p>
                      }
                    </td>
                    <td>{{ kindLabel(build.kind) }}</td>
                    <td>
                      <span class="status" [attr.data-status]="statusStyle(build.status)">{{ statusLabel(build.status) }}</span>
                      @if (build.failureReason) {
                        <p class="cell-note">{{ build.failureReason }}</p>
                      }
                      @if (build.status === 'failed' && build.reports.tests?.passed === false) {
                        <details>
                          <summary>Test output</summary>
                          <pre class="log">{{ build.reports.tests?.log }}</pre>
                        </details>
                      }
                    </td>
                    <td>{{ build.createdAt | date: 'medium' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    }
  `,
})
export class ApplicationDetail implements OnInit, OnDestroy {
  /** From the route. */
  readonly id = input.required<string>();

  readonly #catalog = inject(CatalogApi);
  readonly #delivery = inject(DeliveryApi);
  readonly #session = inject(SessionService);
  readonly #forms = inject(NonNullableFormBuilder);
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly application = signal<Application | null>(null);
  protected readonly repository = signal<Repository | null>(null);
  protected readonly builds = signal<Build[]>([]);
  protected readonly versions = signal<Build[]>([]);
  protected readonly releases = signal<readonly Release[]>([]);
  protected readonly suggestions = signal<Readonly<Record<ReleaseKind, string>>>({ release: '0.1.0', hotfix: '0.0.1' });
  protected readonly featureBranches = signal<string[]>([]);
  protected readonly working = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly canBuildFeatures = computed(() => {
    this.#session.user();
    return this.#session.can('feature-images:build');
  });
  protected readonly canStartReleases = computed(() => {
    this.#session.user();
    return this.#session.can('releases:start');
  });

  protected readonly featureForm = this.#forms.group({ branch: ['', Validators.required] });
  protected readonly releaseForm = this.#forms.group({
    kind: ['release' as ReleaseKind, Validators.required],
    version: ['', [Validators.required, Validators.pattern(/^\d+\.\d+\.\d+$/)]],
  });

  async ngOnInit(): Promise<void> {
    await this.#attempt(async () => {
      const [application, repositories] = await Promise.all([
        this.#catalog.get(this.id()),
        this.#catalog.repositories(),
      ]);
      this.application.set(application);
      this.repository.set(repositories.find((repository) => repository.applicationId === application.id) ?? null);
      if (this.canBuildFeatures() && this.repository()?.status === 'ready') {
        const branches = (await this.#delivery.branches(application.id)).filter((branch) => branch.startsWith('feature/'));
        this.featureBranches.set(branches);
        this.featureForm.setValue({ branch: branches[0] ?? '' });
      }
      await this.#refresh();
      this.suggest();
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.#refreshTimer);
  }

  protected statusLabel(status: BuildStatus): string {
    return STATUS_LABELS[status];
  }

  protected statusStyle(status: BuildStatus): string | null {
    return status === 'succeeded' ? 'active' : status === 'failed' ? 'provisioning-failed' : null;
  }

  protected kindLabel(kind: BuildKind): string {
    return KIND_LABELS[kind];
  }

  protected releaseStatus(release: Release): string {
    return RELEASE_STATUS[release.status];
  }

  protected vulnerabilities(build: Build): string {
    const scan = build.reports.scan;
    return scan === undefined ? 'Not scanned' : `${scan.critical} critical, ${scan.high} high, ${scan.medium} medium`;
  }

  protected suggest(): void {
    this.releaseForm.controls.version.setValue(this.suggestions()[this.releaseForm.controls.kind.value]);
  }

  protected async buildFeature(): Promise<void> {
    await this.#attempt(async () => {
      const build = await this.#delivery.buildFeatureImage(this.id(), this.featureForm.getRawValue().branch);
      this.notice.set(`Building ${build.tag}.`);
      await this.#refresh();
    });
  }

  protected async startRelease(): Promise<void> {
    const { kind, version } = this.releaseForm.getRawValue();
    await this.#attempt(async () => {
      await this.#delivery.startRelease(this.id(), kind, version);
      this.notice.set(`The ${kind} ${version} started. Its first release candidate is being built.`);
      await this.#refresh();
    });
  }

  protected async rebuild(release: Release): Promise<void> {
    await this.#attempt(async () => {
      await this.#delivery.rebuildFinal(release.id);
      this.notice.set(`Building the final image of ${release.version} again.`);
      await this.#refresh();
    });
  }

  /** Reloads, and keeps reloading while a build runs or a release is open. */
  async #refresh(): Promise<void> {
    clearTimeout(this.#refreshTimer);
    const [builds, versions, releases] = await Promise.all([
      this.#delivery.builds(this.id()),
      this.#delivery.versions(this.id()),
      this.#delivery.releases(this.id()),
    ]);
    this.builds.set(builds);
    this.versions.set(versions);
    this.releases.set(releases.releases);
    this.suggestions.set(releases.suggestions);
    const active =
      builds.some((build) => build.status === 'queued' || build.status === 'running') ||
      releases.releases.some((release) => release.status !== 'published');
    if (active) {
      this.#refreshTimer = setTimeout(() => void this.#attempt(() => this.#refresh(), { quiet: true }), REFRESH_MS);
    }
  }

  async #attempt(work: () => Promise<void>, options: { quiet?: boolean } = {}): Promise<void> {
    if (!options.quiet) {
      this.error.set(null);
      this.working.set(true);
    }
    try {
      await work();
    } catch (error) {
      this.notice.set(null);
      this.error.set(errorMessage(error));
    } finally {
      if (!options.quiet) {
        this.working.set(false);
      }
    }
  }
}
