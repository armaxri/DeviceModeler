# Installation and usage

The HSM Modeler comes in five forms. All of them use the same language implementation (`packages/language`)
and the same graphical editor (the web app of `packages/web`):

| | For | Needs |
| --- | --- | --- |
| [**Desktop app**](#desktop-app) *HSM Modeler* | editing models: text and diagram side by side, simulation, export | nothing (Windows, macOS, Linux) |
| [**Command line tool**](#command-line-tool-hsm) `hsm` | validation, code generation, tests, rendering in builds and CI | nothing (one executable) |
| [**VS Code extension**](#vs-code-extension) | models and tests in VS Code: language server, diagram, Test Explorer | VS Code ≥ 1.95 |
| [**Eclipse plugin**](#eclipse-plugin) (prototype) | the graphical editor for `.hsm` files of an Eclipse workspace | Eclipse 2025-06 (older releases untested), Java ≥ 17 |
| [**JetBrains plugin**](#jetbrains-plugin-clion-intellij-idea) (prototype) | the graphical editor for `.hsm` files in CLion, IntelliJ IDEA and the other JetBrains IDEs | an IntelliJ Platform IDE 2025.2 or newer |

## Downloads

Every [release](https://github.com/armaxri/HSM/releases) (version tag `v<version>`) contains all of them;
the [*Distribution* workflow](../.github/workflows/distribution.yml) also builds them for every push and pull
request (artifacts of the workflow run, kept for 90 days). `SHA256SUMS.txt` lists the checksums.

| Platform | Desktop app | Command line tool |
| --- | --- | --- |
| Windows x64 | `hsm-modeler-<version>-windows-x64-setup.exe` (installer, per user) or `…-windows-x64.zip` (portable) | `hsm-<version>-windows-x64.zip` |
| macOS Apple silicon | `hsm-modeler-<version>-macos-arm64.dmg` (or `.zip`) | `hsm-<version>-macos-arm64.tar.gz` |
| macOS Intel | `hsm-modeler-<version>-macos-x64.dmg` (or `.zip`) | `hsm-<version>-macos-x64.tar.gz` |
| Linux x64 | `hsm-modeler-<version>-linux-x86_64.AppImage`, `…-linux-amd64.deb`, `…-linux-x64.tar.gz` | `hsm-<version>-linux-x64.tar.gz` |
| Linux arm64 | `hsm-modeler-<version>-linux-arm64.AppImage`, `…-linux-arm64.deb`, `…-linux-arm64.tar.gz` | `hsm-<version>-linux-arm64.tar.gz` |

Independent of the platform: `hsm-vscode-<version>.vsix` (VS Code extension),
`hsm-eclipse-update-site-<version>.zip` (Eclipse update site archive) and `hsm-jetbrains-<version>.zip`
(JetBrains plugin).

Sizes: the desktop app is about 115 MB to download (250 MB installed, most of it Electron/Chromium); the
command line executable 100 – 130 MB (35 – 45 MB compressed, a complete Node.js runtime); the `.vsix`
2 MB; the Eclipse update site about 200 MB (it contains the `hsm` executables of all five platforms; Eclipse
installs only the one of its platform, about 40 MB); the JetBrains plugin about 2.5 MB (without executable).

### Unsigned downloads

Nothing is signed with a certificate of Apple or Microsoft, so the operating systems warn before the
first start:

- **macOS** (Gatekeeper): open the `.dmg`, drag *HSM Modeler* to *Applications*; at the first start
  macOS refuses to open it – *System Settings → Privacy & Security → Open Anyway* (or remove the
  quarantine flag: `xattr -dr com.apple.quarantine "/Applications/HSM Modeler.app"`). For the command
  line tool: `tar -xzf hsm-…-macos-arm64.tar.gz && xattr -d com.apple.quarantine hsm`. App and executable
  have an ad-hoc signature, which Apple silicon requires to run them at all.
- **Windows** (SmartScreen): *More info → Run anyway*. Some virus scanners distrust unknown executables
  that contain a Node.js or Electron runtime; the SHA-256 checksums allow checking the download.
- **Linux**: `chmod +x hsm-modeler-…AppImage` (AppImages need FUSE 2: `sudo apt install libfuse2t64` on
  Ubuntu ≥ 24.04), or `sudo apt install ./hsm-modeler-…-linux-amd64.deb` (installs `hsm-modeler` with a
  desktop entry and the `.hsm` file type), or unpack the `.tar.gz` and start `hsm-modeler`. On Ubuntu ≥
  24.04 the AppImage and the `.tar.gz` may need `--no-sandbox` (AppArmor restricts the Chromium sandbox
  of applications outside of `/usr`); the `.deb` does not.

## Desktop app

*HSM Modeler* is the graphical editor as a desktop application: every model opens in a native window
with the text editor, the diagram, the properties, the simulation and the export (the same editor as the
web app, see [Web editor](editor.md)) and is read from and saved to its file on disk.

- **File menu**: *New Model* (`Ctrl+N`; the file is chosen on the first save), *Open…* (`Ctrl+O`, several
  files at once), *Open Folder…* (`Ctrl+Shift+O`: a list of the models of a folder, with *New model*), *Open
  Recent*, *Save* (`Ctrl+S`), *Save As…* (`Ctrl+Shift+S`), *Close Window*. On macOS `Cmd` instead of `Ctrl`.
- **Starting with files**: `HSM Modeler model.hsm other.hsm folder/` (Linux: `hsm-modeler …`), double-click
  on a `.hsm` file (the installers register the file type), or drop it on the Dock icon (macOS). A second
  start passes its files to the running app. Without files a new model opens.
- **Imports and submachines**: a model can import the `.hsm` models and C/C++ headers below its *root
  folder*: the folder of the model, or the folder opened with *Open Folder…* if the model is inside of it
  (use *Open Folder…* for `import "../motor.hsm"`). Double-clicking a submachine state opens its model in
  a new window. Go to definition in the text editor (`F12`, `Cmd/Ctrl`+Click) opens imported models in their
  window at the target and C/C++ headers in a read-only viewer window with the declaration selected. *Export…* writes the SVG / PNG next to the model, *Generate C++* into the configured output
  directory (both only inside the root folder).
- **Unsaved changes**: the title shows `●` (macOS: the dot in the close button); closing a window or
  quitting asks to save. Changes of the file on disk (another editor, git) are loaded into the window – after
  a question if the window has unsaved changes; changed imports and generator configurations are loaded too.
- The editor settings (theme, layout direction, …) are kept between starts.

How it works: the Electron main process (`packages/desktop`) runs a small HTTP server on `127.0.0.1` for
its own windows. It serves the web app and the same file API as the Eclipse plugin (the embedded mode
`?host=http` of the web app, [`packages/web/src/host.ts`](../packages/web/src/host.ts)): every window has a
random token in its URL, requests without a known token, with a foreign `Host` header (DNS rebinding) or a
foreign `Origin` are rejected, and all paths are confined to the root folder of the window (`..` and
symbolic links leading outside are rejected). The windows run sandboxed, without Node.js integration;
links to other sites open in the default browser.

## Command line tool (`hsm`)

`hsm` (`hsm.exe`) is a single executable with exactly the commands and options described in the
[README](../README.md#command-line) (`validate`, `generate`, `test`, `render`, `doc`, `import`, `simulate`,
…); without arguments it prints the help. Unpack it into a directory of the `PATH`; the
[CMake integration](build-integration.md#installing-the-command-line-tool) finds it there (or set
`-DHSM_EXECUTABLE=/path/to/hsm`).

```bash
hsm validate examples/cd-player.hsm
hsm generate cpp examples/traffic-light.hsm -o gen
hsm generate --check            # all models / targets of ./hsm.gen.json; exit 1 if out of date (CI)
hsm test examples/tests/*.hsmtest --machine examples --junit report.xml
hsm --version
```

With Node.js the same tool is available from the repository (`node packages/language/bin/cli.js …`, see
the README).

### Language server (`hsm lsp`)

`hsm lsp --stdio` runs the language server of the VS Code extension for any editor with an LSP client (the
Eclipse and JetBrains plugins use it for their text editors, see below; Neovim, Helix, Emacs, Sublime Text, Zed,
Kate, … can be configured the same way): diagnostics, completion, hover with documentation, go to definition /
declaration / type definition (into imported C/C++ headers and other models), references, document links on
import paths, formatting, document symbols / outline, folding, rename and semantic tokens for `.hsm` and
`.hsmtest` (language ids `hsm` and `hsmtest`). The workspace folders (or the `rootUri`) are indexed, so test
classes and imports find the models of other files; imported headers are found through the `headers` block of
the nearest `hsm.gen.json`, and changed headers are re-read when the client reports file changes (Langium
registers a watcher for all files if the client supports dynamic registration of
`workspace/didChangeWatchedFiles`). The client settings `hsm.headers.*` (`workspace/configuration`) are
optional. Other transports: `--socket <port>` (connects to a port the client listens on), `--pipe <name>`.

```lua
-- Neovim (0.11+)
vim.filetype.add({ extension = { hsm = 'hsm', hsmtest = 'hsmtest' } })
vim.lsp.config('hsm', { cmd = { 'hsm', 'lsp', '--stdio' }, filetypes = { 'hsm', 'hsmtest' }, root_markers = { 'hsm.gen.json', '.git' } })
vim.lsp.enable('hsm')
```

## VS Code extension

Install the `.vsix`: *Extensions* view → `…` → *Install from VSIX…*, or `code --install-extension
hsm-vscode-<version>.vsix`. The extension brings its own language server (VS Code runs it with its
Node.js runtime); it does not need the command line tool. Features and settings: [VS Code extension](vscode.md).

## Eclipse plugin

*Help → Install New Software… → Add… → Archive…* → `hsm-eclipse-update-site-<version>.zip`, select *HSM
Modeler (prototype)* (uncheck *Group items by category* if the list is empty), accept the warning about
unsigned content and restart. Double-clicking a `.hsm` file in the Project Explorer opens the graphical
editor; *Open With → Text Editor* still opens the plain text.

**Text editor with language support:** *Open With → Generic Text Editor* opens a `.hsm` file in Eclipse's Generic
Editor with the HSM language server (`hsm lsp` of the bundled executable, through LSP4E): problems as markers,
completion, hover with documentation, *F3* / Ctrl+Click into imported C/C++ headers (the CDT editor if CDT is
installed) and other models, document links, *Format* (Ctrl+Shift+F), *Outline*, rename (Alt+Shift+R),
semantic highlighting, and TextMate highlighting with TM4E. `.hsmtest` files open in the Generic Editor by
default. Requirements: LSP4E and TM4E (Eclipse projects, part of the Eclipse release repository and already
installed in *Eclipse IDE for C/C++ Developers* and most other packages). p2 installs them from the release
repository if they are missing: the update site references `https://download.eclipse.org/releases/2025-06/`,
and for the zip archive the release site of your Eclipse must be available (*Contact all update sites during
install to find required software*, checked by default).

The feature also installs the command line executable `hsm` of the platform (a fragment of the plugin). With
*Configure → Enable / Disable HSM Validation* on a project, the builder validates closed models with it
(`hsm validate --json`) and shows their problems in the *Problems* view; the models importing a changed model or
header are validated again. *Preferences → HSM Modeler → hsm executable* selects another executable (default:
the bundled one, else `hsm` in the `PATH`). The editor itself does not need the executable: it runs the web app
with a small HTTP server of the plugin, and *Generate C++* runs in the editor's page. Details, requirements and
the development setup: [eclipse-plugin/README.md](../eclipse-plugin/README.md).

## JetBrains plugin (CLion, IntelliJ IDEA)

*Settings → Plugins → ⚙ → Install Plugin from Disk…* → `hsm-jetbrains-<version>.zip`. Opening a `.hsm` file
shows the graphical editor (the web app in the IDE's JCEF browser) with the views *Text*, *Text and Diagram* and
*Diagram*; page and IntelliJ text editor edit the same document (undo, autosave, local history and VCS as for
any file). Problems appear in the text editor and in the *Problems* tool window, the outline in the *Structure*
tool window; *Generate C++* is in the context menu of `.hsm` files and in the page.

**Language server in the text editor:** with the free plugin [LSP4IJ](https://plugins.jetbrains.com/plugin/23257-lsp4ij)
(Red Hat, works in all JetBrains IDEs including the free ones; *Settings → Plugins → Marketplace → LSP4IJ*) and the
`hsm` executable (see below), the IDE's text editor of `.hsm` and `.hsmtest` files runs the HSM language server
(`hsm lsp --stdio`): diagnostics, completion, hover with documentation, *Go to Declaration* / Ctrl+Click into
imported C/C++ headers and other models, document links, *Reformat Code*, structure view, folding, rename and
semantic highlighting. The *LSP Consoles* tool window of LSP4IJ shows the server's state and log. Without LSP4IJ
the plugin keeps its own highlighting and the validation described below.

The plugin does not bundle the command line executable (one zip for all platforms). With `hsm` in the `PATH`
(or its path in *Settings → Tools → HSM Modeler*), saved and closed models and their importers are validated
with `hsm validate --json` (*Tools → Validate HSM Models* validates all). In CLion, the CMake functions of
[Build integration](build-integration.md) (`hsm_generate`, `hsm_add_tests`) work as in any CMake project once
`hsm` is in the `PATH` of CLion or `-DHSM_EXECUTABLE=<path>` is set in the CMake options of the profile. Details,
architecture and the development setup: [jetbrains-plugin/README.md](../jetbrains-plugin/README.md).

## Trying the plugins locally

Scripts in [`scripts/ide/`](../scripts/ide) build a plugin from the sources and start its IDE with it and the
examples opened – in a sandbox below `.ide/` of the repository (git-ignored), so the normal installations,
profiles, settings and extensions of the IDEs are not touched. They work on macOS, Linux and Windows
(Node.js ≥ 20.10):

```bash
npm run ide:vscode              # VS Code with the extension (development mode)
npm run ide:vscode -- --vsix    # … with the packaged .vsix installed instead
npm run ide:eclipse             # Eclipse (downloaded once) with the plugin, examples imported as a project
npm run ide:clion               # CLion with the JetBrains plugin
npm run ide:desktop             # the desktop app from the sources with the examples folder
npm run ide:eclipse -- --help   # all options of a script
```

| Script | Sandbox | What it does |
| --- | --- | --- |
| `ide:vscode` | `.ide/vscode/` | builds `packages/vscode`, starts `code` with its own `--user-data-dir` and `--extensions-dir` and `--extensionDevelopmentPath=packages/vscode` (an *Extension Development Host* window), or with `--vsix` packages the `.vsix` and installs it into the sandbox's extensions folder. `code` is taken from the `PATH` (also `code-insiders`, `codium`) or the standard installation folders; `--code <path>` / `HSM_VSCODE` choose another one. |
| `ide:eclipse` | `.ide/eclipse/` | builds the update site (`mvn verify`, needs Java 21 and Maven, and the `hsm` executable of this platform for the plugin's fragment), downloads *Eclipse IDE for C/C++ Developers* of the release the plugin is built against (2025-06, from archive.eclipse.org, checked against its SHA-512; once, into `.ide/eclipse/install/`), installs the feature with the p2 director (replacing an older build), imports the examples as the project `hsm-examples` with CDT's headless import (no wizard) and starts Eclipse with that workspace and `traffic-light.hsm` opened. `--eclipse <path>` / `HSM_ECLIPSE` use an existing installation instead – the plugin is installed **into** it, so use a separate one. |
| `ide:clion` | `.ide/clion/` | Installs LSP4IJ next to the plugin (language server in the text editor; Gradle modes: dependency of the build, `--zip`: downloaded from the JetBrains Marketplace into `.ide/clion/downloads/`). Finds CLion (`/Applications`, `~/Applications`, JetBrains Toolbox, `/opt`, `%LOCALAPPDATA%\Programs`, `%ProgramFiles%\JetBrains`; `--clion <path>` / `HSM_CLION`, any IntelliJ Platform IDE ≥ 2025.2 works) and runs `./gradlew runLocalIde` with [`jetbrains-local-ide.init.gradle`](../scripts/ide/jetbrains-local-ide.init.gradle): the plugin build is unchanged, Gradle builds the plugin and starts that installation with it in `.ide/clion/gradle-sandbox/` (the script waits until the IDE is closed). Without CLion it starts IntelliJ IDEA Community of the plugin's target platform (`./gradlew runIde`, downloaded by Gradle) and says so; `--download-clion` lets Gradle download CLion instead. `--zip` builds the plugin zip, unpacks it into an isolated plugins folder and starts the installed IDE directly with its own `idea.properties` (`CLION_PROPERTIES`: config, system, plugins and log folders in `.ide/clion/zip/`). The `hsm` executable of this platform is put into the plugin (`-PhsmExecutable`) for the validation of closed models. |
| `ide:desktop` | `.ide/desktop/` | builds `packages/desktop` and starts it with Electron from `node_modules` and `--user-data-dir` in the sandbox (an installed *HSM Modeler* keeps its recent files and is not reused as running instance), with the examples folder. |

Options of all scripts:

- `--no-build`: use the existing build;
- `--examples <dir>`: open that folder instead of the examples; `--in-place`: open the repository's `examples/`
  directly (edits change the repository; Eclipse writes `examples/.project`, which is git-ignored). By default
  the IDE opens a copy of `examples/` in `.ide/<ide>/workspace/hsm-examples`, created on the first start and
  kept afterwards;
- `--clean`: reset the sandbox of that IDE first (profile, settings, workspace, examples copy; the downloaded
  Eclipse archive is kept);
- `--dry-run`: print what would be done; `--help`.

Notes:

- Every IDE started by a script is a separate instance next to your own IDE windows; close it as usual. The
  logs are in the sandbox (VS Code: `.ide/vscode/user-data/logs/…/exthost/exthost.log`; Eclipse:
  `.ide/eclipse/workspace/.metadata/.log`; CLion: `.ide/clion/gradle-sandbox/log_runLocalIde/idea.log`).
- First starts ask what a fresh profile asks: Eclipse nothing (the welcome page is turned off), JetBrains IDEs
  their user agreement / license (once per sandbox).
- Only the HSM plugin is installed (plus LSP4IJ for the JetBrains IDEs; Eclipse's C/C++ package already contains
  LSP4E and TM4E, otherwise the script's p2 director installs them from the release repository). Other extensions (e.g. the C/C++ extension for the generated code) can be
  installed in the sandbox IDE as usual; they stay in the sandbox.
- Eclipse is started with `-data .ide/eclipse/workspace`; the `ide:eclipse` script refuses to update the plugin
  while that Eclipse is running (p2 changes the installation).

## How the downloads are built

The [*Distribution* workflow](../.github/workflows/distribution.yml) builds everything on native runners
(desktop app and command line tool for linux-x64, linux-arm64, macos-arm64, macos-x64 and windows-x64),
smoke-tests the desktop app and the executables, puts the five executables into the platform fragments of the
Eclipse plugin (`mvn verify -Dhsm.cli.optional=false`), builds, tests and verifies the JetBrains plugin
(`./gradlew test buildPlugin verifyPlugin`) and, for version tags, creates the GitHub release with all
files and `SHA256SUMS.txt`.

Locally (Node.js ≥ 20.10; for the Eclipse plugin also Java 21 and Maven ≥ 3.9; for the JetBrains plugin a JDK ≥ 17):

```bash
npm ci
npm run package:desktop                   # packages/desktop/release/: installers of the current platform
node packages/desktop/scripts/smoke-test.mjs
npm start -w packages/desktop             # the desktop app from the sources (development)
npm run build:exe                         # packages/cli/dist/bin/<platform>/hsm
node packages/cli/scripts/smoke-test.mjs
npm run package:vscode                    # packages/vscode/hsm-vscode-<version>.vsix
npm run build -w packages/web && (cd eclipse-plugin && mvn verify)   # eclipse-plugin/hsm.eclipse.site/target/*.zip
                                          # (with the hsm executable of this platform if built before)
npm run build -w packages/web && (cd jetbrains-plugin && ./gradlew buildPlugin)   # jetbrains-plugin/build/distributions/*.zip
```

If `npm ci` did not download Electron (`node_modules/electron/dist` missing), run
`node node_modules/electron/install.js`.

### Desktop app (`packages/desktop`)

- `scripts/build.mjs` builds the web app (Vite, `packages/web/dist` → `dist/web`) and bundles the main
  process (`src/main.ts`, `src/server.ts`, `src/file-host.ts`) with esbuild into `dist/main.cjs`.
- `scripts/package.mjs` packages it with [electron-builder](https://www.electron.build) for the current
  platform (`--arch x64|arm64`; `--dir`: only the unpacked app): `.dmg` + `.zip` (macOS, ad-hoc signed,
  not notarized), NSIS installer + `.zip` (Windows), AppImage + `.deb` + `.tar.gz` (Linux), with the file
  association for `.hsm`. Everything is bundled, the app contains no `node_modules`.
- `scripts/smoke-test.mjs` starts the packaged app (or Electron with `dist/` in development) with
  `--smoke-test <copy of examples/door-with-motor/gate.hsm>`: a hidden window opens the model, waits until
  the diagram shows its states and the page reports no errors (the import of `motor.hsm` is resolved from
  the folder), edits the text and saves it through the page, then the app exits (on Linux CI under `xvfb-run`).

Why Electron: the editor is a static web app (Langium, ELK and the simulator run in the page), which
Electron shows unchanged; the main process is Node.js like the rest of the tool chain, so the file access
is plain TypeScript, shared in spirit and protocol with the Eclipse plugin. Tauri would be much smaller but
needs Rust and a system WebView per platform (WebKitGTK on Linux renders differently) and a Node.js sidecar
for everything that is not in the page. The price is the size of the Chromium runtime.

### Command line tool (`packages/cli`)

A [Node.js single executable application](https://nodejs.org/api/single-executable-applications.html)
(SEA):

1. `scripts/build.mjs` bundles the entry point `src/main.ts` with the command line tool of
   `packages/language` and all dependencies into one CommonJS file (esbuild, `dist/hsm.cjs`, about 2.6 MB).
2. `scripts/sea.mjs` downloads the official Node.js binary (currently v24 LTS, verified against the
   published SHA-256 checksums, cached in `packages/cli/.cache`), generates the SEA blob and injects it
   into a copy of the binary with [postject](https://github.com/nodejs/postject). On macOS the
   executable is then signed ad hoc (`codesign --sign -`). `--target linux-x64|linux-arm64|macos-x64|
   macos-arm64|windows-x64|windows-arm64` builds for another platform (Linux and Windows can be
   cross-built; macOS executables must be built on a Mac), `--archive` writes the release archive.
3. `scripts/smoke-test.mjs` checks an executable: `--version`, `--help` and the commands on the examples
   (including `validate --json`, the interface of the Eclipse builder).

Why a Node.js SEA (and not Bun or Deno `compile`, or `pkg`): the executable runs exactly the runtime the
tool is developed and tested with, with an official mechanism of Node.js; `pkg` is discontinued, Bun and
Deno would be a second runtime with their own compatibility questions. It is a separate executable and
not part of the desktop app because Electron applications are GUI applications on Windows (no console
output) and the CLI is used in builds and CI, where a 250 MB Chromium runtime is not wanted.

### Versions and releases

The version is `HSM_VERSION` (set by the workflow from the tag `v<version>`) or that of the
`package.json` of the package (Eclipse: `pom.xml`, set with `tycho-versions-plugin` for tags; JetBrains:
`pluginVersion` of `jetbrains-plugin/gradle.properties`, overridden for tags). Pushing a
tag (`git tag v0.2.0 && git push origin v0.2.0`) builds everything with that version and attaches all files
and `SHA256SUMS.txt` to the GitHub release of the tag (created with generated release notes if it does not
exist).
