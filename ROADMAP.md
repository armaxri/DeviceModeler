# Roadmap

Goal: HSM Modeler becomes a replacement for **itemis CREATE** (formerly YAKINDU Statechart
Tools): the same statechart language and semantics, plus a web-based graphical editor with a
PlantUML-like look.

Status legend: ✅ done · 🚧 in progress · 📋 planned · 💭 idea / to be decided

## Phase 0 – Foundation ✅

- ✅ Langium language, ELK layout, Sprotty diagram with PlantUML look, Monaco editor
- ✅ Graphical editing as text edits (undo, comments and formatting preserved)
- ✅ Composite states, orthogonal regions, choice, junction, shallow and deep history, final states
- ✅ PlantUML export, SVG export, CLI
- ✅ SVG rendering without a browser (`hsm render`, `renderSvg()`; same look and style sheet as the
  editor, Helvetica metrics for the layout in Node.js) and model documentation (`hsm doc`: Markdown or HTML
  with diagram, interface / state / transition tables, `/** */` doc comments, also shown on hover)

## Phase 1 – Language parity with itemis CREATE ✅

- ✅ Definition section: `namespace`, annotations, named and unnamed interfaces, `internal` scope
- ✅ Declarations: `in`/`out`/internal events with payload types, `var`, `var readonly`, `const`,
  operations with (named, variable-length) parameters
- ✅ Expression language: logical, bitwise, relational, arithmetic, conditional, assignments,
  `raise`, `valueof`, `active`, casts (`as`)
- ✅ Reactions: multiple triggers, `after`/`every` time triggers, `entry`, `exit`, `always`,
  `oncycle`, `else`/`default`, guards, multi-statement effects, local reactions
- ✅ Partially qualified state names (`Active.Playing`); the same simple name may appear in
  different composite states
- ✅ Type system and full validation of expressions and declarations (types, operators,
  assignments, calls, raise/valueof, triggers, annotations, ambiguous names)
- 📋 Imports of other statecharts / header files

## Phase 2 – Structure parity ✅

- ✅ Entry points (`entry E` + `# >E`), exit nodes (`exit X` + `# X>`), synchronization (`sync`)
- ✅ Diagram rendering and palette tools for the new pseudo states
- ✅ Definition section shown as a box in the diagram (with an "Add declaration" form)
- ✅ Transition priorities shown in the diagram (toggle in the toolbar)
- 📋 Reorder priorities from the diagram
- 📋 Submachines (a state that references another statechart)
- 💭 State names with spaces (currently mapped to identifiers and the original name kept as the
  description)

## Phase 3 – Migration from itemis CREATE ✅

- ✅ `.sct` importer (CLI `hsm import`, "Open…" in the web editor); 201 of the 215 `.sct` files of
  the upstream itemis repository imported without syntax or linking errors (before the grammar
  additions below)
- ✅ Grammar additions found by the importer: events as conditions (`[e1 && x > 0]`), `x++` / `x--`,
  local reactions of the statechart itself
- 📋 Remaining gaps: `null`, type aliases, transitions handling several exit nodes or entry points at
  once, entry points with the same name in several orthogonal regions
- 📋 Import test suite based on real-world models from users
- 💭 Keep manual layout from `.sct` notation models (saved positions)

## Phase 4 – Execution ✅

- ✅ Execution semantics specified in [docs/semantics.md](docs/semantics.md): cycle-based and
  event-driven, parent-first and child-first
- ✅ Interpreter with a virtual clock (`hsm simulate`)
- ✅ Shared conformance suite (scenario tests) for the interpreter and all code generators
- ✅ Simulation in the web editor: raise events (with values), run cycles / steps, advance time or run in
  real time with a speed factor, inspect and change variables, mocked operation results, logs of out
  events, operation calls and the trace (linked to the text), animated active states, taken transitions
  and final states, simple breakpoints on states and transitions, errors linked to the model element
  - 📋 still missing: conditional breakpoints (guard expression, hit count), breakpoints on local
    reactions / events, stepping micro steps within a cycle, a timer overview (pending time events and
    their due times), recording / exporting a session as a scenario for the conformance suite,
    operation mocks with scripted results (sequences, expressions), simulation of several machines
- 📋 `@SuperSteps`, `@EventBuffering`, `@InEventQueue`

## Phase 5 – Code generation and testing ✅

- ✅ **C++ code generator – the primary target** (`hsm generate cpp`, `generateCpp()`): a class per state
  machine in the style of itemis CREATE (`<Class>.h` / `.cpp` plus the runtime header `sc_statemachine.h`),
  named interfaces as nested classes, operation callbacks, out event flags and observables, timer service
  interface with ns precision, `isStateActive(State)`, runtime errors as `sc::StatemachineError` exceptions
  (the step is aborted like in the interpreter) or an error handler for code without exceptions; C++17
  (`--std 11` for C++11), no global state, no RTTI, dynamic memory only in `std::string` and the event
  queues (`std::deque`). Verified against the complete conformance suite (g++ with `-Wall -Wextra -Wpedantic
  -Werror -Wshadow -Wconversion`, clang++, optionally with sanitizers). The C and C++ generators share
  the analysis and the structure of the generated code (`src/generator/common`)
  - 📋 still missing: generating GoogleTest tests from `.hsmtest` unit tests (`hsm generate cpp --gtest`),
    a thread-safe wrapper / event queue for multi-threaded hosts, a fixed-capacity queue option (no heap)
    for event driven machines on small targets
- ✅ C code generator (`hsm generate c`, `generateC()`): C99 without dynamic memory or global state,
  timer service and operations as host functions, error hook; verified against the complete
  conformance suite by compiling (gcc / clang, `-Wall -Wextra -Wpedantic -Werror`) and running
  every scenario. Limitations: strings live in fixed-size buffers (`<PREFIX>_STRING_CAPACITY`,
  longer strings are truncated with an error), fixed-size event queues (`<PREFIX>_QUEUE_CAPACITY`),
  runtime errors do not abort the step (the failed operation is skipped, see README), typed out
  events are always reported with their value
- ✅ Unit test language for statecharts (like SCTUnit, `.hsmtest`) with a test runner on the interpreter,
  `hsm test` in the CLI (JUnit XML reports) and tests for all examples. Limitations: not run in the web
  editor yet; no `@Ignore`, packages / imports, call order verification or mock value sequences;
  operations of the state machine cannot be called from tests
- 💭 Further generator targets only on demand (currently none planned); they can build on the shared
  generator core (`src/generator/common`)
- ✅ Generator configuration (`hsm.gen.json`, like itemis `.sgen` files) with a JSON schema: models (globs),
  per target and per model options (output directory, namespace, class name, standard, prefix, file
  extensions, license header), only changed files are written; `hsm generate` (no arguments),
  `--check` for CI, `--list-outputs` / `--list-inputs` for build systems
- ✅ CMake integration (`cmake/HsmGenerate.cmake`): `hsm_generate()` regenerates the code at build time when a
  model changes (only changed files are recompiled), `hsm_add_tests()` runs `.hsmtest` files with CTest
  (JUnit reports); example project `examples/cmake` built and tested by `npm test` (Ninja / Makefiles)
  - 📋 still missing: generated GoogleTest targets from `.hsmtest` files, verification on Windows / MSVC,
    shipping the CMake module with the npm package (currently the `cmake/` directory of the repository)

## Phase 6 – Tooling 💭

- 💭 VS Code extension (Langium language server + `sprotty-vscode` diagram)
- 💭 Multi-file projects and workspaces in the web editor
- 💭 Manual layout adjustments stored in the model
- ✅ Model coverage of unit tests (`hsm test --coverage`): states, transitions, local reactions and guard
  decisions with per-test attribution; text, JSON, LCOV, Cobertura and HTML reports, thresholds for CI;
  `CoverageCollector` attachable to any interpreter
  - ✅ the HTML report shows the diagram with covered / uncovered elements (`renderSvg` highlights)
  - 📋 still missing: coverage view in the web simulation and the VS Code extension

## Decisions

- **C++ is the only code generation target in use.** The C++ generator (itemis CREATE style) is the
  primary target and verified against the complete conformance suite; the C generator stays available.
- **Hand-arranged layouts are evaluated on the separate branch `claude/manual-layout`** (sidecar
  layout files, dragging / resizing, positions imported from `.sct` notation models). The main branch
  keeps the automatic layout; the experiment is merged only if it proves worthwhile.

## Open questions

- Is simulation or SCTUnit-style testing used in current projects?
- Is deep C/C++ header integration (using C/C++ types in the statechart) required?
