# Eclipse plugin (prototype)

An editor for `.devm` files in the Eclipse IDE – state machines and structure files (components, ports,
subsystems, systems, threads, connections, delegations): the Device Modeler web app (Monaco text editor, state
machine diagram editor, structure diagram, properties, simulation, export, C++ generation) runs in an SWT
`Browser` widget inside an Eclipse editor and edits the workspace file. Nothing of the language is reimplemented in Java – the plugin hosts the web app and
connects it to the workbench (Problems view, Outline, edit commands, preferences, resources).

```
Eclipse editor (DevmDiagramEditor)                       SWT Browser (Edge / WebKit)
  ├─ IFile ↔ text, dirty state, Save / Save As   HTTP     ├─ packages/web/dist (the web app, ?host=http)
  ├─ problem markers, Outline, edit commands   ◄──────►  └─ packages/web/src/host*.ts: document, changed, save,
  └─ WebServer (127.0.0.1, JDK HttpServer)                   model (problems + outline), settings, generate, …
```

## What it does

- **Editor** for `.devm` (default editor; *Open With > Text Editor* still opens the plain text). State machines
  and structure files share the extension and the editor: a file starting with `statemachine` shows the state
  machine diagram, any other file the structure diagram (internal block diagram of a subsystem or system, the
  component types of the file otherwise; see `docs/structure-language.md`). The page gets
  the text of the workspace file; changes set the dirty marker; *File > Save* or `Ctrl+S` / *Save* in the page
  write the file (with local history); **Save As…** writes another file and edits it from then on.
- **Problems view**: the page reports its Langium diagnostics after every validation (also of unsaved
  text); they become markers of the type `devm.eclipse.problem` (a problem and text marker with line and
  character range). Double-clicking a marker opens the editor and selects the range in the page's text
  editor and the element in the diagram (`IGotoMarker`). Markers stay when the editor is closed (like a build
  result) and are not persisted across restarts.
- **Outline view**: state machines: definitions, states with regions and nested states, pseudo states and
  transitions; structure files: structs with their fields, components with behavior and ports, subsystems and
  systems with ports, threads and their instances, connections and delegations. Selecting an element selects
  its text and diagram element.
- **Navigation from the page's text editor** (`F12`, `Cmd/Ctrl`+Click, *Go to Declaration / Type
  Definition*, links of import paths): C++ names lead into the imported headers, which open in their default
  editor (CDT's C/C++ editor if installed, otherwise the text editor) with the declaration selected; names of
  imported models, component types of structure files, `behavior` paths and model import paths open the model
  (state machine or structure file) in the Device Modeler editor at the target (`api/open` with a position);
  navigating in the structure diagram to another file (e.g. the component type of an instance, *Used by*)
  opens that file the same way. Peek shows the target inside the page.
- **Edit commands**: Eclipse's *Undo*, *Redo*, *Cut*, *Copy*, *Paste*, *Select All* and *Find/Replace* (menus
  and key bindings) act on the page: on the text editor, on an input field of the properties panel or on the
  diagram (undo / select all). Copy and paste use the Eclipse clipboard. On macOS (WebKit) the key bindings
  go to the page directly while it has the focus (`Cmd+Z`, `Cmd+S`, … work natively); if an engine passes a
  key both to Eclipse and to the page, the page ignores the second command.
- **Rename / move** of the file: the editor follows it (and resolves the imports from the new location);
  deleting the file closes the editor. External changes (another editor, git) are loaded into the page, with
  a question if there are unsaved changes.
- **Imports**: all `.devm` models (state machines and structure files) and C/C++ headers of the **project** are
  passed to the page with their project-relative paths, so `import "../motor.devm"` works within the project
  (the project is the boundary; paths leaving it are not found), and the structure diagram knows the files
  that use a component (*Used by*) and the routes across files. The `headers` block (include paths, defines, data model) of the nearest
  `devm.gen.json` / `*.devm.gen.json` (from the model's folder up to the project) is applied, include paths
  relative to the configuration file. Changes of models, headers and configurations update the page.
- **C++ generation**: *Generate C++* in the context menu of `.devm` files (Project Explorer) and the *C++*
  button of the page. The generator of the language package runs in the page (no Node.js needed); the
  configuration is resolved like `Device Modeler: Generate C++` of the VS Code extension: the nearest generator
  configuration that lists the model wins (`outDir`, namespace, extensions, `licenseHeaderFile`, …),
  otherwise *Preferences > Device Modeler* (output folder relative to the model or `${project}/…`, namespace,
  C++ standard). The files are written into the project (unchanged files are not touched); the result is
  shown in the page and in Eclipse's status line, problems in the Error Log. Structure files have no code of
  their own: the command skips them (and says so if only structure files were selected).
- **Page settings** (theme, layout direction, edge routing, priorities, splitter) are stored in the Eclipse
  preferences, so they survive restarts and port changes.
- **Dark theme**: with a dark Eclipse theme (CSS theme engine, otherwise the dark mode of the system) the page
  uses its *Dark* theme; with a light Eclipse theme a stored *Dark* is replaced by *PlantUML classic*.
- **Generic Editor with the language server** (bundle `devm.eclipse.lsp`): *Open With > Generic Text Editor*
  for `.devm` (state machines and structure files; the Device Modeler editor stays the default editor), the
  default editor of `.devmtest` (content type
  `devm.eclipse.devmtest`). LSP4E starts `devm lsp --stdio` of the executable found by `DevmExecutable` (preference,
  platform fragment, `PATH`) with the project as workspace folder: problems as markers
  (`org.eclipse.lsp4e.diagnostic`), completion, hover with documentation, *F3* / Ctrl+Click (*Open Declaration*)
  into imported C/C++ headers (CDT's editor if installed) and other models, document links on import paths,
  *Format* (Ctrl+Shift+F), *Outline*, rename (Alt+Shift+R), *Find References*, folding and semantic
  highlighting. TM4E highlights with the TextMate grammars of `packages/language/syntaxes` (including the
  Doxygen injection of documentation comments) and applies the language configuration of the VS Code extension
  (comments, brackets, auto closing, indentation). The server's state and log: *Window > Show View > Language
  Servers* (LSP4E).
- **Builder for closed files**: the nature / builder `devm.eclipse.nature` / `devm.eclipse.builder`
  (*Configure > Enable / Disable Device Modeler Validation* on projects) writes markers for all changed models
  (state machines and structure files) with the registered `ModelValidator` (the `devm` executable, see below).

## Architecture

| Class / file | Role |
|---|---|
| `devm.eclipse.WebServer` | loopback HTTP server (JDK `com.sun.net.httpserver`, no Eclipse dependencies): static web app + API, one random token per editor; rejects unknown tokens and foreign `Host` headers |
| `devm.eclipse.HostSession` | the API of one page (implemented by the editor), see `packages/web/src/host.ts` for the protocol |
| `devm.eclipse.DevmDiagramEditor` | the editor: browser, dirty state, save / save as, markers, outline, edit commands, resource changes |
| `devm.eclipse.ProjectFiles` | project-relative paths, importable files, generator configurations, writing files, state machine or structure file (`isStructureText`) |
| `devm.eclipse.ProblemMarkers` | marker type `devm.eclipse.problem`, coalescing marker updates |
| `devm.eclipse.DevmOutlinePage` | Outline view |
| `devm.eclipse.Preferences`, `DevmPreferencePage` | C++ preferences, stored page settings |
| `devm.eclipse.tools.*` | **integration point for the bundled executable**: `ModelValidator`, `ModelGenerator`, `ModelProblem`, `DevmTools` (registry), `PageGenerator` (generation in the page) |
| `devm.eclipse.builder.*` | nature, builder (uses `DevmTools.validator()`), toggle command |
| `devm.eclipse.lsp` (bundle) | `DevmLanguageServer` (LSP4E `ProcessStreamConnectionProvider`: `devm lsp --stdio`), content type `devm.eclipse.devmtest`, Generic Editor bindings, TM4E grammars / language configuration (copied from `packages/language/syntaxes` and `packages/vscode/language-configuration.json` by the build, not committed) |
| `packages/web/src/host.ts` | embedded mode of the web app (`?host=http`): protocol and client |
| `packages/web/src/host-model.ts` | problems and outline of a parsed model for the host |
| `packages/web/src/host-generate.ts` | C++ generation in the page with the configuration resolution of `devm generate` |

Without `?host=http` the web app behaves as before (only `app.ts` branches on the host).

### The bundled `devm` executable

The command line executable of `packages/cli` (a Node.js single executable application, no Node.js needed)
runs what needs no page:

- **Validation of closed files**: `devm.eclipse.tools.CliValidator` (registered by the activator in `DevmTools`)
  runs `devm validate --json <models…>` (one process for up to 100 models, in the project folder; imports and
  headers are resolved from the file system with the `headers` block of the nearest `devm.gen.json`) and turns
  the problems (lines, columns and character offsets) into markers. The builder `DevmBuilder` (nature: *Configure
  > Enable / Disable Device Modeler Validation*) validates the changed models and the models that import a changed
  model or header or reference a changed state machine as `behavior` of a component (a structure file is checked
  against the interfaces of its components' state machines) – all models after a change of a generator
  configuration or on a full build; *Clean* removes the
  markers. Without an executable the project gets one warning marker saying so. The opened editors keep
  reporting the problems of the page (same marker type).
- **Where the executable comes from** (`DevmExecutable`): the preference *Preferences > Device Modeler > devm
  executable* if set; else `bin/devm` of the platform fragment `devm.eclipse.cli.<os>.<arch>` (Linux x86_64 /
  aarch64, macOS x86_64 / aarch64, Windows x86_64; installed automatically with the feature for the platform of
  Eclipse, `chmod 755` by a p2 touchpoint); else `devm` in the `PATH` (also `/opt/homebrew/bin`,
  `/usr/local/bin`, `~/.local/bin`, for an Eclipse started from the Finder).
- **C++ generation** stays in the page (`PageGenerator`): it is the same generator with the same resolution of
  `devm.gen.json` as `devm generate`, uses the preferences of the plugin and writes through the workspace (refresh,
  local history). `ModelGenerator` remains the extension point for a generator based on `devm generate`.
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

# optional: the devm executable of this platform for its fragment (packages/cli/dist/bin/<platform>/devm)
npm run build:exe

# the plugin, the fragments with the executables, the feature and a p2 update site
cd eclipse-plugin
mvn verify               # fragments without executable stay empty (and installable); -Ddevm.cli.optional=false requires all five
# → devm.eclipse.site/target/devm.eclipse.site-0.1.0-SNAPSHOT.zip (update site archive)
```

A fragment with the executable gets the p2 instruction that makes `bin/devm` executable when it is installed
(`META-INF/p2.inf`, generated from `p2-chmod.inf` by the build only if `bin/devm` is there).

The Maven build copies `packages/web/dist` into the bundle (`devm.eclipse/webapp/`, not committed); rebuild
the web app before the plugin to get its latest version.

`mvn verify -Pui-tests` also runs the integration tests in a real workbench (a window opens for a few
seconds, see `devm.eclipse.tests/src/devm/eclipse/DevmDiagramEditorTest.java` and `DevmLanguageServerTest.java`).

**Dependencies of `devm.eclipse.lsp`:** LSP4E (0.18.x bundle in 2025-06), LSP4J, TM4E (0.14.x) and the Generic
Editor are required bundles; the feature does not include them. They are part of the Eclipse release repository
and preinstalled in *Eclipse IDE for C/C++ Developers* (checked: installing the feature from the local update
site into the 2025-06 C/C++ package with the p2 director needs no other repository) and most other EPP packages.
Otherwise p2 installs them from the release repository: the update site references
`https://download.eclipse.org/releases/2025-06/` (`category.xml`), the zip archive relies on the release site
configured in the IDE (*Contact all update sites during install*). Including them in the update site
(`includeAllDependencies`) was not chosen: it would pull in a large part of the platform and pin versions that
may not match the user's release, while every Eclipse package can reach its own release repository.

## Install

*Help > Install New Software… > Add… > Archive…* → `devm.eclipse.site-0.1.0-SNAPSHOT.zip`, select
*Device Modeler (prototype)* (uncheck *Group items by category* if the list is empty), accept the unsigned
content warning and restart. Double-click a `.devm` file in the Project Explorer; *Open With > Generic Text
Editor* for the text with the language server. Without LSP4E / TM4E in the installation, keep *Contact all
update sites during install to find required software* checked (the release site provides them).

Requirements: Java 17+ and an Eclipse release with Edge support in SWT on Windows (2021-03 or newer).
It is built and tested against 2025-06; the plugin only uses old, stable APIs, so older releases (e.g.
2022-03+) should work but are untested. Windows needs the WebView2 runtime (part of Windows 11 and of
current Windows 10).

Options (`eclipse.ini`, after `-vmargs`): `-Ddevm.browser=edge|webkit|chromium|default` (browser engine;
default: Edge on Windows, the platform default elsewhere), `-Ddevm.server.port=…` (default 47913, a free port
if it is taken).

## Develop in Eclipse (PDE)

1. Build the web app (see above) and run `mvn verify` once (or copy `packages/web/dist` to
   `eclipse-plugin/devm.eclipse/webapp`).
2. In an *Eclipse IDE for RCP and RAP Developers* (PDE + m2e): *File > Import… > Maven > Existing Maven
   Projects* → `eclipse-plugin` (the projects `devm.eclipse`, `devm.eclipse.feature`, `devm.eclipse.site` and,
   with the profile `ui-tests`, `devm.eclipse.tests`).
3. *Run As > Eclipse Application* starts an Eclipse with the plugin.

## Verified

On macOS (aarch64) with Eclipse 4.36 and WebKit, by the UI tests (`mvn verify -Pui-tests`):

- loading with `../` imports and a header found through the include path of `devm.gen.json`; outline;
- an error typed in the page → error marker with line / range; `IDE.gotoMarker` selects the range in the page;
  Eclipse's *Undo* command undoes it in the page and the marker disappears;
- *Select All* + *Copy* (Eclipse commands) → Eclipse clipboard; *Paste* inserts the clipboard; *Find/Replace*
  opens the find widget; dirty state, *Save*, `Ctrl+S` in the page, external changes;
- page settings stored in the preferences; *Generate C++* (command) with `devm.gen.json` (`outDir`,
  `licenseHeaderFile`, header include); rename and move of the file (editor follows, imports re-resolved);
  *Save As*;
- the builder with a test `ModelValidator` creates markers for a closed file;
- the builder with the bundled executable (fragment of the build, macOS aarch64): markers with ranges for a
  closed file, `../` imports and headers of `devm.gen.json` resolved, the importer of a changed header is
  validated again;
- structure files (`structureFile`): the page switches to the structure diagram, the outline shows the subsystem
  with its ports, threads, instances and delegations, an unknown port becomes an error marker and *Undo* removes
  it, *Go to Definition* on a component type opens the structure file declaring it in the Device Modeler editor
  with the declaration selected, `api/open` with a position selects the range; the builder with the bundled
  executable validates a structure file again when the state machine of its component (`behavior`) changes;
- the Generic Editor with the language server (`DevmLanguageServerTest`, bundled executable): the Device Modeler
  editor stays the default editor of `.devm`, *Open With* offers the Generic Editor, `.devmtest` defaults to it; LSP4E markers
  for an unknown name while the header constant of the include path of `devm.gen.json` resolves; hover
  (`LSPTextHover`) with the header's documentation comment; *F3* (`open.hyperlink`) opens the header; LSP4E's
  *Format* re-indents the model; TM4E colors the keywords; in a structure file: an LSP4E marker for an unknown
  component type, TM4E colors `system`, *F3* on a component type opens the structure file declaring it (in the
  Device Modeler editor).

The rendered diagram (SVG) is only checked when the workbench window is visible: WebKit runs no animation
frames for a hidden page (e.g. a locked screen), and the diagram is drawn in one. The structure diagram of the
test files was checked in a Chromium page with a host stub serving `api/document` (all models of the project).

Manually checked once with real (OS-level) key events on macOS: typing, `Cmd+Z` and `Cmd+S` work while the
page has the focus (they reach the page directly, not Eclipse's key bindings).

**Not tested**: the CDT editor as target of *F3* (the tests run without CDT and open the header in the text
editor), completion / outline / rename in the Generic Editor (covered by the language server's own tests),
Windows (Edge / WebView2) and Linux (WebKitGTK), older Eclipse releases, the dark theme
detection, `Cmd+A` / `Cmd+C` / `Cmd+V` key presses (only the commands), the context menu entries (the
commands themselves are tested), interactive use in a full IDE.

## Limitations / next steps

- Markers of opened files come from the page (they reflect the unsaved text), those of closed files from the
  builder with the bundled executable (saved text, imports from the file system: not limited to the project).
- Imports and include paths are limited to the project; include paths outside of it (absolute paths) are
  ignored. At most 500 importable files (2 MB each) of a project are passed to the page.
- The undo history is the page's (Monaco): Eclipse's *Undo* of the menu acts on it, but there is no
  operation history integration (e.g. with refactorings of other plugins).
- C/C++ unit tests (`.devmtest`), simulation from Eclipse launch configurations and C generation are not
  integrated (the page's simulator works).
- A model open in the Generic Editor and validated by the builder can show its problems twice in the
  *Problems* view (LSP4E markers of the open text, builder markers of the saved file).
- The language server's `devm.headers.*` settings (include paths for all models) are not offered in the
  preferences; the `headers` block of `devm.gen.json` applies.
- Navigating from the structure diagram into another file (`api/open`) opens that file on its own: the
  context of the navigation (the instance path of the subsystem or system the user came from) stays in the
  page that started it.
- Signing of the bundles. The update site with all five executables is about 200 MB (each platform installs
  only its fragment of about 40 MB).
