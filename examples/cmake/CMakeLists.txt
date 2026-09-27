# Example: generating C++ code from state machine models with CMake.
#
#   npm ci && npm run build -w packages/language     # once, in the repository root (builds the hsm CLI)
#   cmake -S examples/cmake -B build/cmake-example -G Ninja
#   cmake --build build/cmake-example
#   ctest --test-dir build/cmake-example --output-on-failure
#   build/cmake-example/traffic_light 10              # runs the traffic light for 10 seconds
#
# The code is generated into the build directory at build time and regenerated when a model changes.
cmake_minimum_required(VERSION 3.20)
project(HsmCMakeExample LANGUAGES CXX)

# the hsm build integration (alternatively: find_package(Hsm CONFIG REQUIRED PATHS ../../cmake))
list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/../../cmake")
include(HsmGenerate)

set(CMAKE_CXX_EXTENSIONS OFF)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# 1. Models listed in CMake: TrafficLight.h / TrafficLight.cpp / sc_statemachine.h in namespace example.
add_library(traffic_light_sm STATIC)
hsm_generate(TARGET traffic_light_sm
    MODELS ../traffic-light.hsm
    NAMESPACE example
    STD 17)

# 2. A generator configuration (hsm.gen.json): CdPlayer.hpp / CdPlayer.cc with a license header.
add_library(cd_player_sm STATIC)
hsm_generate(TARGET cd_player_sm CONFIG hsm.gen.json STD 17)

# The application: a host with a std::chrono timer service and operation callbacks.
add_executable(traffic_light main.cpp)
target_link_libraries(traffic_light PRIVATE traffic_light_sm)

# A C++ test driving the generated classes with a virtual clock.
enable_testing()
add_executable(statemachine_tests tests/statemachine_tests.cpp)
target_link_libraries(statemachine_tests PRIVATE traffic_light_sm cd_player_sm)
add_test(NAME statemachine_tests COMMAND statemachine_tests)

# The model unit tests (.hsmtest) run by `hsm test`; JUnit reports in <build>/hsm_test_results.
hsm_add_tests(TARGET models
    TESTS ../tests/traffic-light.hsmtest ../tests/cd-player.hsmtest
    MODELS ../traffic-light.hsm ../cd-player.hsm)
