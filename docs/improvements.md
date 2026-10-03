# Possible improvements

A collected list of improvements that are known but not implemented yet, grouped by area. The
[roadmap](../ROADMAP.md) tracks what has been done; this document describes what could come next,
why it would be useful and roughly how it could be done. Nothing here is scheduled – pick items when
a real need shows up (ideally found with real models).

Effort estimates: **S** a few hours · **M** a few days · **L** a week or more.

## Code generation (C++)

Code generation is planned "much later"; these items are the known gaps of the existing C++ generator.

| Improvement | Why | How | Effort |
| --- | --- | --- | --- |
| Submachine instances in generated code | Models with `var motor : Motor` / `state Moving : motor` can be simulated and tested, but not generated yet (the generators report a diagnostic) | Generate the instance as a member of the parent class, forward the step order and event visibility of [semantics §9](semantics.md); enable the 19 skipped `s9-*` scenarios | L |
| GoogleTest from `.devmtest` | Run the unit tests against the compiled C++ code, not only against the interpreter; CTest targets via `devm_add_tests` | Translate test operations to `TEST()` functions: `raise` → `raise_x()`, `proceed` → run cycles with a virtual timer service, mocks → generated operation callback classes | M |
| Tracing hooks | Log state changes on the target; later animate the diagram live from a running device | Optional observer interface (`onStateEntered`, `onStateExited`, `onTransition`) called from the generated code, zero cost when not set | S–M |
| Thread-safe in-event queue (`@InEventQueue`) | Raise events from other threads (drivers, ISRs, worker threads) | Optional generated wrapper with a mutex-protected or lock-free queue drained at the beginning of `runCycle()` | M |
| Fixed-capacity queues without heap | Event driven machines on small targets without dynamic memory | Template parameter / option for a ring buffer instead of `std::deque`, overflow reported via the error handler | S |
| `@SuperSteps`, `@EventBuffering` | Remaining execution-semantics options of itemis CREATE (currently a warning) | Specify in [semantics.md](semantics.md), implement in interpreter and generators, add scenarios | M |
| Remove the C generator | Only C++ is used; the C generator doubles the maintenance of the shared generator core | Delete `src/generator/c`, its tests and CLI target; the shared core stays | S |

## Language and C++ integration

| Improvement | Why | How | Effort |
| --- | --- | --- | --- |
| Struct literals (`motor::Position{1, 2}`) | Assign / pass struct values without member-wise assignments | New primary expression with positional / designated initializers, typed against the header struct | M |
| `==` of structs with a user-defined `operator==` | Compare header structs in guards | Detect `operator==` declarations in the header analyzer; interpreter compares member-wise | S–M |
| Header functions as operations | Declare operations once in C++ and use them in the model | Map free function declarations of imported headers to operations (callbacks still implemented by the host) | M |
| Templates other than `std::array` | Use more header types (`std::optional`, own templates) | Case by case; `std::optional` would need a notion of "no value" in the type system | L |
| Unsaved header edits in VS Code | Headers are read from disk; edits are seen after saving | Let the language server use open text documents for headers | S |
| Headers in the web editor | The web editor can hover header declarations but not show or navigate into them | Open headers read-only in Monaco from the virtual file list | S |
| Nested member access of instances (`motor.sub.x`) | Only one level of instance member access is supported | Extend the member-access linker to nested instances | M |
| State names with spaces | itemis names like `Door Open` become `Door_Open` (original kept as description) | Allow quoted names (`state "Door Open"`) and quoted references; generated identifiers stay sanitized | M |

## Editor, diagram and VS Code

| Improvement | Why | How | Effort |
| --- | --- | --- | --- |
| Test in a real VS Code instance | The extension was only tested with the language server over stdio and the webview with a mocked API | Run `@vscode/test-electron` end-to-end tests in CI (download is possible on GitHub runners) | M |
| Reorder transition priorities in the diagram | Priorities are the text order today | Context action "raise / lower priority" moving the transition text | S |
| Expand submachine states | See the states of the referenced machine inside the submachine state (read-only), especially while simulating | Lay out the referenced machine inside the state, mark it read-only | M |
| Refactorings | Restructuring bigger machines by hand is tedious | "Group states into composite state", "extract submachine" (creates a new file + instance), "inline submachine" as `ModelEditor` operations | M |
| Real workspaces in the web editor | The web editor keeps a flat virtual file list | Folder structure, saving several files (File System Access API or a small local server `devm serve`) | M–L |
| Hand-arranged layouts | Keep diagrams arranged by hand, e.g. migrated itemis diagrams | Done: layout annotations `@at`, `@via`, … in the model, also in VS Code, merged into main from the branch `claude/layout-annotations` (PR #4; the earlier branch `claude/manual-layout` used sidecar `.layout` files) | – |

## Simulation and testing

| Improvement | Why | How | Effort |
| --- | --- | --- | --- |
| Record a simulation as a test | Turn an interactive session into a regression test | Record raised events, time steps and observed states; export as `.devmtest` operation or scenario JSON | S–M |
| Conditional breakpoints, hit counts | Stop only in interesting situations | Guard expression evaluated by the interpreter; breakpoints on local reactions and events | S |
| Timer overview | See pending time events and when they fire | List the interpreter's timers with due times in the simulation panel | S |
| Mocks with scripted results | Operations returning different values per call | Sequences / expressions for mocked operations in the simulation panel and in `.devmtest` (`mock op returns (1, 2, 3)`) | S |
| Simulation of several independent machines | Interactions between machines that are not submachines | Several interpreters in one session with wiring of out events to in events | M |
| Coverage in the web simulation | Coverage exists for `devm test` and VS Code, not in the web editor | Attach a `CoverageCollector` to the web simulation and highlight the diagram | S |
| `@Ignore`, test suites, call order checks | Missing SCTUnit features | Extend the test grammar and runner | S–M |

## Build integration

| Improvement | Why | How | Effort |
| --- | --- | --- | --- |
| Ship the CMake module with the npm package | Today `cmake/DevmGenerate.cmake` is used from the repository | Add `cmake/` to the package files and document `find_package(Devm CONFIG)` with the installed path | S |
| Windows / MSVC | Only Linux (gcc / clang, Ninja / Make) is verified | CI job on `windows-latest` building the CMake example with MSVC | S–M |
| Regenerate when the `devm` CLI changes | Upgrading the tool does not trigger regeneration | Add the CLI version (or its path) to the dependencies of the custom command | S |

## Differences to itemis CREATE

No exchange with itemis is planned. The importer converts itemis models as far as possible; the
remaining language differences found in the upstream itemis models are kept as known differences
and only changed if our own models need them:

- raising `in` events inside the state machine (rejected by the Device Modeler),
- calling operations without parentheses,
- `out` events as triggers,
- `%` on real numbers,
- `import:` statements of itemis definition sections are commented out by the importer,
- the format of submachine references in `.sct` files is assumed (`referencedStatechart` with an `href`) and
  unverified.
