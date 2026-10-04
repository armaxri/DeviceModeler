# JetBrains plugin (prototype)

An editor for `.hsm` files in CLion, IntelliJ IDEA and the other IDEs of the IntelliJ Platform (2025.2 or
newer): the HSM web app (Monaco text editor, diagram editor, properties, simulation, export, C++ generation)
runs in a JCEF browser (the Chromium embedded in the IDE) inside an editor tab and edits the IDE's document of
the file. Like the [Eclipse plugin](../eclipse-plugin/README.md), nothing of the language is reimplemented in
Kotlin – the plugin hosts the web app and connects it to the IDE (document, Problems, Structure, edit shortcuts,
settings, VFS). It depends only on `com.intellij.modules.platform`, so it runs in every JetBrains IDE.

```
HsmSplitEditor (TextEditorWithPreview)                   JCEF browser
  ├─ IntelliJ text editor ─┐                              ├─ packages/web/dist (webapp/, ?host=http)
  │                        ├─ the Document of the file    └─ packages/web/src/host*.ts: document, changed,
  └─ HsmDiagramEditor ─────┘        ▲                         save, model (problems + outline), settings,
       └─ HsmSession ── HTTP ───────┼──────────────────►      open, export, generate
            HostServer (127.0.0.1, JDK HttpServer, token per editor)
```

## What it does

- **Editor** for `.hsm` with the views *Text*, *Text and Diagram* and *Diagram* (toolbar at the top right of
  the editor; default *Diagram*). Page and IntelliJ text editor work on the same `Document`: changes of the
  page become undoable commands of the document (only the changed part is replaced, so carets and markers
  survive), changes of the document from elsewhere (text editor, VCS, external changes, refactorings) are
  loaded into the page. Dirty state, autosave, local history and *File > Save All* are the IDE's; `Cmd/Ctrl+S`
  in the page or *Save* in the page save the file. Renames and moves are followed (imports are resolved from
  the new location), deleting the file closes the editor (IntelliJ). External changes with unsaved changes go
  through IntelliJ's usual conflict dialog.
- **Problems**: the page reports its Langium diagnostics after every validation (also of the unsaved text).
  They are shown in the text editor (external annotator) and in the *Problems* tool window (*Project
  Errors*), and stay when the editor is closed (like the markers of a build). Navigating to a problem (or a
  search result) selects the position in the text editor and the range / element in the page.
- **Closed files**: after a model, a header or a generator configuration of the project was saved or changed on
  disk, `hsm validate --json` validates the changed models and the models importing a changed model or header
  (all models after a change of `hsm.gen.json`) – the counterpart of the Eclipse builder. *Tools > Validate HSM
  Models* validates all models of the project. Models with an open diagram are left to their page. A saved
  model opened without page (no JCEF) is validated by the annotator with the executable.
- **Structure** tool window: state machine, definitions, states, regions, pseudo states and transitions of the
  page; selecting an element selects its text and its diagram element.
- **Navigation from the page's text editor** (`F12`, `Cmd/Ctrl`+Click, *Go to Declaration / Type
  Definition*, links of import paths): C++ names open the imported header in the editor of its type (CLion's
  C/C++ editor) with the declaration selected, imported models open in the HSM editor at the target
  (`api/open` with a position, `OpenFileDescriptor`). Peek shows the target inside the page.
- **Edit shortcuts in the page**: the IDE's *Undo*, *Redo*, *Cut*, *Copy*, *Paste*, *Select All*, *Find*,
  *Replace* and *Save All* shortcuts of the active keymap act on the page while it has the focus (on the
  Monaco editor, an input field of the properties panel or the diagram); copy and paste use the IDE clipboard
  (`hsmApp.hostCommand`, the same as in Eclipse; a key the page already handled itself is not applied twice).
- **Imports**: the `.hsm` models and C/C++ headers below the project directory are passed to the page with
  their project-relative paths (unsaved changes of open files included; excluded and ignored folders,
  `node_modules` and dot folders skipped), so `import "../motor.hsm"` works within the project. The `headers`
  block of the nearest `hsm.gen.json` / `*.hsm.gen.json` is applied. Changes of models, headers and
  configurations update the page.
- **Generate C++**: context menu of `.hsm` files (project view, editor tab) and *Tools > Generate C++*, and the
  *C++* button of the page. The generator of the language package runs in the page (no Node.js), configured
  like `hsm generate` (nearest `hsm.gen.json` listing the model, else the settings); the files are written
  through the VFS (unchanged files are not touched); the result is shown as a notification.
- **Settings** (*Settings > Tools > HSM Modeler*): `hsm` executable, validation of saved models, the defaults of
  *Generate C++* (output folder relative to the model or `${project}/…`, namespace, C++ standard). The page
  settings (theme, layout direction, edge routing, …) are stored by the IDE (`hsm.xml`).
- **Theme**: with a dark IDE theme the page uses its *Dark* theme, with a light one *PlantUML classic*; a
  change of the IDE theme is applied to the open pages (`hsmApp.setHostTheme`).
- **Text editor support** without a language server: highlighting (keywords of the grammars, comments, strings,
  numbers, `@annotations`), comment / uncomment, brace matching for `.hsm` and `.hsmtest` (file types with
  icon; `.hsmtest` opens in the text editor only).

## Architecture

| Class | Role |
|---|---|
| `server.HostServer` | loopback HTTP server (JDK `com.sun.net.httpserver` + Gson, no IntelliJ dependencies): web app + API, one random token per editor; rejects unknown tokens, foreign `Host` headers (DNS rebinding) and foreign `Origin`s; static files only below `webapp/` |
| `server.HostSession` | the API of one page (protocol: `packages/web/src/host.ts`) |
| `server.HsmWebServer` | application service: the one server of the IDE (port 47915, a free one if taken; `-Dhsm.server.port`), `webapp/` of the plugin directory (`-Dhsm.webapp` for development) |
| `editor.HsmSession` | the host side of a page on the IntelliJ `Document`: text sync (with protection against late echoes of pushed text), save, problems, settings, open, export, generated files |
| `editor.HsmDiagramEditor` | the JCEF browser (`JBCefBrowser`, `JBCefJSQuery` for return values), page scripts, edit shortcuts, VFS / theme listeners; a message instead of the browser if JCEF is unavailable |
| `editor.HsmSplitEditor`, `HsmEditorProvider` | `TextEditorWithPreview` *Text / Text and Diagram / Diagram*, navigation into the page, Structure view |
| `editor.ProjectFiles` | root (project directory, else content root, else folder), project-relative paths, confinement (no `..`, no symlinks out of the root), importable files, generator configurations, writing files |
| `problems.HsmProblems` | problems per file → Problems tool window (`ProblemsCollector`), red files (`WolfTheProblemSolver`), annotator |
| `problems.HsmExternalAnnotator` | problems in the text editor |
| `problems.HsmValidation` | validation of saved / closed models with `hsm validate --json` (VFS listener, *Validate HSM Models*) |
| `cli.HsmExecutable`, `cli.CliValidator` | executable lookup and `hsm validate --json` (same as the Eclipse plugin) |
| `lang.*` | file types, lexer, highlighting, commenter, brace matcher, flat PSI |
| `settings.*` | settings and settings page |
| `actions.*` | *Generate C++*, *Validate HSM Models* |

Decisions:

- **Own loopback server instead of a JCEF resource handler** (custom scheme): the web app and its protocol stay
  exactly as for Eclipse and the desktop app (relative `api/…` URLs, `fetch` with POST bodies, which CEF
  scheme handlers do not pass reliably), the server is plain JDK code tested without an IDE, and it is shared
  in spirit with `eclipse-plugin/…/WebServer.java`. It only answers on 127.0.0.1, below `/s/<token>/` of an
  open editor, with a loopback `Host` and without a foreign `Origin`.
- **The IDE document is the single source of truth** (unlike Eclipse, where the page holds the text until
  saved): the IDE's text editor, undo, autosave, local history, VCS and other plugins see every change of the
  diagram immediately. The page's own undo (Monaco) is used for the undo shortcut while the page has the
  focus; *Edit > Undo* of the menu undoes the document, which the page then shows.
- **No bundled `hsm` executable**: a JetBrains plugin is one zip for all platforms, the executables have about
  120 MB each (600 MB for five platforms). The plugin looks for it in this order: the setting, `bin/hsm` of the
  plugin directory (only in a plugin built with `-PhsmExecutable=<path>` for one platform), `hsm` in the `PATH`
  (plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`). Without one, a notification (with *Configure…*)
  says so once per project; everything except the validation of closed files works without it.
- **CLion**: no CLion-specific code is needed. CLion's CMake integration of the models (`cmake/HsmGenerate.cmake`,
  `hsm_generate` / `hsm_add_tests`, see [Build integration](../docs/build-integration.md)) works when `hsm` is in
  the `PATH` of CLion (or with `-DHSM_EXECUTABLE=<path>` in the CMake options of the CLion profile) – it
  regenerates the code on every build;
  *Generate C++* of the plugin is for projects without that.

## Build

Requires Node.js ≥ 20.10 and a JDK ≥ 17 to run Gradle (the build downloads JDK 21 for the toolchain, the
IntelliJ Platform and the Gradle distribution; the Gradle wrapper is committed).

```bash
# in the repository root: build the web app (packages/web/dist)
npm ci
npm run build -w packages/web

cd jetbrains-plugin
./gradlew buildPlugin        # → build/distributions/hsm-jetbrains-<version>.zip
./gradlew test               # unit tests and light platform tests (headless)
./gradlew verifyPlugin       # Plugin Verifier against IntelliJ IDEA 2025.2 and the latest release
./gradlew runIde             # IntelliJ IDEA 2025.2 with the plugin (runLatestIde, runClion: other IDEs)
./gradlew buildPlugin -PhsmExecutable=../packages/cli/dist/bin/macos-arm64/hsm   # with the executable of one platform
```

`./gradlew runIdeForUiTests --args="<project> <file>"` starts the IDE with the
[Robot server](https://github.com/JetBrains/intellij-ui-test-robot) on `http://127.0.0.1:8082` and without the
dialogs of a first start; scripts posted to `/js/execute` run in the IDE (that is how the end-to-end checks
below were done).

## Install

*Settings > Plugins > ⚙ > Install Plugin from Disk…* → `hsm-jetbrains-<version>.zip`, restart if asked. Open a
`.hsm` file. For the validation of closed files install the `hsm` command line tool (see
[Installation](../docs/installation.md#command-line-tool-hsm)) or set its path in *Settings > Tools > HSM Modeler*.

Requirements: an IntelliJ Platform IDE 2025.2 or newer (CLion, IntelliJ IDEA, PyCharm, …) with JCEF (all
standard JetBrains runtimes have it; without it the editor shows the text only).

## Verified

- `./gradlew test` (macOS): the host server (tokens, unknown / closed sessions, `Host` and `Origin` checks,
  path traversal, every API operation, missing web app), paths and outputs (`hsm validate --json` with a fake
  executable, executable lookup in the `PATH`), and light platform tests in a headless IDE: file types, editor
  provider (without JCEF: text layout and fallback), the session on the document (document with imports,
  headers and configuration, file reads confined to the project, changes of the page → undoable document
  changes, save, document changes → page with a late echo that must not win, problems → Problems tool window
  and text editor annotations, structure view, generated / exported files, settings), the lexer.
- `./gradlew buildPlugin` and `verifyPlugin` (IntelliJ IDEA 2025.2.6 and 2026.2.3).
- End to end in IntelliJ IDEA Community 2025.2.6 (macOS, real JCEF; `runIdeForUiTests` with scripts through the
  Robot server): the page starts and reports its outline (the import `motor.hsm` resolved); an edit in the
  page reaches the document; *Select All* + *Copy* puts the model into the IDE clipboard; a change of the
  document reaches the page, its problems reach the Problems tool window; *Undo* in the page reverts it in the
  document; *Save* in the page saves the file; `setHostTheme('dark')` switches the page; *Generate C++* (the
  action, for a model that is not open) opens the editor and writes `Door.h` / `Door.cpp`, and reports the
  errors of a model the generator does not support; an external change of the file reaches document and page;
  `hsm validate --json` with the executable of `npm run build:exe` reports the problem of a closed model.
- `./gradlew runLatestIde`: IntelliJ IDEA 2026.2.3 starts with the plugin loaded, without errors (not driven
  further: it stopped at the dialogs of a first start).

**Not tested**: CLion itself and IDEs other than IntelliJ IDEA (the plugin uses only platform APIs), Windows
and Linux, real key presses in the page (the shortcuts were called as commands), the reaction to a change of
the IDE theme (`LafManagerListener`; the page function it calls is tested), the red files in the project view
(`WolfTheProblemSolver` did not report the file as a problem file in the test project), interactive use.

## Limitations / next steps

- A language server for the text editor (completion, hover, go to definition): the platform's LSP API (IntelliJ
  Ultimate / CLion and other commercial IDEs) or [LSP4IJ](https://github.com/redhat-developer/lsp4ij) (all IDEs)
  with the language server of `packages/vscode` (needs Node.js) or of the `hsm` executable.
- TextMate highlighting with the grammars of `packages/language/syntaxes` (the plugin has its own small lexer).
- `.hsmtest` files: no test runner integration (`hsm test` in a run configuration would be the next step).
- Imports and include paths are limited to the project directory; at most 500 importable files (2 MB each).
- The page and the text editor have separate undo histories (both change the same document).
- Signing and publication on the JetBrains Marketplace.
