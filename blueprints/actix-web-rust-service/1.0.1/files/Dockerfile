# syntax=docker/dockerfile:1
# Base images are pinned by digest, so every build of a version uses the same base. This is
# the Alpine Linux image the platform already pins, for Node.js, and Rust comes from Alpine's
# own packages. To build with an official Rust image instead, change the first FROM line to
# its Alpine variant, pinned by digest, so the service still runs on Alpine, and remove the
# line that adds cargo.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
RUN apk add --no-cache cargo gcc musl-dev
WORKDIR /app
# Cargo downloads many crates at once. When the network drops some, as Docker's can on a
# busy machine, these make it try again, one connection at a time, rather than fail.
ENV CARGO_NET_RETRY=10 CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_TIMEOUT=120
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# Only the versions in Cargo.lock are downloaded, each checked against its checksum, in a
# step of its own, so a network problem shows as one.
RUN cargo fetch --locked
# Each crate compiled at once takes up to about 450 MB. Four at a time peak at about 1.2 GB,
# which fits the memory Docker gives builds on a laptop, beside the platform's own
# containers, where one per CPU could run out of it. With more memory, raise it.
ARG CARGO_BUILD_JOBS=4
RUN cargo build --release --locked --offline

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
# The base is pinned, so it misses security fixes Alpine released after it was published,
# such as for musl. They're applied here, as the image is built, so each new build has
# them. Then libgcc, which the service needs, is added, though the base has it already.
RUN apk upgrade --no-cache
RUN apk add --no-cache libgcc
# Node.js, npm, Corepack and Yarn come with the base image, and the service uses none of
# them. They bring packages of their own, such as undici, which scanners report, so they're
# removed.
RUN rm -rf /usr/local/bin/node /usr/local/bin/nodejs /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
      /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/include/node /usr/local/share/doc/node /usr/local/share/man/man1/node.1 /usr/local/share/systemtap
ENV PORT=8080
# The binary belongs to root and the service runs as "node", the base image's own user, so
# it can't change its own code.
COPY --from=build /app/target/release/service /usr/local/bin/service
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health/live || exit 1
CMD ["service"]
