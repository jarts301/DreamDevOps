# syntax=docker/dockerfile:1
# Base images are pinned by digest, so every build of a version uses the same base.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
# The base is pinned, so it misses security fixes Alpine released after it was published,
# such as for musl, curl or brotli. They're applied here, as the image is built, so each
# new build has them. Only packages already in the base are updated, and nothing is added.
USER root
RUN apk upgrade --no-cache
# The base image's own unprivileged user.
USER 101
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --chmod=0755 nginx/write-runtime-config.sh /docker-entrypoint.d/40-write-runtime-config.sh
# Sends the container's CPU and memory use to the platform, when it says where. See README.md.
COPY --chmod=0755 nginx/send-metrics.sh /docker-entrypoint.d/50-send-metrics.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
