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
- 🧪 **Manual layout** (only on the branch `claude/manual-layout`): *Positions: Auto | Manual*,
  *Auto-arrange* and *Reset* in the toolbar of the diagram (also as commands **HSM: Diagram Positions:
  Manual / Automatic**, **HSM: Auto-arrange Diagram**, **HSM: Reset Manual Diagram Layout**). The layout
  is the sidecar file `<model>.hsm.layout` in the workspace: read when the diagram is opened, written
  (debounced) when the layout is changed in the diagram – only in the manual mode or if the file exists
  already, so opening a diagram never creates files –, deleted by *Reset*, reloaded when another tool
  (e.g. git) changes it, and moved along when the model is renamed in VS Code. The `.sct` import writes
  the arrangement of the itemis diagram as `.hsm.layout`, and the SVG export applies a manual layout.
  **Undo:** text changes belong to the VS Code document (`Ctrl+Z` in the text editor or in the diagram,
  the dirty marker, *Save*), layout-only changes (move, resize, bend points, labels, Auto / Manual,
  Auto-arrange, Reset) are undone with `Ctrl+Z` / `Ctrl+Y` **in the diagram**, in the order in which they
  were made relative to the text edits. Layout changes caused by diagram edits (rename, move into
  another state, delete) are undone together with their text edit – also with `Ctrl+Z` in the text
  editor. The layout file is written directly, independent of saving the model.
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
npm run package:vscode    # builds and packages packages/vscode/hsm-vscode-<version>.vsix
code --install-extension packages/vscode/hsm-vscode-0.1.0-manual-layout.vsix   # main branch: hsm-vscode-0.1.0.vsix
```

On the branch `claude/manual-layout` the package is `hsm-vscode-0.1.0-manual-layout.vsix` with the
display name *HSM Modeler (manual layout)*, so the two builds can be told apart. Both have the same
extension id (`hsm-modeler.hsm-vscode`): only one of them can be installed at a time. To switch, uninstall
the other one first (`code --uninstall-extension hsm-modeler.hsm-vscode`) or install with `--force`.
Layout files written by the manual layout build are simply ignored by the build of the main branch.

Three bundles: `dist/extension.cjs` (extension host, esbuild), `dist/server.cjs` (language server,
esbuild) and `dist/webview/` (Vite, the diagram controller, views and styles of `packages/web` – no
code is duplicated). The tests (`npm test -w packages/vscode`) cover the edit conversion, the generator
configuration resolution, test discovery / execution / coverage mapping, the layout file handling of
the manual layout (with a minimal `vscode` mock) and a language server round
trip over stdio (initialize, diagnostics, cross-file linking, hover, definition, references, rename,
formatting, symbols, folding, completion, semantic tokens). There are no tests in a real VS Code
instance yet (`@vscode/test-electron` needs to download VS Code, which was not possible in the build
environment).
