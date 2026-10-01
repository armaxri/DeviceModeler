# Roadmap

Goal: HSM Modeler becomes a replacement for **itemis CREATE** (formerly YAKINDU Statechart
Tools): the same statechart language and semantics, plus a web-based graphical editor with a
PlantUML-like look.

Status legend: ✅ done · 🚧 in progress · 📋 planned · 💭 idea / to be decided · ⛔ not planned · 🧪 experimental (separate branch)

Possible next steps are described in more detail in [docs/improvements.md](docs/improvements.md).

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
- ✅ Imports of other state machines (`import "motor.hsm"`, also `import: "a.hsm" "b.hsm"`): resolved
  relative to the importing file, loaded transitively (CLI, tests, language server, VS Code webview, a
  virtual file list in the web editor); missing files, cycles and duplicate names are reported
- ✅ **C++ header imports** (`import "motor_types.h"`, [docs/cpp-integration.md](docs/cpp-integration.md)):
  enums / enum classes, structs, `typedef` / `using` aliases and constants of namespaces are types and values
  of models (`var mode : motor::Mode = motor::Mode::Off`, `pos.x`, `a[i]`, `motor::kMaxSpeed`); C++ integer
  widths are kept as storage types (wrap-around on assignment, range warnings), enums compare with `==` / `!=`,
  structs are assigned as a whole; interpreter, unit tests, scenarios (14 `s10-cpp-*`), C++ generator
  (`#include`s the headers, uses the types by name), hover / definition / completion, include paths, defines
  and data model in the `headers` block of `hsm.gen.json`, `-I` / `-D` / `--data-model`, VS Code settings,
  headers re-read on change; web app: headers in the virtual file list, editors for enum and struct values
  in the simulation. Example [`examples/cpp-types`](examples/cpp-types) (also built by the CMake example)
  - 📋 still missing: struct literals (`motor::Position{1, 2}`), `==` of structs with a user-defined
    `operator==`, C headers for the C generator (C enums / structs / typedefs), templates other than
    `std::array`, whole-array assignment of C arrays, unsaved header edits in VS Code (headers are read from
    disk), viewing headers in the web editor, go to definition into headers in the web editor
  - 💭 functions of headers as operations (callbacks generated from declarations)

## Phase 2 – Structure parity ✅

- ✅ Entry points (`entry E` + `# >E`), exit nodes (`exit X` + `# X>`), synchronization (`sync`)
- ✅ Diagram rendering and palette tools for the new pseudo states
- ✅ Definition section shown as a box in the diagram (with an "Add declaration" form)
- ✅ Transition priorities shown in the diagram (toggle in the toolbar)
- 📋 Reorder priorities from the diagram
- ✅ Submachines: instances of imported state machines (`var motor : Motor`) bound to states
  (`state Moving : motor`), accessed through their interfaces (`raise motor.start`, `motor.stopped`,
  `motor.speed`, `active(motor.On)`), entered through entry points (`# >Run`), left through exit nodes
  (`# Failed>`); semantics in [docs/semantics.md §9](docs/semantics.md), 19 conformance scenarios,
  interpreter, validation, unit tests (`assert active(motor.On)`, `mock motor.op`), diagram (`Moving : Motor`,
  submachine icon, entry / exit points on the border, active states of the instance in the simulation,
  double-click opens the state machine), web editor and VS Code
  - 📋 C / C++ generator support (the generators report "submachine instances are not supported yet")
  - 💭 expanding a submachine state in the diagram (read-only view of the states of the instance);
    instances of the same machine in several states; completion transitions of instances
- 💭 State names with spaces (currently mapped to identifiers and the original name kept as the
  description)

## Phase 3 – Migration from itemis CREATE ✅

- ✅ `.sct` importer (CLI `hsm import`, "Open…" in the web editor); 213 of the 215 `.sct` files of
  the upstream itemis repository are imported without syntax or linking errors (201 before the grammar
  additions below; the remaining two use outdated syntax that itemis CREATE rejects as well)
- ✅ Grammar additions found by the importer: events as conditions (`[e1 && x > 0]`), `x++` / `x--`,
  local reactions of the statechart itself
- ✅ `null` literal (only compatible with `string`, denotes the empty string in all implementations)
- ✅ Type aliases (`alias Name : type`, chains, cycles reported; generators use the base type)
- ✅ Transitions handling several exit nodes (`# X1> X2>`) or selecting several entry points
  (`# >E1 >E2`, only the first one is used like in itemis CREATE)
- ✅ Entry points / exit nodes with the same name in several orthogonal regions (`# >failure` enters
  every region through its `failure` entry point)
- ✅ Submachine states of statecharts imported together (`hsm import A.sct B.sct`, several files in
  "Open…") become submachine instances (the reference format is assumed to be `referencedStatechart`
  with an `href`; itemis `import:` statements of the definition section are commented out)
- ⛔ Remaining differences found in the upstream models (raising `in` events inside the machine,
  operations called without parentheses, `out` events as triggers, `%` on reals) – not planned, see
  [docs/improvements.md](docs/improvements.md#differences-to-itemis-create)
- 📋 Import test suite based on real-world models from users
- 🧪 Keep manual layout from `.sct` notation models (saved positions): experimental on the branch
  `claude/manual-layout` – positions, sizes, region orientation and bend points are imported into
  `<model>.hsm.layout` ([docs/manual-layout.md](docs/manual-layout.md))

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
  runtime errors do not abort the step (the failed operation is skipped, see docs/c-generator.md), typed out
  events are always reported with their value, no C/C++ header types (a diagnostic; the `s10-cpp-*`
  scenarios are skipped)
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

## Phase 6 – Tooling 🚧

- ✅ VS Code extension (`packages/vscode`): Langium language server for `.hsm` / `.hsmtest` (workspace
  index, hover with doc comments, rename, formatting, semantic highlighting, …), the diagram editor of
  the web app as webview with selection sync and diagram edits applied as `WorkspaceEdit`s, theme
  following VS Code, Generate C++ (`hsm.gen.json` or settings), tests and model coverage in the Test
  Explorer, `.sct` import, SVG / PlantUML export, `.vsix` packaging
  - limitations: no hand-arranged layout on the main branch (see below); the extension generates only the `cpp` target; no end-to-end
    tests in a real VS Code instance (`@vscode/test-electron` could not download VS Code) – the language
    server is tested over stdio, the webview bundle in Chromium with a mocked VS Code API
- 🚧 Multi-file projects in the web editor: a virtual file list (examples, opened and edited files) against
  which imports are resolved; several files can be opened at once; 💭 real workspaces (folders, saving
  several files)
- 🧪 Manual layout adjustments: experimental on the branch `claude/manual-layout` – stored in a sidecar
  file `<model>.hsm.layout` instead of the model; move / resize states, waypoints, label offsets,
  auto-arrange / reset, undo shared with the text ([docs/manual-layout.md](docs/manual-layout.md))
  - 🧪 transitions of moved states are rerouted around the other states in the shape of the edge routing
    setting (orthogonal router, polyline shortcuts, splines); bend points are waypoints the route passes
    through
  - 🧪 in the VS Code extension of the branch (`hsm-vscode-0.1.0-manual-layout.vsix`, *HSM Modeler
    (manual layout)*): the webview uses the shared diagram controller; the extension reads / writes /
    watches the `.hsm.layout` file next to the model, moves it along on renames, the `.sct` import
    writes it and the SVG export applies it; layout-only changes are undone in the diagram, layout
    changes of diagram edits together with the text (VS Code undo)
  - 📋 open: layout file not tied to saving the model (written immediately, also for unsaved models);
    renames typed in the text (or via *Rename Symbol*) do not update the keys
- ✅ Model coverage of unit tests (`hsm test --coverage`): states, transitions, local reactions and guard
  decisions with per-test attribution; text, JSON, LCOV, Cobertura and HTML reports, thresholds for CI;
  `CoverageCollector` attachable to any interpreter
  - ✅ the HTML report shows the diagram with covered / uncovered elements (`renderSvg` highlights)
  - ✅ coverage view in the VS Code extension (Test Explorer coverage profile)
  - 📋 still missing: coverage view in the web simulation

## Decisions

- **C++ is the only code generation target in use.** The C++ generator (itemis CREATE style) is the
  primary target and verified against the complete conformance suite; the C generator stays available.
- **Hand-arranged layouts are evaluated on the separate branch `claude/manual-layout`** (sidecar
  layout files, dragging / resizing, positions imported from `.sct` notation models). The main branch
  keeps the automatic layout; the experiment is merged only if it proves worthwhile.
- **No exchange with itemis is planned.** HSM replaces itemis CREATE for our own models; remaining
  differences to the itemis language are only closed if our models need them.
- **Code generation improvements come later.** Submachines and C++ header types are supported by the
  language, simulation and tests first; the C++ generator catches up when needed.

## Open questions

- Is simulation or SCTUnit-style testing used in current projects?
- Does hand-arranged layout (branch `claude/manual-layout`) prove worthwhile in daily use?
