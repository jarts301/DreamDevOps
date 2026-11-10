# Build and Artifacts

Builds images in the platform's pipeline, checks and signs them, and keeps each application's version list.

## Kinds of build

| Kind | Started by | Image tag | Signed with |
|---|---|---|---|
| Feature | A developer or Tech Lead, from a `feature/*` branch, on the application's page | `feature-<branch>-<commit>` | Test key |
| Release candidate | Release Management, for each new commit on a release or hotfix branch | `x.y.z-rc.N` | Test key |
| Final | Release Management, after the release merges into `main` | `x.y.z` | Release key |
| Pull request check | Each new commit on a pull request | None: it builds no image | |

Production must only trust the release key, so feature and RC images can only run in test environments. A feature branch's images are deleted with their signatures when the branch is deleted.

A pull request check runs only the secret scan and the tests, from [`pipelines/check.yaml`](../../../../pipelines/check.yaml), and reports `dreamdevops/tests` on the commit. A commit that was already checked keeps its result.

## The pipeline

The pipeline is defined once, in [`pipelines/build.yaml`](../../../../pipelines/build.yaml). The platform keeps an exact copy in each company's `dreamdevops-pipeline` repository, which no company team can access, and starts a run for each build. So no pull request can remove a step.

| Job | What it does |
|---|---|
| `secrets` | Gitleaks scans the source |
| `test` | Runs `npm ci` and `npm test`, if the project has a `package.json` |
| `image` | Builds the image with rootless BuildKit on the image runner, then uploads it to the platform |
| `scan` | Trivy scans the image the platform stored |
| `sbom` | Syft lists the stored image's contents as a CycloneDX SBOM |
| `failed` | Runs only when a job failed, and tells the platform which, so the build doesn't wait for the timeout |

Every tool image is pinned by digest. Each job tells the platform when it starts, at `/pipeline/builds/:id/jobs/:job/started`, so the dashboard shows every job waiting, running, passed, failed or skipped while the build runs.

## What jobs can and can't do

- **No credentials:** each run gets a one-time token that only reads that build's source and reports that build's results, while the build runs. Only its hash is stored.
- **The platform pushes:** the job uploads the image to the platform, which pushes it to the company's registry namespace with the bot's account, and records its digest. Jobs never hold registry credentials.
- **Clean checks:** the scan and SBOM jobs download the exact image the platform stored, in fresh containers where no application code has run.
- **The platform decides:** a build passes only when every report is in: no secrets found, tests passed, the image stored, no critical vulnerabilities, and an SBOM. Any failing gate fails it at once. A failure report can only fail a build.

The pipeline's tools can only upload text, so the image goes up in base64 parts of 16 MB, and the platform checks the whole file against the SHA-256 the job sends.

## Signing

The platform signs each passing image with Cosign's format: an ECDSA P-256 signature over the image's repository and manifest digest, stored next to the image as `sha256-<digest>.sig`. The real `cosign verify` accepts these, which the registry integration test checks.

Each company has a test key and a release key, made the first time they're needed. Private keys are encrypted with AES-256-GCM under `SIGNING_KEY_SECRET`, so the database alone can't sign anything. `GET /company/signing-keys` returns the public keys, for targets to check images.

## Routes

All routes start with `/api/v1`.

| Route | Who | Purpose |
|---|---|---|
| `POST /company/applications/:id/feature-builds` | `feature-images:build` | Builds a feature image from `{ "branch": "feature/..." }` |
| `GET /company/applications/:id/builds` | Any member | Recent builds, with each check's result |
| `GET /company/applications/:id/versions` | Any member | Signed images that passed every check |
| `GET /company/applications/:id/branches` | Any member | The repository's branches |
| `GET /company/builds/:id` | Any member | One build |
| `GET /company/builds/:id/sbom` | Any member | The image's SBOM |
| `GET /company/signing-keys` | Any member | The company's public keys |
| `/pipeline/builds/:id/...` | The build's token | Used only by pipeline jobs |

## Settings

| Setting | Purpose |
|---|---|
| `SIGNING_KEY_SECRET` | At least 32 characters. The API refuses to start in production with the sample value. |
| `BUILD_TIMEOUT_MINUTES` | Builds that haven't finished by then fail. Default 60. |
| `BUILD_WORK_DIR` | Where uploaded images wait during a build. Default: the system's temporary folder. |
| `PIPELINES_DIR` | The pipeline definitions. Default: the repository's `pipelines` folder. |
| `IMAGE_RUNNER_LABEL` | The label of the runner that builds images. The API refuses to start in production with the sample value. |

## Not done yet

- **Shared runners locally:** every company's jobs share the local runners. Each job gets a fresh, limited container that can't reach internal services, but on servers each company should get its own runners and Docker engine.
- **Unscanned layers:** Trivy scans OS and language packages; it doesn't check the application's own code.
- **Clean-up:** old RC images and feature images aren't deleted after a retention period yet.
- **SBOM attachment:** the SBOM is kept by the platform, not attached to the image in the registry.
