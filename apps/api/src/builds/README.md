# Builds and versions

Builds each application's container images, gives each one a version, and validates, scans, publishes, signs and verifies it. Every step's progress shows on the dashboard's **Builds** page.

## What gets built

| Build | Starts when | Version | Who |
|---|---|---|---|
| Development | Someone asks for it on an open pull request from a `feature/*` branch into `develop` | `1.5.0-dev.pr12.1` | Developers and Tech Leads (`feature-images:build`) |
| Release candidate | A `release/<version>` branch is created | `1.5.0-rc.1` | Tech Leads start releases (`releases:start`) |
| Hotfix candidate | A `hotfix/<version>` branch is created | `1.4.1-hotfix.1` | Tech Leads start hotfixes (`releases:start`) |
| Release | A `release/*` or `hotfix/*` branch is merged into `main` | `1.5.0` | Automatic |

- **Release and hotfix branches:** only the platform may create them, as [Git Flow](../source-governance/README.md#git-flow-rules) requires, so Tech Leads start them from the dashboard. A release branches from `develop` and counts up the minor or major version. A hotfix branches from `main` and counts up the patch version. One release and one hotfix can be in progress at a time.
- **More candidates:** after more changes reach a release or hotfix branch, a Tech Lead chooses **Build new candidate**, which builds `rc.2`, `rc.3` and so on from the branch's latest commit.
- **Versions only go up:** new versions count from the newest one merged into `main`. A release that isn't newer than that fails validation.
- **Development versions** name the release they lead towards, the pull request and a count, such as `1.5.0-dev.pr12.3`. Each commit is built once.
- **Abandoning:** a release or hotfix whose branch is deleted in Forgejo no longer counts as in progress.

Every version is also the image's tag, so versions never contain `+`. Images are named `<registry>/<organization>/<application>:<version>`, such as `localhost:3000/acme/billing-api:1.5.0`.

## The steps

Each build runs these steps in order, and saves its progress after each one:

| Step | What it does | It fails when |
|---|---|---|
| Get the source | Downloads the exact commit the build was asked for, and unpacks it with the machine's `tar`, which Linux, macOS and Windows all have. Git for Windows' own `tar` works too. | |
| Validate | Checks the version and what started the build, then the Dockerfile | Any check below fails |
| Build | Builds the image, labelled with its version, commit and source | The Dockerfile doesn't build |
| Check the image | Reads the built image's settings | It runs as root, or has no health check |
| Scan | Scans for known vulnerabilities with Trivy | It has a critical vulnerability. High ones are warnings. |
| Publish | Pushes the image to the registry, and records its digest | |
| Sign | Signs the digest with the platform's key, in cosign's format | |
| Verify | Reads the signature back from the registry and checks it | It doesn't match the key or the digest |
| Tag | Releases only: tags the merge commit `v<version>` in Git | The tag exists on another commit |

Validation checks:

- The version is a semantic version, and a release or candidate is newer than what's on `main`.
- A development build's pull request is still open, comes from a feature branch of the application's own repository and targets `develop`. Forks are never built.
- A release's pull request was merged into `main`, its branch is named after the version, and the commit is the merge commit.
- The Dockerfile pins every base image by digest, downloads files with `ADD` only with `--checksum`, and has no build argument or environment variable named like a secret, such as `NPM_TOKEN`.
- A missing `.dockerignore` is a warning.

Both published [blueprints](../../../../blueprints/README.md) pass every check.

Each step is a class in `application/steps/`. To add one, write it there, add it to `defaultSteps` in `build-pipeline.ts`, and add its key to `stepsFor` in `domain/pipeline.ts`. A test checks that every step a build can run has exactly one implementation.

## Failures and retries

A failed check stops the build at once, and the step shows which check failed and why. Anything that may pass, such as an unreachable registry, runs the build again from the start, up to `BUILD_MAX_ATTEMPTS` times. People who may start that kind of build can choose **Try again** on a failed build, which runs it again with the same version and commit.

Builds run in the background, one at a time by default. A running build reports to the job queue every 30 seconds, so a build whose API process stopped starts again soon, while a slow build keeps going. Only one worker runs a build at a time.

## Signatures

Signatures use cosign's format and live in the registry beside the image, so anyone can check an image:

```bash
cosign verify --key dreamdevops-images.pub --insecure-ignore-tlog=true localhost:3000/acme/billing-api@sha256:…
```

The **Builds** page shows the public key and its fingerprint. Signatures aren't uploaded to a public transparency log, hence `--insecure-ignore-tlog`.

The signing key is an ECDSA P-256 key in `IMAGE_SIGNING_KEY_FILE`. On a developer's machine, the API creates it on first start in `infra/local/signing/`, which Git ignores. Keep it: images signed with a lost key can't be verified with a new one. In production, the API refuses to start unless the setting names an existing key.

## Deploying images

Every image that went through all its steps can be deployed, as the [Environments guide](../environments/README.md#deploying) explains. The **Builds** page links each one to the **Environments** page.

Builds offers other modules its images through `DeployableImages`, in `application/deployable-images.ts`: each application's images that built, whether each is fit for production, and a check of an image's signatures against the platform's key, which deployments run before anything starts. Only releases are fit for production, because only they were merged into `main` and tagged.

## Webhooks

Forgejo tells the platform about new branches and merged pull requests through a webhook on each repository. The platform creates it when the repository is created, and again before starting a release or hotfix, so repositories made before this module get one too.

- **Signatures:** each repository's webhook has its own secret, made from `FORGEJO_WEBHOOK_SECRET` and the repository's name. A delivery without a valid signature is refused before anything else happens.
- **Duplicates:** each change starts one build, however often it's reported.
- **Missed deliveries:** Forgejo doesn't retry a webhook it couldn't deliver, such as while the API was stopped. Opening the **Builds** page asks the platform to look for release and hotfix branches merged into `main` since, and builds their releases.

## Routes

All routes start with `/api/v1`.

| Route | Who | Purpose |
|---|---|---|
| `GET /company/applications/:id/builds` | Any member | The application's builds, newest first, with every step's progress |
| `GET /company/applications/:id/versions` | Any member | What's on `main`, what's published, what's in progress and what comes next |
| `GET /company/applications/:id/pull-requests` | Any member | Open pull requests from feature branches, with their latest development image |
| `POST /company/applications/:id/builds/sync` | Any member | Looks for merges into `main` the platform missed |
| `POST /company/applications/:id/pull-requests/:number/builds` | `feature-images:build` | Builds a development image of the pull request's latest commit |
| `POST /company/applications/:id/releases` | `releases:start` | Starts a release: `{ "bump": "minor" }` or `"major"` |
| `POST /company/applications/:id/hotfixes` | `releases:start` | Starts a hotfix |
| `POST /company/applications/:id/candidates` | `releases:start` | Builds a new candidate: `{ "branch": "release/1.5.0" }` |
| `GET /company/builds/:id` | Any member | One build |
| `POST /company/builds/:id/retry` | `feature-images:build` for development builds, `releases:start` for the rest | Runs a failed build again |
| `GET /company/image-signing-key` | Any member | The public key that checks every signature |
| `POST /hooks/forgejo` | Forgejo, with a valid signature | Receives webhooks |

## Events

`ReleaseStarted`, `HotfixStarted`, `BuildQueued`, `BuildSucceeded` and `BuildFailed` are recorded in the audit log. Company Admins can post all but `BuildQueued` to chat.

## Settings

| Setting | Purpose |
|---|---|
| `FORGEJO_WEBHOOK_SECRET` | Required. The master secret for webhook signatures. At least 32 characters in production. |
| `FORGEJO_WEBHOOK_URL` | Where Forgejo sends webhooks. Locally `http://host.docker.internal:4000/api/v1/hooks/forgejo`. |
| `IMAGE_REGISTRY_URL` | The registry to publish to. Defaults to Forgejo's own, at `FORGEJO_URL`. It must be the same address the registry calls itself, because the platform only signs in where the registry says. |
| `IMAGE_SIGNING_KEY_FILE` | The signing key. Required in production. |
| `IMAGE_SCANNER` | `trivy` (default), or `none` to skip scanning, for local testing only |
| `TRIVY_IMAGE` | The Trivy image. Defaults to `aquasec/trivy:0.58.1`. |
| `BUILD_CONCURRENCY` | Builds running at once in each API process. Defaults to 1. |
| `BUILD_TIMEOUT_MINUTES` | The longest a build, scan or push may take. Defaults to 30. |
| `BUILD_MAX_ATTEMPTS`, `BUILD_RETRY_SECONDS` | Runs before a build that keeps hitting temporary problems fails, and the wait between them |

## What the API's machine needs

Builds run with the Docker command line on the machine that runs the API, which is the developer's machine locally. Trivy runs as a container, and gets the image as a file rather than access to Docker itself. The first scan downloads Trivy's vulnerability database, which needs the internet.

Building runs each repository's Dockerfile, which is code from the company's developers, inside Docker's build sandbox. Only the company's own branches are built, never forks.

## Not included yet

- **Passing tests before building:** the build doesn't wait for the repository's CI checks, because no CI runners exist yet.
- **Merging back:** merging a finished release or hotfix back into `develop` is still done by hand.
- **Cleaning up:** old development images stay in the registry.
- **Webhooks that can't reach the API:** locally, Forgejo calls the API through `host.docker.internal`, and the API listens only on `127.0.0.1`. Where those don't meet, such as with Docker Engine on Linux, merges are still found, and their releases built, when someone opens the **Builds** page.
