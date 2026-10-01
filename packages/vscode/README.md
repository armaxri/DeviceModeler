# HSM Modeler for VS Code

> 🧪 This is the build of the branch `claude/manual-layout` (version `0.1.0-manual-layout`, display name
> *HSM Modeler (manual layout)*) with hand-arranged diagrams, see [Manual layout](#manual-layout-experimental).
> It has the same extension id as the regular build (`hsm-modeler.hsm-vscode`), so only one of them can
> be installed at a time: uninstall the other one first (`code --uninstall-extension hsm-modeler.hsm-vscode`)
> or install with `code --install-extension <file>.vsix --force`.

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
- **HSM: Import itemis CREATE Model (.sct)** converts an `.sct` file into an `.hsm` file next to it
  (also in the context menu of `.sct` files in the explorer).
- **HSM: Export Diagram as SVG** (standalone SVG with embedded styles, rendered like `hsm render`) and
  **HSM: Export as PlantUML**.

## Manual layout (experimental)

The diagram is laid out automatically by default. With **Positions: Manual** in the toolbar of the
diagram it can be arranged by hand, as in the web app: drag states, pseudo states and the definitions
box (`Shift` while dropping moves a state into the state below the mouse), resize a selected state with
the handle at its bottom right corner, double-click a selected transition to add a waypoint the route
passes through (drag it, double-click it to remove it), drag the label of a selected transition. **Auto-arrange** re-runs the
automatic layout and keeps it as manual layout, **Reset** discards the manual layout, **Auto** shows the
automatic layout but keeps the manual one. The same actions are available as commands (**HSM: Diagram
Positions: Manual / Automatic**, **HSM: Auto-arrange Diagram**, **HSM: Reset Manual Diagram Layout**)
and in the *…* menu of the diagram.

- **Storage:** `<model>.hsm.layout` next to the model (JSON keyed by qualified names; format in
  `docs/manual-layout.md` of the repository). It is read when the diagram is opened and written 300 ms
  after a change in the diagram – only in the manual mode or if the file exists already, so opening a
  diagram never creates a file. *Reset* deletes it. Changes by other tools (git, another editor) are
  picked up by a file watcher. Renaming or moving the model in VS Code moves the layout file along.
  **HSM: Import itemis CREATE Model** writes the arrangement of the itemis diagram as `.hsm.layout`;
  **HSM: Export Diagram as SVG** applies the manual layout.
- **Undo:** text edits (including those made in the diagram) belong to the document and are undone by
  VS Code. Layout-only changes (move, resize, bend points, labels, Auto / Manual, Auto-arrange, Reset)
  are undone with `Ctrl+Z` / `Ctrl+Y` **while the diagram has the focus**: the diagram undoes the most
  recent change – a layout change if the text has not been changed since, otherwise the text (via VS
  Code's undo). Layout changes that belong to a diagram edit (renamed or moved states keep their
  position, deleted ones lose it) are undone and redone together with the text edit, also with `Ctrl+Z`
  in the text editor. Layout changes do not mark the model as dirty; the layout file is written
  independently of saving the model.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `hsm.diagram.theme` | `auto` | `auto`, `classic`, `modern`, `dark` |
| `hsm.diagram.lightTheme` | `classic` | theme for light color themes with `auto` |
| `hsm.diagram.direction` | `DOWN` | layout direction (`DOWN`, `RIGHT`) |
| `hsm.diagram.edgeRouting` | `SPLINES` | `SPLINES`, `ORTHOGONAL`, `POLYLINE` |
| `hsm.diagram.priorities` | `true` | show transition priorities |
| `hsm.diagram.showProperties` | `true` | properties panel next to the diagram |
| `hsm.diagram.autoOpen` | `false` | open the diagram whenever an `.hsm` file is opened |
| `hsm.cpp.outputDirectory` | `""` | relative to the model; `${workspaceFolder}` and absolute paths work |
| `hsm.cpp.namespace` | `null` | `null`: namespace of the model, `""`: global namespace |
| `hsm.cpp.standard` | `17` | `17` or `11` |
| `hsm.trace.server` | `off` | trace of the language server protocol |

## Architecture

| Process | Bundle | Content |
| --- | --- | --- |
| Extension host | `dist/extension.cjs` (esbuild, CJS) | language client, commands, diagram panels, test controller; the language package (generators, test runner, SVG renderer) is bundled |
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
code --install-extension packages/vscode/hsm-vscode-0.1.0-manual-layout.vsix --force
```

To debug, open the repository in VS Code and start an *Extension Development Host* with
`--extensionDevelopmentPath=packages/vscode` after building (`npm run watch -w packages/vscode`
rebuilds the extension and the server on changes).

## Limitations

- Manual layout (experimental): the layout file is written also while the model has unsaved changes,
  and *Revert File* does not revert it; renames typed in the text (or via *Rename Symbol*) do not update
  the layout keys (the renamed state is placed automatically).
- Generate C++ generates the model on disk (unsaved changes are saved first); the `c` target of a
  generator configuration is not generated by the extension (use `hsm generate`).
- Tests run in the extension host on the interpreter of the language package (no compiled C++).
- The extension has no end-to-end tests in a real VS Code instance yet (`@vscode/test-electron`
  needs to download VS Code); the language server is tested over stdio, the extension logic by unit
  tests.
