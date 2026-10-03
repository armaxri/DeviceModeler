# Device Modeler

A [Langium](https://langium.org) based modeling environment for devices: the **structure of a product**
(components with their ports, subsystems, threads, instances and connections – 🧪 structure files) and
the **hierarchical state machines** that implement the behavior of its components. Both are model files
with the extension **`.devm`** – a file contains either a state machine or structure elements (structs,
interfaces, components, subsystems, systems), never both – and unit tests of state machines are `.devmtest`
files. Both are edited as text and in graphical editors built on
[Sprotty](https://sprotty.org) and [ELK](https://eclipse.dev/elk/): the state machine diagrams look like
PlantUML state diagrams, structures are shown as SysML internal block diagrams in the same themes – and you
can edit them directly: add states, draw transitions, nest states by drag and drop, add instances and
connect ports, rename in place, … Text and diagram always stay in sync, and the structure links to the
state machines: double-click an instance to open its state machine.

![Device Modeler](docs/screenshot.png)

## Structure of a product (structure files)

🧪 Experimental (branch `claude/device-modeling`): the structure elements of `.devm` files
([docs/structure-language.md](docs/structure-language.md), example [`examples/device`](examples/device)).
The kind of a `.devm` file is decided by its first word: a file starting with `statemachine` is a state
machine, every other file is a structure file.

![The structure of a garage door: internal block diagram of the system GarageDoor](docs/examples/GarageDoor.svg)

- **Component types** with `provides` / `requires` **ports**: sync ports carry data (a simple type, a
  struct or a C/C++ type of an imported header), async ports carry events (named groups of events:
  `interface DoorCmd { event open event close }`). A component can be implemented by a state machine
  (`behavior "door.devm"`): its ports are checked against the interfaces of the state machine (provided async
  port = `in` events, required async port = `out` events, sync ports = variables and operations).
- **Subsystems** (`subsystem`, composite component types) and the root **`system`**: **threads**
  (`@priority(5) @period(10 ms)`) with the instances of components running in them, instances of other
  subsystems outside of the threads (recursive nesting; their parts run in threads of their own),
  explicit **connections** (`connect door.motor -> drive.ctrl`, required → provided) and **delegations**
  to the boundary ports.
- **Validation**: unconnected required ports, mismatching kinds, types and directions, connections
  crossing threads (shown dashed), ports that do not match the state machine, unresolved imports, …
- **Route analysis**: selecting a port, connector or instance highlights the whole signal path across
  connections and delegations through all levels of the hierarchy and all files; *go to provider* of a
  required port.
- **Internal block diagram** (SysML style, PlantUML themes): frames for the subsystem / system and its
  threads, instances with stereotypes, filled (provided) / hollow (required) ports with a chevron for async
  ports and their type; the structs and interfaces declared in the file as separate «struct» /
  «interface» boxes.
  **Graphical editing** like the state machine diagrams (palette for threads, instances, ports and
  connectors with compatibility feedback, rename, drag into threads, properties panel) – every action is a
  text edit; **navigation** between systems, subsystems, component types, data types and state machines with a
  back / forward history.
- **Tools**: the web editor, the VS Code extension (language server, diagram, navigation, edits across
  files) and `devm render` (SVG) support structure files. Not (yet) supported: simulation and code
  generation of structure files.

## State machines (state machine files)

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
    [C/C++ header imports](docs/language.md#cc-header-imports))
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
  real-time mode (see [Simulation](docs/editor.md#simulation)).
- **Selection sync**: selecting an element in the diagram highlights its text, moving the cursor in the
  text selects the element in the diagram.
- **Export** of the diagram as standalone SVG or PNG (*Export…* in the toolbar; the PNG has twice the
  screen resolution).
- **CLI** (`devm`) for validation, layout computation, rendering and code generation.
- **Rendering and documentation without a browser**: `devm render` writes the diagrams as SVG files that look
  like the editor's export, `devm doc` generates Markdown or HTML documentation of models (diagram,
  interfaces, states, transitions and `/** … */` doc comments) – see [Rendering diagrams](docs/rendering.md#rendering-diagrams)
  and [Model documentation](docs/rendering.md#model-documentation), examples in [`docs/examples`](docs/examples/index.md).
- **Unit tests** for state machines in the style of SCTUnit (`.devmtest` files, see [Unit tests](docs/testing.md#unit-tests)),
  executed by the interpreter, with JUnit XML reports for CI.
- **Code generation** for **C++** (a class per state machine like itemis CREATE, see
  [Code generation (C++)](docs/cpp-generator.md)) and C99, both verified against the conformance suite of the
  interpreter by compiling and running every scenario.
- **VS Code extension** (`packages/vscode`): language server for `.devm` and `.devmtest` files, the diagram
  editors of the web app next to the text editor, C++ generation, tests in the Test Explorer (with model
  coverage) and the itemis CREATE import – see [VS Code extension](docs/vscode.md).
- **Build integration**: a generator configuration file (`devm.gen.json`, like the `.sgen` files of itemis
  CREATE), `devm generate --check` for CI and CMake functions (`devm_generate`, `devm_add_tests`) that
  regenerate the code when a model changes (see [Build integration (CMake)](docs/build-integration.md)).

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
npm run package:vscode   # packages/vscode/devm-vscode-<version>.vsix
```

### Command line

The command line tool is `devm` (`npm install -g ./packages/language` after the build, or
`node packages/language/bin/cli.js` as below):

```bash
npm run build -w packages/language
node packages/language/bin/cli.js validate examples/cd-player.devm
node packages/language/bin/cli.js layout examples/keyboard.devm --direction RIGHT
node packages/language/bin/cli.js render examples -o out --theme modern     # SVG diagrams, see below
node packages/language/bin/cli.js render examples/device/system.devm -o system.svg   # internal block diagram of a system
node packages/language/bin/cli.js doc examples -o docs/models --format html  # documentation, see below
node packages/language/bin/cli.js import model.sct -o model.devm   # itemis CREATE import, see below
node packages/language/bin/cli.js simulate examples/cd-player.devm -e play,eject,eject   # run the interpreter
node packages/language/bin/cli.js simulate examples/door.devm --script packages/language/test/scenarios/example-door.json
node packages/language/bin/cli.js test examples/tests/*.devmtest --machine examples --junit report.xml   # unit tests
node packages/language/bin/cli.js generate cpp examples/traffic-light.devm -o gen   # C++ code, see below
node packages/language/bin/cli.js generate c examples/traffic-light.devm -o gen     # C code
node packages/language/bin/cli.js generate                  # all models / targets of ./devm.gen.json, see below
node packages/language/bin/cli.js generate --check          # exit 1 if generated files are out of date (CI)
```

## Documentation

| Document | Content |
| --- | --- |
| [The language](docs/language.md) | syntax of the models: definition section, reactions, expressions, states, regions, pseudo states; imports and submachines; C/C++ header imports |
| [Structure language](docs/structure-language.md) | 🧪 structure files: components, ports, subsystems, threads, instances, connections; port ↔ state machine rules; route analysis |
| [Execution semantics](docs/semantics.md) | how a state machine executes – the specification implemented by the interpreter and the code generators |
| [Web editor](docs/editor.md) | editing in the diagram, 🧪 structure diagrams and navigation, 🧪 manual layout, simulation |
| [Manual layout](docs/manual-layout.md) | 🧪 experimental (branch `claude/layout-annotations`): layout annotations in the model (state machines and structure diagrams), layout computation, routing, editor integration, migration |
| [VS Code extension](docs/vscode.md) | language server, diagrams, 🧪 structure files, generation, Test Explorer (details in [packages/vscode/README.md](packages/vscode/README.md)) |
| [Rendering and model documentation](docs/rendering.md) | `devm render` (SVG diagrams), `devm doc` (Markdown / HTML documentation), doc comments |
| [Unit tests and coverage](docs/testing.md) | the `.devmtest` language, `devm test`, model coverage, CI examples |
| [Code generation (C++)](docs/cpp-generator.md) | generated API, runtime errors, a complete host example |
| [Code generation (C)](docs/c-generator.md) | C99 generator |
| [Build integration (CMake)](docs/build-integration.md) | `devm.gen.json`, installing the command line tool, `devm_generate` / `devm_add_tests` |
| [Importing itemis CREATE models](docs/itemis-import.md) | `.sct` import and its mapping |
| [C++ integration](docs/cpp-integration.md) | the C++ header analyzer, the supported C++ subset and design decisions |
| [Architecture](docs/architecture.md) | packages, source files and the editing pipeline |
| [Examples](docs/examples/index.md) | generated documentation of the example models |
| [Possible improvements](docs/improvements.md) · [Roadmap](ROADMAP.md) | what could come next, what has been done |

## Architecture

The repository is an npm workspace with three packages: `packages/language` (the Langium languages – the
`.devm` language of state machines and structures and the unit test language –, CLI `devm`, interpreter,
test runner, renderer and code generators –
no DOM dependencies, runs in Node.js and in the browser), `packages/web` (the Vite web app: Monaco editor
and Sprotty diagram) and `packages/vscode` (the VS Code extension). The npm packages are named
`devm-language`, `devm-web` and `devm-vscode`. The text is the single source of truth: diagram
edits become text edits, which run
through the same parse → validate → layout → render pipeline as typed changes. See
[docs/architecture.md](docs/architecture.md) for the details.
