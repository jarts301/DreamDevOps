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
# them. Only packages already in the base are updated, and nothing is added: the C++
# libraries the service needs are already there, for Node.js.
RUN apk upgrade --no-cache
ENV PORT=8080
# The binary belongs to root and the service runs as "node", the base image's own user, so
# it can't change its own code.
COPY --from=build /app/build/service /usr/local/bin/service
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health/live || exit 1
CMD ["service"]
