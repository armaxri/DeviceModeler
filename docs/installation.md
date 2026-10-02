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
  a new window. *Export…* writes the SVG / PNG next to the model, *Generate C++* into the configured output
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

## VS Code extension

Install the `.vsix`: *Extensions* view → `…` → *Install from VSIX…*, or `code --install-extension
hsm-vscode-<version>.vsix`. The extension brings its own language server (VS Code runs it with its
Node.js runtime); it does not need the command line tool. Features and settings: [VS Code extension](vscode.md).

## Eclipse plugin

*Help → Install New Software… → Add… → Archive…* → `hsm-eclipse-update-site-<version>.zip`, select *HSM
Modeler (prototype)* (uncheck *Group items by category* if the list is empty), accept the warning about
unsigned content and restart. Double-clicking a `.hsm` file in the Project Explorer opens the graphical
editor; *Open With → Text Editor* still opens the plain text.

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

The plugin does not bundle the command line executable (one zip for all platforms). With `hsm` in the `PATH`
(or its path in *Settings → Tools → HSM Modeler*), saved and closed models and their importers are validated
with `hsm validate --json` (*Tools → Validate HSM Models* validates all). In CLion, the CMake functions of
[Build integration](build-integration.md) (`hsm_generate`, `hsm_add_tests`) work as in any CMake project once
`hsm` is in the `PATH` of CLion or `-DHSM_EXECUTABLE=<path>` is set in the CMake options of the profile. Details,
architecture and the development setup: [jetbrains-plugin/README.md](../jetbrains-plugin/README.md).

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
