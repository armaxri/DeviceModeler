# VS Code extension

`packages/vscode` is a VS Code extension for state machines, their unit tests and the structure files of
the Device Modeling Framework (details in [packages/vscode/README.md](../packages/vscode/README.md)):

- **Language server** for `.hsm`, `.hsmtest` and `.dmf` (Langium, separate Node process): diagnostics,
  completion, hover with doc comments, definition, references, rename, formatting, outline, folding
  and semantic highlighting (state machines and tests). The whole workspace is indexed, so test classes
  resolve state machines of other files and structure files the component types and ports of other files.
  TextMate grammars and a language configuration (comments, brackets, `/** */` continuation).
- **Diagram** (**HSM: Open Diagram** or the button in the editor title): the diagram editor of the web
  app in a webview beside the text – updated while typing, selection sync in both directions, palette
  tools, inline rename, delete, drag to nest, properties panel and simulation. Diagram edits are
  computed with `ModelEditor` and applied to the document as `WorkspaceEdit`s, so undo, the dirty
  state and git behave as for typed changes. The diagram follows the VS Code color theme (light:
  PlantUML classic, configurable with `hsm.diagram.lightTheme`; dark: dark theme).
- 🧪 **Manual layout** (only on the branches `claude/manual-layout` / `claude/layout-annotations`): the
  diagram is arranged by hand as soon as a state is dragged; the positions are layout annotations in the
  model (`@at(x, y)`, `@via(…)`, …, see [Manual layout](manual-layout.md)). *Auto-arrange* and *Automatic layout* in
  the toolbar of the diagram (also as commands **HSM: Auto-arrange Diagram** and **HSM: Use Automatic
  Diagram Layout**) write the automatic layout as annotations / remove them.
  **HSM: Convert Layout File to Annotations** writes an old `<model>.hsm.layout` into the model.
  Layout changes are `WorkspaceEdit`s like every diagram edit: one undo history (`Ctrl+Z` in the text
  editor or in the diagram), the dirty marker and *Save* apply to them. The `.sct` import writes the
  arrangement of the itemis diagram as annotations, and the SVG export applies them. Structure diagrams
  are arranged the same way (see below).
- 🧪 **Structure files (`.dmf`)**, see [below](#structure-files-dmf): language server, the structure
  diagram with editing and navigation between the diagrams.
- **C/C++ header imports**: headers are read from disk (and re-read when they change: the importing models are
  validated again), hover shows their declarations with documentation, go to definition opens the header,
  completion after `ns::`. Include paths, defines and the data model come from the `headers` block of the
  nearest `devm.gen.json` and the settings `hsm.headers.includePaths` / `hsm.headers.defines` /
  `hsm.headers.dataModel`; the diagram webview gets the headers from the extension.
- **HSM: Generate C++** uses a generator configuration (`devm.gen.json` / `*.devm.gen.json` that lists
  the model, searched from the model directory up to the workspace folder) with the same generator code
  as `hsm generate`, otherwise the settings `hsm.cpp.outputDirectory`, `hsm.cpp.namespace` and
  `hsm.cpp.standard`. `devm.gen.json` files are validated with the JSON schema.
- **Tests** in the Test Explorer (all `@Test` operations of the workspace; failures with location and
  trace; **HSM: Run Tests** for the active file) and a **Run with Model Coverage** profile that shows
  covered states / transitions / reactions and guard decisions in the coverage view.
- **HSM: Import itemis CREATE Model (.sct)**, **HSM: Export Diagram…** (SVG rendered with `renderSvg`
  – structure files: `renderIbdSvg` of the structure shown in the diagram –, or PNG: the same SVG
  rasterized in the diagram webview; also *Export…* in the diagram toolbar).

## Structure files (`.dmf`)

🧪 The [structure language](structure-language.md) of the Device Modeling Framework is served by the
same extension:

- **Language**: the language `dmf` (`.dmf`, TextMate grammar, the language configuration of the state
  machines) in the same language server – diagnostics (port ↔ state machine rules, connections, threads),
  completion, hover, formatting, outline, go to definition (component types, ports, type names, import
  paths, the state machine of a `behavior`), **Go to Implementation** = go to the provider of a required
  port, find references and rename across the structure files of the workspace (all `.dmf` files are
  indexed). The state machine features (semantic highlighting, the definition provider of `.hsm`) are not
  added to the structure language, it has its own.
- **Diagram**: **HSM: Open Diagram** (editor title, context menus, `hsm.diagram.autoOpen`) opens the
  internal block diagram beside the text, in the same webview as the state machine diagrams (structure
  mode of the diagram controller, the styles of the web app): palette, rename, drag into threads,
  connectors, properties, route highlighting, the selector of the shown subsystem or system, the structs
  and interfaces of the file as «struct» / «interface» boxes (a file with data types only shows only
  them). **Manual layout** as in the web app: drag nodes, resize them, drag ports along the border of their
  node, add / move waypoints of connectors – the positions are layout annotations of the `.dmf` text
  (`@at`, `@size`, `@port`, `@via`, see [Manual layout](manual-layout.md#structure-diagrams-dmf)), written as
  `WorkspaceEdit`s (undone with `Ctrl+Z`). *Auto-arrange* / *Automatic layout* (toolbar, the *…* menu of the
  diagram panel and the commands **HSM: Auto-arrange Diagram** / **HSM: Use Automatic Diagram Layout**, also
  with a `.dmf` editor active) apply to the shown diagram, and **HSM: Export Diagram…** uses the layout. The
  controls of the state machines (layout direction and edge routing, simulation, C++) are disabled; the
  context key `hsm.structureDiagramActive` hides *Generate C++* and *Convert Layout File to Annotations* for
  structure diagrams.
- **Navigation** (double-click an instance, its type name, the type of a port, *Go to provider*, *Follow into*, *Used by* of a
  state machine, …): the extension opens the target file in the text editor column of the diagram and
  its diagram in the column of the diagram, and shows and selects the target there. The navigation
  history is shared by all diagrams: *◀* / *▶* in the toolbar of every diagram, `Alt+←` / `Alt+→` in the
  diagram, **HSM: Diagram: Go Back** / **Go Forward** (the tooltips name the targets).
- **Edits of several files**: renaming a component type or a port in the diagram also changes the
  structure files using it, deleting a port also deletes its connections in other files. The webview
  computes the edits on the texts sent by the extension; the extension applies them as one
  `WorkspaceEdit` (`Ctrl+Z` undoes them together across the files – VS Code asks for confirmation),
  provided the files still have these texts (otherwise nothing is changed and the diagram asks to try
  again).
- **Workspace files**: the webview has no file system. With the text of the document the extension sends
  the texts of all `.hsm` and `.dmf` files of the workspace (open documents with their unsaved changes, the
  others from disk, at most 1000 files) and of the files the document imports (also C/C++ headers), and
  sends them again when one of them changes – so *Used by*, routes and providers in other files, renames and
  the markers of instances whose component type or state machine has errors work across files.

```bash
npm run package:vscode    # builds and packages packages/vscode/hsm-vscode-<version>.vsix
code --install-extension packages/vscode/hsm-vscode-0.1.0-manual-layout.vsix   # main branch: hsm-vscode-0.1.0.vsix
```

On the branches `claude/manual-layout` and `claude/layout-annotations` the package is `hsm-vscode-0.1.0-manual-layout.vsix` with the
display name *HSM Modeler (manual layout)*, so the two builds can be told apart. Both have the same
extension id (`hsm-modeler.hsm-vscode`): only one of them can be installed at a time. To switch, uninstall
the other one first (`code --uninstall-extension hsm-modeler.hsm-vscode`) or install with `--force`.
Models with layout annotations (`@at`, …) cannot be opened by the build of the main branch (syntax
errors) until the experiment is merged.

Three bundles: `dist/extension.cjs` (extension host, esbuild), `dist/server.cjs` (language server,
esbuild) and `dist/webview/` (Vite, the diagram controller, views and styles of `packages/web` – no
code is duplicated). The tests (`npm test -w packages/vscode`) cover the edit conversion, the generator
configuration resolution, test discovery / execution / coverage mapping, the collection of imported and
workspace files, the navigation history, extension code that needs the VS Code API (with a minimal
`vscode` mock: the diagram panel, workspace edits of several files, the SVG export of structures) and a
language server round trip over stdio (initialize, diagnostics, cross-file linking, hover, definition,
references, rename, formatting, symbols, folding, completion, semantic tokens; for `.dmf` files also go to
implementation and renames across files). There are no tests in a real VS Code
instance yet (`@vscode/test-electron` needs to download VS Code, which was not possible in the build
environment).
