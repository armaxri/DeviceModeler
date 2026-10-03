# DevmGenerate.cmake - build integration of the code generator of the Device Modeler (devm).
#
#   list(APPEND CMAKE_MODULE_PATH "<repository>/cmake")
#   include(DevmGenerate)            # or: find_package(Devm CONFIG REQUIRED PATHS "<repository>/cmake")
#
#   add_library(statemachines STATIC)
#   devm_generate(TARGET statemachines MODELS models/traffic-light.devm NAMESPACE app STD 17)
#   devm_add_tests(TARGET statemachines TESTS tests/traffic-light.devmtest MODELS models/traffic-light.devm)
#
# devm_generate(TARGET <target>
#              [MODELS <file.devm>...]       models (relative to the current source directory)
#              [CONFIG <devm.gen.json>]      generator configuration (models, per target options)
#              [GENERATOR cpp|c]            target language (default: cpp with MODELS, all targets of CONFIG)
#              [OUTPUT_DIR <dir>]           default: ${CMAKE_CURRENT_BINARY_DIR}/devm_generated/<target>
#              [NAMESPACE <ns>]             cpp: namespace (a::b), "" for the global namespace
#              [STD 17|11]                  cpp: C++ standard of the generated code (also required from the target)
#              [PREFIX <prefix>]            c: prefix of the generated functions and files
#              [INCLUDE_DIRS <dir>...]      include directories of imported C/C++ headers (devm -I; also added
#                                           to the include directories of <target>)
#              [DEFINES <NAME[=VALUE]>...]) macros for the analysis of imported headers (devm -D; also added
#                                           to the compile definitions of <target>)
#
#   Generates the code at build time: the generated files are determined at configure time
#   (devm generate --list-outputs) and added to the sources of <target>; OUTPUT_DIR is added to its
#   include directories (PUBLIC for libraries, PRIVATE for executables). The code is regenerated when
#   a model, the configuration or a license header file changes; only files whose contents changed are
#   rewritten, so only they are recompiled. If the set of generated files changes (e.g. a state machine
#   is renamed), the build fails once and CMake re-runs on the next build. The generation runs in the
#   custom target <target>_devm_generate (<target>_devm_generate_<n> for further calls for the same
#   target; each call needs its own OUTPUT_DIR, which is the default).
#   With CONFIG, the outDir of the configuration is ignored (OUTPUT_DIR is used) and the models of the
#   configuration are used unless MODELS is given; globs in the configuration are expanded at configure
#   time (re-run CMake after adding a model).
#   Models importing C/C++ headers (import "motor_types.h", docs/cpp-integration.md) are regenerated when
#   an imported header (or a header it includes) changes. The generated header includes them by the
#   import path if they are found in an include directory (INCLUDE_DIRS or the headers block of CONFIG,
#   which the target needs as include directory, too), else by their path relative to OUTPUT_DIR.
#
# devm_add_tests(TARGET <name> TESTS <file.devmtest>... [MODELS <file.devm>...] [JUNIT_DIR <dir>]
#               [INCLUDE_DIRS <dir>...] [DEFINES <NAME[=VALUE]>...])
#
#   Registers one CTest test per .devmtest file (named <name>.<file stem>, label "devm") running
#   `devm test <file> --machine <models> --junit <JUNIT_DIR>/<file stem>.xml`
#   (default JUNIT_DIR: ${CMAKE_CURRENT_BINARY_DIR}/devm_test_results).
#
# The devm command line tool is found in this order:
#   1. the cache variable DEVM_EXECUTABLE (a command, e.g. "/usr/local/bin/devm" or "node;/path/to/cli.js")
#   2. node + packages/language/bin/cli.js of the Device Modeler repository containing this file (after
#      `npm ci && npm run build -w packages/language`)
#   3. `devm` in the PATH (`npm install -g <repository>/packages/language`, or a package made with `npm pack`)
#   4. `npx --no-install devm` in the source directory (devm-language installed as a dev dependency)

include_guard(GLOBAL)
cmake_minimum_required(VERSION 3.20)

set(_DEVM_CMAKE_DIR "${CMAKE_CURRENT_LIST_DIR}")
set(DEVM_EXECUTABLE "" CACHE STRING "Command running the devm command line tool (a list, e.g. 'node;/path/to/cli.js'); empty: auto-detect")

# Sets DEVM_COMMAND (a list) to the command running the devm command line tool.
function(_devm_find_command)
    if(DEVM_EXECUTABLE)
        get_property(reported GLOBAL PROPERTY _DEVM_REPORTED)
        if(NOT reported)
            list(JOIN DEVM_EXECUTABLE " " text)
            message(STATUS "devm: using ${text} (DEVM_EXECUTABLE)")
            set_property(GLOBAL PROPERTY _DEVM_REPORTED TRUE)
        endif()
        set(DEVM_COMMAND "${DEVM_EXECUTABLE}" PARENT_SCOPE)
        return()
    endif()
    if(_DEVM_DETECTED_COMMAND)
        set(DEVM_COMMAND "${_DEVM_DETECTED_COMMAND}" PARENT_SCOPE)
        return()
    endif()
    set(command "")
    find_program(DEVM_NODE_EXECUTABLE NAMES node nodejs)
    get_filename_component(repo_cli "${_DEVM_CMAKE_DIR}/../packages/language/bin/cli.js" ABSOLUTE)
    get_filename_component(repo_main "${_DEVM_CMAKE_DIR}/../packages/language/out/cli/main.js" ABSOLUTE)
    if(DEVM_NODE_EXECUTABLE AND EXISTS "${repo_cli}" AND EXISTS "${repo_main}")
        set(command "${DEVM_NODE_EXECUTABLE}" "${repo_cli}")
    endif()
    if(NOT command)
        find_program(DEVM_CLI_PROGRAM NAMES devm devm.cmd)
        if(DEVM_CLI_PROGRAM)
            set(command "${DEVM_CLI_PROGRAM}")
        endif()
    endif()
    if(NOT command)
        find_program(DEVM_NPX_EXECUTABLE NAMES npx npx.cmd)
        if(DEVM_NPX_EXECUTABLE)
            execute_process(COMMAND "${DEVM_NPX_EXECUTABLE}" --no-install devm --help
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" RESULT_VARIABLE result OUTPUT_QUIET ERROR_QUIET)
            if(result EQUAL 0)
                set(command "${DEVM_NPX_EXECUTABLE}" --no-install devm)
            endif()
        endif()
    endif()
    if(NOT command)
        set(hint "")
        if(EXISTS "${repo_cli}")
            set(hint " The Device Modeler repository at ${_DEVM_CMAKE_DIR}/.. is not built: run `npm ci && npm run build -w packages/language` there.")
        endif()
        message(FATAL_ERROR "devm: command line tool not found.${hint} Install it with `npm install -g <repository>/packages/language` "
            "or set DEVM_EXECUTABLE (e.g. -DDEVM_EXECUTABLE=\"node;/path/to/repository/packages/language/bin/cli.js\").")
    endif()
    list(JOIN command " " text)
    message(STATUS "devm: using ${text}")
    set(_DEVM_DETECTED_COMMAND "${command}" CACHE INTERNAL "Detected command of the devm command line tool")
    set(DEVM_COMMAND "${command}" PARENT_SCOPE)
endfunction()

# Runs `devm <args>` at configure time and stores the printed lines as a list in <out>.
function(_devm_query out)
    execute_process(COMMAND ${DEVM_COMMAND} ${ARGN}
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
        RESULT_VARIABLE result OUTPUT_VARIABLE output ERROR_VARIABLE errors)
    if(NOT result EQUAL 0)
        list(JOIN ARGN " " text)
        message(FATAL_ERROR "devm ${text} failed:\n${errors}")
    endif()
    string(STRIP "${output}" output)
    if(output STREQUAL "")
        set(lines "")
    else()
        string(REPLACE "\r" "" output "${output}")
        string(REPLACE ";" "\\;" output "${output}")
        string(REPLACE "\n" ";" lines "${output}")
    endif()
    set(${out} "${lines}" PARENT_SCOPE)
endfunction()

function(devm_generate)
    cmake_parse_arguments(PARSE_ARGV 0 DEVM "" "TARGET;CONFIG;GENERATOR;OUTPUT_DIR;NAMESPACE;STD;PREFIX" "MODELS;INCLUDE_DIRS;DEFINES")
    if(DEVM_UNPARSED_ARGUMENTS)
        message(FATAL_ERROR "devm_generate: unknown arguments ${DEVM_UNPARSED_ARGUMENTS}")
    endif()
    if(NOT DEVM_TARGET)
        message(FATAL_ERROR "devm_generate: TARGET is required")
    endif()
    if(NOT TARGET ${DEVM_TARGET})
        message(FATAL_ERROR "devm_generate: ${DEVM_TARGET} is not a target (create it with add_library / add_executable first)")
    endif()
    if(NOT DEVM_MODELS AND NOT DEVM_CONFIG)
        message(FATAL_ERROR "devm_generate(${DEVM_TARGET}): MODELS or CONFIG is required")
    endif()
    if(DEVM_GENERATOR AND NOT DEVM_GENERATOR MATCHES "^(cpp|c)$")
        message(FATAL_ERROR "devm_generate(${DEVM_TARGET}): GENERATOR must be cpp or c")
    endif()
    if(DEFINED DEVM_STD AND NOT DEVM_STD MATCHES "^(11|17)$")
        message(FATAL_ERROR "devm_generate(${DEVM_TARGET}): STD must be 17 or 11")
    endif()
    if(DEVM_MODELS AND NOT DEVM_GENERATOR)
        set(DEVM_GENERATOR cpp)
    endif()
    # several calls for one target: numbered names of the generation targets and output directories
    get_target_property(count ${DEVM_TARGET} _DEVM_GENERATE_COUNT)
    if(NOT count)
        set(count 0)
    endif()
    math(EXPR count "${count} + 1")
    set_target_properties(${DEVM_TARGET} PROPERTIES _DEVM_GENERATE_COUNT ${count})
    set(name "${DEVM_TARGET}_devm_generate")
    if(count GREATER 1)
        string(APPEND name "_${count}")
    endif()
    if(NOT DEVM_OUTPUT_DIR)
        set(DEVM_OUTPUT_DIR "${CMAKE_CURRENT_BINARY_DIR}/devm_generated/${DEVM_TARGET}")
        if(count GREATER 1)
            string(APPEND DEVM_OUTPUT_DIR "_${count}")
        endif()
    endif()
    get_filename_component(DEVM_OUTPUT_DIR "${DEVM_OUTPUT_DIR}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_BINARY_DIR}")
    _devm_find_command()

    # arguments of `devm generate`
    set(args generate)
    if(DEVM_GENERATOR)
        list(APPEND args ${DEVM_GENERATOR})
    endif()
    foreach(model IN LISTS DEVM_MODELS)
        get_filename_component(model "${model}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        list(APPEND args "${model}")
    endforeach()
    if(DEVM_CONFIG)
        get_filename_component(DEVM_CONFIG "${DEVM_CONFIG}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        list(APPEND args --config "${DEVM_CONFIG}")
    endif()
    list(APPEND args --out "${DEVM_OUTPUT_DIR}")
    if(DEFINED DEVM_NAMESPACE OR "NAMESPACE" IN_LIST DEVM_KEYWORDS_MISSING_VALUES)
        # one argument, also for "" (the global namespace)
        list(APPEND args "--namespace=${DEVM_NAMESPACE}")
    endif()
    if(DEVM_STD)
        list(APPEND args --std ${DEVM_STD})
    endif()
    if(DEVM_PREFIX)
        list(APPEND args --prefix "${DEVM_PREFIX}")
    endif()
    set(include_dirs "")
    foreach(dir IN LISTS DEVM_INCLUDE_DIRS)
        get_filename_component(dir "${dir}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        list(APPEND include_dirs "${dir}")
        list(APPEND args --include "${dir}")
    endforeach()
    foreach(define IN LISTS DEVM_DEFINES)
        list(APPEND args --define "${define}")
    endforeach()

    # configure time: inputs and outputs
    _devm_query(inputs ${args} --list-inputs)
    _devm_query(outputs ${args} --list-outputs)
    if(NOT outputs)
        message(FATAL_ERROR "devm_generate(${DEVM_TARGET}): no files to generate")
    endif()
    if(DEVM_CONFIG)
        # the configuration determines the outputs: re-run CMake when it changes
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${DEVM_CONFIG}")
    endif()
    # the outputs known to the build system; the generator fails and updates the file if they change
    set(state_dir "${CMAKE_CURRENT_BINARY_DIR}/devm_generated/.${name}")
    set(outputs_file "${state_dir}/outputs.txt")
    list(JOIN outputs "\n" outputs_text)
    set(outputs_text "${outputs_text}\n")
    set(previous "")
    if(EXISTS "${outputs_file}")
        file(READ "${outputs_file}" previous)
    endif()
    if(NOT previous STREQUAL outputs_text)
        file(WRITE "${outputs_file}" "${outputs_text}")
    endif()
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${outputs_file}")

    set(stamp "${state_dir}/generate.stamp")
    add_custom_command(
        OUTPUT "${stamp}"
        BYPRODUCTS ${outputs}
        COMMAND ${DEVM_COMMAND} ${args} --outputs-file "${outputs_file}"
        COMMAND "${CMAKE_COMMAND}" -E touch "${stamp}"
        DEPENDS ${inputs}
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
        COMMENT "Generating state machine code for ${DEVM_TARGET}"
        VERBATIM)
    add_custom_target(${name} DEPENDS "${stamp}")
    add_dependencies(${DEVM_TARGET} ${name})

    get_target_property(type ${DEVM_TARGET} TYPE)
    if(type STREQUAL "EXECUTABLE")
        set(scope PRIVATE)
    else()
        set(scope PUBLIC)
    endif()
    target_sources(${DEVM_TARGET} PRIVATE ${outputs})
    target_include_directories(${DEVM_TARGET} ${scope} "${DEVM_OUTPUT_DIR}" ${include_dirs})
    if(DEVM_DEFINES)
        target_compile_definitions(${DEVM_TARGET} ${scope} ${DEVM_DEFINES})
    endif()
    if(DEVM_GENERATOR STREQUAL "cpp" OR NOT DEVM_GENERATOR)
        if(DEVM_STD)
            target_compile_features(${DEVM_TARGET} ${scope} cxx_std_${DEVM_STD})
        elseif(DEVM_MODELS AND NOT DEVM_CONFIG)
            target_compile_features(${DEVM_TARGET} ${scope} cxx_std_17)
        endif()
    endif()
    set_property(TARGET ${DEVM_TARGET} APPEND PROPERTY DEVM_GENERATED_SOURCES ${outputs})
endfunction()

function(devm_add_tests)
    cmake_parse_arguments(PARSE_ARGV 0 DEVM "" "TARGET;JUNIT_DIR" "TESTS;MODELS;INCLUDE_DIRS;DEFINES")
    if(DEVM_UNPARSED_ARGUMENTS)
        message(FATAL_ERROR "devm_add_tests: unknown arguments ${DEVM_UNPARSED_ARGUMENTS}")
    endif()
    if(NOT DEVM_TARGET OR NOT DEVM_TESTS)
        message(FATAL_ERROR "devm_add_tests: TARGET and TESTS are required")
    endif()
    if(NOT DEVM_JUNIT_DIR)
        set(DEVM_JUNIT_DIR "${CMAKE_CURRENT_BINARY_DIR}/devm_test_results")
    endif()
    get_filename_component(DEVM_JUNIT_DIR "${DEVM_JUNIT_DIR}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_BINARY_DIR}")
    file(MAKE_DIRECTORY "${DEVM_JUNIT_DIR}")
    _devm_find_command()
    set(machines "")
    foreach(model IN LISTS DEVM_MODELS)
        get_filename_component(model "${model}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        list(APPEND machines "${model}")
    endforeach()
    foreach(test IN LISTS DEVM_TESTS)
        get_filename_component(test "${test}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        get_filename_component(stem "${test}" NAME_WE)
        set(command ${DEVM_COMMAND} test "${test}")
        if(machines)
            list(APPEND command --machine ${machines})
        endif()
        list(APPEND command --junit "${DEVM_JUNIT_DIR}/${stem}.xml")
        foreach(dir IN LISTS DEVM_INCLUDE_DIRS)
            get_filename_component(dir "${dir}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
            list(APPEND command --include "${dir}")
        endforeach()
        foreach(define IN LISTS DEVM_DEFINES)
            list(APPEND command --define "${define}")
        endforeach()
        add_test(NAME ${DEVM_TARGET}.${stem} COMMAND ${command} WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
        set_tests_properties(${DEVM_TARGET}.${stem} PROPERTIES LABELS devm)
    endforeach()
endfunction()
