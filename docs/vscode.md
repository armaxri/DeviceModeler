# VS Code extension

`packages/vscode` is the VS Code extension of the Device Modeler: state machines and structure files
(`.devm`) and the unit tests of state machines (`.devmtest`), details in
[packages/vscode/README.md](../packages/vscode/README.md):

- **Language server** for the languages `devm` (`.devm`: state machine files and structure files) and
  `devmtest` (Langium, separate Node process): diagnostics, completion, hover with doc comments,
  definition, references, rename, formatting, outline, folding and semantic highlighting. The whole workspace is indexed, so test classes
  resolve state machines of other files and structure files the component types and ports of other files.
  TextMate grammars and a language configuration (comments, brackets, `/** */` continuation).
- **Diagram** (**Device Modeler: Open Diagram** or the button in the editor title): the diagram editor of the web
  app in a webview beside the text – updated while typing, selection sync in both directions, palette
  tools, inline rename, delete, drag to nest, properties panel and simulation. Diagram edits are
  computed with `ModelEditor` and applied to the document as `WorkspaceEdit`s, so undo, the dirty
  state and git behave as for typed changes. The diagram follows the VS Code color theme (light:
  PlantUML classic, configurable with `devm.diagram.lightTheme`; dark: dark theme).
- **Manual layout** (merged into main from the branch `claude/layout-annotations`, PR #4): the
  diagram is arranged by hand as soon as a state is dragged; the positions are layout annotations in the
  model (`@at(x, y)`, `@via(…)`, …, see [Manual layout](manual-layout.md)). The toolbar of the diagram shows
  *Positions: automatic* / *stored in model*; *Store positions* / *Re-arrange* writes the automatic
  arrangement as annotations, *Clear positions* removes them (also the commands **Device Modeler: Re-arrange Diagram
  and Store Positions in Model** and **Device Modeler: Clear Stored Diagram Positions (Remove Layout Annotations)**).
  **Device Modeler: Convert Layout File to Annotations** writes an old `<model>.devm.layout` into the model.
  Layout changes are `WorkspaceEdit`s like every diagram edit: one undo history (`Ctrl+Z` in the text
  editor or in the diagram), the dirty marker and *Save* apply to them. The `.sct` import writes the
  arrangement of the itemis diagram as annotations, and the SVG export applies them. Structure diagrams
  are arranged the same way (see below).
- 🧪 **Structure files**, see [below](#structure-files): language server, the structure
  diagram with editing and navigation between the diagrams.
- **C/C++ header imports**: headers are read from disk (and re-read when they change: the importing models are
  validated again), hover shows their declarations with documentation, go to definition opens the header,
  completion after `ns::`. Include paths, defines and the data model come from the `headers` block of the
  nearest `devm.gen.json` and the settings `devm.headers.includePaths` / `devm.headers.defines` /
  `devm.headers.dataModel`; the diagram webview gets the headers from the extension.
- **Device Modeler: Generate C++** uses a generator configuration (`devm.gen.json` / `*.devm.gen.json` that lists
  the model, searched from the model directory up to the workspace folder) with the same generator code
  as `devm generate`, otherwise the settings `devm.cpp.outputDirectory`, `devm.cpp.namespace` and
  `devm.cpp.standard`. `devm.gen.json` files are validated with the JSON schema.
- **Tests** in the Test Explorer (all `@Test` operations of the workspace; failures with location and
  trace; **Device Modeler: Run Tests** for the active file) and a **Run with Model Coverage** profile that shows
  covered states / transitions / reactions and guard decisions in the coverage view.
- **Debugging tests** (*Debug Test* in the Test Explorer, **Device Modeler: Debug Tests**, `F5` in a `.devmtest`
  file, or a launch configuration `"type": "devm-test"`): see [Debugging tests](#debugging-tests) below.
- **Device Modeler: Import itemis CREATE Model (.sct)**, **Device Modeler: Export Diagram…** (SVG rendered with `renderSvg`,
  or PNG: the same SVG rasterized in the diagram webview; also *Export…* in the diagram toolbar).

- **Device Modeler: Import itemis CREATE Model (.sct)**, **Device Modeler: Export Diagram…** (SVG rendered with `renderSvg`
  – structure files: `renderIbdSvg` of the structure shown in the diagram –, or PNG: the same SVG
  rasterized in the diagram webview; also *Export…* in the diagram toolbar).

## Structure files

🧪 The [structure language](structure-language.md) of the Device Modeler is served by the
same extension:

- **Language**: structure files are `.devm` files of the language `devm` like the state machines (one
  TextMate grammar and language configuration, the diagram and the code generation menus follow the
  content of the file: the context key `devm.structureEditorActive` is set for an editor showing a
  structure file) – diagnostics (port ↔ state machine rules, connections, threads),
  completion, hover, formatting, outline, go to definition (component types, ports, type names, import
  paths, the state machine of a `behavior`), **Go to Implementation** = go to the source of the data of an
  in port (the ports sharing the data of an inout port), find references and rename across the structure files of the workspace (all `.devm` files are
  indexed). The providers of the language dispatch on the kind of the file or node (see
  [Architecture](architecture.md#one-language-for-two-kinds-of-model-files)), so the definition provider
  of state machines (C++ names, imported machines) and the one of structure files work side by side.
- **Diagram**: **Device Modeler: Open Diagram** (editor title, context menus, `devm.diagram.autoOpen`) opens the
  internal block diagram beside the text, in the same webview as the state machine diagrams (structure
  mode of the diagram controller, the styles of the web app): palette, rename, drag into threads,
  connectors, properties, route highlighting, the selector of the shown subsystem or system, the structs
  of the file as «struct» boxes (a file with data types only shows only them). **Manual layout** as in the web app: drag nodes, resize them, drag ports along the border of their
  node, add / move waypoints of connectors – the positions are layout annotations of the `.devm` text
  (`@at`, `@size`, `@port`, `@via`, see [Manual layout](manual-layout.md#structure-diagrams)), written as
  `WorkspaceEdit`s (undone with `Ctrl+Z`). *Store positions* / *Re-arrange* / *Clear positions* (toolbar, the *…* menu of the
  diagram panel and the commands **Device Modeler: Re-arrange Diagram and Store Positions in Model** / **Device Modeler: Clear
  Stored Diagram Positions (Remove Layout Annotations)**, also with the `.devm` editor active) apply to the shown diagram, and **Device Modeler: Export Diagram…** uses the layout. The
  controls of the state machines (layout direction and edge routing, simulation, C++) are disabled; the
  context key `devm.structureDiagramActive` hides *Generate C++* and *Convert Layout File to Annotations* for
  structure diagrams.
- **Navigation** (double-click an instance, its type name, the type of a port, *Go to source*, *Follow into*, *Used by* of a
  state machine, …): the extension opens the target file in the text editor column of the diagram and
  its diagram in the column of the diagram, and shows and selects the target there. The navigation
  history is shared by all diagrams: *◀* / *▶* in the toolbar of every diagram, `Alt+←` / `Alt+→` in the
  diagram, **Device Modeler: Diagram: Go Back** / **Go Forward** (the tooltips name the targets).
- **Edits of several files**: renaming a component type or a port in the diagram also changes the
  structure files using it, deleting a port also deletes its connections in other files. The webview
  computes the edits on the texts sent by the extension; the extension applies them as one
  `WorkspaceEdit` (`Ctrl+Z` undoes them together across the files – VS Code asks for confirmation),
  provided the files still have these texts (otherwise nothing is changed and the diagram asks to try
  again).
- **Workspace files**: the webview has no file system. With the text of the document the extension sends
  the texts of all `.devm` files of the workspace (open documents with their unsaved changes, the
  others from disk, at most 1000 files) and of the files the document imports (also C/C++ headers), and
  sends them again when one of them changes – so *Used by*, routes and sources in other files, renames and
  the markers of instances whose component type or state machine has errors work across files.

```bash
npm run package:vscode    # builds and packages packages/vscode/devm-vscode-<version>.vsix
code --install-extension packages/vscode/devm-vscode-0.1.0.vsix
```

The extension id is `device-modeler.devm-vscode` (formerly `devm-modeler.devm-vscode`): a build with the
former id is a different extension and has to be uninstalled first
(`code --uninstall-extension devm-modeler.devm-vscode`); builds with the same id replace each other with
`--force`. Its settings `devm.*` are not taken over, the settings are now `devm.*`.

Three bundles: `dist/extension.cjs` (extension host, esbuild), `dist/server.cjs` (language server,
esbuild) and `dist/webview/` (Vite, the diagram controller, views and styles of `packages/web` – no
code is duplicated). The tests (`npm test -w packages/vscode`) cover the edit conversion, the generator
configuration resolution, test discovery / execution / coverage mapping, the collection of imported and
workspace files, the navigation history, extension code that needs the VS Code API (with a minimal
`vscode` mock: the diagram panel, workspace edits of several files, the SVG export of structures) and a
language server round trip over stdio (initialize, diagnostics, cross-file linking, hover, definition,
references, rename, formatting, symbols, folding, completion, semantic tokens; for structure files also go
to implementation and renames across files). There are no tests in a real VS Code
instance yet (`@vscode/test-electron` needs to download VS Code, which was not possible in the build
environment).

## Debugging tests

The tests of `.devmtest` files can be run in the debugger, step by step, while the diagram of the
state machine under test shows the current states:

- **Start**: the *Debug Test* action of the Test Explorer (also the debug icon next to the run icon in
  the gutter of a test), **Device Modeler: Debug Tests** (debug button in the editor title of `.devmtest` files,
  context menu of the explorer), `F5` in a `.devmtest` file without a `launch.json`, or a launch
  configuration:

  ```jsonc
  {
      "type": "devm-test",
      "request": "launch",
      "name": "Debug Device Modeler tests",
      "program": "${file}",              // the .devmtest file
      "test": "DoorTest.opensAndCloses", // optional: a test class, Class.test or a test name
      "stopOnEntry": false               // pause before the first statement
  }
  ```

  Results of debug runs started from the Test Explorer (or with *Device Modeler: Debug Tests*) are reported there
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
  `.devm` file) – and enters called helper operations; *Step Out* finishes the microsteps of the
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
