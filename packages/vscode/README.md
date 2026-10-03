# Device Modeling Framework (HSM Modeler) for VS Code

> 🧪 This is the build of the branch `claude/layout-annotations` (version `0.1.0-manual-layout`, display name
> *Device Modeling Framework – HSM Modeler (manual layout)*) with hand-arranged diagrams, see
> [Manual layout](#manual-layout-experimental), and the 🧪 structure files of the Device Modeling Framework
> (branch `claude/device-modeling`), see [Structure files](#structure-files-dmf-experimental).
> It has the same extension id as the regular build (`hsm-modeler.hsm-vscode`), so only one of them can
> be installed at a time: uninstall the other one first (`code --uninstall-extension hsm-modeler.hsm-vscode`)
> or install with `code --install-extension <file>.vsix --force`.

Hierarchical state machines (`.hsm`), their unit tests (`.hsmtest`) and the structure of a product
(`.dmf`: components, ports, threads, instances and connections) in VS Code: a language server, the
PlantUML-style diagram editors of the web app (state machines, SysML internal block diagrams), C++ code
generation, a test runner in the Test Explorer and the import of itemis CREATE models.

## Features

- **Language server** for `.hsm` and `.hsmtest` files: diagnostics, completion, hover with signature
  and `/** … */` documentation, go to definition, find references, rename (across files), formatting,
  document symbols (outline, breadcrumbs), folding and semantic highlighting. All `.hsm` / `.hsmtest`
  files of the workspace are indexed, so `testclass T for statemachine Lamp` resolves `Lamp` in
  another file. TextMate grammars provide the basic highlighting.
- **Diagram** (**HSM: Open Diagram**, button in the editor title bar of `.hsm` files; structure files see
  [below](#structure-files-dmf-experimental)): the diagram of
  the web app next to the text editor, updated while typing. Selecting an element in the diagram
  highlights its text; moving the cursor in the text selects the element in the diagram.
  The diagram can be edited like in the web app – palette tools (states, regions, pseudo states,
  transitions), double-click / `F2` to rename or edit transition labels, `Del`, drag a state onto
  another one to nest it, properties panel. Every diagram operation is applied to the document as a
  normal text edit: undo (`Ctrl+Z` in the diagram or the text editor), the dirty marker, saving and
  git work as usual. The simulation of the web app is available in the diagram (**▶ Simulate**).
- **C/C++ header imports** (`import "motor_types.h"`, see [docs/language.md](../../docs/language.md#cc-header-imports)): models use the enums, structs,
  aliases and constants of headers. Headers are read from disk and re-read when they change (the models
  importing them are validated again); hover shows declarations with their documentation comments, go to
  definition opens the header, completion after `ns::` and `var.`. Include paths, defines and the data
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
- **HSM: Import itemis CREATE Model (.sct)** converts an `.sct` file into an `.hsm` file next to it
  (also in the context menu of `.sct` files in the explorer).
- **HSM: Export Diagram…** (also *Export…* in the diagram toolbar): standalone SVG with embedded styles,
  rendered like `hsm render`, or the same diagram as PNG image (twice the resolution, rasterized in the
  diagram webview, which is opened if necessary).

## Manual layout (experimental)

The diagram is laid out automatically by default. It can be arranged by hand, as in the web app: drag
states, pseudo states and the definitions box (`Shift` while dropping moves a state into the state below
the mouse), resize a selected state with the handle at its bottom right corner, double-click a selected
transition to add a waypoint the route passes through (drag it, double-click it to remove it), drag the
label of a selected transition. The first drag turns the diagram into a manual layout.

- **Storage:** the layout is part of the model – layout annotations before the elements (`@at(x, y)`,
  `@size(w, h)`, `@via(x1, y1, …)`, `@label(dx, dy)`, `@regions(…)`) and in their bodies (`@initial`,
  `@final`, `@definitions`); syntax in `docs/manual-layout.md` of the repository. A model with layout
  annotations has a manual layout, one without the automatic layout.
- **Auto-arrange** writes the automatic layout as annotations, **Automatic layout** removes all layout annotations;
  both are also commands (**HSM: Auto-arrange Diagram**, **HSM: Use Automatic Diagram Layout**) and in the *…*
  menu of the diagram.
  **HSM: Convert Layout File to Annotations** writes a `<model>.hsm.layout` of the earlier sidecar
  experiment into the model (the file is kept).
- **Undo and saving:** layout changes are edits of the document like all diagram edits – undone with
  `Ctrl+Z` (text editor or diagram), they mark the model as dirty and are saved with it. Renames, also
  typed in the text or via *Rename Symbol*, keep the layout.
- **HSM: Import itemis CREATE Model** writes the arrangement of the itemis diagram as annotations;
  **HSM: Export Diagram…** applies them.

## Structure files (`.dmf`, experimental)

🧪 The structure language of the Device Modeling Framework (`docs/structure-language.md` of the
repository): component types with `provides` / `requires` ports (sync data, async events), implemented by
state machines (`behavior "door.hsm"`), subsystems and the `system`, threads (instances of components run
in threads, instances of subsystems outside of them) and connections.

- **Language server**: diagnostics (ports checked against the state machine, connection kinds, types and
  directions, threads), completion, hover, formatting, outline, go to definition (component types, ports,
  types, imports, the state machine of a behavior), **Go to Implementation** = go to the provider of a
  required port, find references and rename across all `.dmf` files of the workspace.
- **Diagram** (**HSM: Open Diagram**): the internal block diagram of the subsystem or system next to the
  text (with the structs and interfaces of the file as separate «struct» / «interface» boxes), edited
  like in the web app – palette (thread, instance, ports, connector), rename (`F2`), drag instances into
  threads, `Del`, properties panel; selecting a port, connector or instance highlights the route of its
  signals through all levels. **HSM: Export Diagram…** exports the shown diagram (SVG / PNG).
- **Navigation**: double-click an instance to open its state machine or the diagram of its subsystem, its
  type name (or the type of a port) to open the type; *Go to provider*, *Follow into*, *Used by* (on a state machine diagram: the
  instances implementing it). The target file is opened with its diagram; *◀* / *▶* in the diagram toolbar,
  `Alt+←` / `Alt+→` and **HSM: Diagram: Go Back / Go Forward** move through the navigation history shared
  by all diagrams.
- **Several files at once**: a rename of a component type or port in the diagram changes all structure files
  using it, deleting a port also deletes its connections in other files – one workspace edit, undone
  together. The diagrams get the texts of all `.hsm` / `.dmf` files of the workspace (updated on every
  change) for these queries across files.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `hsm.diagram.theme` | `auto` | `auto`, `classic`, `modern`, `dark` |
| `hsm.diagram.lightTheme` | `classic` | theme for light color themes with `auto` |
| `hsm.diagram.direction` | `DOWN` | layout direction (`DOWN`, `RIGHT`) |
| `hsm.diagram.edgeRouting` | `SPLINES` | `SPLINES`, `ORTHOGONAL`, `POLYLINE` |
| `hsm.diagram.priorities` | `true` | show transition priorities |
| `hsm.diagram.showProperties` | `true` | properties panel next to the diagram |
| `hsm.diagram.autoOpen` | `false` | open the diagram whenever an `.hsm` or `.dmf` file is opened |
| `hsm.cpp.outputDirectory` | `""` | relative to the model; `${workspaceFolder}` and absolute paths work |
| `hsm.cpp.namespace` | `null` | `null`: namespace of the model, `""`: global namespace |
| `hsm.cpp.standard` | `17` | `17` or `11` |
| `hsm.trace.server` | `off` | trace of the language server protocol |

## Architecture

| Process | Bundle | Content |
| --- | --- | --- |
| Extension host | `dist/extension.cjs` (esbuild, CJS) | language client, commands, diagram panels, test controller; the language package (generators, test runner, SVG renderer) is bundled |
| Language server | `dist/server.cjs` (esbuild, CJS) | Langium services of the three languages (`createHsmServices` of the language package) plus semantic tokens and hover signatures of the state machine languages; started via IPC, `--stdio` for other clients |
| Diagram webview | `dist/webview/webview.js`, `webview.css` (Vite, IIFE) | `DiagramController`, views, properties / simulation panels and styles of the web app (`packages/web/src`), ELK in a blob web worker |

The webview parses the text of the document itself (the same code as the web app) and computes the
text edits of diagram operations with `ModelEditor`; the extension applies them with a
`WorkspaceEdit` to the document version they were computed for (otherwise the edit is rejected and
the diagram is refreshed). Edits of several files (structure files) are checked against the texts the
webview computed them on (hashes) and applied as one `WorkspaceEdit`; navigation between diagrams and its
history are handled by the extension. The protocol is in `src/common/protocol.ts`.

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

- Manual layout (experimental): models with layout annotations cannot be opened by the regular build
  (syntax errors); every drag changes the model text (coordinates appear in diffs).
- Generate C++ generates the model on disk (unsaved changes are saved first); the `c` target of a
  generator configuration is not generated by the extension (use `hsm generate`).
- Tests run in the extension host on the interpreter of the language package (no compiled C++).
- Structure files: no manual layout (layout annotations) of structure diagrams, no simulation or code
  generation of structures; the diagrams get at most 1000 workspace files.
- The extension has no end-to-end tests in a real VS Code instance yet (`@vscode/test-electron`
  needs to download VS Code); the language server is tested over stdio, the extension logic by unit
  tests.
