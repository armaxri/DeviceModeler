# HSM Modeler

A [Langium](https://langium.org) based modeling environment for **hierarchical state machines** with a
graphical editor built on [Sprotty](https://sprotty.org) and [ELK](https://eclipse.dev/elk/).
The diagrams look like PlantUML state diagrams, but you can edit them directly: add states, draw
transitions, nest states by drag and drop, rename in place, … Text and diagram always stay in sync.

![HSM Modeler](docs/screenshot.png)

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
- **Unit tests** for state machines in the style of SCTUnit (`.hsmtest` files, see [Unit tests](#unit-tests)),
  executed by the interpreter, with JUnit XML reports for CI.

## Getting started

Requires Node.js ≥ 20.10.

```bash
npm install
npm run dev        # starts the editor on http://localhost:5173
```

Other scripts:

```bash
npm test           # unit tests of the language package (parser, validation, edits, layout, generator)
npm run build      # langium generate + TypeScript build + production build of the web app (packages/web/dist)
npm run typecheck
```

### Command line

```bash
npm run build -w packages/language
node packages/language/bin/cli.js validate examples/cd-player.hsm
node packages/language/bin/cli.js plantuml examples/cd-player.hsm -o cd-player.puml
node packages/language/bin/cli.js layout examples/keyboard.hsm --direction RIGHT
node packages/language/bin/cli.js import model.sct -o model.hsm   # itemis CREATE import, see below
node packages/language/bin/cli.js simulate examples/cd-player.hsm -e play,eject,eject   # run the interpreter
node packages/language/bin/cli.js simulate examples/door.hsm --script packages/language/test/scenarios/example-door.json
node packages/language/bin/cli.js test examples/tests/*.hsmtest --machine examples --junit report.xml   # unit tests
node packages/language/bin/cli.js generate c examples/traffic-light.hsm -o gen   # C code, see below
```

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
  with `in event`, `out event`, `event`, `var`, `var readonly`, `const` and `operation` declarations.
  Types: `integer`, `real`, `boolean`, `string`, `void`. It may start with `namespace a.b` and
  annotations: `@CycleBased(period)`, `@EventDriven`, `@ParentFirstExecution`, `@ChildFirstExecution`.
- **Reactions** (transition labels and local reactions of states) have the form
  `trigger, trigger [guard] / effect`; every part is optional (a local reaction needs the effect).
  Triggers: events, `after n unit` / `every n unit` (units `s`, `ms`, `us`, `ns`), `always`,
  `oncycle`, `entry` / `exit` (local reactions only), `else` / `default` (transitions leaving a choice).
  Effects are `;`-separated statements: expressions (assignments, operation calls) and
  `raise event` / `raise event : value`.
- **Expressions**: `=`, `+=`, `-=`, `*=`, `/=`, `%=`, `<<=`, `>>=`, `&=`, `|=`, `^=`, `? :`, `||`,
  `&&`, `|`, `^`, `&`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `<<`, `>>`, `+`, `-`, `*`, `/`, `%`, `!`,
  `~`, `as` casts, literals (`true`, `42`, `0x1F`, `1.5`, `"text"`), `valueof(event)` and
  `active(State)`.
- **States** are referenced by (partially) qualified names: `Playing`, `Active.Playing` or
  `Closed.Active.Playing`. A name is resolved in the scope of the transition first and then outwards,
  so sibling states must have different names, but states in different composite states may share a
  simple name. Transitions may be declared in any scope; `[*]` refers to the initial (as source) or
  final (as target) state of the scope the transition is declared in.
- **Orthogonal regions**: `state S { region A { ... } region B { ... } }` (regions may be unnamed).
- **Entry points and exit nodes** (inside a composite state `C`): `entry E` / `exit X`. A transition
  to `C` ending with `# >E` enters `C` via `E`; when `X` is reached, `C` is left by the transition
  `C -> ... # X>`.
- **Synchronization**: `sync S` joins several incoming transitions (from orthogonal regions) and forks
  into several outgoing transitions.
- **Priorities**: the outgoing transitions of a vertex are checked in the order of the text; the first
  enabled one is taken.
- The execution semantics are specified in [`docs/semantics.md`](docs/semantics.md). See
  [`examples/`](examples) for more: `door.hsm` shows entry points, exit nodes and fork / join,
  `traffic-light.hsm` time events and named interfaces, `keyboard.hsm` orthogonal regions.

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

## Manual layout (experimental)

🧪 By default the diagram is laid out automatically (ELK). With *Positions: Manual* in the toolbar the
diagram can be arranged by hand instead; the automatic layout is not affected as long as no manual
layout is active. Design, format and trade-offs: [docs/manual-layout.md](docs/manual-layout.md).

- The positions are stored next to the model in `<model>.hsm.layout` (JSON, keyed by qualified names),
  the `.hsm` text stays free of layout information. The web editor keeps the layout per file in the
  browser; *Save* downloads the model and its `.hsm.layout`, *Open…* accepts both files together.
- Switching to *Manual* starts from the current automatic layout. *Auto-arrange* re-runs the automatic
  layout and keeps it as manual layout, *Reset* discards the manual layout, *Auto* shows the automatic
  layout but keeps the manual one for later.
- Elements without a stored position (e.g. new states) are placed automatically near their siblings;
  composite states grow when their content does not fit. Transitions keep their automatic route while
  their end points are arranged as in the automatic layout, otherwise they become straight lines
  through their bend points.

| Action (manual layout) | How |
| --- | --- |
| Move a state, pseudo state or the definitions box | drag it (attached transitions follow) |
| Move a state into another state | hold `Shift` while dropping it |
| Resize a state | select it, drag the handle at the bottom right corner |
| Add / move / remove a bend point | select the transition; double-click its line / drag the point / double-click the point |
| Move a transition label | select the transition, drag its label |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` in the diagram – layout changes and text edits in the order they were made |

Renames, moves and deletions done in the diagram update the layout; renames typed in the text editor do
not (the element is then placed automatically). Importing an itemis CREATE `.sct` file keeps the
arrangement of its diagram. On the command line, `hsm layout model.hsm` uses `model.hsm.layout` if it
exists (`--layout <file>`, `--auto`), and `hsm import` writes the `.hsm.layout` next to the model
(`--no-layout` to skip it).

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
    src/generator/c/          C code generator and scenario test harness generator
    src/importer/             itemis CREATE (.sct) importer with a small XML parser
    src/simulation/           interpreter (docs/semantics.md) with virtual clock, scenario runner
    src/hsm-test.langium      grammar of the unit test language (.hsmtest), imports the expressions of hsm.langium
    src/testing/              scoping, validation and test runner of the unit test language, JUnit XML
    test/scenarios/           conformance suite shared with code generators (format: README.md there)
    src/cli/main.ts           command line interface
  web/          Vite app: Monaco editor + Sprotty diagram
    src/app.ts                controller: text -> Langium -> ELK (web worker) -> Sprotty, diagram edits -> text
    src/language-support.ts   Langium services wired into Monaco (markers, completion, formatting, …)
    src/diagram/              Sprotty model, views (PlantUML look), mouse / selection listeners
    src/simulation/           simulation session: interpreter, real-time clock, logs, operation mocks, breakpoints
    src/ui/                   properties and simulation panels, inline editor, SVG / PlantUML export
examples/       sample state machines, examples/tests: their unit tests
docs/           execution semantics
```

The text is the single source of truth. On every change it is parsed and validated by the Langium
services, which run directly in the browser. The AST is converted into a diagram model whose layout is
computed by ELK (layered algorithm with hierarchy support, in a web worker) and rendered by Sprotty with
custom views. Diagram interactions are turned into text edits by `ModelEditor` and applied to the Monaco
model, which triggers the same pipeline again – so undo / redo, comments and formatting just work.

Possible next steps: a VS Code extension (the language package can be used by a Langium language server
together with `sprotty-vscode`) and code generation for further target languages (see [ROADMAP.md](ROADMAP.md)).

## Code generation (C)

`hsm generate c model.hsm -o gen` (or `generateC(machine, options)` of `hsm-language`) generates C99
code in the spirit of the itemis CREATE C generator: `sc_types.h` (`sc_integer` = `int64_t`,
`sc_real` = `double`, `sc_boolean` = `bool`, `sc_string` = `const char *`) and one `.h` / `.c` pair
per state machine, named after the state machine in snake case (`TrafficLight` →
`traffic_light.h`, prefix `traffic_light_`; option `--prefix`). The code implements
[`docs/semantics.md`](docs/semantics.md) exactly like the interpreter: every scenario of the
conformance suite is compiled with gcc (`-std=c99 -Wall -Wextra -Wpedantic -Werror`) and run by
`npm test`, the examples are also compiled with clang. It uses no dynamic memory and no global
state – everything is in the handle struct – and consists of readable functions per state
(`enter_…`, `exit_…`, `react_…`), region and transition, with comments naming them.

Generated API (for `TrafficLight`; `@EventDriven` machines process each event when it is raised):

| Function | |
|---|---|
| `void traffic_light_init(TrafficLight *h)` | initializes the handle (call first) |
| `void traffic_light_enter(TrafficLight *h)` / `traffic_light_exit` | enters / exits the state machine |
| `void traffic_light_run_cycle(TrafficLight *h)` | one run cycle (cycle based: call every `TRAFFIC_LIGHT_CYCLE_PERIOD_MS`) |
| `void traffic_light_raise_powerOn(TrafficLight *h)` | raises an in event (typed events take a value); named interfaces: `traffic_light_Pedestrian_raise_request` |
| `sc_boolean traffic_light_is_raised_lightsChanged(const TrafficLight *h)` | whether an out event was raised in the last call; value: `traffic_light_get_lightsChanged_value` |
| `traffic_light_set_out_event_observer(h, callback)` | optional callback for every out event (`TrafficLightEvent` id) |
| `traffic_light_get_x` / `traffic_light_set_x`, `traffic_light_Pedestrian_get_waiting`, `traffic_light_internal_get_lights` | variables and constants (setters only for writable variables) |
| `traffic_light_is_state_active(h, TrafficLight_Operating_Red)`, `traffic_light_is_final`, `traffic_light_is_active` | state queries (`TrafficLightState` enum) |
| `void traffic_light_raise_time_event(TrafficLight *h, TrafficLightTimerId timer)` | called by the timer service when a timer expires |

The host implements the **required functions** (like the operation callbacks of itemis CREATE):
operations `traffic_light_<op>` / `traffic_light_<Interface>_<op>` / `traffic_light_internal_<op>`
with the handle as first argument (variable arguments are passed as count and array), the timer
service `traffic_light_set_timer(h, timer, duration_ns, periodic)` / `traffic_light_unset_timer(h, timer)`
(only for machines with time events; durations in nanoseconds) and the error hook
`traffic_light_on_error(h, error, message)`. Runtime errors of the semantics (a choice without
enabled branch, a composite state without initial transition, an exit node without transition,
division by zero, too many transitions in one step, a full event queue, a string that does not fit
its buffer) are reported to the hook; after it returns the machine continues with the failed part
skipped (the choice is not left, the division yields 0, the string is truncated). The handle has a
`user_data` pointer for the host, e.g. to find its timers when there are several instances.

Strings (variables, event values, concatenation results) are stored in buffers of
`<PREFIX>_STRING_CAPACITY` bytes (default 64, generator option `stringCapacity` or `-D`), the event
queues of event driven machines hold `<PREFIX>_QUEUE_CAPACITY` events (default 16), and loops are
stopped after `<PREFIX>_MAX_MICROSTEPS` transitions (default 1000).

```c
#include <stdio.h>
#include "traffic_light.h"

typedef struct {
    sc_boolean active, periodic;
    sc_integer remaining_ns, period_ns;
} Timer;

static Timer timers[TRAFFIC_LIGHT_TIMER_COUNT];

/* timer service */
void traffic_light_set_timer(TrafficLight *h, TrafficLightTimerId timer, sc_integer duration_ns, sc_boolean periodic) {
    (void)h;
    timers[timer].active = true;
    timers[timer].periodic = periodic;
    timers[timer].remaining_ns = duration_ns;
    timers[timer].period_ns = duration_ns;
}

void traffic_light_unset_timer(TrafficLight *h, TrafficLightTimerId timer) {
    (void)h;
    timers[timer].active = false;
}

/* operation switchOn of the internal scope */
void traffic_light_internal_switchOn(TrafficLight *h, sc_integer mask) {
    (void)h;
    printf("lights: %d\n", (int)mask);
}

void traffic_light_on_error(TrafficLight *h, TrafficLightError error, const char *message) {
    (void)h;
    fprintf(stderr, "state machine error %d: %s\n", (int)error, message);
}

int main(void) {
    const sc_integer period_ns = TRAFFIC_LIGHT_CYCLE_PERIOD_MS * INT64_C(1000000);
    TrafficLight light;
    int i;

    traffic_light_init(&light);
    traffic_light_enter(&light);
    traffic_light_raise_powerOn(&light);
    for (;;) {
        /* ... wait for the next cycle (TRAFFIC_LIGHT_CYCLE_PERIOD_MS), e.g. a timer interrupt ... */
        for (i = 0; i < TRAFFIC_LIGHT_TIMER_COUNT; i++) {
            if (timers[i].active && (timers[i].remaining_ns -= period_ns) <= 0) {
                traffic_light_raise_time_event(&light, (TrafficLightTimerId)i);
                if (timers[i].periodic) {
                    timers[i].remaining_ns += timers[i].period_ns;
                } else {
                    timers[i].active = false;
                }
            }
        }
        traffic_light_run_cycle(&light);
        if (traffic_light_is_raised_lightsChanged(&light)) {
            printf("lights changed: %d\n", (int)traffic_light_get_lightsChanged_value(&light));
        }
    }
}
```

The test harnesses are generated from the scenarios by `generateScenarioHarness(api, scenario)`
(mocked operations with scripted results, a virtual timer service); `HSM_CFLAGS='-O2
-fsanitize=address,undefined' npm test` runs them with sanitizers.

## Importing itemis CREATE models

Statecharts of itemis CREATE (formerly YAKINDU Statechart Tools) can be converted into `.hsm` models:

```bash
node packages/language/bin/cli.js import TrafficLight.sct -o TrafficLight.hsm   # warnings go to stderr
```

In the web editor, `Open…` accepts `.sct` files as well; warnings are shown in the status bar. From
code, use `importSct(xml)` of `hsm-language`, which returns `{ text, warnings, layout }` (no DOM needed).

The definition section and all reactions are copied as they are (both languages use the same
syntax); the diagram of the `.sct` file becomes a manual layout (🧪 experimental, `<out>.hsm.layout`,
see [Manual layout](#manual-layout-experimental)). The structure is mapped as follows:

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
| transition `spec # >entry` / `# exit>`          | `Source -> Target : spec # >entry` / `# exit>`                      |
| `active(Statechart.main_region.A.r.B)`          | `active(B)` (shortest unambiguous name, regions are not part of it) |

Details and limitations (each of them is reported as a warning):

- State names that are not valid identifiers or clash with keywords are sanitized (`Door Open` →
  `state Door_Open "Door Open"`, `entry` → `entry_`) and made unique among the vertices of the same
  state (itemis names only need to be unique per region).
- Transitions are declared in the innermost container of source and target and keep the order of the
  itemis model, i.e. their priority. Multi-line effects get `;` separators, number suffixes (`1.5f`)
  are removed.
- A transition which handles several exit nodes (`# ex1> ex2>`) is duplicated per exit node; the
  unnamed (default) exit is handled by the transitions without trigger.
- Local reactions of the statechart itself (e.g. `oncycle / x += 1` in the `internal:` scope) are
  placed after the definition section.
- Several final states of one region are merged into the final state `[*]` of the region.
- An entry through a named history (`# >hist`) targets the history pseudo state; an unknown entry
  point name enters by default. Entry points with the same name in several orthogonal regions cannot
  be expressed: only one of them is used.
- Not supported (kept as `// TODO import: …` comments): submachine states (referenced statecharts),
  `@SuperSteps` / `@EventBuffering` and imports. Type aliases and `null` are copied unchanged and
  reported by the validator.
