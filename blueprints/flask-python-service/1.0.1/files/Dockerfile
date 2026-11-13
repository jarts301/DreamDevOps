# syntax=docker/dockerfile:1
# Base images are pinned by digest, so every build of a version uses the same base. This is
# the Alpine Linux image the platform already pins, for Node.js, and Python comes from
# Alpine's own packages. To use an official Python image instead, change both FROM lines
# to it, pinned by digest, remove the lines that add python3, and add a user to run as,
# as it has no "node" user.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
RUN apk add --no-cache python3
WORKDIR /app
COPY requirements.txt ./
# Every package is checked against its hash, and comes as a wheel, so nothing is compiled.
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.txt

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
# The base is pinned, so it misses security fixes Alpine released after it was published,
# such as for musl. They're applied here, as the image is built, so each new build has
# them. Python is added next, in the newest version Alpine has for it.
RUN apk upgrade --no-cache
RUN apk add --no-cache python3
# Node.js, npm, Corepack and Yarn come with the base image, and the service uses none of
# them. They bring packages of their own, such as undici, which scanners report, so they're
# removed.
RUN rm -rf /usr/local/bin/node /usr/local/bin/nodejs /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
      /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/include/node /usr/local/share/doc/node /usr/local/share/man/man1/node.1 /usr/local/share/systemtap
ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8080
WORKDIR /app
# Files belong to root and the service runs as "node", the base image's own user, so it
# can't change its own code.
COPY --from=build /opt/venv /opt/venv
COPY service ./service
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health/live || exit 1
CMD ["python", "-m", "service"]
