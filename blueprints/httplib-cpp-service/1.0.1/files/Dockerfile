# syntax=docker/dockerfile:1
# Base images are pinned by digest, so every build of a version uses the same base. This is
# the Alpine Linux image the platform already pins, for Node.js, and the compiler comes from
# Alpine's own packages. Both stages use the same image, so the service runs with the C++
# libraries it was built with. To move to a newer one, change both FROM lines.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
RUN apk add --no-cache g++ cmake make
WORKDIR /app
COPY CMakeLists.txt ./
COPY third_party ./third_party
COPY src ./src
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=OFF \
 && cmake --build build --parallel \
 && strip build/service

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
# The base is pinned, so it misses security fixes Alpine released after it was published,
# such as for musl. They're applied here, as the image is built, so each new build has
# them. Then the C++ libraries the service needs are added, though the base has them already.
RUN apk upgrade --no-cache
RUN apk add --no-cache libstdc++ libgcc
# Node.js, npm, Corepack and Yarn come with the base image, and the service uses none of
# them. They bring packages of their own, such as undici, which scanners report, so they're
# removed.
RUN rm -rf /usr/local/bin/node /usr/local/bin/nodejs /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
      /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/include/node /usr/local/share/doc/node /usr/local/share/man/man1/node.1 /usr/local/share/systemtap
ENV PORT=8080
# The binary belongs to root and the service runs as "node", the base image's own user, so
# it can't change its own code.
COPY --from=build /app/build/service /usr/local/bin/service
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health/live || exit 1
CMD ["service"]
