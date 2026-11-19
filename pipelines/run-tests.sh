# Runs a project's tests, by the language its files show. The platform puts this into the
# test job of build.yaml and check.yaml, where the source has been unpacked. It writes the
# output to /tmp/tests.log and sets code to the result.
#
# Every blueprint builds on the same node:24-alpine image as the test job, and adds its
# language's tools from Alpine's packages, so tests run with the tools the image uses.
#
# Downloads, of the language's tools and of the project's packages, run apart from the tests,
# and are tried again when they fail, as the network drops lookups and connections now and
# then, such as Docker Desktop's on a busy machine. The tests themselves run once: a failing
# test is the project's, and trying it again would only hide it.

# Runs a download, and tries it again, up to three times in all, 15 seconds apart.
download() {
  attempt=1
  until "$@"; do
    if [ "$attempt" -ge 3 ]; then
      echo "The download failed $attempt times, so the tests can't run: $*"
      return 1
    fi
    attempt=$((attempt + 1))
    echo "The download failed. Trying it again in 15 seconds: $*"
    sleep 15
  done
}

run_tests() {
  if [ -f Cargo.toml ]; then
    echo "Rust: running cargo test."
    # As the Rust blueprints' Dockerfile does: Cargo downloads many crates at once, and these
    # make it try again, one connection at a time, with time to finish, rather than fail.
    export CARGO_NET_RETRY=10 CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_TIMEOUT=120
    download apk add --no-cache cargo gcc musl-dev &&
      download cargo fetch --locked &&
      cargo test --locked --offline
  elif [ -f CMakeLists.txt ]; then
    echo "C++: building with CMake and running CTest."
    download apk add --no-cache g++ cmake make &&
      { [ ! -f third_party/SHA256SUMS ] || sha256sum -c third_party/SHA256SUMS; } &&
      cmake -S . -B /tmp/build && cmake --build /tmp/build --parallel &&
      ctest --test-dir /tmp/build --output-on-failure
  elif [ -f pyproject.toml ] || [ -f requirements-dev.txt ]; then
    echo "Python: running pytest."
    # pip gives up on a download that stalls for 15 seconds, which a busy network can.
    pip="/tmp/venv/bin/pip install --timeout 120 --retries 10"
    download apk add --no-cache python3 && python3 -m venv /tmp/venv && {
      if [ -f requirements-dev.txt ]; then
        # Blueprints pin every package by hash, so nothing unexpected is installed.
        download $pip --require-hashes --only-binary=:all: -r requirements-dev.txt
      else
        download $pip pytest && { [ ! -f requirements.txt ] || download $pip -r requirements.txt; }
      fi
    } && /tmp/venv/bin/pytest
  elif [ -f package.json ]; then
    echo "JavaScript or TypeScript: running npm test."
    download npm ci && npm test
  else
    echo "No Cargo.toml, CMakeLists.txt, Python project or package.json was found, so there were no tests to run."
  fi
}

# The job runs with sh -e, which would stop at a failing command, before the log is sent. So
# the result is kept instead, and the job sends the log either way, then fails with it.
code=0
run_tests > /tmp/tests.log 2>&1 || code=$?
