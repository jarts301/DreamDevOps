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

A pull request check runs only the Dockerfile rules, the secret scan and the tests, from [`pipelines/check.yaml`](../../../../pipelines/check.yaml), and reports `dreamdevops/tests` on the commit. A commit that was already checked keeps its result.

## The pipeline

The pipeline is defined once, in [`pipelines/build.yaml`](../../../../pipelines/build.yaml). The platform keeps an exact copy in each company's `dreamdevops-pipeline` repository, which no company team can access, and starts a run for each build. So no pull request can remove a step.

| Job | What it does |
|---|---|
| `secrets` | Gitleaks scans the source |
| `test` | Runs the tests for the project's language, found from its files: `cargo test` for Rust (`Cargo.toml`), CMake and CTest for C++ (`CMakeLists.txt`), `pytest` for Python (`pyproject.toml` or `requirements-dev.txt`), and `npm ci` and `npm test` for JavaScript and TypeScript (`package.json`). A project with none of these has no tests to run. |
| `image` | Builds the image with rootless BuildKit on the image runner, then uploads it to the platform |
| `scan` | Trivy scans the image the platform stored |
| `sbom` | Syft lists the stored image's contents as a CycloneDX SBOM |
| `failed` | Runs only when a job failed, and tells the platform which, so the build doesn't wait for the timeout |

The test job's commands live in [`pipelines/run-tests.sh`](../../../../pipelines/run-tests.sh), which the API puts into both workflows, where `__RUN_TESTS__` stands, when it starts. Every blueprint builds on the same `node:24-alpine` image as the job and adds its language's tools from Alpine's packages, so the tests run with the tools the image is built with. `npm run test:scaffolds` runs the job on every blueprint version.

Every tool image is pinned by digest. Each job tells the platform when it starts, at `/pipeline/builds/:id/jobs/:job/started`, so the dashboard shows every job waiting, running, passed, failed or skipped while the build runs.

## The platform's own checks

Three steps run on the platform itself, where the thing they check is in its hands, not in a job:

| Step | When | It fails when |
|---|---|---|
| Dockerfile rules | Before the pipeline starts. The platform reads the `Dockerfile` and `.dockerignore` at the build's exact commit. A failing rule stops the build before any job runs. | There's no Dockerfile, a base image isn't pinned by digest, `ADD` downloads a file without `--checksum`, or a build argument or environment variable is named like a secret, such as `NPM_TOKEN`. A missing `.dockerignore` is only a warning. |
| Image rules | When the image arrives, before it's stored. The platform reads the image's settings from its OCI configuration, so a user set by the base image counts. An image that breaks a rule is never pushed, so nothing can deploy it. | It runs as root, or has no health check. |
| Signature | Right after signing. The platform reads the signature back from the registry, as a target would, and checks it with the company's public key. | The registry doesn't return it, it names another image, or it doesn't match the key. |

The rules are in `domain/dockerfile-policy.ts` and `domain/image-rules.ts`. Every [blueprint](../../../../blueprints/README.md) passes them, which the blueprint tests check.

## Why a build failed

Each step reports what it checked. A failed check says what's wrong and how to fix it, and the build's reason starts with the step, such as *The Dockerfile breaks a platform rule: Base images are pinned by digest. Not pinned: node:24 on line 1.* The application's page lists the failed checks and warnings under the build's steps.

The pipeline repository is closed to company teams, so people can't read Forgejo's job logs. The jobs send what explains a failure instead: the test job the end of the tests' output, and the image job the end of the build's output, which names the instruction that failed. Both show on the build. A job that stopped before it reported, such as when a tool couldn't be downloaded, is named, with the advice to try again.

## What jobs can and can't do

- **No credentials:** each run gets a one-time token that only reads that build's source and reports that build's results, while the build runs. Only its hash is stored.
- **The platform pushes:** the job uploads the image to the platform, which pushes it to the company's registry namespace with the bot's account, and records its digest. Jobs never hold registry credentials.
- **Clean checks:** the scan and SBOM jobs download the exact image the platform stored, in fresh containers where no application code has run.
- **The platform decides:** a build passes only when every report is in: the Dockerfile and image rules passed, no secrets found, tests passed, the image stored, no critical vulnerabilities, and an SBOM, and then only once its signature checks out. Any failing gate fails it at once. A failure report can only fail a build.

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
