# HSM Modeler for VS Code

Hierarchical state machines (`.hsm`) and their unit tests (`.hsmtest`) in VS Code: a language
server, the PlantUML-style diagram editor of the HSM web app, C++ code generation, a test runner in
the Test Explorer and the import of itemis CREATE models.

## Features

- **Language server** for `.hsm` and `.hsmtest` files: diagnostics, completion, hover with signature
  and `/** … */` documentation, go to definition, find references, rename (across files), formatting,
  document symbols (outline, breadcrumbs), folding and semantic highlighting. All `.hsm` / `.hsmtest`
  files of the workspace are indexed, so `testclass T for statemachine Lamp` resolves `Lamp` in
  another file. TextMate grammars provide the basic highlighting.
- **Diagram** (**HSM: Open Diagram**, button in the editor title bar of `.hsm` files): the diagram of
  the web app next to the text editor, updated while typing. Selecting an element in the diagram
  highlights its text; moving the cursor in the text selects the element in the diagram.
  The diagram can be edited like in the web app – palette tools (states, regions, pseudo states,
  transitions), double-click / `F2` to rename or edit transition labels, `Del`, drag a state onto
  another one to nest it, properties panel. Every diagram operation is applied to the document as a
  normal text edit: undo (`Ctrl+Z` in the diagram or the text editor), the dirty marker, saving and
  git work as usual. The simulation of the web app is available in the diagram (**▶ Simulate**).
- **C/C++ header imports** (`import "motor_types.h"`, see [docs/language.md](../../docs/language.md#cc-header-imports)): models use the enums, structs,
  aliases and constants of headers. Headers are read from disk and re-read when they change (the models
  importing them are validated again); hover shows declarations with their documentation comments,
  completion after `ns::` and `var.`. **Navigation into the headers** works with the usual keys: Go to
  Definition (`F12`, `Ctrl`/`Cmd`+Click), Peek Definition (`Alt+F12`), Go to Declaration and Go to Type
  Definition. Each segment of a qualified name leads to its own declaration (`app` → the namespace,
  `Mode` → the enum, `Fast` → the enumerator in `app::Mode::Fast`), struct members (`cfg.limits.low`)
  lead to the fields, the definition is preferred (the enum definition over an opaque declaration, the
  target of `using ns::Name;`; Go to Declaration lists all of them), Go to Type Definition leads from a
  variable, event, parameter, constant, enumerator or member to its C++ enum or struct (or the alias of a
  built-in type); the path in `import "header.h"` is a link that opens the header (also headers found
  through include paths and `#include`s). Include paths, defines and the data
  model come from the `headers` block of the nearest `hsm.gen.json` and the settings
  `hsm.headers.includePaths`, `hsm.headers.defines` and `hsm.headers.dataModel` (also used by the diagram,
  its simulation – enum drop-downs and struct editors – and the Test Explorer).
- **Themes**: with `hsm.diagram.theme` = `auto` (default) the diagram follows the color theme of VS
  Code: light themes use `hsm.diagram.lightTheme` (default *PlantUML classic*), dark and high contrast
  themes the dark diagram theme.
- **HSM: Generate C++**: generates `sc_statemachine.h`, `<Class>.h` and `<Class>.cpp` exactly like
  `hsm generate`. A generator configuration `hsm.gen.json` or `<name>.hsm.gen.json` in the directory of
  the model or in a parent directory (up to the workspace folder) that lists the model and configures
  the `cpp` target is used with all its options (output directory, namespace, class name, standard,
  file extensions, license header, …). Otherwise the settings `hsm.cpp.outputDirectory`,
  `hsm.cpp.namespace` and `hsm.cpp.standard` apply. `hsm.gen.json` files are validated against the
  JSON schema (completion and hover in the JSON editor).
- **Tests** in the Test Explorer: the `@Test` operations of all `.hsmtest` files, grouped by file and
  test class. Failed assertions are reported with their location and the execution trace. The run
  profile **Run with Model Coverage** shows which states, transitions and local reactions of the
  models were covered (statements) and which guards were true / false (branches) in the coverage
  view of VS Code. **HSM: Run Tests** runs the tests of the active `.hsmtest` file.
- **Debugging tests** (*Debug Test* in the Test Explorer, **HSM: Debug Tests**, `F5` or a launch
  configuration of type `hsm-test`): breakpoints on test statements and on states, transitions and
  reactions of the model, stepping over statements and into the microsteps of the interpreter, the
  active states, variables, events and operation calls in the debug views, and the diagram of the
  model showing the current states on every stop – see [Debugging tests](#debugging-tests).
- **HSM: Import itemis CREATE Model (.sct)** converts an `.sct` file into an `.hsm` file next to it
  (also in the context menu of `.sct` files in the explorer).
- **HSM: Export Diagram…** (also *Export…* in the diagram toolbar): standalone SVG with embedded styles,
  rendered like `hsm render`, or the same diagram as PNG image (twice the resolution, rasterized in the
  diagram webview, which is opened if necessary).

## Debugging tests

The tests of `.hsmtest` files can be run in the debugger, step by step, while the diagram of the
state machine under test shows the current states:

- **Start**: the *Debug Test* action of the Test Explorer (also the debug icon next to the run icon in
  the gutter of a test), **HSM: Debug Tests** (debug button in the editor title of `.hsmtest` files,
  context menu of the explorer), `F5` in an `.hsmtest` file without a `launch.json`, or a launch
  configuration:

  ```jsonc
  {
      "type": "hsm-test",
      "request": "launch",
      "name": "Debug HSM tests",
      "program": "${file}",              // the .hsmtest file
      "test": "DoorTest.opensAndCloses", // optional: a test class, Class.test or a test name
      "stopOnEntry": false               // pause before the first statement
  }
  ```

  Results of debug runs started from the Test Explorer (or with *HSM: Debug Tests*) are reported there
  like normal runs (passed / failed with message, location and trace).
- **Breakpoints** on statements of tests (`raise`, `proceed`, `assert`, …; a breakpoint on another line
  moves to the next statement) and in models: on a state (pauses when it is entered), on a transition
  (when it is taken) and on a local reaction (`entry / …`, when it runs). *Function breakpoints* with
  the name of a state (`Closed`, `Moving.Up`, `motor.Running`) pause when the state is entered. The
  exception breakpoints **Assertion failures** and **Errors** (both enabled by default) pause on a
  failed assertion or a runtime error with the message, before the test ends.
- **Stepping**: *Step Over* runs the current statement (with all run-to-completion steps of the state
  machine) and pauses at the next statement; *Step Into* pauses at every microstep of the interpreter –
  state exited, transition taken, state entered, reaction executed (the frame shows the element in the
  `.hsm` file) – and enters called helper operations; *Step Out* finishes the microsteps of the
  statement or returns from a helper operation; *Continue*, *Pause* (also in endless loops), *Restart*
  and *Stop*.
- **Views**: the call stack (microstep → helper operation → test), the variables in the scopes
  *Locals* (parameters and local variables of the test operation), *Microstep*, *Active states*,
  *State machine* (all variables, also of submachine instances, structured C/C++ values expandable),
  *Events* (out events of the last step, events raised by the statement), *Operation calls* (calls of
  the state machine and the mocks) and *Execution* (test, virtual time, execution mode, last trace
  lines). Hover, watch and the debug console evaluate names: local variables, variables of the state
  machine (`count`, `Iface.x`, `motor.speed`), `active(State)` or a state name, `time`, `is_final`
  (no complete expressions). The debug console shows the execution trace (`> raise open`,
  `transition Closed -> Moving`, …) and the result of every test.
- **Live diagram**: on every stop the diagram of the model under test is opened beside the editor (if
  necessary) and shows the active states and the transitions taken since the previous stop, like the
  simulation; its side panel lists the active states and the stop location. The diagram is read-only
  while the session runs (no edits, no simulation, layout controls disabled) and returns to normal when
  the session ends.

The debug adapter runs inline in the extension host (`vscode.DebugAdapterInlineImplementation`,
`src/debug/adapter.ts`); the tests run in a worker thread (`dist/debug-worker.cjs`, `src/debug/engine.ts`)
that pauses inside the hooks of the test runner of the language package (`TestDebugHooks`) and waits
for the next command of the adapter.

## Manual layout (experimental)

The diagram is laid out automatically by default. It can be arranged by hand, as in the web app: drag
states, pseudo states and the definitions box (`Shift` while dropping moves a state into the state below
the mouse), resize a selected state with the handle at its bottom right corner, double-click a selected
transition to add a waypoint the route passes through (drag it, double-click it to remove it), drag the
label of a selected transition, drag the square at the start or end of a selected transition along the border
of its state (double-click it to place that end automatically again). The first drag turns the diagram into a manual layout.

- **Storage:** the layout is part of the model – layout annotations before the elements (`@at(x, y)`,
  `@size(w, h)`, `@via(x1, y1, …)`, `@label(dx, dy)`, `@from(side, %)` / `@to(side, %)`, `@regions(…)`) and in their bodies (`@initial`,
  `@final`, `@definitions`); syntax in `docs/manual-layout.md` of the repository. A model with layout
  annotations has a manual layout, one without the automatic layout.
- **Toolbar:** *Positions: automatic* or *Positions: stored in model* shows whether the model has layout
  annotations. **Store positions** (no annotations yet) / **Re-arrange** (annotations present) arranges all
  elements automatically and writes the positions as annotations (Re-arrange replaces the stored ones and
  drops waypoints, sizes and label positions); **Clear positions** removes all layout annotations, so the
  diagram is arranged automatically again. Both are one undoable edit and also commands (**HSM: Re-arrange
  Diagram and Store Positions in Model**, **HSM: Clear Stored Diagram Positions (Remove Layout
  Annotations)**) in the command palette and the *…* menu of the diagram.
  **HSM: Convert Layout File to Annotations** writes a `<model>.hsm.layout` of the earlier sidecar
  experiment into the model (the file is kept).
- **Undo and saving:** layout changes are edits of the document like all diagram edits – undone with
  `Ctrl+Z` (text editor or diagram), they mark the model as dirty and are saved with it. Renames, also
  typed in the text or via *Rename Symbol*, keep the layout.
- **HSM: Import itemis CREATE Model** writes the arrangement of the itemis diagram as annotations;
  **HSM: Export Diagram…** applies them.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `hsm.diagram.theme` | `auto` | `auto`, `classic`, `modern`, `dark` |
| `hsm.diagram.lightTheme` | `classic` | theme for light color themes with `auto` |
| `hsm.diagram.direction` | `DOWN` | layout direction (`DOWN`, `RIGHT`) |
| `hsm.diagram.edgeRouting` | `SPLINES` | `SPLINES`, `ORTHOGONAL`, `ROUNDED` (orthogonal with rounded corners), `POLYLINE`, `SMOOTH` (smooth curve through the polyline) |
| `hsm.diagram.priorities` | `true` | show transition priorities |
| `hsm.diagram.showProperties` | `true` | side panel (properties, simulation) next to the diagram; also toggled by the panel button of the diagram's toolbar |
| `hsm.diagram.autoOpen` | `false` | open the diagram whenever an `.hsm` file is opened |
| `hsm.cpp.outputDirectory` | `""` | relative to the model; `${workspaceFolder}` and absolute paths work |
| `hsm.cpp.namespace` | `null` | `null`: namespace of the model, `""`: global namespace |
| `hsm.cpp.standard` | `17` | `17` or `11` |
| `hsm.trace.server` | `off` | trace of the language server protocol |

## Architecture

| Process | Bundle | Content |
| --- | --- | --- |
| Extension host | `dist/extension.cjs` (esbuild, CJS) | language client, commands, diagram panels, test controller, debug adapter of tests; the language package (generators, test runner, SVG renderer) is bundled |
| Debug worker | `dist/debug-worker.cjs` (esbuild, CJS) | worker thread of the extension host executing the tests of a debug session (`src/debug/worker.ts`, `engine.ts`) |
| Language server | `dist/server.cjs` (esbuild, CJS) | Langium services of both languages (`createHsmServices` of the language package) plus semantic tokens and hover signatures; started via IPC, `--stdio` for other clients |
| Diagram webview | `dist/webview/webview.js`, `webview.css` (Vite, IIFE) | `DiagramController`, views, properties / simulation panels and styles of the web app (`packages/web/src`), ELK in a blob web worker |

The webview parses the text of the document itself (the same code as the web app) and computes the
text edits of diagram operations with `ModelEditor`; the extension applies them with a
`WorkspaceEdit` to the document version they were computed for (otherwise the edit is rejected and
the diagram is refreshed). The protocol is in `src/common/protocol.ts`.

## Development

```bash
npm run build -w packages/vscode      # bundles into packages/vscode/dist
npm test -w packages/vscode           # unit tests + language server round trip over stdio
npm run package -w packages/vscode    # build + packages/vscode/hsm-vscode-<version>.vsix
code --install-extension packages/vscode/hsm-vscode-0.1.0.vsix --force
```

To debug, open the repository in VS Code and start an *Extension Development Host* with
`--extensionDevelopmentPath=packages/vscode` after building (`npm run watch -w packages/vscode`
rebuilds the extension and the server on changes).

## Limitations

- Manual layout (experimental): models with layout annotations cannot be opened by the regular build
  (syntax errors); every drag changes the model text (coordinates appear in diffs).
- Generate C++ generates the model on disk (unsaved changes are saved first); the `c` target of a
  generator configuration is not generated by the extension (use `hsm generate`).
- Tests run in the extension host on the interpreter of the language package (no compiled C++).
- Debugging: the debug console, hover and watch evaluate names (variables, states, `active(State)`), not
  complete expressions; variables cannot be changed in the Variables view; conditional and hit count
  breakpoints are not supported; breakpoints in models work on the elements of the files of the workspace
  (also of imported submachines), the diagram highlights the elements of the model under test only
  (submachine instances show their active states in the state they are bound to).
- The extension has no end-to-end tests in a real VS Code instance yet (`@vscode/test-electron`
  needs to download VS Code); the language server is tested over stdio, the extension logic by unit
  tests.
