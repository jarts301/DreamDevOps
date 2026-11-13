# Service image fixes: Axum's build, and Fastify's scan

Two images built from the new service blueprints failed. This report says why, what changed, and what to do for the applications already created from them.

- [Summary](#summary)
- [Fastify: a critical vulnerability that wasn't there](#fastify-a-critical-vulnerability-that-wasnt-there)
- [Fastify: high vulnerabilities from the base image](#fastify-high-vulnerabilities-from-the-base-image)
- [Axum: the image didn't build](#axum-the-image-didnt-build)
- [Build errors now say why](#build-errors-now-say-why)
- [What to do now](#what-to-do-now)
- [How it was checked](#how-it-was-checked)

## Summary

| Problem | Cause | Fix |
|---|---|---|
| Fastify failed its scan: `CVE-2018-3711 in fastify 0.1.0` | The image held the project's `package.json`, named after the application, *fastify*, at version `0.1.0`. Trivy took it for the published fastify package, version 0.1.0, from 2016. The service runs Fastify 5. | The image no longer holds the project's `package.json`. It gets one that only says the code is ES modules. |
| 10 high vulnerabilities, such as in `undici` 6.28.0 and `brace-expansion` 5.0.9 | npm, which comes with the Node.js base image, brings those packages. `apk upgrade` can't update them, as they aren't Alpine packages. The service never runs npm. | The image removes npm, npx, Corepack and Yarn. Services in Python, Rust and C++ remove Node.js too. |
| Axum's image didn't build | Not certain: the platform kept only Docker's last 6 lines, which say where the build failed, not why. The code and lockfile build on every Rust from 1.83 to the newest, for Alpine's kind of Linux. The likely causes are compiling one crate per CPU at once, which can take more memory than Docker gives builds on a laptop, and downloads dropped by the network. | The image compiles four crates at a time, about 1.2 GB at most, downloads crates in a step of its own, and tries again, one connection at a time, when downloads drop. |
| The build error didn't say why | The platform kept Docker's last 6 lines: an excerpt of the `Dockerfile` and a summary. | A failed build now shows the instruction that failed and its last 15 lines of output, such as Cargo's error. |

New blueprint versions carry the fixes: `node-service` 1.3.1, and 1.0.1 of the other nine services. New applications start from them. Applications already created keep their `Dockerfile`, so they need theirs replaced. See [What to do now](#what-to-do-now).

## Fastify: a critical vulnerability that wasn't there

The image's `/app/package.json` was the project's own, copied into the image so Node.js knows the code is ES modules. Every scaffold names its project after the application's short name, and gives it version `0.1.0`:

```json
{ "name": "fastify", "version": "0.1.0", "private": true, "type": "module" }
```

Trivy reads every `package.json` in an image as an installed package. It found a package called `fastify` at `0.1.0`, and reported CVE-2018-3711, which affects fastify before 0.38.0. The service's real Fastify, in `node_modules`, is 5.x, and wasn't reported. Any application named like a published package, such as *Express*, *Lodash* or *Axios*, would have had the same false report. This affected every service in TypeScript and JavaScript, including `node-service`.

**Fix:** the image writes its own `package.json`, with only `{"type":"module"}`, which is all Node.js needs. A package with no name matches nothing in a vulnerability database. The project's `package.json` stays in the repository, unchanged.

## Fastify: high vulnerabilities from the base image

The 10 high vulnerabilities weren't in the service's dependencies: none of the five named packages are in its lockfile. They're npm's own dependencies. The Node.js base image brings npm in `/usr/local/lib/node_modules/npm`, and the versions found, `undici` 6.28.0 and `brace-expansion` 5.0.9, are the ones npm 11.19 to 11.21 bundles. The step lists five of the ten. The other five are probably npm's too.

`apk upgrade` updates Alpine's packages only, so building again couldn't fix them. Even the newest npm, 11.21.1, bundles `undici` 6.29.0, which is still affected. The image only needs npm while it's built, in its build stage. The service runs with `node` alone.

**Fix:** every service image removes npm, npx, Corepack and Yarn after `apk upgrade`. The Python, Rust and C++ services also remove Node.js itself, which they never used. They only built on the Node.js image because it's the one Alpine image the platform pins by digest. They add the libraries they need from Alpine, `libstdc++` and `libgcc`, though the base has them already, so they don't depend on what Node.js brought. Every image still runs as the `node` user, whose account the base image creates.

## Axum: the image didn't build

The platform showed:

```
13 | >>> RUN cargo build --release --locked
...
ERROR: failed to build: failed to solve: process "/bin/sh -c cargo build --release --locked" did not complete successfully
```

That names the failing instruction, but Cargo's own error was in the lines before it, which the platform dropped. So the exact cause can't be read from the report, and this machine has no Docker to build the image again. What was ruled out:

- **The code and lockfile:** the Dockerfile's exact steps, with only `Cargo.toml`, `Cargo.lock` and `src` copied, build with Rust 1.83, the oldest Alpine release the base image could have, for musl, Alpine's C library. The pipeline's checks pass with Rust 1.83, 1.87, 1.91 and the newest. The crates also compile for ARM, as on a Mac.
- **Anything special to Axum:** it differs from Actix Web by six crates, all common ones that build with Rust 1.83.

What remains, as Cargo builds in Docker on a laptop:

- **Memory:** Cargo compiles one crate per CPU at once, in release mode. Some crates take up to 450 MB each, so a machine with many CPUs can need more memory than Docker gives builds, beside the platform's own containers, such as Keycloak, Forgejo and PostgreSQL. The compiler is then killed, and Cargo fails.
- **Downloads:** Cargo downloads the service's 150 or so crates many at a time, over one HTTP/2 connection. Some networks, and Docker's on some laptops, drop such downloads, and Cargo gives up after 3 tries.

**Fix, in the Rust services' `Dockerfile`:**

```dockerfile
ENV CARGO_NET_RETRY=10 CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_TIMEOUT=120
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo fetch --locked
ARG CARGO_BUILD_JOBS=4
RUN cargo build --release --locked --offline
```

- Downloads happen in a step of their own, so a network problem shows as one. They try again up to 10 times, one connection at a time.
- Four crates compile at a time. Measured here, the build peaks at about 1.0 GB of memory and takes about 90 seconds on 4 CPUs. Building one crate per CPU on a machine with 16 could need several gigabytes. Where builds have more memory, `CARGO_BUILD_JOBS` can be raised.
- The build uses only what was downloaded, still checked against `Cargo.lock`.

If it still fails, the build step now shows Cargo's own error. See the next section.

## Build errors now say why

When a `Dockerfile` instruction fails, Docker prints the instruction's last lines of output, then an excerpt of the `Dockerfile`, then a summary. The platform kept the last 6 lines, which are the excerpt and the summary. The build step now keeps:

1. The instruction that failed, such as `[build 6/6] RUN cargo build --release --locked`
2. Its last 15 lines of output, such as `error: could not compile 'zerocopy'` and why
3. Docker's summary, with the exit code

The dashboard shows them on separate lines. Network errors among them, such as *connection reset by peer*, make the build try again, as they did when Docker itself reported them. The change is in `apps/api/src/builds/infrastructure/docker-image-builder.ts`, as `buildFailure`, with a test.

## What to do now

1. **Restart the API**, so it has the new blueprint versions and the build error change.
2. **Fix the applications already created.** Their repositories keep the `Dockerfile` they started with. In each one, replace the `Dockerfile` with the new version's, from `blueprints/<key>/<version>/files/Dockerfile`, on a `feature/*` branch, and merge the pull request into `develop`:

   | Application | Copy the `Dockerfile` from |
   |---|---|
   | Axum | `blueprints/axum-rust-service/1.0.1/files/` |
   | Fastify | `blueprints/fastify-javascript-service/1.0.1/files/` |
   | Any other service created since the new blueprints | The same blueprint's `1.0.1` folder, or `node-service/1.3.1` |

   Or register them again: new applications start from the fixed versions.
3. **Build them again.** Fastify's scan should show no critical vulnerabilities. If high ones remain, they're in the service's own dependencies, and the step names them. If Axum's build still fails, the step now says why.
4. **Run `npm run test:scaffolds`** on a machine with Docker. It builds every blueprint version's image, and now also checks that services from these versions hold neither npm nor Yarn, nor a `package.json` with a name.

## How it was checked

| Check | Result |
|---|---|
| Each Node.js service, built as its `Dockerfile` does, installed under the name *fastify*, and run from a folder laid out like the image's `/app`, with only `{"type":"module"}` as `package.json` | All five answer, log, trace and send metrics as before |
| The Rust services' new build steps, with an empty Cargo cache, for musl, with Rust 1.83, then the service run | Both build, in 88 and 101 seconds, peaking at 1.0 GB, and pass the same checks |
| The C++ service's image build | Peaks at 1.0 GB on 4 CPUs |
| `buildFailure`, with BuildKit's output of a compiler killed for lack of memory | Keeps the step, Cargo's error and the summary |
| `npm test` | 539 API unit tests pass, including new ones that every service image removes npm and Yarn, and copies no `package.json` |
| Integration tests of builds and repositories | 51 pass, with the new versions |
| Dashboard tests | 185 pass |

Not checked here: building the images with Docker and scanning them with Trivy, as this machine has neither. Step 4 above does both.
