cmake_minimum_required(VERSION 3.20)
project(service LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# The pipeline turns every warning into an error, so warnings are fixed as they appear.
option(WARNINGS_AS_ERRORS "Fail the build on any compiler warning" OFF)
option(BUILD_TESTS "Build the tests" ON)

find_package(Threads REQUIRED)

# cpp-httplib and doctest are kept in third_party, each a single header, at the version and
# checksum third_party/README.md gives. Their warnings aren't the service's, so they're hidden.
add_library(third_party INTERFACE)
target_include_directories(third_party SYSTEM INTERFACE third_party/httplib third_party/doctest)

add_library(service_core STATIC
  src/app.cpp
  src/config.cpp
  src/json.cpp
  src/logs.cpp
  src/telemetry.cpp
  src/trace_context.cpp)
target_include_directories(service_core PUBLIC src)
target_link_libraries(service_core PUBLIC third_party Threads::Threads)

set(SERVICE_WARNINGS -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wsign-conversion -Wold-style-cast)
if(WARNINGS_AS_ERRORS)
  list(APPEND SERVICE_WARNINGS -Werror)
endif()
target_compile_options(service_core PRIVATE ${SERVICE_WARNINGS})

add_executable(service src/main.cpp)
target_link_libraries(service PRIVATE service_core)
target_compile_options(service PRIVATE ${SERVICE_WARNINGS})

if(BUILD_TESTS)
  enable_testing()
  add_executable(tests
    tests/main.cpp
    tests/app_test.cpp
    tests/config_test.cpp
    tests/json_test.cpp
    tests/logs_test.cpp
    tests/telemetry_test.cpp
    tests/trace_context_test.cpp)
  target_link_libraries(tests PRIVATE service_core)
  target_compile_options(tests PRIVATE ${SERVICE_WARNINGS})
  add_test(NAME tests COMMAND tests)
endif()
