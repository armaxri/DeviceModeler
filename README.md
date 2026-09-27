# HSM Modeler

A [Langium](https://langium.org) based modeling environment for **hierarchical state machines** with a
graphical editor built on [Sprotty](https://sprotty.org) and [ELK](https://eclipse.dev/elk/).
The diagrams look like PlantUML state diagrams, but you can edit them directly: add states, draw
transitions, nest states by drag and drop, rename in place, … Text and diagram always stay in sync.

![HSM Modeler](docs/screenshot.png)

Documentation: [execution semantics](docs/semantics.md) · [C++ integration](docs/cpp-integration.md) ·
[possible improvements](docs/improvements.md) · [roadmap](ROADMAP.md)

## Features

- **Textual DSL** (Langium): the structure of the state machine (states, regions, transitions) uses a
  PlantUML-like notation, the definition section and all reactions follow the statechart language of
  [itemis CREATE](https://www.itemis.com/en/products/itemis-create/) (formerly YAKINDU Statechart Tools):
  - **definition section**: interfaces (`in` / `out` events with optional payload types, variables,
    constants, operations), named interfaces, an `internal` scope, `namespace` and annotations such as
    `@EventDriven` or `@CycleBased(100)`
  - **reactions** `trigger, trigger [guard] / effect` with event triggers, **time events**
    (`after 10 s`, `every 200 ms`), `always`, `oncycle`, `entry`, `exit`, `else` / `default`
  - an **expression language** for guards and effects: assignments (`=`, `+=`, …), arithmetic, logical,
    bitwise and conditional operators, operation calls, `raise event : value`, `valueof(event)`,
    `active(State)`, casts with `as`
  - composite states, orthogonal regions, initial / final states, choice, junction, shallow and deep
    history, **synchronization** (`sync`, fork / join), named **entry points** and **exit nodes**
  - vertices are referenced by (partially) qualified names (`Playing`, `Active.Playing`,
    `Closed.Active.Playing`), so the same simple name can be used in different composite states
  - **imports** of other state machines (submachine instances) and of **C/C++ headers**: models use the
    enums, structs, type aliases and constants of the application's headers (`var mode : motor::Mode`,
    `pos.x = motor::kHome.x`), in the simulator, the unit tests and the generated C++ code (see
    [C/C++ header imports](#cc-header-imports))
- **Language services** in the browser: syntax highlighting, validation, code completion (events,
  variables, operations, qualified state names), formatting, go to definition, find references and
  rename (Monaco editor).
- **Validation**: duplicate names, unresolved references, missing or multiple initial transitions,
  transitions between orthogonal regions, non-deterministic transitions, unreachable states, misplaced
  history states, entry points / exit nodes / synchronizations used incorrectly, … Problems are shown in
  the editor *and* as markers in the diagram.
- **Diagram** (Sprotty + ELK layered layout) in the style of PlantUML: rounded states with name and
  compartment of local reactions (long lines are wrapped, the full text is shown as tooltip), nested
  states, dashed region separators, black initial dots, bull's-eye final states, choice diamonds,
  `H` / `H*` history circles, black synchronization bars, hollow entry point circles and crossed exit
  node circles with their names. The **definition section** is shown as a box at the top left, like in
  itemis CREATE. **Transition priorities** are shown like in itemis CREATE: if a vertex has several
  outgoing transitions, their labels are prefixed with the priority (`1: ev [g] / a`; toggle
  *Priorities* in the toolbar). Themes: *PlantUML classic* (yellow/red), *PlantUML modern* (gray) and
  *Dark*. Top-down or left-right layout, spline / orthogonal / polyline edges.
- **Graphical editing** – every diagram operation is translated into a minimal text edit, so comments
  and formatting are preserved and everything is undoable with `Ctrl+Z`:
  - palette tools for states, regions, choice, junction, history, synchronization, entry points, exit
    nodes, initial and final states and transitions
  - double-click to rename a state or to edit the label of a transition (`trigger [guard] / effect`,
    with completion of event and variable names); labels and actions are checked for syntax errors
    before they are applied
  - drag a state onto another state (or region) to nest it, onto the canvas to move it to the top level
  - properties panel for names, descriptions, entry / exit actions, reactions and to reconnect
    transitions; the panel of the definition section adds declarations (events, variables, constants,
    operations) to the right scope and creates `interface:` / `internal:` if necessary
  - `Del` deletes (including all attached transitions), `F2` renames
- **Simulation** in the editor, like the simulation view of itemis CREATE: raise events, run cycles,
  advance the virtual clock or let it run in real time (0.1× – 10×), inspect and change variables, mock
  operation results, watch out events, operation calls and the execution trace. Active states and the
  transitions just taken are highlighted in the diagram; breakpoints on states and transitions pause
  real-time mode (see [Simulation](#simulation)).
- **Selection sync**: selecting an element in the diagram highlights its text, moving the cursor in the
  text selects the element in the diagram.
- **Export**: standalone SVG, PlantUML (`.puml`, copy to clipboard or open on plantuml.com). Synchronizations
  become `<<fork>>` / `<<join>>`, entry points / exit nodes `<<entryPoint>>` / `<<exitPoint>>`, the
  definition section a legend.
- **CLI** for validation, PlantUML generation and layout computation.
- **Rendering and documentation without a browser**: `hsm render` writes the diagrams as SVG files that look
  like the editor's export, `hsm doc` generates Markdown or HTML documentation of models (diagram,
  interfaces, states, transitions and `/** … */` doc comments) – see [Rendering diagrams](#rendering-diagrams)
  and [Model documentation](#model-documentation), examples in [`docs/examples`](docs/examples/index.md).
- **Unit tests** for state machines in the style of SCTUnit (`.hsmtest` files, see [Unit tests](#unit-tests)),
  executed by the interpreter, with JUnit XML reports for CI.
- **Code generation** for **C++** (a class per state machine like itemis CREATE, see
  [Code generation (C++)](#code-generation-c)) and C99, both verified against the conformance suite of the
  interpreter by compiling and running every scenario.
- **VS Code extension** (`packages/vscode`): language server for `.hsm` / `.hsmtest`, the diagram editor
  of the web app next to the text editor, C++ generation, tests in the Test Explorer (with model
  coverage) and the itemis CREATE import – see [VS Code extension](#vs-code-extension).
- **Build integration**: a generator configuration file (`hsm.gen.json`, like the `.sgen` files of itemis
  CREATE), `hsm generate --check` for CI and CMake functions (`hsm_generate`, `hsm_add_tests`) that
  regenerate the code when a model changes (see [Build integration (CMake)](#build-integration-cmake)).

## Getting started

Requires Node.js ≥ 20.10.

```bash
npm install
npm run dev        # starts the editor on http://localhost:5173
```

Other scripts:

```bash
npm test           # unit tests of the language package and of the VS Code extension
npm run build      # langium generate + TypeScript build + web app (packages/web/dist) + extension bundles (packages/vscode/dist)
npm run typecheck
npm run package:vscode   # packages/vscode/hsm-vscode-<version>.vsix
```

### Command line

```bash
npm run build -w packages/language
node packages/language/bin/cli.js validate examples/cd-player.hsm
node packages/language/bin/cli.js plantuml examples/cd-player.hsm -o cd-player.puml
node packages/language/bin/cli.js layout examples/keyboard.hsm --direction RIGHT
node packages/language/bin/cli.js render examples -o out --theme modern     # SVG diagrams, see below
node packages/language/bin/cli.js doc examples -o docs/models --format html  # documentation, see below
node packages/language/bin/cli.js import model.sct -o model.hsm   # itemis CREATE import, see below
node packages/language/bin/cli.js simulate examples/cd-player.hsm -e play,eject,eject   # run the interpreter
node packages/language/bin/cli.js simulate examples/door.hsm --script packages/language/test/scenarios/example-door.json
node packages/language/bin/cli.js test examples/tests/*.hsmtest --machine examples --junit report.xml   # unit tests
node packages/language/bin/cli.js generate cpp examples/traffic-light.hsm -o gen   # C++ code, see below
node packages/language/bin/cli.js generate c examples/traffic-light.hsm -o gen     # C code
node packages/language/bin/cli.js generate                  # all models / targets of ./hsm.gen.json, see below
node packages/language/bin/cli.js generate --check          # exit 1 if generated files are out of date (CI)
```

## Rendering diagrams

`hsm render` computes the layout with ELK and renders the diagram as a standalone SVG file – in Node.js, without
a browser, e.g. for reviews or in CI. The SVG has the shapes, classes and style sheet of the web editor
(`DIAGRAM_CSS`, shared by both), so it looks like *Export SVG* of the editor.

```bash
hsm render model.hsm                            # writes model.svg next to the model
hsm render model.hsm -o diagram.svg --theme dark --direction RIGHT --routing ORTHOGONAL
hsm render models/ 'src/**/*.hsm' -o build/diagrams   # directories and glob patterns (also when not expanded by the shell)
```

Options: `--theme classic|modern|dark` (default `classic`), `--direction DOWN|RIGHT`, `--routing
SPLINES|ORTHOGONAL|POLYLINE`, `--no-priorities`. Only SVG is supported (no PNG: there is no pure JavaScript
rasterizer; convert with e.g. `rsvg-convert` or a browser if needed). Models with syntax errors are skipped
(exit code 1), validation errors are printed but the model is rendered.

Text is measured with a built-in table of the Helvetica character widths (Helvetica, Arial and Liberation Sans
are metric compatible) and a monospace width for the definition section, so the layout computed in Node.js is
close to the one of the editor, which measures with the browser's fonts: for the examples, text widths differ
by 1.5 % on average (at most 2 px) from Chromium with Liberation Sans, the widths of the state boxes by 0.1 %
(at most 1 px). Fonts with other metrics (e.g. *Helvetica Neue* on macOS) make the text slightly wider or
narrower than the boxes.

From code (works in the browser as well):

```ts
import { HsmModelLoader, layoutStateMachine, renderSvg } from 'hsm-language';

const { model } = await new HsmModelLoader().load(text);
const layout = await layoutStateMachine(model, { direction: 'DOWN' });
const svg = renderSvg(layout.graph, {
    theme: 'classic',                        // 'classic' | 'modern' | 'dark'
    title: 'CdPlayer – test coverage',       // optional heading above the diagram
    highlight: new Map([                     // diagram element id -> highlight
        [layout.ids.get(playingState)!, 'covered'],       // CSS class hsm-covered (green)
        [layout.ids.get(ejectTransition)!, 'uncovered'],  // CSS class hsm-uncovered (red, dashed)
        [layout.ids.get(pausedState)!, 'active']          // CSS class active (like the simulation)
    ]),                                      // any other value is used as CSS class name(s)
    legend: true,                            // legend of the used highlights (or [{ kind, label }])
    embedStyles: true,                       // false: the page embedding the SVG provides DIAGRAM_CSS
    xmlDeclaration: true                     // false for inlining into HTML
});
```

`highlight` applies to states, pseudo states (`<g class="hsm-node …">`) and transitions (`<g class="transition …">`);
the ids are those of `LayoutResult.ids` (AST node → id) and `LayoutResult.elements` (id → AST node). The
classes `hsm-covered` and `hsm-uncovered` are defined in `DIAGRAM_CSS` for all themes.

## Model documentation

`hsm doc` generates a documentation page per state machine and an index page:

```bash
hsm doc examples -o docs/examples                 # Markdown (GitHub flavored) + one SVG per machine
hsm doc 'models/**/*.hsm' -o site --format html   # self-contained HTML pages (inline SVG and styles)
```

Each page contains the description and doc comment of the state machine, the diagram, the execution semantics
(cycle based with period / event driven, parent first / child first, annotations), per interface (and the
internal scope) tables of the events (direction, type), variables and constants (type, initial value, `readonly`)
and operations (signature, return type), a table of all states and pseudo states (qualified name, kind,
description, entry / exit actions, other local reactions, sub states per region) and of all transitions
(source, target, trigger, guard, effect, priority, entry / exit point). Options: `--format md|html`, `--title`
of the index page and the diagram options of `hsm render`. `npm run docs:examples` regenerates
[`docs/examples`](docs/examples/index.md).

**Doc comments**: a `/** … */` comment directly before the state machine, an interface, a declaration, a
state, a pseudo state or a transition documents it (Markdown, JSDoc tags like `@see` are allowed). Plain
comments (`/* … */`, `// …`) are ignored.

```
/** Push button of the pedestrian crossing. */
interface Pedestrian:
    /** A pedestrian has pressed the button and waits for red. */
    var waiting : boolean = false
```

The language server shows the doc comments on hover together with the signature of the element
(`HsmDocumentationProvider`). From code: `describeStateMachine(model)` returns the collected information,
`generateModelDoc(model, { format, svg, svgFile })` and `generateDocIndex(entries, format)` render it,
`docComment(node)` returns the doc comment of an AST node.

## The language

```
// comments like in Java / TypeScript
statemachine CdPlayer "optional description" {
    @CycleBased(200)                              // execution mode (default), or @EventDriven

    interface:                                    // definition section
        in event play
        in event pause
        in event eject
        in event powerOff
        in event trackEnd
        out event finished : integer              // events may carry a value
        var track : integer = 1
        var tracks : integer = 0
        operation discInserted() : boolean        // implemented by the host application
        operation startMotor() : void

    internal:
        const MAX_TRACKS : integer = 99
        event tick

    [*] -> Closed                                 // initial transition of the state machine

    state Closed {
        [*] -> Stopped                            // initial transition of the composite state

        history H                                 // also: deephistory, choice, junction, sync
        state Stopped {
            entry / track = 1                     // local reactions: trigger [guard] / effect
        }
        state Active {
            [*] -> Playing
            state Playing {
                entry / startMotor()
                trackEnd [track < tracks] / track += 1
                every 1 s / raise tick
            }
            state Paused
            Playing -> Paused : pause
            Paused -> Playing : pause, play       // several triggers
            Paused -> Stopped : after 30 s        // time event
        }
        choice HasDisc

        Stopped -> HasDisc : play
        HasDisc -> Active : [discInserted() && tracks > 0]   // guard only
        HasDisc -> Stopped : else                 // taken if no other branch is enabled
    }

    state Open "Tray is open"                     // description shown in the state

    Closed -> Open : eject
    Open -> H : eject                             // re-enter the last active sub state
    Closed -> [*] : powerOff / raise finished : track   // transition to the final state
}
```

- **Definition section**: `interface:`, named interfaces
  (`interface Pedestrian:` – their members are referenced as `Pedestrian.request`) and `internal:`
  with `in event`, `out event`, `event`, `var`, `var readonly`, `const`, `operation` and `alias`
  declarations. Types: `integer`, `real`, `boolean`, `string`, `void` and **type aliases**
  (`alias Speed : integer`, also aliases of aliases; `Iface.Speed` for aliases of a named interface,
  the simple name works if it is unambiguous). An alias has exactly the semantics of its base type;
  the code generators use the base type. It may start with `namespace a.b` and
  annotations: `@CycleBased(period)`, `@EventDriven`, `@ParentFirstExecution`, `@ChildFirstExecution`.
- **Reactions** (transition labels and local reactions of states) have the form
  `trigger, trigger [guard] / effect`; every part is optional (a local reaction needs the effect).
  Triggers: events, `after n unit` / `every n unit` (units `s`, `ms`, `us`, `ns`), `always`,
  `oncycle`, `entry` / `exit` (local reactions only), `else` / `default` (transitions leaving a choice).
  Effects are `;`-separated statements: expressions (assignments, operation calls) and
  `raise event` / `raise event : value`.
- **Expressions**: `=`, `+=`, `-=`, `*=`, `/=`, `%=`, `<<=`, `>>=`, `&=`, `|=`, `^=`, `? :`, `||`,
  `&&`, `|`, `^`, `&`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `<<`, `>>`, `+`, `-`, `*`, `/`, `%`, `!`,
  `~`, `as` casts, literals (`true`, `42`, `0x1F`, `1.5`, `"text"`, `null`), `valueof(event)` and
  `active(State)`. `null` can only be assigned to, passed as or compared with a `string` (and `null`);
  it denotes the empty string (`s == null` is `s == ""`) in the interpreter and in the generated C and
  C++ code (`std::string` cannot be null).
- **States** are referenced by (partially) qualified names: `Playing`, `Active.Playing` or
  `Closed.Active.Playing`. A name is resolved in the scope of the transition first and then outwards,
  so sibling states must have different names, but states in different composite states may share a
  simple name. Transitions may be declared in any scope; `[*]` refers to the initial (as source) or
  final (as target) state of the scope the transition is declared in.
- **Orthogonal regions**: `state S { region A { ... } region B { ... } }` (regions may be unnamed).
- **Entry points and exit nodes** (inside a composite state `C`): `entry E` / `exit X`. A transition
  to `C` ending with `# >E` enters `C` via `E`; when `X` is reached, `C` is left by the transition
  `C -> ... # X>`. As in itemis CREATE, one transition may handle several exit nodes
  (`C -> Done # X1> X2>`), and entry points / exit nodes in different orthogonal regions of `C` may
  have the same name: `# >failure` enters every region that has an entry point `failure` through it
  (the other regions by default), and reaching any exit node `X` takes the `# X>` transition. Of
  several entry points on one transition (`# >E1 >E2`) only the first one is used (warning, like
  itemis CREATE).
- **Synchronization**: `sync S` joins several incoming transitions (from orthogonal regions) and forks
  into several outgoing transitions.
- **Priorities**: the outgoing transitions of a vertex are checked in the order of the text; the first
  enabled one is taken.
- The execution semantics are specified in [`docs/semantics.md`](docs/semantics.md). See
  [`examples/`](examples) for more: `door.hsm` shows entry points, exit nodes and fork / join,
  `traffic-light.hsm` time events and named interfaces, `keyboard.hsm` orthogonal regions,
  [`door-with-motor/`](examples/door-with-motor) imports and submachines, [`cpp-types/`](examples/cpp-types)
  the types and constants of a C++ header.

### Imports and submachines

A state machine can import other state machines and use them as **submachines**: a variable whose type
is an imported state machine is an **instance** of it, a state bound to the instance runs it while the
state is active (the instance is a separate object with its own states and variables – it is not inlined).

```
// motor.hsm                                      // gate.hsm
statemachine Motor {                              statemachine Gate {
    interface:                                        import "motor.hsm"   // relative to this file
        in event start                                interface:
        in event stop                                     in event open
        out event stopped                                 in event fast
        out event failed : integer                    internal:
        var speed : integer = 0                           var motor : Motor  // an instance of Motor
    entry Run   // entry point of the machine         [*] -> Closed
    exit Failed // exit node of the machine           state Closed
    [*] -> Off                                        state Moving : motor   // runs while Moving is active
    Run -> On                                         state Error
    state Off                                         Closed -> Moving : open / raise motor.start
    state On                                          Closed -> Moving : fast # >Run   // via entry point Run
    Off -> On : start / speed = 1                     Moving -> Closed : motor.stopped [motor.speed == 0]
    On -> Off : stop / raise stopped                  Moving -> Error : # Failed>      // exit node reached
    On -> Failed : after 5 s / raise failed : 1   }
}
```

- **Imports**: `import "path"` (several allowed, also the itemis CREATE form `import: "a.hsm" "b.hsm"`) at
  the beginning of the state machine body (before or after `namespace`). Paths are resolved relative to the
  importing file; the name of the imported state machine is a type. Missing files, import cycles, duplicate
  machine names and imports of the importing machine itself are errors. C/C++ headers (`import "types.h"`,
  `.hpp`, …) import types and constants, see [C/C++ header imports](#cc-header-imports).
- **Instances** (`var motor : Motor`, in any scope; no initial value, not `const`) are used only through
  the **interfaces** of their state machine: `raise motor.start` (its `in` events), `motor.stopped` as
  trigger or condition and `valueof(motor.failed)` (its `out` events), `motor.speed` (read and assign its
  interface variables, not constants / `readonly` ones), `motor.Iface.x` for named interfaces and
  `active(motor.On)` / `active(motor.Running.Fast)` for its states. Its internal scope, its operations and its
  own instances are not visible. Instances cannot be assigned, compared or passed around.
- **Binding**: `state Moving : motor` (a simple state – no sub states – may have local reactions). An
  instance can be bound to one state; an unbound instance is a warning (it never runs). A transition to
  the state may select an entry point of the instance's machine (`# >Run`); `Moving -> X : # Failed>` is
  taken when the instance reaches its exit node `Failed`. Entry points and exit nodes may be declared at the
  top level of a state machine for this purpose.
- **Execution** ([docs/semantics.md §9](docs/semantics.md)): the instance is entered after the entry
  reactions of its state and exited before its exit reactions; in each step it is processed like the sub
  region of its state (parent first: after the state's transitions and local reactions, child first: before
  them). Events raised on it are processed in its next processing (cycle based) or in a step of their own
  (event driven); its out events are seen by every reaction of the parent exactly once. It uses the execution
  mode and order of the parent (a warning if its machine declares others), shares the virtual clock and keeps
  its variables when it is entered again. States of instances are reported as `motor.On` (`activeStates`,
  scenarios, traces), their operations are implemented by the host as `motor.setPwm`.
- **Where imports are resolved**: CLI (`hsm validate/simulate/test/render/doc`) and API (`HsmModelLoader`,
  `HsmTestWorkspace`) read imported files transitively from disk (or from given texts); the VS Code language
  server resolves them in the workspace (a change of `motor.hsm` updates the diagnostics of `gate.hsm`, go to
  definition works on `Motor` and on the import path); the diagram webview gets the imported files from the
  extension; the web editor resolves imports against a virtual file list (the examples and the opened files;
  "Open…" accepts several files, the example list also lists the files). Double-clicking a submachine state
  opens the file of its state machine.
- The **C and C++ generators do not support submachine instances yet**; they report
  "Submachine instances are not supported by the C/C++ generator yet".

### C/C++ header imports

A model can import C/C++ headers of the application and use their **types and constants** – enums (also
`enum class`), structs with data members, `typedef` / `using` aliases, `constexpr` / `const` constants in
namespaces. Operations stay callbacks (functions and classes with methods of the headers are not used).
Example: [`examples/cpp-types`](examples/cpp-types) (a header, a model and its unit tests; it is also part of
the [CMake example](#example)).

```
// motor_types.h                                   // controller.hsm
namespace motor {                                  statemachine Controller {
/// Operating mode.                                    import "motor_types.h"
enum class Mode : std::uint8_t { Off, Slow, Fast };    interface:
struct Position {                                          in event moveTo : motor::Position
    std::int32_t x = 0;                                    in event setMode : motor::Mode
    std::int32_t y = 0;                                    var mode : motor::Mode = motor::Mode::Off
};                                                         var target : motor::Position = motor::kHome
using Rpm = std::uint16_t;                                 var speed : motor::Rpm
constexpr Rpm kMaxSpeed = 3000;                            var small : uint8_t
constexpr Position kHome{10, 20};                          operation drive(p : motor::Position) : boolean
}                                                      [*] -> Idle
                                                       state Idle
                                                       state Moving
                                                       Idle -> Moving : moveTo [valueof(moveTo).x < 500]
                                                           / target = valueof(moveTo); target.y += 1; speed = motor::kMaxSpeed
                                                       Moving -> Idle : setMode [valueof(setMode) == motor::Mode::Off]
                                                   }
```

- **Names**: C++ names are written with `::`, fully qualified from the global namespace: types
  (`motor::Mode`, `motor::Rpm`), enumerators (`motor::Mode::Fast`; enumerators of unscoped enums also as
  `motor::kStall`), constants (`motor::kMaxSpeed`, static members `motor::Limits::kVersion`). Names of the
  global namespace are written `::Color` in expressions (types also `Color`). The `<cstdint>` / `<cstddef>`
  typedefs (`uint8_t`, `std::int32_t`, `size_t`, …) are always known; C++ keywords like `int` or `double`
  are not type names of models (use `integer`, `real` or a typedef).
- **Types**: integer types are `integer`, whose values are converted to the C++ type when they are stored
  (a variable, member, event value or parameter of type `uint8_t` wraps around like in C++; constant values
  out of range are warnings); arithmetic uses 64-bit integers like all HSM integers. `float` / `double` are
  `real` (`float` rounds to single precision), `bool` is `boolean`, `std::string` is `string`
  (`const char*` / `std::string_view` constants can be read). **Enums** are types of their own: values are
  compared with `==` / `!=`; unscoped enum values convert to `integer` (flags: `faults | motor::kJam`);
  `x as motor::Mode` / `mode as integer` convert. **Structs**: members are read and assigned (`pos.x`,
  `cfg.timing.periodMs = 5`, `valueof(e).x`, `measure().y`), structs are assigned as a whole, not compared
  (no `==`). **Arrays** (`std::array<T, N>`, `T[N]` members): elements `a[i]` (checked: an index out of bounds is
  a runtime error). Unions, pointers, templates (other than `std::array`) and the like are errors where used.
- **Values**: variables of C++ types are initialized like `T{}` (default member initializers, zero otherwise,
  the enumerator with value 0). Hosts, scenarios and operation callbacks exchange plain values: enum values as
  the qualified enumerator name (`"motor::Mode::Fast"`, set also as `"Fast"` or a number), structs as objects
  (members that are not given keep their default), arrays as arrays. Traces show `motor::Mode::Fast` and
  `{x: 1, y: 2}`. The simulation panel of the web app and of VS Code edits enum values with a drop-down and the
  members of structs in expandable editors; the unit test language uses the same names and values
  (`assert mode == motor::Mode::Fast`, `mock measure returns (motor::kHome)`, `p.x = 3` for a local struct).
- **Headers** are searched relative to the importing model, then in the **include paths**; the headers they
  include (`#include "…"` / `<…>` found in the include paths) are analyzed too and their declarations are
  visible. The settings of the analysis are configured in the `headers` block of `hsm.gen.json` (include
  paths relative to the file, predefined macros for `#if`, the data model of the target, e.g. 32-bit `long`
  on microcontrollers):

  ```json
  { "models": ["models/*.hsm"], "cpp": {},
    "headers": { "includePaths": ["include"], "defines": { "USE_CAN": "1" }, "dataModel": { "longBits": 32, "pointerBits": 32 } } }
  ```

  The nearest `hsm.gen.json` / `*.hsm.gen.json` in the directory of a model or a parent directory applies (CLI,
  language server); `hsm validate|simulate|test|generate|layout|plantuml` add `-I <dir>`, `-D NAME[=VALUE]` and
  `--data-model lp64|llp64|ilp32`, VS Code the settings `hsm.headers.includePaths` / `hsm.headers.defines` /
  `hsm.headers.dataModel`, CMake `hsm_generate(… INCLUDE_DIRS … DEFINES …)`. A missing header is an error at
  the import, errors in the header are reported there with their location (`motor_types.h:12:5: …`);
  `hsm cpp-header <files>` prints what the analyzer extracts. The supported C++ subset is described in
  [docs/cpp-integration.md](docs/cpp-integration.md).
- **Tools**: hover shows the declaration, value and documentation comment of the header, go to definition
  opens the header (VS Code), completion after `motor::` lists the names of the namespace / enum and after
  `pos.` the members. The language server re-reads a header when it changes on disk and revalidates the models
  importing it; the web app accepts headers in *Open…* (they are added to its virtual file list).
- **Generated C++** `#include`s the headers and uses the types by their names (`motor::Mode mode`,
  `void raise_moveTo(const motor::Position& value)`, `std::uint8_t get_small() const`), enumerators and
  constants by name, stores with `static_cast` to the declared type. The **C generator** reports
  "C++ header types are not supported by the C generator".

## Unit tests

State machines are tested with a small test language modeled after **SCTUnit** of itemis CREATE
(files `*.hsmtest`). A test class tests one state machine; every operation annotated with `@Test` is
executed on a fresh instance of the interpreter, after the `@SetUp` operation (if any):

```
testclass CdPlayerTest for statemachine CdPlayer {

    @SetUp
    operation insertDisc() {
        mock discInserted returns (true)        // result of an operation (`mock op(1) returns (x)`: for these arguments)
        enter
        tracks = 3                              // assign variables of the state machine
    }

    @Test
    operation playsWhenDiscInserted() {
        assert active(Closed.Stopped)
        raise play                              // raise in events (`raise level : 4` with a value)
        proceed 1 cycle                         // `proceed 2 cycles`, `proceed 200 ms` (s, ms, us, ns)
        assert active(CdPlayer.Active.Playing) message "the choice selects Active"
        assert called startMotor times 1        // `assert called op with (1, true)`, `assert !called op`
        assert track == 1 && !is_final
        press(2)                                // call helper operations
    }

    operation press(count : integer) {          // operations without @Test are helpers
        var i : integer = 0                     // local variables
        while (i < count) { raise play; proceed 1 cycle; i += 1 }
        if (tracks > 0) { assert active(Playing) } else { assert false }
    }
}
```

- **Statements**: `enter`, `exit`, `raise`, `proceed`, `assert <expr> (message "...")?`,
  `assert (!)called op (with (args))? (times n)?`, `mock op ((args))? returns (value)`, `var` / `const`,
  assignments (`=`, `+=`, …, `++`, `--`), `if` / `else if` / `else`, `while`, calls of helper operations.
  Statements are separated by line breaks or `;`. The keywords of the test language (`enter`, `proceed`,
  `called`, `mock`, `returns`, `times`, `with`, `message`, `if`, `while`, …) cannot be used as names in tests.
- **Expressions** are the expressions of the HSM language. Names are resolved in the tested state machine
  like inside the state machine (`x`, `Iface.x`, states by (partially) qualified name, optionally prefixed
  with the name of the state machine), local variables and parameters shadow them. An **out event** is
  `true` if it was raised by the last `enter` / `raise` (event driven) / `proceed` / `exit`; `valueof(e)`
  is its last value. `is_final` is true if the final state of the top-level region is active.
- **`proceed n cycle(s)`** performs `n` run cycles (event driven: `n` steps without events).
  **`proceed t unit`** advances the virtual clock: cycle based state machines run a cycle whenever the
  clock reaches a multiple of the cycle period (counted from `enter`), event driven ones process the
  time events that expire.
- **`assert called`** counts the calls since the start of the test (including the set up). Operations of the
  state machine cannot be called in tests; unmocked operations return the default value of their type.
- **Submachine instances**: members of instances are used like in the state machine – `assert active(motor.On)`,
  `assert motor.speed == 3`, `motor.maxSpeed = 2`, `assert motor.failed` / `valueof(motor.failed)` (out events
  of the instance raised by the last call), `mock motor.setPwm returns (...)` and `assert called motor.setPwm`
  (see [`examples/door-with-motor/gate.hsmtest`](examples/door-with-motor/gate.hsmtest)). Events of
  instances cannot be raised by a test.
- The validator checks the references and the types (asserted expressions and conditions are boolean,
  event values, mocked values and arguments match the declarations, units of `proceed`, `@Test` / `@SetUp`
  operations have no parameters).
- A **failed** assertion reports its line, the message (or the asserted expression with the values of
  the operands of a comparison) and the last lines of the trace; runtime errors of the model (e.g. an event
  raised before `enter`) are reported as **errors**.

```bash
hsm test examples/tests/door.hsmtest                    # loads the .hsm files next to the test file (or in its parent directory)
hsm test tests/*.hsmtest --machine models/ --junit report.xml -v
```

`--machine` adds `.hsm` files or directories, `--junit` writes a JUnit XML report, `-v` prints the trace of
every test. The exit code is 1 if a test failed or a file has errors. The examples in
[`examples/tests/`](examples/tests) test all example state machines. The runner is available as API
(`runTests`, `HsmTestWorkspace`, `toJUnitXml` in `hsm-language`); it runs in the browser as well.

Not yet supported (compared to SCTUnit): `@Ignore`, `package` / imports, test suites, verifying the
order of calls, mocks with sequences of values, calling operations of the state machine in a test,
`assert` on time (`proceed` is the only way to advance time); the web editor does not run tests yet.

## Coverage

`hsm test --coverage` measures which parts of the state machines the unit tests exercise (like the
coverage view of SCTUnit in itemis CREATE). Coverage is aggregated over all tests of all test files:

| Metric | Covered when |
| --- | --- |
| **States** | the state was entered; final states count per region (`[*]`, `Active.[*]`, `S.r1.[*]`) |
| **Transitions** | the transition was taken – every transition of the model, including initial transitions, choice / junction branches, history defaults, entry / exit point transitions and each branch of a fork / join |
| **Reactions** | the local reaction was executed (`entry`, `exit`, `always`, `oncycle`, event and time reactions, also those of the state machine) |
| **Guard decisions** | each guard of a transition or local reaction counts twice: covered once it was evaluated to `true` and once to `false` (guards are evaluated only when a trigger matched) |

```bash
hsm test examples/tests/*.hsmtest --coverage                          # text summary + coverage/lcov.info + coverage/html/
hsm test tests/*.hsmtest --coverage-format text,cobertura --coverage-dir build/coverage
hsm test tests/*.hsmtest --coverage-threshold states=100,transitions=90   # exit code 1 if not reached
```

Any `--coverage-*` option implies `--coverage`. Formats (`--coverage-format`, default `text,lcov,html`):

| Format | Output | Use |
| --- | --- | --- |
| `text` | table per state machine (states, transitions, reactions, guard decisions) and the uncovered elements with line numbers, on stdout | console, CI logs |
| `json` | `coverage.json`: totals and every element with id, kind, name, line, diagram id, hits and the covering tests, every guard with its true / false counts (schema version 1, see `toCoverageJson`) | own tooling |
| `lcov` | `lcov.info`: one record per `.hsm` file; lines (`DA`) are the lines of states, transitions and reactions (a line counts as covered only if all its elements are), functions (`FN`) are the states, branches (`BRDA`) the guard decisions | VS Code (e.g. *Coverage Gutters*), GitHub (Codecov, Coveralls), `genhtml` |
| `cobertura` | `cobertura-coverage.xml` with the same lines and branches, paths relative to the working directory | GitLab merge request coverage, Jenkins |
| `html` | `html/index.html` and one self-contained page per state machine with all elements (covered / uncovered, hits, tests) and guards | browsing, CI artifacts |

`--coverage-threshold` takes `states`, `transitions`, `reactions`, `guards` (or `all` / a single number)
in percent and checks the totals over all state machines. Element ids are stable and equal the ids of the
diagram elements (`Closed`, `Active.Playing`, `#machine#initial->Closed`, `Closed->Opened`, `Closed->Opened~1`
for a second transition between the same vertices, `Service#region1#final`, reactions `Opened#reaction2`),
so reports can be mapped onto the diagram.

CI examples:

```yaml
# GitLab: test report and coverage in merge requests
model-tests:
  script:
    - npx hsm test tests/*.hsmtest --junit report.xml --coverage-format text,cobertura --coverage-threshold transitions=90
  artifacts:
    when: always
    reports:
      junit: report.xml
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml
```

```yaml
# GitHub Actions
- run: npx hsm test tests/*.hsmtest --junit report.xml --coverage-format text,lcov,html --coverage-threshold states=100
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: model-coverage, path: coverage/ }
- uses: codecov/codecov-action@v5        # optional: coverage/lcov.info
  with: { files: coverage/lcov.info }
```

As API, `runTests(test, machine, { coverage: new CoverageCollector() })` collects the coverage of tests;
a `CoverageCollector` can also be attached to any interpreter –
`new StatechartInterpreter(machine, collector.attach(options))` – e.g. to show the coverage of a
simulation session (`collector.highlight(machine)` returns the diagram element ids with the classes
`hsm-covered` / `hsm-uncovered`). The report functions are `toCoverageText`, `toCoverageJson`, `toLcov`,
`toCobertura` and `toCoverageHtml` (with an optional `renderDiagram(machine, highlight)` hook that embeds the
highlighted diagram).

## Editing in the diagram

| Action | How |
| --- | --- |
| Add a state | *State* tool (`S`), then click on the canvas, a state or a region – or double-click the canvas |
| Add a sub state | *State* tool, click on the parent state (a simple state becomes composite) |
| Add a region | *Region* tool (`R`), click on a state – existing sub states are moved into the first region |
| Add choice / junction / history | `C` / `J` / `H` / `D`, then click on the target container |
| Add a synchronization (fork / join) | `B`, then click on the target container |
| Add an entry point / exit node | `E` / `X`, then click on the composite state |
| Add a declaration (event, variable, …) | click the definitions box, use *Add declaration* in the properties panel |
| Show / hide transition priorities | *Priorities* in the toolbar |
| Initial state | *Initial* tool (`I`), click on the state that should be entered first |
| Final state | *Final* tool (`F`), click on the state that should get a transition to the final state |
| Add a transition | *Transition* tool (`T`), click the source, then the target, then type the label (`Tab` completes names) |
| Rename / edit label | double-click or `F2` |
| Move into another state | drag and drop |
| Delete | `Del` / `Backspace` or the trash button |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` (shared with the text editor) |
| Keep a tool active | hold `Shift` while choosing it, `Esc` to go back to selection |

## Simulation

Click **▶ Simulate** in the toolbar (the model must not contain errors; warnings are fine). The text
becomes read-only, the diagram tools are disabled and the simulation panel replaces the properties
panel. The simulation uses the interpreter of the language package (`StatechartInterpreter`, semantics in
[`docs/semantics.md`](docs/semantics.md)) with a virtual clock; **■ Stop** returns to editing.

| Part of the panel | What it does |
| --- | --- |
| *Run cycle* / *Step* | cycle based: one run cycle with the collected events and expired time events; event driven: a step without events (`Space`) |
| *Real time* | advances the virtual clock with the wall-clock time × *Speed*: cycle based machines run a cycle every `@CycleBased` period, event driven machines fire their time events (`Esc` pauses) |
| *Advance … ms* | advances the virtual clock at once, running the cycles resp. firing the time events that are due |
| *Restart* | re-enters the state machine (breakpoints and operation results are kept) |
| *In events* | one button per `in` event, grouped by interface, with a value field for typed events. Cycle based: with *Run cycle after raising an event* (default) a cycle is run immediately, otherwise the event is shown as *pending* until the next cycle |
| *Variables* | grouped by interface / internal scope; non-constant variables can be edited (checked against the type), changed values flash |
| *Operations* | the value each operation returns (a mock of the host implementation) and the number of calls |
| *Out events*, *Operation calls*, *Trace* | logs with the virtual time; click a trace entry to show the element in the text and in the diagram |

Active states (also inside orthogonal regions) are highlighted in the diagram, the transitions taken in
the last step light up in orange and fade out, a reached final state turns green. Right-click a state or
a transition (or use *Toggle breakpoint* for the selected element) to set a **breakpoint** (red dot):
real-time mode and *Advance* stop when the state is entered or the transition is taken. Errors of the
interpreter (e.g. a division by zero or a choice without enabled branch) stop the simulation and are
shown with a link to the model element.

## Architecture

```
packages/
  language/     Langium language (no DOM dependencies, runs in Node.js and in the browser)
    src/hsm.langium           grammar
    src/hsm-validator.ts      validation rules
    src/hsm-scope.ts          name resolution (qualified state names, declarations)
    src/hsm-formatter.ts      formatter
    src/diagram/layout.ts     AST -> PlantUML-like diagram model, laid out with ELK
    src/edit/model-edits.ts   structural edits (add, move, rename, delete, add declaration, …) as text edits
    src/generator/plantuml.ts PlantUML generator
    src/render/               SVG renderer without DOM (renderSvg), diagram style sheet shared with the web app
    src/doc/                  model documentation (Markdown / HTML), doc comments, hover documentation
    src/generator/common/     shared part of the C / C++ generators (analysis, states, transitions, expressions)
    src/generator/cpp/        C++ code generator and scenario test harness generator
    src/generator/c/          C code generator and scenario test harness generator
    src/generator/config.ts   generator configuration (hsm.gen.json): format, validation, file names (no fs)
    src/generator/generate-command.ts  `hsm generate`: loads the configuration, writes / checks the files (Node)
    schemas/                  JSON schema of hsm.gen.json
    src/importer/             itemis CREATE (.sct) importer with a small XML parser
    src/simulation/           interpreter (docs/semantics.md) with virtual clock, scenario runner
    src/hsm-test.langium      grammar of the unit test language (.hsmtest), imports the expressions of hsm.langium
    src/testing/              scoping, validation and test runner of the unit test language, JUnit XML
    test/scenarios/           conformance suite shared with code generators (format: README.md there)
    src/cli/main.ts           command line interface
  web/          Vite app: Monaco editor + Sprotty diagram
    src/app.ts                the web app: Monaco editor, toolbar, files; host of the diagram controller
    src/diagram-controller.ts graphical editor: text -> Langium -> ELK (web worker) -> Sprotty, diagram edits -> text
                              (independent of Monaco: also used by the VS Code webview via the DiagramHost interface)
    src/model-service.ts      Langium parsing / validation of the model text in the browser
    src/language-support.ts   Langium services wired into Monaco (markers, completion, formatting, …)
    src/diagram/              Sprotty model, views (PlantUML look), mouse / selection listeners
    src/simulation/           simulation session: interpreter, real-time clock, logs, operation mocks, breakpoints
    src/ui/                   properties and simulation panels, inline editor, SVG / PlantUML export
  vscode/       VS Code extension: language client + commands + test controller (extension host),
                Langium language server (src/server), diagram webview reusing packages/web (src/webview)
examples/       sample state machines, examples/tests: their unit tests, examples/cmake: CMake example
cmake/          CMake integration (HsmGenerate.cmake: hsm_generate, hsm_add_tests)
docs/           execution semantics, C++ integration, possible improvements, generated example docs
```

The text is the single source of truth. On every change it is parsed and validated by the Langium
services, which run directly in the browser. The AST is converted into a diagram model whose layout is
computed by ELK (layered algorithm with hierarchy support, in a web worker) and rendered by Sprotty with
custom views. Diagram interactions are turned into text edits by `ModelEditor` and applied to the Monaco
model, which triggers the same pipeline again – so undo / redo, comments and formatting just work.

The VS Code extension runs the same pipeline in its diagram webview; instead of the Monaco model its
host is the VS Code document (see [VS Code extension](#vs-code-extension)).

## VS Code extension

`packages/vscode` is a VS Code extension for models and their unit tests (details in
[packages/vscode/README.md](packages/vscode/README.md)):

- **Language server** for `.hsm` and `.hsmtest` (Langium, separate Node process): diagnostics,
  completion, hover with doc comments, definition, references, rename, formatting, outline, folding
  and semantic highlighting. The whole workspace is indexed, so test classes resolve state machines of
  other files. TextMate grammars and a language configuration (comments, brackets, `/** */` continuation).
- **Diagram** (**HSM: Open Diagram** or the button in the editor title): the diagram editor of the web
  app in a webview beside the text – updated while typing, selection sync in both directions, palette
  tools, inline rename, delete, drag to nest, properties panel and simulation. Diagram edits are
  computed with `ModelEditor` and applied to the document as `WorkspaceEdit`s, so undo, the dirty
  state and git behave as for typed changes. The diagram follows the VS Code color theme (light:
  PlantUML classic, configurable with `hsm.diagram.lightTheme`; dark: dark theme).
- **C/C++ header imports**: headers are read from disk (and re-read when they change: the importing models are
  validated again), hover shows their declarations with documentation, go to definition opens the header,
  completion after `ns::`. Include paths, defines and the data model come from the `headers` block of the
  nearest `hsm.gen.json` and the settings `hsm.headers.includePaths` / `hsm.headers.defines` /
  `hsm.headers.dataModel`; the diagram webview gets the headers from the extension.
- **HSM: Generate C++** uses a generator configuration (`hsm.gen.json` / `*.hsm.gen.json` that lists
  the model, searched from the model directory up to the workspace folder) with the same generator code
  as `hsm generate`, otherwise the settings `hsm.cpp.outputDirectory`, `hsm.cpp.namespace` and
  `hsm.cpp.standard`. `hsm.gen.json` files are validated with the JSON schema.
- **Tests** in the Test Explorer (all `@Test` operations of the workspace; failures with location and
  trace; **HSM: Run Tests** for the active file) and a **Run with Model Coverage** profile that shows
  covered states / transitions / reactions and guard decisions in the coverage view.
- **HSM: Import itemis CREATE Model (.sct)**, **HSM: Export Diagram as SVG** (`renderSvg`),
  **HSM: Export as PlantUML**.

```bash
npm run package:vscode    # builds and packages packages/vscode/hsm-vscode-0.1.0.vsix
code --install-extension packages/vscode/hsm-vscode-0.1.0.vsix
```

Three bundles: `dist/extension.cjs` (extension host, esbuild), `dist/server.cjs` (language server,
esbuild) and `dist/webview/` (Vite, the diagram controller, views and styles of `packages/web` – no
code is duplicated). The tests (`npm test -w packages/vscode`) cover the edit conversion, the generator
configuration resolution, test discovery / execution / coverage mapping and a language server round
trip over stdio (initialize, diagnostics, cross-file linking, hover, definition, references, rename,
formatting, symbols, folding, completion, semantic tokens). There are no tests in a real VS Code
instance yet (`@vscode/test-electron` needs to download VS Code, which was not possible in the build
environment).

## Code generation (C++)

C++ is the primary code generation target. `hsm generate cpp model.hsm -o gen` (or
`generateCpp(machine, options)` of `hsm-language`) generates code in the spirit of the itemis CREATE C++
generator: one class per state machine in `<Class>.h` / `<Class>.cpp` (`TrafficLight.h`,
`TrafficLight.cpp`) plus the shared runtime header `sc_statemachine.h` (`sc::integer` = `int64_t`,
`sc::real` = `double`, `sc::boolean` = `bool`, `sc::string` = `std::string`, the interfaces
`sc::StatemachineInterface`, `sc::TimedInterface`, `sc::TimerServiceInterface`, observers and errors).
Options: `--namespace a::b` (default: the `namespace` of the model, `""` for none), `--class-name`,
`--std 11` (the code is written for C++17; with `--std 11` it also compiles as C++11 – the only
difference are nested namespace definitions). Models importing C/C++ headers ([C/C++ header
imports](#cc-header-imports)) get `#include`s of the headers and use their types, enumerators and constants
by name.

The code implements [`docs/semantics.md`](docs/semantics.md) exactly like the interpreter: every scenario
of the conformance suite is compiled with g++ (`-std=c++17 -Wall -Wextra -Wpedantic -Werror -Wshadow
-Wconversion`, checked with clang++ too) and run by `npm test`; the examples are also compiled as C++11
and with `-fno-exceptions`. The class uses no global state and no RTTI; it allocates dynamic memory
only in `std::string` values and, for `@EventDriven` machines, in the `std::deque` event queues. It is readable: private member functions per
state (`enter_…`, `exit_…`, `react_…`), region and transition, with comments naming them. It is not
thread-safe: call it from one thread (or synchronize the calls).

Generated API (for `TrafficLight` of [`examples/traffic-light.hsm`](examples/traffic-light.hsm)):

| Member | |
|---|---|
| `void enter()`, `void exit()` | enters / exits the state machine (`sc::StatemachineInterface`) |
| `void runCycle()` | one run cycle; call it every `TrafficLight::cyclePeriodMs` ms (`@EventDriven`: each event is processed when it is raised, `runCycle()` performs a step without events) |
| `bool isActive()`, `bool isFinal()`, `bool isStateActive(State s)` | state queries, `enum class State { Off, Operating, Operating_Red, … }` |
| `void raise_powerOn()` | raises an in event of the unnamed interface (typed events take the value) |
| `bool isRaised_lightsChanged()`, `sc::integer get_lightsChanged_value()` | whether an out event was raised in the last call of `enter`, `exit`, `runCycle`, `raiseTimeEvent` or (event driven) `raise_…`, and its value |
| `sc::rx::Observable<sc::integer>& getLightsChanged()` | out event observable: `subscribe(observer)` with an `sc::rx::Observer<T>` (`sc::rx::Observer<void>` for events without value) that is notified immediately; no dynamic memory, an observer observes one observable at a time and unsubscribes itself when it is destroyed |
| `get_x()`, `set_x(v)` | variables and constants of the unnamed interface (no setter for constants and `readonly` variables) |
| `Pedestrian& getPedestrian()` | a named interface: nested class `TrafficLight::Pedestrian` with the same members (`getPedestrian().raise_request()`, `get_waiting()`, …) |
| `setOperationCallback(OperationCallback*)`, `setInternalOperationCallback(InternalOperationCallback*)`, `getPedestrian().setOperationCallback(Pedestrian::OperationCallback*)` | the operations: the host implements the abstract callback classes (like the operation callbacks of itemis CREATE); without a callback an operation returns the default value of its return type |
| `setTimerService(sc::TimerServiceInterface*)`, `raiseTimeEvent(sc::eventid)` | time events (`sc::TimedInterface`, only for machines with time events): the state machine calls `setTimer(machine, event, durationNs, periodic)` / `unsetTimer(machine, event)` of the timer service (durations in nanoseconds), the host calls `raiseTimeEvent(event)` when a timer expires |
| `setErrorHandler(sc::ErrorHandler*)` | runtime errors, see below |

Operations with variable-length parameters receive them as `std::initializer_list<T>` (no allocation).
Strings are passed as `const sc::string&` and returned by value. The internal scope is private; tests can
read and write it through a struct `TrafficLightInternals` (a friend of the class they may define).

**Runtime errors** of the semantics (a choice without enabled branch, a composite state without initial
transition, an exit node without transition, division by zero, a shift out of range, too many transitions
in one step, …) throw an `sc::StatemachineError` (derived from `std::runtime_error`, with `kind()`) whose
message has the format of the interpreter (`Choice 'C' has no enabled outgoing transition (line 12: 'choice C')`).
Like in the interpreter, the step is aborted and the state machine stays usable (its configuration may be
inconsistent). For code without exceptions, set an `sc::ErrorHandler`: it receives the error and the
machine continues with the failed part skipped like the C code (a division yields 0, the choice is not
left). Without handler and without exceptions (`-fno-exceptions`) an error calls `std::abort()`.

A complete host with a timer service based on `std::chrono`, an operation callback and an observer
(compiled and run by `npm test`):

```cpp
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <thread>
#include <vector>
#include "TrafficLight.h"

using Clock = std::chrono::steady_clock;

// Timer service: the host checks the timers before every run cycle.
class TimerService : public sc::TimerServiceInterface {
public:
    void setTimer(sc::TimedInterface* machine, sc::eventid event, sc::integer durationNs, bool periodic) override {
        unsetTimer(machine, event);
        const std::chrono::nanoseconds period(durationNs);
        timers.push_back(Timer{machine, event, Clock::now() + period, period, periodic});
    }

    void unsetTimer(sc::TimedInterface* machine, sc::eventid event) override {
        timers.erase(std::remove_if(timers.begin(), timers.end(), [&](const Timer& timer) {
            return timer.machine == machine && timer.event == event;
        }), timers.end());
    }

    // Raises the time events of all expired timers.
    void raiseExpired() {
        const Clock::time_point now = Clock::now();
        std::vector<Timer> expired;
        for (auto it = timers.begin(); it != timers.end();) {
            if (it->due > now) {
                ++it;
                continue;
            }
            expired.push_back(*it);
            if (it->periodic) {
                it->due += it->period;
                ++it;
            } else {
                it = timers.erase(it);
            }
        }
        for (const Timer& timer : expired) {
            timer.machine->raiseTimeEvent(timer.event);
        }
    }

private:
    struct Timer {
        sc::TimedInterface* machine;
        sc::eventid event;
        Clock::time_point due;
        std::chrono::nanoseconds period;
        bool periodic;
    };
    std::vector<Timer> timers;
};

// Operation switchOn of the internal scope.
class Lights : public TrafficLight::InternalOperationCallback {
public:
    void switchOn(sc::integer mask) override {
        std::printf("lights: %d\n", static_cast<int>(mask));
    }
};

// Observer of the out event lightsChanged.
class LightsChanged : public sc::rx::Observer<sc::integer> {
public:
    void next(const sc::integer& lights) override {
        std::printf("lights changed: %d\n", static_cast<int>(lights));
    }
};

int main() {
    TrafficLight light;
    TimerService timerService;
    Lights lights;
    LightsChanged lightsChanged;
    light.setTimerService(&timerService);
    light.setInternalOperationCallback(&lights);
    light.getLightsChanged().subscribe(lightsChanged);

    try {
        light.enter();
        light.raise_powerOn();
        Clock::time_point next = Clock::now();
        for (int cycle = 0; cycle < 600; cycle++) { // one minute
            next += std::chrono::milliseconds(TrafficLight::cyclePeriodMs);
            std::this_thread::sleep_until(next);
            timerService.raiseExpired();
            if (cycle == 300 && light.isStateActive(TrafficLight::State::Operating_Green)) {
                light.getPedestrian().raise_request(); // a pedestrian presses the button
            }
            light.runCycle();
        }
        light.exit();
    } catch (const sc::StatemachineError& error) {
        std::fprintf(stderr, "state machine error: %s\n", error.what());
        return 1;
    }
    return 0;
}
```

```bash
node packages/language/bin/cli.js generate cpp examples/traffic-light.hsm -o gen
g++ -std=c++17 -Wall -Wextra -Igen -o traffic-light main.cpp gen/TrafficLight.cpp
```

The test harnesses are generated from the scenarios by `generateCppScenarioHarness(api, scenario)`
(mocked operation callbacks with scripted results, a virtual timer service, observers recording the out
events); `HSM_CXXFLAGS='-O1 -fsanitize=address,undefined' npm test` runs them with sanitizers.

## Code generation (C)

C is also available: `hsm generate c model.hsm -o gen` (or `generateC(machine, options)`) generates C99
code in the spirit of the itemis CREATE C generator – `sc_types.h` and one `.h` / `.c` pair per state
machine named after it in snake case (`traffic_light.h`, prefix `traffic_light_`; option `--prefix`).
It shares the implementation of the semantics with the C++ generator (`src/generator/common`) and passes
the same conformance suite (gcc and clang, `-std=c99 -Wall -Wextra -Wpedantic -Werror`). It uses no
dynamic memory and no global state – everything is in the handle struct:

| Function | |
|---|---|
| `traffic_light_init(&h)`, `traffic_light_enter(&h)`, `traffic_light_exit(&h)` | initializes the handle (first), enters / exits the state machine |
| `traffic_light_run_cycle(&h)` | one run cycle (every `TRAFFIC_LIGHT_CYCLE_PERIOD_MS`) |
| `traffic_light_raise_powerOn(&h)`, `traffic_light_Pedestrian_raise_request(&h)` | raises in events |
| `traffic_light_is_raised_lightsChanged(&h)`, `traffic_light_get_lightsChanged_value(&h)`, `traffic_light_set_out_event_observer(&h, callback)` | out events |
| `traffic_light_get_x` / `traffic_light_set_x`, `traffic_light_internal_get_lights` | variables and constants |
| `traffic_light_is_state_active(&h, TrafficLight_Operating_Red)`, `traffic_light_is_final`, `traffic_light_is_active` | state queries |
| `traffic_light_raise_time_event(&h, timer)` | called by the timer service when a timer expires |

The host implements the **required functions**: the operations (`traffic_light_internal_switchOn(h, mask)`,
variable arguments as count and array), the timer service `traffic_light_set_timer(h, timer, duration_ns,
periodic)` / `traffic_light_unset_timer(h, timer)` and the error hook `traffic_light_on_error(h, error,
message)`. Unlike C++, runtime errors do not abort the step: after the hook returns, the machine continues
with the failed part skipped. Strings are stored in buffers of `<PREFIX>_STRING_CAPACITY` bytes (default
64, longer strings are truncated with an error), the event queues of event driven machines hold
`<PREFIX>_QUEUE_CAPACITY` events (default 16). The C harnesses are generated by
`generateScenarioHarness(api, scenario)`; `HSM_CFLAGS='-O2 -fsanitize=address,undefined' npm test` runs
them with sanitizers.

## Build integration (CMake)

### Generator configuration (`hsm.gen.json`)

Like the `.sgen` files of itemis CREATE, a generator configuration says which models are generated for
which targets with which options. `hsm generate` without arguments reads `hsm.gen.json` in the current
directory (`--config <file>` for another file; `<name>.hsm.gen.json` is the recommended name for further
configurations). Relative paths are relative to the configuration file. The JSON schema
[`packages/language/schemas/hsm-gen.schema.json`](packages/language/schemas/hsm-gen.schema.json) gives
completion and validation in editors (`"$schema"`); unknown properties are errors.

```json
{
    "$schema": "node_modules/hsm-language/schemas/hsm-gen.schema.json",
    "models": [
        "models/**/*.hsm",
        { "path": "models/door.hsm", "cpp": { "namespace": "legacy", "className": "DoorController" } }
    ],
    "cpp": {
        "outDir": "src-gen",
        "namespace": "app::sm",
        "std": 17,
        "headerExtension": ".hpp",
        "sourceExtension": ".cc",
        "licenseHeaderFile": "LICENSE-HEADER.txt"
    },
    "c": { "outDir": "src-gen/c" },
    "headers": { "includePaths": ["include"], "defines": { "USE_CAN": "1" } },
    "writeOnlyIfChanged": true
}
```

| Property | |
|---|---|
| `models` | paths or globs (`*`, `?`, `**`; hidden directories and `node_modules` are skipped) of `.hsm` files; an entry can be an object `{ "path": …, "cpp": {…}, "c": {…} }` whose options override the target options for these models (entries are applied in order). A glob matching nothing is an error |
| `cpp`, `c` | the targets: a target is generated if its key is present (`"c": {}` for the defaults) |
| `outDir` | output directory (default: the directory of each model) |
| `namespace`, `className`, `std` (cpp) | like `--namespace`, `--class-name`, `--std` (17 or 11) |
| `prefix`, `typeName`, `stringCapacity`, `queueCapacity` (c) | options of the C generator |
| `headerExtension`, `sourceExtension` | `.h` / `.cpp` (`.c`) by default, e.g. `.hpp` / `.cc`; the includes of the generated files are adapted and the runtime header is renamed too (`sc_statemachine.hpp`) |
| `licenseHeader` / `licenseHeaderFile` | text (string or array of lines) or file put at the top of every generated file; wrapped in `/* … */` unless it already starts with `//` or `/*` |
| `maxMicrosteps` | maximum number of transitions per step (default 1000) |
| `writeOnlyIfChanged` | default `true`: files whose content did not change are not rewritten, so their modification time is kept and build systems do not recompile them |
| `headers` | analysis of imported C/C++ headers ([C/C++ header imports](#cc-header-imports)): `includePaths` (relative to the configuration), `defines` (`"NAME": "value"`), `dataModel` (`longBits`, `pointerBits`: 32 or 64, `charSigned`). Also used by the other commands and the language server for the models below the configuration |

Files generated by several models (the runtime header) are written once; two models generating the same
file with different contents (e.g. the same class name) is an error. Nothing is written if a model has
errors.

```bash
hsm generate                       # all targets of ./hsm.gen.json ("Generated …" / "Unchanged …")
hsm generate cpp                   # only the cpp target
hsm generate --config sm.hsm.gen.json -o build/gen   # another configuration, all outputs into build/gen
hsm generate --check               # writes nothing, exit 1 if a file is missing or out of date (for CI)
hsm generate --list-outputs        # writes nothing, prints the absolute paths of the generated files
hsm generate --list-inputs         # prints the configuration, the models, imported files (.hsm, C/C++ headers) and license header files
hsm generate cpp model.hsm -o gen  # without configuration (as before; --config adds its cpp options)
```

`--namespace`, `--class-name`, `--std` and `--prefix` override the configuration. From code, the format
is available as `parseGeneratorConfig(json)` and `generateTarget(machine, target, options)` of
`hsm-language` (no file system access, usable in the browser); the file based part is
`src/generator/generate-command.ts` (`loadGeneratorConfig`, `runGeneration`).

### Installing the command line tool

The CMake functions need the `hsm` command line tool (Node.js ≥ 20.10):

- **In this repository**: `npm ci && npm run build -w packages/language`. `cmake/HsmGenerate.cmake` finds
  `packages/language/bin/cli.js` next to it automatically.
- **Globally**: `npm install -g ./packages/language` (links the package of this checkout, build it first) or
  `cd packages/language && npm pack` and `npm install -g hsm-language-0.1.0.tgz` on any machine (the
  package includes `schemas/`).
- **As a dev dependency** of a project with a `package.json`: `npm install -D <path or tarball>`; CMake then
  uses `npx --no-install hsm`.
- Or set the CMake cache variable `HSM_EXECUTABLE` to the command, e.g.
  `-DHSM_EXECUTABLE="node;/opt/hsm/packages/language/bin/cli.js"`.

### CMake functions

```cmake
list(APPEND CMAKE_MODULE_PATH "${HSM_ROOT}/cmake")   # the cmake/ directory of this repository
include(HsmGenerate)                                  # or: find_package(Hsm CONFIG REQUIRED PATHS "${HSM_ROOT}/cmake")

add_library(statemachines STATIC)
hsm_generate(TARGET statemachines
    MODELS models/traffic-light.hsm models/door.hsm   # and / or CONFIG hsm.gen.json
    NAMESPACE app                                    # cpp: namespace ("" for the global namespace)
    STD 17)                                          # also required from the target (cxx_std_17)

enable_testing()
hsm_add_tests(TARGET statemachines TESTS tests/traffic-light.hsmtest MODELS models/traffic-light.hsm)
```

`hsm_generate(TARGET <target> [MODELS <file.hsm>...] [CONFIG <file>] [GENERATOR cpp|c] [OUTPUT_DIR <dir>]
[NAMESPACE <ns>] [STD 17|11] [PREFIX <prefix>] [INCLUDE_DIRS <dir>...] [DEFINES <NAME[=VALUE]>...])`:

- generates the code **at build time** into `OUTPUT_DIR` (default
  `${CMAKE_CURRENT_BINARY_DIR}/hsm_generated/<target>`), adds the generated files to the sources of the
  target and `OUTPUT_DIR` to its include directories (`PUBLIC` for libraries, `PRIVATE` for executables);
- the generated files are determined at configure time (`hsm generate --list-outputs`); the models, the
  configuration and license header files are dependencies of the generation (custom target
  `<target>_hsm_generate`), so changing a model regenerates the code. Thanks to `writeOnlyIfChanged` only
  files whose content changed are recompiled: a changed comment in the model recompiles nothing, a changed
  transition `<Class>.cpp` (and the files including the header if the header changed, e.g. the comment of
  a time event);
- if the *set* of generated files changes (a state machine is renamed), the build fails once with
  "The set of generated files changed …; build again" and CMake re-runs automatically on the next build;
  changing the configuration file re-runs CMake as well;
- with `CONFIG`, the models and options of the configuration are used (`MODELS` replaces its models, the
  other arguments override its options); its `outDir` is ignored in favor of `OUTPUT_DIR`. Globs are
  expanded at configure time: re-run CMake after adding a model file;
- models importing **C/C++ headers**: the headers (and the headers they include) are dependencies, too.
  `INCLUDE_DIRS` / `DEFINES` are passed to `hsm` (`-I` / `-D`) and added to the include directories / compile
  definitions of the target; the generated header includes a header by its import path if it is found in
  an include directory, otherwise by its path relative to `OUTPUT_DIR`.

`hsm_add_tests(TARGET <name> TESTS <file.hsmtest>... [MODELS <file.hsm>...] [JUNIT_DIR <dir>] [INCLUDE_DIRS <dir>...] [DEFINES …])` registers
a CTest test `<name>.<file stem>` (label `hsm`) per test file that runs `hsm test` with a JUnit report in
`JUNIT_DIR` (default `${CMAKE_CURRENT_BINARY_DIR}/hsm_test_results`).

### Example

[`examples/cmake`](examples/cmake) builds the traffic light (generated with `MODELS`) and the CD player
(generated with the configuration [`examples/cmake/hsm.gen.json`](examples/cmake/hsm.gen.json): `.hpp` /
`.cc` files with a license header) as static libraries, an application with a `std::chrono` timer service
and operation callbacks ([`main.cpp`](examples/cmake/main.cpp)), a C++ test driving both classes with a
virtual clock and the `.hsmtest` unit tests of both models. The conveyor of
[`examples/cpp-types`](examples/cpp-types) imports a C++ header; its generated class uses the header's types
(tested by [`tests/conveyor_test.cpp`](examples/cmake/tests/conveyor_test.cpp)):

```bash
npm ci && npm run build -w packages/language
cmake -S examples/cmake -B build/cmake-example -G Ninja      # or "Unix Makefiles"
cmake --build build/cmake-example
ctest --test-dir build/cmake-example --output-on-failure     # statemachine_tests, conveyor_test, models.*, conveyor.conveyor
build/cmake-example/traffic_light 30                         # runs the traffic light for 30 s
```

`npm test` runs this example end to end in a temporary directory (configure, build, ctest, incremental
rebuilds after model changes; skipped without cmake; `HSM_CMAKE_GENERATOR='Unix Makefiles'` selects the
generator).

## Importing itemis CREATE models

Statecharts of itemis CREATE (formerly YAKINDU Statechart Tools) can be converted into `.hsm` models:

```bash
node packages/language/bin/cli.js import TrafficLight.sct -o TrafficLight.hsm   # warnings go to stderr
```

In the web editor, `Open…` accepts `.sct` files as well; warnings are shown in the status bar. From
code, use `importSct(xml)` of `hsm-language`, which returns `{ text, warnings }` (no DOM needed).
Several statecharts are imported together with `hsm import A.sct B.sct` (or several files in `Open…`,
`importSctFiles(files)`): a **submachine state** that references one of the other statecharts becomes a
submachine instance – `import "B.hsm"`, `var b : B` in the internal scope and `state S : b`.

The definition section and all reactions are copied as they are (both languages use the same
syntax); the diagram layout of the `.sct` file is ignored. The structure is mapped as follows:

| itemis CREATE                                   | HSM                                                                 |
|-------------------------------------------------|---------------------------------------------------------------------|
| statechart `specification`                      | definition section (`namespace`, annotations and scopes re-ordered) |
| single top-level region                         | body of the `statemachine`                                          |
| several top-level regions                       | `[*] -> Main` and `state Main { region r1 { … } region r2 { … } }`  |
| region of a composite state                     | dropped if it is the only one, otherwise `region name { … }`        |
| state and its local reactions                   | `state Name { entry / … }`, one reaction per line                   |
| default entry and its transition                | `[*] -> Target`                                                     |
| named entry / exit                              | `entry Name` / `exit Name` (an unnamed exit becomes `exit Exit1`)   |
| shallow / deep history entry                    | `history H` / `deephistory DH` (or the itemis name)                 |
| choice (dynamic / static)                       | `choice Choice1` / `junction Junction1`                             |
| synchronization                                 | `sync Sync1`                                                        |
| final state                                     | `Source -> [*]` in the region of the final state                    |
| transition `spec # >entry` / `# ex1> ex2>`      | `Source -> Target : spec # >entry` / `# ex1> ex2>`                  |
| `active(Statechart.main_region.A.r.B)`          | `active(B)` (shortest unambiguous name, regions are not part of it) |

Details and limitations (each of them is reported as a warning):

- State names that are not valid identifiers or clash with keywords are sanitized (`Door Open` →
  `state Door_Open "Door Open"`, `entry` → `entry_`) and made unique among the vertices of the same
  state (itemis names only need to be unique per region); entry points and exit nodes of different
  regions keep a shared name (`# >failure` enters all of them, like in itemis CREATE).
- Transitions are declared in the innermost container of source and target and keep the order of the
  itemis model, i.e. their priority. Multi-line effects get `;` separators, number suffixes (`1.5f`)
  are removed.
- A transition which handles several exit nodes (`# ex1> ex2>`) is imported as it is; the unnamed
  (default) exits are handled by the transitions without trigger (`# Exit1>`).
- Local reactions of the statechart itself (e.g. `oncycle / x += 1` in the `internal:` scope) are
  placed after the definition section.
- Several final states of one region are merged into the final state `[*]` of the region.
- An entry through a named history (`# >hist`) targets the history pseudo state; an unknown entry
  point name enters by default. Of several entry points (`# >e1 >e2`) the known ones are kept (only
  the first one is used, the validator warns like itemis CREATE).
- Type aliases (`alias inti : integer`) and `null` are copied unchanged; `event e : void` becomes
  `event e`.
- Not supported (kept as `// TODO import: …` comments): submachine states whose statechart is not imported
  together with them, `@SuperSteps` / `@EventBuffering` and the `import:` statements of itemis CREATE (header
  files and statechart references of the definition section). The format of submachine references is
  assumed to be a `referencedStatechart` attribute or element with an `href` (`Motor.sct#…`); every submachine
  state gets its own instance.
- Result for the 215 `.sct` files of the itemis CREATE repository: 213 are imported without syntax or
  linking errors (the other two use outdated syntax or an unqualified member of a named interface, which current
  itemis CREATE rejects as well); the remaining
  validation errors are mostly in itemis validation test models that are invalid on purpose, or in
  features HSM checks more strictly (raising `in` events internally, operations called without
  parentheses, `out` events as triggers, `%` on reals).
