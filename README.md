# HSM Modeler

A [Langium](https://langium.org) based modeling environment for **hierarchical state machines** with a
graphical editor built on [Sprotty](https://sprotty.org) and [ELK](https://eclipse.dev/elk/).
The diagrams look like PlantUML state diagrams, but you can edit them directly: add states, draw
transitions, nest states by drag and drop, rename in place, … Text and diagram always stay in sync.

![HSM Modeler](docs/screenshot.png)

## Features

- **Textual DSL** (Langium) with PlantUML-like notation: composite states, orthogonal regions,
  initial / final states, choice, junction, shallow and deep history, entry / exit / do actions,
  internal transitions and transitions with `event [guard] / effect`.
- **Language services** in the browser: syntax highlighting, validation, code completion,
  formatting, go to definition, find references and rename (Monaco editor).
- **Validation**: duplicate names, missing or multiple initial transitions, transitions between
  orthogonal regions, non-deterministic transitions, unreachable states, misplaced history states, …
  Problems are shown in the editor *and* as markers in the diagram.
- **Diagram** (Sprotty + ELK layered layout) in the style of PlantUML: rounded states with name and
  action compartments, nested states, dashed region separators, black initial dots, bull's-eye final
  states, choice diamonds and `H` / `H*` history circles. Themes: *PlantUML classic* (yellow/red),
  *PlantUML modern* (gray) and *Dark*. Top-down or left-right layout, spline / orthogonal / polyline edges.
- **Graphical editing** – every diagram operation is translated into a minimal text edit, so comments
  and formatting are preserved and everything is undoable with `Ctrl+Z`:
  - palette tools for states, regions, choice, junction, history, initial and final states and transitions
  - double-click to rename a state or to edit the label of a transition (`event [guard] / effect`)
  - drag a state onto another state (or region) to nest it, onto the canvas to move it to the top level
  - properties panel for names, descriptions, entry / exit / do actions, triggers, guards, effects and
    to reconnect transitions
  - `Del` deletes (including all attached transitions), `F2` renames
- **Selection sync**: selecting an element in the diagram highlights its text, moving the cursor in the
  text selects the element in the diagram.
- **Export**: standalone SVG, PlantUML (`.puml`, copy to clipboard or open on plantuml.com).
- **CLI** for validation, PlantUML generation and layout computation.

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
```

## The language

```
// comments like in Java / TypeScript
statemachine CdPlayer "optional description" {
    [*] -> Closed                                  // initial transition of the state machine

    state Closed {
        [*] -> Stopped                             // initial transition of the composite state

        history H                                  // also: deephistory, choice, junction
        state Stopped
        state Active {
            [*] -> Playing
            state Playing {
                entry / "startMotor()"             // entry, exit and do actions
                do / "play()"
                on volumeUp / "louder()"           // internal transition
            }
            state Paused
            Playing -> Paused : pause
            Paused -> Playing : pause
        }
        choice HasDisc

        Stopped -> HasDisc : play
        HasDisc -> Active : [ "discInserted()" ]  // guard only
        HasDisc -> Stopped                         // else branch
    }

    state Open "Tray is open"                      // description shown in the state

    Closed -> Open : eject
    Open -> H : eject                              // re-enter the last active sub state
    Closed -> [*] : powerOff                       // transition to the final state
}
```

- State names are unique within a state machine, so transitions can refer to any state regardless of
  its nesting level – just like in PlantUML. Transitions may be declared in any scope; `[*]` refers to
  the initial (as source) or final (as target) state of the scope the transition is declared in.
- Orthogonal regions: `state S { region A { ... } region B { ... } }` (regions may be unnamed).
- Guards and effects are string literals so that they can contain arbitrary code of a target language.
- See [`examples/`](examples) for more.

## Editing in the diagram

| Action | How |
| --- | --- |
| Add a state | *State* tool (`S`), then click on the canvas, a state or a region – or double-click the canvas |
| Add a sub state | *State* tool, click on the parent state (a simple state becomes composite) |
| Add a region | *Region* tool (`R`), click on a state – existing sub states are moved into the first region |
| Add choice / junction / history | `C` / `J` / `H` / `D`, then click on the target container |
| Initial state | *Initial* tool (`I`), click on the state that should be entered first |
| Final state | *Final* tool (`F`), click on the state that should get a transition to the final state |
| Add a transition | *Transition* tool (`T`), click the source, then the target, then type the label |
| Rename / edit label | double-click or `F2` |
| Move into another state | drag and drop |
| Delete | `Del` / `Backspace` or the trash button |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` (shared with the text editor) |
| Keep a tool active | hold `Shift` while choosing it, `Esc` to go back to selection |

## Architecture

```
packages/
  language/     Langium language (no DOM dependencies, runs in Node.js and in the browser)
    src/hsm.langium           grammar
    src/hsm-validator.ts      validation rules
    src/hsm-scope.ts          global state names
    src/hsm-formatter.ts      formatter
    src/diagram/layout.ts     AST -> PlantUML-like diagram model, laid out with ELK
    src/edit/model-edits.ts   structural edits (add, move, rename, delete, …) as text edits
    src/generator/plantuml.ts PlantUML generator
    src/importer/             itemis CREATE (.sct) importer with a small XML parser
    src/simulation/           interpreter (docs/semantics.md) with virtual clock, scenario runner
    test/scenarios/           conformance suite shared with code generators (format: README.md there)
    src/cli/main.ts           command line interface
  web/          Vite app: Monaco editor + Sprotty diagram
    src/app.ts                controller: text -> Langium -> ELK (web worker) -> Sprotty, diagram edits -> text
    src/language-support.ts   Langium services wired into Monaco (markers, completion, formatting, …)
    src/diagram/              Sprotty model, views (PlantUML look), mouse / selection listeners
    src/ui/                   properties panel, inline editor, SVG / PlantUML export
examples/       sample state machines
```

The text is the single source of truth. On every change it is parsed and validated by the Langium
services, which run directly in the browser. The AST is converted into a diagram model whose layout is
computed by ELK (layered algorithm with hierarchy support, in a web worker) and rendered by Sprotty with
custom views. Diagram interactions are turned into text edits by `ModelEditor` and applied to the Monaco
model, which triggers the same pipeline again – so undo / redo, comments and formatting just work.

Possible next steps: a VS Code extension (the language package can be used by a Langium language server
together with `sprotty-vscode`), code generation for a target language, and simulation / animation of
state machine executions.

## Importing itemis CREATE models

Statecharts of itemis CREATE (formerly YAKINDU Statechart Tools) can be converted into `.hsm` models:

```bash
node packages/language/bin/cli.js import TrafficLight.sct -o TrafficLight.hsm   # warnings go to stderr
```

In the web editor, `Open…` accepts `.sct` files as well; warnings are shown in the status bar. From
code, use `importSct(xml)` of `hsm-language`, which returns `{ text, warnings }` (no DOM needed).

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
