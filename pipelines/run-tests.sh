# Runs a project's tests, by the language its files show. The platform puts this into the
# test job of build.yaml and check.yaml, where the source has been unpacked. It writes the
# output to /tmp/tests.log and sets code to the result.
#
# Every blueprint builds on the same node:24-alpine image as the test job, and adds its
# language's tools from Alpine's packages, so tests run with the tools the image uses.
run_tests() {
  if [ -f Cargo.toml ]; then
    echo "Rust: running cargo test."
    apk add --no-cache cargo gcc musl-dev && cargo test --locked
  elif [ -f CMakeLists.txt ]; then
    echo "C++: building with CMake and running CTest."
    apk add --no-cache g++ cmake make &&
      { [ ! -f third_party/SHA256SUMS ] || sha256sum -c third_party/SHA256SUMS; } &&
      cmake -S . -B /tmp/build && cmake --build /tmp/build --parallel &&
      ctest --test-dir /tmp/build --output-on-failure
  elif [ -f pyproject.toml ] || [ -f requirements-dev.txt ]; then
    echo "Python: running pytest."
    apk add --no-cache python3 && python3 -m venv /tmp/venv && {
      if [ -f requirements-dev.txt ]; then
        # Blueprints pin every package by hash, so nothing unexpected is installed.
        /tmp/venv/bin/pip install --require-hashes --only-binary=:all: -r requirements-dev.txt
      else
        /tmp/venv/bin/pip install pytest && { [ ! -f requirements.txt ] || /tmp/venv/bin/pip install -r requirements.txt; }
      fi
    } && /tmp/venv/bin/pytest
  elif [ -f package.json ]; then
    echo "JavaScript or TypeScript: running npm test."
    npm ci && npm test
  else
    echo "No Cargo.toml, CMakeLists.txt, Python project or package.json was found, so there were no tests to run."
  fi
}
run_tests > /tmp/tests.log 2>&1
code=$?
