# syntax=docker/dockerfile:1
# Base images are pinned by digest, so every build of a version uses the same base.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
# The base is pinned, so it misses security fixes Alpine released after it was published,
# such as for musl. They're applied here, as the image is built, so each new build has
# them. Only packages already in the base are updated, and nothing is added.
RUN apk upgrade --no-cache
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Files belong to root and the service runs as "node", so it can't change its own code.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health/live || exit 1
CMD ["node", "--import", "./dist/telemetry.js", "dist/main.js"]
