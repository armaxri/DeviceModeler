# VS Code extension

`packages/vscode` is a VS Code extension for models and their unit tests (details in
[packages/vscode/README.md](../packages/vscode/README.md)):

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
- 🧪 **Manual layout** (only on the branches `claude/manual-layout` / `claude/layout-annotations`): the
  diagram is arranged by hand as soon as a state is dragged; the positions are layout annotations in the
  model (`@at(x, y)`, `@via(…)`, …, see [Manual layout](manual-layout.md)). The toolbar of the diagram shows
  *Positions: automatic* / *stored in model*; *Store positions* / *Re-arrange* writes the automatic
  arrangement as annotations, *Clear positions* removes them (also the commands **HSM: Re-arrange Diagram
  and Store Positions in Model** and **HSM: Clear Stored Diagram Positions (Remove Layout Annotations)**).
  **HSM: Convert Layout File to Annotations** writes an old `<model>.hsm.layout` into the model.
  Layout changes are `WorkspaceEdit`s like every diagram edit: one undo history (`Ctrl+Z` in the text
  editor or in the diagram), the dirty marker and *Save* apply to them. The `.sct` import writes the
  arrangement of the itemis diagram as annotations, and the SVG export applies them.
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
- **Debugging tests** (*Debug Test* in the Test Explorer, **HSM: Debug Tests**, `F5` in an `.hsmtest`
  file, or a launch configuration `"type": "hsm-test"`): see [Debugging tests](#debugging-tests) below.
- **HSM: Import itemis CREATE Model (.sct)**, **HSM: Export Diagram…** (SVG rendered with `renderSvg`,
  or PNG: the same SVG rasterized in the diagram webview; also *Export…* in the diagram toolbar).

```bash
npm run package:vscode    # builds and packages packages/vscode/hsm-vscode-<version>.vsix
code --install-extension packages/vscode/hsm-vscode-0.1.0.vsix
```

Three bundles: `dist/extension.cjs` (extension host, esbuild), `dist/server.cjs` (language server,
esbuild) and `dist/webview/` (Vite, the diagram controller, views and styles of `packages/web` – no
code is duplicated). The tests (`npm test -w packages/vscode`) cover the edit conversion, the generator
configuration resolution, test discovery / execution / coverage mapping, extension code that needs the
VS Code API (with a minimal `vscode` mock) and a language server round
trip over stdio (initialize, diagnostics, cross-file linking, hover, definition, references, rename,
formatting, symbols, folding, completion, semantic tokens). There are no tests in a real VS Code
instance yet (`@vscode/test-electron` needs to download VS Code, which was not possible in the build
environment).

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
