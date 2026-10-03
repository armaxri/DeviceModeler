# Roadmap

Goal: the Device Modeler (formerly *HSM Modeler*) becomes a replacement for **itemis CREATE** (formerly
YAKINDU Statechart Tools): the same statechart language and semantics, plus a web-based graphical editor
with a PlantUML-like look. 🧪 The device modeling experiment (branch `claude/device-modeling`,
[Phase 7](#phase-7--device-modeler-)) adds the structure of a product around the state machines.

Status legend: ✅ done · 🚧 in progress · 📋 planned · 💭 idea / to be decided · ⛔ not planned · 🧪 experimental (separate branch)

Possible next steps are described in more detail in [docs/improvements.md](docs/improvements.md).

## Phase 0 – Foundation ✅

- ✅ Langium language, ELK layout, Sprotty diagram with PlantUML look, Monaco editor
- ✅ Graphical editing as text edits (undo, comments and formatting preserved)
- ✅ Composite states, orthogonal regions, choice, junction, shallow and deep history, final states
- ✅ SVG / PNG export (one *Export…* dialog; the PlantUML export was dropped), CLI
- ✅ SVG rendering without a browser (`devm render`, `renderSvg()`; same look and style sheet as the
  editor, Helvetica metrics for the layout in Node.js) and model documentation (`devm doc`: Markdown or HTML
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
- ✅ Imports of other state machines (`import "motor.devm"`, also `import: "a.devm" "b.devm"`): resolved
  relative to the importing file, loaded transitively (CLI, tests, language server, VS Code webview, a
  virtual file list in the web editor); missing files, cycles and duplicate names are reported
- ✅ **C++ header imports** (`import "motor_types.h"`, [docs/cpp-integration.md](docs/cpp-integration.md)):
  enums / enum classes, structs, `typedef` / `using` aliases and constants of namespaces are types and values
  of models (`var mode : motor::Mode = motor::Mode::Off`, `pos.x`, `a[i]`, `motor::kMaxSpeed`); C++ integer
  widths are kept as storage types (wrap-around on assignment, range warnings), enums compare with `==` / `!=`,
  structs are assigned as a whole; interpreter, unit tests, scenarios (14 `s10-cpp-*`), C++ generator
  (`#include`s the headers, uses the types by name), hover / definition / completion, include paths, defines
  and data model in the `headers` block of `devm.gen.json`, `-I` / `-D` / `--data-model`, VS Code settings,
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

- ✅ `.sct` importer (CLI `devm import`, "Open…" in the web editor); 213 of the 215 `.sct` files of
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
- ✅ Submachine states of statecharts imported together (`devm import A.sct B.sct`, several files in
  "Open…") become submachine instances (the reference format is assumed to be `referencedStatechart`
  with an `href`; itemis `import:` statements of the definition section are commented out)
- ⛔ Remaining differences found in the upstream models (raising `in` events inside the machine,
  operations called without parentheses, `out` events as triggers, `%` on reals) – not planned, see
  [docs/improvements.md](docs/improvements.md#differences-to-itemis-create)
- 📋 Import test suite based on real-world models from users
- ✅ Keep manual layout from `.sct` notation models (saved positions): positions, sizes, region orientation
  and bend points are imported as layout annotations into the model
  ([docs/manual-layout.md](docs/manual-layout.md); merged into main from the branch
  `claude/layout-annotations`, PR #4)

## Phase 4 – Execution ✅

- ✅ Execution semantics specified in [docs/semantics.md](docs/semantics.md): cycle-based and
  event-driven, parent-first and child-first
- ✅ Interpreter with a virtual clock (`devm simulate`)
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

- ✅ **C++ code generator – the primary target** (`devm generate cpp`, `generateCpp()`): a class per state
  machine in the style of itemis CREATE (`<Class>.h` / `.cpp` plus the runtime header `sc_statemachine.h`),
  named interfaces as nested classes, operation callbacks, out event flags and observables, timer service
  interface with ns precision, `isStateActive(State)`, runtime errors as `sc::StatemachineError` exceptions
  (the step is aborted like in the interpreter) or an error handler for code without exceptions; C++17
  (`--std 11` for C++11), no global state, no RTTI, dynamic memory only in `std::string` and the event
  queues (`std::deque`). Verified against the complete conformance suite (g++ with `-Wall -Wextra -Wpedantic
  -Werror -Wshadow -Wconversion`, clang++, optionally with sanitizers). The C and C++ generators share
  the analysis and the structure of the generated code (`src/generator/common`)
  - 📋 still missing: generating GoogleTest tests from `.devmtest` unit tests (`devm generate cpp --gtest`),
    a thread-safe wrapper / event queue for multi-threaded hosts, a fixed-capacity queue option (no heap)
    for event driven machines on small targets
- ✅ C code generator (`devm generate c`, `generateC()`): C99 without dynamic memory or global state,
  timer service and operations as host functions, error hook; verified against the complete
  conformance suite by compiling (gcc / clang, `-Wall -Wextra -Wpedantic -Werror`) and running
  every scenario. Limitations: strings live in fixed-size buffers (`<PREFIX>_STRING_CAPACITY`,
  longer strings are truncated with an error), fixed-size event queues (`<PREFIX>_QUEUE_CAPACITY`),
  runtime errors do not abort the step (the failed operation is skipped, see docs/c-generator.md), typed out
  events are always reported with their value, no C/C++ header types (a diagnostic; the `s10-cpp-*`
  scenarios are skipped)
- ✅ Unit test language for statecharts (like SCTUnit, `.devmtest`) with a test runner on the interpreter,
  `devm test` in the CLI (JUnit XML reports) and tests for all examples. Limitations: not run in the web
  editor yet; no `@Ignore`, packages / imports, call order verification or mock value sequences;
  operations of the state machine cannot be called from tests
- 💭 Further generator targets only on demand (currently none planned); they can build on the shared
  generator core (`src/generator/common`)
- ✅ Generator configuration (`devm.gen.json`, like itemis `.sgen` files) with a JSON schema: models (globs),
  per target and per model options (output directory, namespace, class name, standard, prefix, file
  extensions, license header), only changed files are written; `devm generate` (no arguments),
  `--check` for CI, `--list-outputs` / `--list-inputs` for build systems
- ✅ CMake integration (`cmake/DevmGenerate.cmake`): `devm_generate()` regenerates the code at build time when a
  model changes (only changed files are recompiled), `devm_add_tests()` runs `.devmtest` files with CTest
  (JUnit reports); example project `examples/cmake` built and tested by `npm test` (Ninja / Makefiles)
  - 📋 still missing: generated GoogleTest targets from `.devmtest` files, verification on Windows / MSVC,
    shipping the CMake module with the npm package (currently the `cmake/` directory of the repository)

## Phase 6 – Tooling 🚧

- ✅ VS Code extension (`packages/vscode`): Langium language server for `.devm` / `.devmtest` (workspace
  index, hover with doc comments, rename, formatting, semantic highlighting, …), the diagram editor of
  the web app as webview with selection sync and diagram edits applied as `WorkspaceEdit`s, theme
  following VS Code, Generate C++ (`devm.gen.json` or settings), tests and model coverage in the Test
  Explorer, `.sct` import, SVG / PNG export, `.vsix` packaging
  - 🧪 structure files (`.devm`) of the Device Modeler on the branch `claude/device-modeling`, see
    [Phase 7](#phase-7--device-modeler-)
  - limitations: the extension generates only the `cpp` target; no end-to-end
    tests in a real VS Code instance (`@vscode/test-electron` could not download VS Code) – the language
    server is tested over stdio, the webview bundle in Chromium with a mocked VS Code API
- 🚧 Multi-file projects in the web editor: a virtual file list (examples, opened and edited files) against
  which imports are resolved; several files can be opened at once; 💭 real workspaces (folders, saving
  several files)
- ✅ Manual layout adjustments, merged into main from the branch `claude/layout-annotations` (PR #4; the
  sidecar layout files of the earlier branch `claude/manual-layout` were dropped) – stored as layout
  annotations in the model (`@at`, `@size`, `@via`, …; a model with annotations has a manual layout, no
  mode switch, a model without them keeps the automatic layout); move / resize states, waypoints, label
  offsets, auto-arrange / automatic layout; layout changes are text edits (one undo history, saved with the
  model) ([docs/manual-layout.md](docs/manual-layout.md))
  - ✅ transitions of moved states are rerouted around the other states in the shape of the edge routing
    setting (orthogonal router, polyline shortcuts, splines); bend points are waypoints the route passes
    through
  - ✅ web app and VS Code extension share the diagram controller; the `.sct` import writes annotations,
    the SVG / PNG export, `devm layout|render|doc` and test coverage diagrams apply them;
    `devm migrate-layout` converts the `.devm.layout` files of the earlier sidecar experiment
  - 📋 the extension still has the version `0.1.0-manual-layout` and the display name *Device Modeler
    (manual layout)* of the experiment
  - ✅ resolved by the annotations: renames typed in the text (or via *Rename Symbol*) keep the layout;
    no second file and no separate layout undo history
  - 📋 open: the formatter puts container annotations on lines of their own while the layout writer
    appends to an existing annotation line; container annotations (`@initial`, `@final`) of elements
    deleted in the text stay until the next layout change
- ✅ Model coverage of unit tests (`devm test --coverage`): states, transitions, local reactions and guard
  decisions with per-test attribution; text, JSON, LCOV, Cobertura and HTML reports, thresholds for CI;
  `CoverageCollector` attachable to any interpreter
  - ✅ the HTML report shows the diagram with covered / uncovered elements (`renderSvg` highlights)
  - ✅ coverage view in the VS Code extension (Test Explorer coverage profile)
  - 📋 still missing: coverage view in the web simulation

## Phase 7 – Device Modeler 🧪

Experimental on the branch `claude/device-modeling`: the structure of a product modeled alongside its state
machines ([docs/structure-language.md](docs/structure-language.md), example [`examples/device`](examples/device)).

- 🧪 Renamed to **Device Modeler** (formerly *Device Modeling Framework* / *HSM Modeler*) with one file
  extension for all models: `.devm` (formerly `.hsm` for state machines and `.dmf` for structure files),
  unit tests `.devmtest` (formerly `.hsmtest`), the CLI `devm` (formerly `hsm`) and the generator
  configuration `devm.gen.json` (formerly `hsm.gen.json`). A `.devm` file contains either a state machine
  or structure elements: one Langium language whose entry rule is the alternative of both kinds
  (`src/devm.langium`, [Architecture](docs/architecture.md#one-language-for-two-kinds-of-model-files))
- 🧪 The remaining old names are gone (no compatibility aliases): npm packages `devm-language`,
  `devm-web`, `devm-vscode`; VS Code commands, settings and context keys `devm.*` (formerly `hsm.*`);
  CMake `find_package(Devm)`, `devm_generate`, `devm_add_tests`, `DEVM_EXECUTABLE` (formerly
  `find_package(Hsm)`, `hsm_generate`, `hsm_add_tests`, `HSM_EXECUTABLE`); CSS classes `devm-*`; in the
  language package `createDevmServices` / `DevmServices`, `StateMachine*` and `Structure*` services and
  the AST type `CompositeType` of subsystems and systems
- 🧪 Structure elements (`src/structure.langium` in the language package, one language with the state machines): component types with ports as **directed data flow** –
  `in` / `out` / `inout sync name : Type` (data values: simple types, structs, C/C++ header types) and
  `in` / `out async name [: Type]` (exactly one event, named like the port, with an optional payload); no
  operations, no provided / required services, no interface types –, `behavior "door.devm"` (ports mapped onto
  the interfaces of the state machine: `out sync` = `var`, `in sync` = `var readonly`, `inout sync` = `var`,
  `in` / `out async` = `in` / `out event`), `subsystem`s and the root `system` (recursive nesting; the system is
  the closed, complete top level without ports – its environment is modeled as parts, e.g. `GarageInstallation`
  with the remote control, the status display and the `GarageDoor` subsystem), threads with
  annotations (`@priority`, `@period`, `@stack`) – instances of components run in threads, instances of
  subsystems are placed outside of them –, explicit `connect` / `delegate` in the direction of the data
  (`connect out -> in`, `delegate in -> part.in`, `delegate part.out -> out`, inout with inout in any order),
  imports of structure files, state machines and headers. The earlier `provides` / `requires` ports with
  `interface` event groups were replaced by this model (the parser points to the new syntax)
- 🧪 Validation (directions, kinds, types and payloads, one source per sync in port, one sender per async in
  port, unconnected in ports, connections crossing threads, the port ↔ state
  machine mapping) and route analysis through all levels along the data flow (`routeOf`, `findSources`,
  `findTargets`, go to source)
- 🧪 Internal block diagram (SysML style, PlantUML themes, ELK with orthogonal routing): `devm render`, the
  web editor and VS Code; graphical editing as text edits (threads, instances, ports, connectors with
  compatibility feedback – incompatible ports are refused with the explanation of the validator –, rename across files, delete with the connections in other files, properties),
  route highlighting, navigation between systems, subsystems, component types and state machines
  (*Used by*, *Follow into*, back / forward; like in PlantUML a subsystem opened directly is shown on its
  own – routes end at its boundary ports –, reached from a containing structure it is shown as that part,
  with the navigation path as breadcrumb and *Follow out*), markers for problems in imported files; the structs
  of a file as unconnected «struct» boxes (types-only files show only them), port labels `name : Type`;
  notation of the data flow: hollow squares = sync data, filled squares = async events, an arrow in every
  port for the direction (in / out / inout), arrowheads at the receiving end of the connectors; palette
  with five port tools (sync in / out / inout, async in / out)
- 🧪 VS Code: structure files in the language server (references, renames and go to source across files), the
  structure diagram in the diagram webview, navigation through the extension (shared history), edits of
  several files as one `WorkspaceEdit`, all workspace `.devm` files sent to the diagrams
- 🧪 Manual layout of structure diagrams with the concept and syntax of the state machines (`@at`,
  `@size`, `@via`, `@port` for the side and offset of ports), on a layout core shared with the state machine
  diagrams (`src/diagram/layout-core`: annotation edits, placement, orthogonal routing; web: mouse
  interaction and `LayoutEditor`); connectors follow dragged instances; `devm render`, export and VS Code
  ([docs/manual-layout.md](docs/manual-layout.md#structure-diagrams))
- 📋 open follow-ups of the experiment:
  - simulation of the composed system (several state machines connected through the ports, threads and
    their periods / priorities) and code generation of the composition (instances, wiring of the generated
    state machine classes, thread setup)
  - `devm doc` for structure files (structure documentation with the diagrams, port tables, routes)
  - ports of an instance whose type is declared in another file are not editable in the diagram (edit them in
    the type)
  - renames and deletions of several files are undone together in VS Code only (the web app changes the other
    files directly); the web app has no real workspace (a virtual file list)
  - state machines cannot use the structs of structure files (shared C/C++ headers instead); a validation of
    the `behavior` of components across the instances (e.g. one state machine per thread)
  - 💭 multiplicities of ports and instances, deployment (mapping threads to cores / ECUs); copying and
    transporting the data between threads (and instances) is the job of the underlying runtime framework,
    the model describes the data flow only ([docs/structure-language.md](docs/structure-language.md#semantics-of-the-data-flow))
  - no tests in a real VS Code instance (the webview bundle is smoke-tested in Chromium with a mocked VS Code API)

## Decisions

- **C++ is the only code generation target in use.** The C++ generator (itemis CREATE style) is the
  primary target and verified against the complete conformance suite; the C generator stays available.
- **Hand-arranged layouts are layout annotations in the model.** Of the two experiments
  (`claude/manual-layout`: sidecar layout files; `claude/layout-annotations`: layout annotations in the
  model) the annotations were merged into main (PR #4): dragging / resizing in the diagram and positions
  imported from `.sct` notation models are written into the model text; a model without annotations keeps
  the automatic layout (ELK), which stays the default.
- **No exchange with itemis is planned.** The Device Modeler replaces itemis CREATE for our own models; remaining
  differences to the itemis language are only closed if our models need them.
- **The structure language is evaluated on a separate branch** (`claude/device-modeling`); it is merged
  only if modeling the structure alongside the state machines proves worthwhile.
- **Code generation improvements come later.** Submachines and C++ header types are supported by the
  language, simulation and tests first; the C++ generator catches up when needed.

## Open questions

- Is simulation or SCTUnit-style testing used in current projects?
- Are the layout annotations in the model (merged into main) acceptable in daily use, reviews and merges?
- Is the structure language (branch `claude/device-modeling`) the right level of detail for our products
  (threads, ports as directed data flow: sync data and async events), and should the composed system be
  simulated and generated?
