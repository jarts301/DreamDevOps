# syntax=docker/dockerfile:1
# Base images are pinned by digest, so every build of a version uses the same base.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# JavaScript runs as it is, so only what it needs at runtime is installed.
RUN npm ci --omit=dev

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
# The base is pinned, so it misses security fixes Alpine released after it was published,
# such as for musl. They're applied here, as the image is built, so each new build has
# them. Only packages already in the base are updated, and nothing is added.
RUN apk upgrade --no-cache
# The service runs on Node.js alone. npm, npx, Corepack and Yarn come with the base image,
# for installing packages, which the build stage does. They bring packages of their own,
# such as undici, which scanners report, though the service never runs them.
RUN rm -rf /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
      /usr/local/lib/node_modules /opt/yarn-*
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Node.js only needs to know the code is ES modules. The project's package.json isn't
# copied: it's named after the application, which may also be the name of a published
# package, such as fastify, and scanners would report that package's vulnerabilities.
RUN echo '{"type":"module"}' > package.json
# Files belong to root and the service runs as "node", so it can't change its own code.
COPY --from=build /app/node_modules ./node_modules
COPY src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health/live || exit 1
CMD ["node", "--import", "./src/telemetry.js", "src/main.js"]
