# HsmGenerate.cmake - build integration of the hsm state machine code generator.
#
#   list(APPEND CMAKE_MODULE_PATH "<hsm>/cmake")
#   include(HsmGenerate)            # or: find_package(Hsm CONFIG REQUIRED PATHS "<hsm>/cmake")
#
#   add_library(statemachines STATIC)
#   hsm_generate(TARGET statemachines MODELS models/traffic-light.hsm NAMESPACE app STD 17)
#   hsm_add_tests(TARGET statemachines TESTS tests/traffic-light.hsmtest MODELS models/traffic-light.hsm)
#
# hsm_generate(TARGET <target>
#              [MODELS <file.hsm>...]       models (relative to the current source directory)
#              [CONFIG <hsm.gen.json>]      generator configuration (models, per target options)
#              [GENERATOR cpp|c]            target language (default: cpp with MODELS, all targets of CONFIG)
#              [OUTPUT_DIR <dir>]           default: ${CMAKE_CURRENT_BINARY_DIR}/hsm_generated/<target>
#              [NAMESPACE <ns>]             cpp: namespace (a::b), "" for the global namespace
#              [STD 17|11]                  cpp: C++ standard of the generated code (also required from the target)
#              [PREFIX <prefix>]            c: prefix of the generated functions and files
#              [INCLUDE_DIRS <dir>...]      include directories of imported C/C++ headers (hsm -I; also added
#                                           to the include directories of <target>)
#              [DEFINES <NAME[=VALUE]>...]) macros for the analysis of imported headers (hsm -D; also added
#                                           to the compile definitions of <target>)
#
#   Generates the code at build time: the generated files are determined at configure time
#   (hsm generate --list-outputs) and added to the sources of <target>; OUTPUT_DIR is added to its
#   include directories (PUBLIC for libraries, PRIVATE for executables). The code is regenerated when
#   a model, the configuration or a license header file changes; only files whose contents changed are
#   rewritten, so only they are recompiled. If the set of generated files changes (e.g. a state machine
#   is renamed), the build fails once and CMake re-runs on the next build. The generation runs in the
#   custom target <target>_hsm_generate (<target>_hsm_generate_<n> for further calls for the same
#   target; each call needs its own OUTPUT_DIR, which is the default).
#   With CONFIG, the outDir of the configuration is ignored (OUTPUT_DIR is used) and the models of the
#   configuration are used unless MODELS is given; globs in the configuration are expanded at configure
#   time (re-run CMake after adding a model).
#   Models importing C/C++ headers (import "motor_types.h", docs/cpp-integration.md) are regenerated when
#   an imported header (or a header it includes) changes. The generated header includes them by the
#   import path if they are found in an include directory (INCLUDE_DIRS or the headers block of CONFIG,
#   which the target needs as include directory, too), else by their path relative to OUTPUT_DIR.
#
# hsm_add_tests(TARGET <name> TESTS <file.hsmtest>... [MODELS <file.hsm>...] [JUNIT_DIR <dir>]
#               [INCLUDE_DIRS <dir>...] [DEFINES <NAME[=VALUE]>...])
#
#   Registers one CTest test per .hsmtest file (named <name>.<file stem>, label "hsm") running
#   `hsm test <file> --machine <models> --junit <JUNIT_DIR>/<file stem>.xml`
#   (default JUNIT_DIR: ${CMAKE_CURRENT_BINARY_DIR}/hsm_test_results).
#
# The hsm command line tool is found in this order:
#   1. the cache variable HSM_EXECUTABLE (a command, e.g. "/usr/local/bin/hsm" or "node;/path/to/cli.js")
#   2. node + packages/language/bin/cli.js of the hsm repository containing this file (after
#      `npm ci && npm run build -w packages/language`)
#   3. `hsm` in the PATH (`npm install -g <hsm>/packages/language`, or a package made with `npm pack`)
#   4. `npx --no-install hsm` in the source directory (hsm-language installed as a dev dependency)

include_guard(GLOBAL)
cmake_minimum_required(VERSION 3.20)

set(_HSM_CMAKE_DIR "${CMAKE_CURRENT_LIST_DIR}")
set(HSM_EXECUTABLE "" CACHE STRING "Command running the hsm command line tool (a list, e.g. 'node;/path/to/cli.js'); empty: auto-detect")

# Sets HSM_COMMAND (a list) to the command running the hsm command line tool.
function(_hsm_find_command)
    if(HSM_EXECUTABLE)
        get_property(reported GLOBAL PROPERTY _HSM_REPORTED)
        if(NOT reported)
            list(JOIN HSM_EXECUTABLE " " text)
            message(STATUS "hsm: using ${text} (HSM_EXECUTABLE)")
            set_property(GLOBAL PROPERTY _HSM_REPORTED TRUE)
        endif()
        set(HSM_COMMAND "${HSM_EXECUTABLE}" PARENT_SCOPE)
        return()
    endif()
    if(_HSM_DETECTED_COMMAND)
        set(HSM_COMMAND "${_HSM_DETECTED_COMMAND}" PARENT_SCOPE)
        return()
    endif()
    set(command "")
    find_program(HSM_NODE_EXECUTABLE NAMES node nodejs)
    get_filename_component(repo_cli "${_HSM_CMAKE_DIR}/../packages/language/bin/cli.js" ABSOLUTE)
    get_filename_component(repo_main "${_HSM_CMAKE_DIR}/../packages/language/out/cli/main.js" ABSOLUTE)
    if(HSM_NODE_EXECUTABLE AND EXISTS "${repo_cli}" AND EXISTS "${repo_main}")
        set(command "${HSM_NODE_EXECUTABLE}" "${repo_cli}")
    endif()
    if(NOT command)
        find_program(HSM_CLI_PROGRAM NAMES hsm hsm.cmd)
        if(HSM_CLI_PROGRAM)
            set(command "${HSM_CLI_PROGRAM}")
        endif()
    endif()
    if(NOT command)
        find_program(HSM_NPX_EXECUTABLE NAMES npx npx.cmd)
        if(HSM_NPX_EXECUTABLE)
            execute_process(COMMAND "${HSM_NPX_EXECUTABLE}" --no-install hsm --help
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" RESULT_VARIABLE result OUTPUT_QUIET ERROR_QUIET)
            if(result EQUAL 0)
                set(command "${HSM_NPX_EXECUTABLE}" --no-install hsm)
            endif()
        endif()
    endif()
    if(NOT command)
        set(hint "")
        if(EXISTS "${repo_cli}")
            set(hint " The hsm repository at ${_HSM_CMAKE_DIR}/.. is not built: run `npm ci && npm run build -w packages/language` there.")
        endif()
        message(FATAL_ERROR "hsm: command line tool not found.${hint} Install it with `npm install -g <hsm>/packages/language` "
            "or set HSM_EXECUTABLE (e.g. -DHSM_EXECUTABLE=\"node;/path/to/hsm/packages/language/bin/cli.js\").")
    endif()
    list(JOIN command " " text)
    message(STATUS "hsm: using ${text}")
    set(_HSM_DETECTED_COMMAND "${command}" CACHE INTERNAL "Detected command of the hsm command line tool")
    set(HSM_COMMAND "${command}" PARENT_SCOPE)
endfunction()

# Runs `hsm <args>` at configure time and stores the printed lines as a list in <out>.
function(_hsm_query out)
    execute_process(COMMAND ${HSM_COMMAND} ${ARGN}
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
        RESULT_VARIABLE result OUTPUT_VARIABLE output ERROR_VARIABLE errors)
    if(NOT result EQUAL 0)
        list(JOIN ARGN " " text)
        message(FATAL_ERROR "hsm ${text} failed:\n${errors}")
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

function(hsm_generate)
    cmake_parse_arguments(PARSE_ARGV 0 HSM "" "TARGET;CONFIG;GENERATOR;OUTPUT_DIR;NAMESPACE;STD;PREFIX" "MODELS;INCLUDE_DIRS;DEFINES")
    if(HSM_UNPARSED_ARGUMENTS)
        message(FATAL_ERROR "hsm_generate: unknown arguments ${HSM_UNPARSED_ARGUMENTS}")
    endif()
    if(NOT HSM_TARGET)
        message(FATAL_ERROR "hsm_generate: TARGET is required")
    endif()
    if(NOT TARGET ${HSM_TARGET})
        message(FATAL_ERROR "hsm_generate: ${HSM_TARGET} is not a target (create it with add_library / add_executable first)")
    endif()
    if(NOT HSM_MODELS AND NOT HSM_CONFIG)
        message(FATAL_ERROR "hsm_generate(${HSM_TARGET}): MODELS or CONFIG is required")
    endif()
    if(HSM_GENERATOR AND NOT HSM_GENERATOR MATCHES "^(cpp|c)$")
        message(FATAL_ERROR "hsm_generate(${HSM_TARGET}): GENERATOR must be cpp or c")
    endif()
    if(DEFINED HSM_STD AND NOT HSM_STD MATCHES "^(11|17)$")
        message(FATAL_ERROR "hsm_generate(${HSM_TARGET}): STD must be 17 or 11")
    endif()
    if(HSM_MODELS AND NOT HSM_GENERATOR)
        set(HSM_GENERATOR cpp)
    endif()
    # several calls for one target: numbered names of the generation targets and output directories
    get_target_property(count ${HSM_TARGET} _HSM_GENERATE_COUNT)
    if(NOT count)
        set(count 0)
    endif()
    math(EXPR count "${count} + 1")
    set_target_properties(${HSM_TARGET} PROPERTIES _HSM_GENERATE_COUNT ${count})
    set(name "${HSM_TARGET}_hsm_generate")
    if(count GREATER 1)
        string(APPEND name "_${count}")
    endif()
    if(NOT HSM_OUTPUT_DIR)
        set(HSM_OUTPUT_DIR "${CMAKE_CURRENT_BINARY_DIR}/hsm_generated/${HSM_TARGET}")
        if(count GREATER 1)
            string(APPEND HSM_OUTPUT_DIR "_${count}")
        endif()
    endif()
    get_filename_component(HSM_OUTPUT_DIR "${HSM_OUTPUT_DIR}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_BINARY_DIR}")
    _hsm_find_command()

    # arguments of `hsm generate`
    set(args generate)
    if(HSM_GENERATOR)
        list(APPEND args ${HSM_GENERATOR})
    endif()
    foreach(model IN LISTS HSM_MODELS)
        get_filename_component(model "${model}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        list(APPEND args "${model}")
    endforeach()
    if(HSM_CONFIG)
        get_filename_component(HSM_CONFIG "${HSM_CONFIG}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        list(APPEND args --config "${HSM_CONFIG}")
    endif()
    list(APPEND args --out "${HSM_OUTPUT_DIR}")
    if(DEFINED HSM_NAMESPACE OR "NAMESPACE" IN_LIST HSM_KEYWORDS_MISSING_VALUES)
        # one argument, also for "" (the global namespace)
        list(APPEND args "--namespace=${HSM_NAMESPACE}")
    endif()
    if(HSM_STD)
        list(APPEND args --std ${HSM_STD})
    endif()
    if(HSM_PREFIX)
        list(APPEND args --prefix "${HSM_PREFIX}")
    endif()
    set(include_dirs "")
    foreach(dir IN LISTS HSM_INCLUDE_DIRS)
        get_filename_component(dir "${dir}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        list(APPEND include_dirs "${dir}")
        list(APPEND args --include "${dir}")
    endforeach()
    foreach(define IN LISTS HSM_DEFINES)
        list(APPEND args --define "${define}")
    endforeach()

    # configure time: inputs and outputs
    _hsm_query(inputs ${args} --list-inputs)
    _hsm_query(outputs ${args} --list-outputs)
    if(NOT outputs)
        message(FATAL_ERROR "hsm_generate(${HSM_TARGET}): no files to generate")
    endif()
    if(HSM_CONFIG)
        # the configuration determines the outputs: re-run CMake when it changes
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${HSM_CONFIG}")
    endif()
    # the outputs known to the build system; the generator fails and updates the file if they change
    set(state_dir "${CMAKE_CURRENT_BINARY_DIR}/hsm_generated/.${name}")
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
        COMMAND ${HSM_COMMAND} ${args} --outputs-file "${outputs_file}"
        COMMAND "${CMAKE_COMMAND}" -E touch "${stamp}"
        DEPENDS ${inputs}
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
        COMMENT "Generating state machine code for ${HSM_TARGET}"
        VERBATIM)
    add_custom_target(${name} DEPENDS "${stamp}")
    add_dependencies(${HSM_TARGET} ${name})

    get_target_property(type ${HSM_TARGET} TYPE)
    if(type STREQUAL "EXECUTABLE")
        set(scope PRIVATE)
    else()
        set(scope PUBLIC)
    endif()
    target_sources(${HSM_TARGET} PRIVATE ${outputs})
    target_include_directories(${HSM_TARGET} ${scope} "${HSM_OUTPUT_DIR}" ${include_dirs})
    if(HSM_DEFINES)
        target_compile_definitions(${HSM_TARGET} ${scope} ${HSM_DEFINES})
    endif()
    if(HSM_GENERATOR STREQUAL "cpp" OR NOT HSM_GENERATOR)
        if(HSM_STD)
            target_compile_features(${HSM_TARGET} ${scope} cxx_std_${HSM_STD})
        elseif(HSM_MODELS AND NOT HSM_CONFIG)
            target_compile_features(${HSM_TARGET} ${scope} cxx_std_17)
        endif()
    endif()
    set_property(TARGET ${HSM_TARGET} APPEND PROPERTY HSM_GENERATED_SOURCES ${outputs})
endfunction()

function(hsm_add_tests)
    cmake_parse_arguments(PARSE_ARGV 0 HSM "" "TARGET;JUNIT_DIR" "TESTS;MODELS;INCLUDE_DIRS;DEFINES")
    if(HSM_UNPARSED_ARGUMENTS)
        message(FATAL_ERROR "hsm_add_tests: unknown arguments ${HSM_UNPARSED_ARGUMENTS}")
    endif()
    if(NOT HSM_TARGET OR NOT HSM_TESTS)
        message(FATAL_ERROR "hsm_add_tests: TARGET and TESTS are required")
    endif()
    if(NOT HSM_JUNIT_DIR)
        set(HSM_JUNIT_DIR "${CMAKE_CURRENT_BINARY_DIR}/hsm_test_results")
    endif()
    get_filename_component(HSM_JUNIT_DIR "${HSM_JUNIT_DIR}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_BINARY_DIR}")
    file(MAKE_DIRECTORY "${HSM_JUNIT_DIR}")
    _hsm_find_command()
    set(machines "")
    foreach(model IN LISTS HSM_MODELS)
        get_filename_component(model "${model}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        list(APPEND machines "${model}")
    endforeach()
    foreach(test IN LISTS HSM_TESTS)
        get_filename_component(test "${test}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        get_filename_component(stem "${test}" NAME_WE)
        set(command ${HSM_COMMAND} test "${test}")
        if(machines)
            list(APPEND command --machine ${machines})
        endif()
        list(APPEND command --junit "${HSM_JUNIT_DIR}/${stem}.xml")
        foreach(dir IN LISTS HSM_INCLUDE_DIRS)
            get_filename_component(dir "${dir}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
            list(APPEND command --include "${dir}")
        endforeach()
        foreach(define IN LISTS HSM_DEFINES)
            list(APPEND command --define "${define}")
        endforeach()
        add_test(NAME ${HSM_TARGET}.${stem} COMMAND ${command} WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
        set_tests_properties(${HSM_TARGET}.${stem} PROPERTIES LABELS hsm)
    endforeach()
endfunction()
