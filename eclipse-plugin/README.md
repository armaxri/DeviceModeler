# Eclipse plugin (prototype)

An editor for `.hsm` files in the Eclipse IDE: the HSM web app (Monaco text editor, diagram editor,
properties, simulation, export, C++ generation) runs in an SWT `Browser` widget inside an Eclipse editor and
edits the workspace file. Nothing of the language is reimplemented in Java – the plugin hosts the web app and
connects it to the workbench (Problems view, Outline, edit commands, preferences, resources).

```
Eclipse editor (HsmDiagramEditor)                       SWT Browser (Edge / WebKit)
  ├─ IFile ↔ text, dirty state, Save / Save As   HTTP     ├─ packages/web/dist (the web app, ?host=http)
  ├─ problem markers, Outline, edit commands   ◄──────►  └─ packages/web/src/host*.ts: document, changed, save,
  └─ WebServer (127.0.0.1, JDK HttpServer)                   model (problems + outline), settings, generate, …
```

## What it does

- **Editor** for `.hsm` (default editor; *Open With > Text Editor* still opens the plain text). The page gets
  the text of the workspace file; changes set the dirty marker; *File > Save* or `Ctrl+S` / *Save* in the page
  write the file (with local history); **Save As…** writes another file and edits it from then on.
- **Problems view**: the page reports its Langium diagnostics after every validation (also of unsaved
  text); they become markers of the type `hsm.eclipse.problem` (a problem and text marker with line and
  character range). Double-clicking a marker opens the editor and selects the range in the page's text
  editor and the element in the diagram (`IGotoMarker`). Markers stay when the editor is closed (like a build
  result) and are not persisted across restarts.
- **Outline view**: state machine, definitions, states with regions and nested states, pseudo states and
  transitions; selecting an element selects its text and diagram element.
- **Edit commands**: Eclipse's *Undo*, *Redo*, *Cut*, *Copy*, *Paste*, *Select All* and *Find/Replace* (menus
  and key bindings) act on the page: on the text editor, on an input field of the properties panel or on the
  diagram (undo / select all). Copy and paste use the Eclipse clipboard. On macOS (WebKit) the key bindings
  go to the page directly while it has the focus (`Cmd+Z`, `Cmd+S`, … work natively); if an engine passes a
  key both to Eclipse and to the page, the page ignores the second command.
- **Rename / move** of the file: the editor follows it (and resolves the imports from the new location);
  deleting the file closes the editor. External changes (another editor, git) are loaded into the page, with
  a question if there are unsaved changes.
- **Imports**: the `.hsm` models and C/C++ headers of the **project** are passed to the page with their
  project-relative paths, so `import "../motor.hsm"` works within the project (the project is the boundary;
  paths leaving it are not found). The `headers` block (include paths, defines, data model) of the nearest
  `hsm.gen.json` / `*.hsm.gen.json` (from the model's folder up to the project) is applied, include paths
  relative to the configuration file. Changes of models, headers and configurations update the page.
- **C++ generation**: *Generate C++* in the context menu of `.hsm` files (Project Explorer) and the *C++*
  button of the page. The generator of the language package runs in the page (no Node.js needed); the
  configuration is resolved like `HSM: Generate C++` of the VS Code extension: the nearest generator
  configuration that lists the model wins (`outDir`, namespace, extensions, `licenseHeaderFile`, …),
  otherwise *Preferences > HSM Modeler* (output folder relative to the model or `${project}/…`, namespace,
  C++ standard). The files are written into the project (unchanged files are not touched); the result is
  shown in the page and in Eclipse's status line, problems in the Error Log.
- **Page settings** (theme, layout direction, edge routing, priorities, splitter) are stored in the Eclipse
  preferences, so they survive restarts and port changes.
- **Dark theme**: with a dark Eclipse theme (CSS theme engine, otherwise the dark mode of the system) the page
  uses its *Dark* theme; with a light Eclipse theme a stored *Dark* is replaced by *PlantUML classic*.
- **Builder for closed files** (prepared): the nature / builder `hsm.eclipse.nature` / `hsm.eclipse.builder`
  (*Configure > Enable / Disable HSM Validation* on projects) writes markers for all changed models – as soon
  as a `ModelValidator` is registered (see below). Without one it does nothing.

## Architecture

| Class / file | Role |
|---|---|
| `hsm.eclipse.WebServer` | loopback HTTP server (JDK `com.sun.net.httpserver`, no Eclipse dependencies): static web app + API, one random token per editor; rejects unknown tokens and foreign `Host` headers |
| `hsm.eclipse.HostSession` | the API of one page (implemented by the editor), see `packages/web/src/host.ts` for the protocol |
| `hsm.eclipse.HsmDiagramEditor` | the editor: browser, dirty state, save / save as, markers, outline, edit commands, resource changes |
| `hsm.eclipse.ProjectFiles` | project-relative paths, importable files, generator configurations, writing files |
| `hsm.eclipse.ProblemMarkers` | marker type `hsm.eclipse.problem`, coalescing marker updates |
| `hsm.eclipse.HsmOutlinePage` | Outline view |
| `hsm.eclipse.Preferences`, `HsmPreferencePage` | C++ preferences, stored page settings |
| `hsm.eclipse.tools.*` | **integration point for the bundled executable**: `ModelValidator`, `ModelGenerator`, `ModelProblem`, `HsmTools` (registry), `PageGenerator` (generation in the page) |
| `hsm.eclipse.builder.*` | nature, builder (uses `HsmTools.validator()`), toggle command |
| `packages/web/src/host.ts` | embedded mode of the web app (`?host=http`): protocol and client |
| `packages/web/src/host-model.ts` | problems and outline of a parsed model for the host |
| `packages/web/src/host-generate.ts` | C++ generation in the page with the configuration resolution of `hsm generate` |

Without `?host=http` the web app behaves as before (only `app.ts` branches on the host).

### The bundled `hsm` executable

The command line executable of `packages/cli` (a Node.js single executable application, no Node.js needed)
runs what needs no page:

- **Validation of closed files**: `hsm.eclipse.tools.CliValidator` (registered by the activator in `HsmTools`)
  runs `hsm validate --json <models…>` (one process for up to 100 models, in the project folder; imports and
  headers are resolved from the file system with the `headers` block of the nearest `hsm.gen.json`) and turns
  the problems (lines, columns and character offsets) into markers. The builder `HsmBuilder` (nature: *Configure
  > Enable / Disable HSM Validation*) validates the changed models and the models that import a changed model
  or header (all models after a change of a generator configuration or on a full build); *Clean* removes the
  markers. Without an executable the project gets one warning marker saying so. The opened editors keep
  reporting the problems of the page (same marker type).
- **Where the executable comes from** (`HsmExecutable`): the preference *Preferences > HSM Modeler > hsm
  executable* if set; else `bin/hsm` of the platform fragment `hsm.eclipse.cli.<os>.<arch>` (Linux x86_64 /
  aarch64, macOS x86_64 / aarch64, Windows x86_64; installed automatically with the feature for the platform of
  Eclipse, `chmod 755` by a p2 touchpoint); else `hsm` in the `PATH` (also `/opt/homebrew/bin`,
  `/usr/local/bin`, `~/.local/bin`, for an Eclipse started from the Finder).
- **C++ generation** stays in the page (`PageGenerator`): it is the same generator with the same resolution of
  `hsm.gen.json` as `hsm generate`, uses the preferences of the plugin and writes through the workspace (refresh,
  local history). `ModelGenerator` remains the extension point for a generator based on `hsm generate`.
- **The editor** keeps its own JDK HTTP server instead of a server process of the executable: no process to
  start, watch and stop per Eclipse session, no dependency of the editor on the executable (it works without
  one), and the server already knows the workspace (resources, markers, refresh). The executable is only
  started for builds.

## Build

Requires Node.js ≥ 20.10, Java ≥ 21 and Maven ≥ 3.9 (the build downloads Tycho and the Eclipse 2025-06
platform; set `-Declipse.repository=…` for another release or a mirror).

```bash
# in the repository root: build the web app (packages/web/dist)
npm install
npm run build            # or: npm run langium:generate && npm run build -w packages/web

# optional: the hsm executable of this platform for its fragment (packages/cli/dist/bin/<platform>/hsm)
npm run build:exe

# the plugin, the fragments with the executables, the feature and a p2 update site
cd eclipse-plugin
mvn verify               # fragments without executable stay empty (and installable); -Dhsm.cli.optional=false requires all five
# → hsm.eclipse.site/target/hsm.eclipse.site-0.1.0-SNAPSHOT.zip (update site archive)
```

A fragment with the executable gets the p2 instruction that makes `bin/hsm` executable when it is installed
(`META-INF/p2.inf`, generated from `p2-chmod.inf` by the build only if `bin/hsm` is there).

The Maven build copies `packages/web/dist` into the bundle (`hsm.eclipse/webapp/`, not committed); rebuild
the web app before the plugin to get its latest version.

`mvn verify -Pui-tests` also runs the integration tests in a real workbench (a window opens for a few
seconds, see `hsm.eclipse.tests/src/hsm/eclipse/HsmDiagramEditorTest.java`).

## Install

*Help > Install New Software… > Add… > Archive…* → `hsm.eclipse.site-0.1.0-SNAPSHOT.zip`, select
*HSM Modeler (prototype)* (uncheck *Group items by category* if the list is empty), accept the unsigned
content warning and restart. Double-click a `.hsm` file in the Project Explorer.

Requirements: Java 17+ and an Eclipse release with Edge support in SWT on Windows (2021-03 or newer).
It is built and tested against 2025-06; the plugin only uses old, stable APIs, so older releases (e.g.
2022-03+) should work but are untested. Windows needs the WebView2 runtime (part of Windows 11 and of
current Windows 10).

Options (`eclipse.ini`, after `-vmargs`): `-Dhsm.browser=edge|webkit|chromium|default` (browser engine;
default: Edge on Windows, the platform default elsewhere), `-Dhsm.server.port=…` (default 47913, a free port
if it is taken).

## Develop in Eclipse (PDE)

1. Build the web app (see above) and run `mvn verify` once (or copy `packages/web/dist` to
   `eclipse-plugin/hsm.eclipse/webapp`).
2. In an *Eclipse IDE for RCP and RAP Developers* (PDE + m2e): *File > Import… > Maven > Existing Maven
   Projects* → `eclipse-plugin` (the projects `hsm.eclipse`, `hsm.eclipse.feature`, `hsm.eclipse.site` and,
   with the profile `ui-tests`, `hsm.eclipse.tests`).
3. *Run As > Eclipse Application* starts an Eclipse with the plugin.

## Verified

On macOS (aarch64) with Eclipse 4.36 and WebKit, by the UI tests (`mvn verify -Pui-tests`):

- loading with `../` imports and a header found through the include path of `hsm.gen.json`; outline;
- an error typed in the page → error marker with line / range; `IDE.gotoMarker` selects the range in the page;
  Eclipse's *Undo* command undoes it in the page and the marker disappears;
- *Select All* + *Copy* (Eclipse commands) → Eclipse clipboard; *Paste* inserts the clipboard; *Find/Replace*
  opens the find widget; dirty state, *Save*, `Ctrl+S` in the page, external changes;
- page settings stored in the preferences; *Generate C++* (command) with `hsm.gen.json` (`outDir`,
  `licenseHeaderFile`, header include); rename and move of the file (editor follows, imports re-resolved);
  *Save As*;
- the builder with a test `ModelValidator` creates markers for a closed file;
- the builder with the bundled executable (fragment of the build, macOS aarch64): markers with ranges for a
  closed file, `../` imports and headers of `hsm.gen.json` resolved, the importer of a changed header is
  validated again.

Manually checked once with real (OS-level) key events on macOS: typing, `Cmd+Z` and `Cmd+S` work while the
page has the focus (they reach the page directly, not Eclipse's key bindings).

**Not tested**: Windows (Edge / WebView2) and Linux (WebKitGTK), older Eclipse releases, the dark theme
detection, `Cmd+A` / `Cmd+C` / `Cmd+V` key presses (only the commands), the context menu entries (the
commands themselves are tested), interactive use in a full IDE.

## Limitations / next steps

- Markers of opened files come from the page (they reflect the unsaved text), those of closed files from the
  builder with the bundled executable (saved text, imports from the file system: not limited to the project).
- Imports and include paths are limited to the project; include paths outside of it (absolute paths) are
  ignored. At most 500 importable files (2 MB each) of a project are passed to the page.
- The undo history is the page's (Monaco): Eclipse's *Undo* of the menu acts on it, but there is no
  operation history integration (e.g. with refactorings of other plugins).
- C/C++ unit tests (`.hsmtest`), simulation from Eclipse launch configurations and C generation are not
  integrated (the page's simulator works).
- Complement for plain text editing: [LSP4E](https://github.com/eclipse/lsp4e) with the language server of
  `packages/vscode` (or of the bundled executable) and [TM4E](https://github.com/eclipse/tm4e) with its
  TextMate grammar would give a Generic Editor with validation, completion and hover. The content type
  `hsm.eclipse.hsm` is already defined for such bindings.
- Signing of the bundles. The update site with all five executables is about 200 MB (each platform installs
  only its fragment of about 40 MB).
