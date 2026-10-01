# Self-contained executable

`hsm` (`hsm.exe` on Windows) is a single file containing the graphical editor (the web app) and the
command line tool. Users need neither Node.js nor npm: download, unpack, run.

- `hsm` without arguments starts the editor: a small web server on `127.0.0.1` serves the web app and
  the default browser opens it. It runs until `Ctrl+C` (or until the terminal window is closed).
- `hsm <command> …` is the command line tool, with exactly the commands and options described in the
  [README](../README.md#command-line) (`validate`, `generate`, `test`, `render`, `doc`, `import`, …).

## Download

The [releases](https://github.com/armaxri/HSM/releases) of version tags have one archive per platform;
the [*Executables* workflow](../.github/workflows/executables.yml) also builds them for every push and
pull request (artifacts of the workflow run, kept for 90 days).

| Platform | File |
| --- | --- |
| Windows x64 | `hsm-<version>-windows-x64.zip` |
| macOS Apple silicon | `hsm-<version>-macos-arm64.tar.gz` |
| macOS Intel | `hsm-<version>-macos-x64.tar.gz` |
| Linux x64 | `hsm-<version>-linux-x64.tar.gz` (glibc ≥ 2.28, e.g. Ubuntu ≥ 20.04, Debian ≥ 10, RHEL ≥ 8) |
| Linux arm64 | `hsm-<version>-linux-arm64.tar.gz` (glibc ≥ 2.28) |

`SHA256SUMS.txt` of the release lists the checksums. The executables are 100 – 130 MB (35 – 45 MB
compressed): each contains a complete Node.js runtime.

Put `hsm` into a directory of the `PATH` to use it like the npm installed command line tool, e.g. from
the [CMake integration](build-integration.md#installing-the-command-line-tool), which finds `hsm` in the
`PATH` (or set `-DHSM_EXECUTABLE=/path/to/hsm`).

### Unsigned executables

The executables are not signed with a certificate of Apple or Microsoft, so the operating systems warn
before the first start:

- **macOS** (Gatekeeper): the archive is unpacked with `tar -xzf hsm-…-macos-arm64.tar.gz`, then
  `xattr -d com.apple.quarantine hsm` removes the quarantine flag of the download (or: try to start it
  once, then *System Settings → Privacy & Security → Open Anyway*). The executable has an ad-hoc
  signature, which Apple silicon requires to run it at all.
- **Windows** (SmartScreen): *More info → Run anyway*. Some virus scanners distrust unknown executables
  that contain a Node.js runtime; the SHA-256 checksums allow checking the download.
- **Linux**: `chmod +x hsm` if the executable bit got lost (it is kept in the `.tar.gz`).

## The editor (`hsm ui`)

```text
hsm                      start the graphical editor in the default browser (same as `hsm ui`)
hsm ui [options]
  -p, --port <port>      port on 127.0.0.1 (default: 51734; 0: a free port chosen by the system)
  --no-open              do not open the browser
  --json                 machine readable output: one JSON line per event on stdout
  --exit-on-stdin-close  stop the server when stdin is closed
hsm --version            prints the version (only the version number, e.g. 0.1.0)
hsm --help
```

The editor is the same web app as `npm run dev`: it keeps the open model and the files of the workspace
in the **browser storage** (`localStorage`), *Open…* reads files of the computer, *Save* and *Export…*
download files. The browser storage belongs to the address including the port, therefore `hsm ui` uses
the fixed port 51734: the next start finds the files again. If the port is used by another program, a free
port is taken (with an empty storage); if it is used by a running `hsm`, the browser just opens that one.

The server only listens on the loopback interface (`127.0.0.1`), answers only `GET` / `HEAD` requests
whose `Host` header is `127.0.0.1`, `localhost` or `[::1]` (protection against DNS rebinding), and serves
only the embedded files of the web app – it has no access to the file system.

## Embedding the editor (IDE integration)

An IDE plugin (e.g. the Eclipse prototype, which shows the web app in a browser widget) starts the server
as a child process:

```bash
hsm ui --no-open --port 0 --json --exit-on-stdin-close
```

- `--port 0` lets the system choose a free port (no conflicts between several IDE instances; note that
  the browser storage is then empty on every start).
- `--json` prints events as single JSON lines on **stdout** (UTF-8, `\n` terminated); human readable
  messages go to stderr. The first line is either

  ```json
  {"event":"listening","url":"http://127.0.0.1:53187/","port":53187,"pid":4711,"version":"0.1.0"}
  ```

  after which the URL can be loaded, or

  ```json
  {"event":"error","message":"port 8080 is already in use"}
  ```

  followed by exit code 1 (2 for invalid options). When the server stops, it prints `{"event":"stopped","reason":"SIGTERM"}`
  (reasons: `SIGINT`, `SIGTERM`, `SIGHUP`, `stdin closed`). Consumers should ignore unknown events and
  unknown properties (the format may get additional ones).
- `--exit-on-stdin-close`: the server stops when its stdin reaches end of file, i.e. when the parent
  process closes the pipe or terminates (also if it crashes). Without this flag, the parent has to
  terminate the process (`SIGTERM`; on Windows `Process.destroy()` / `TerminateProcess`).
- `GET /api/info` answers `{"app":"hsm-modeler","version":"0.1.0","pid":4711}` (e.g. as health check).
- Exit codes: `0` stopped normally, `1` the server could not start, `2` invalid options.

Java example (Eclipse):

```java
Process process = new ProcessBuilder(hsm, "ui", "--no-open", "--port", "0", "--json", "--exit-on-stdin-close")
        .redirectError(ProcessBuilder.Redirect.INHERIT)
        .start();
BufferedReader out = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
String line = out.readLine();   // {"event":"listening","url":"http://127.0.0.1:53187/",...}
// parse "url", load it into the browser widget; keep process.getOutputStream() open while the editor
// is needed, close it (or call process.destroy()) to stop the server
```

Not available yet (possible next steps): opening a given model file (`hsm ui model.hsm`) and saving back
to the file system. The web app currently only works with browser storage and downloads; a file API of the
server (bound to `127.0.0.1`, with a per-start access token and restricted to the opened directory) would
make that possible, as would a host bridge like the one of the VS Code webview.

## How it is built

The executable is a [Node.js single executable application](https://nodejs.org/api/single-executable-applications.html)
(SEA), made by `packages/standalone`:

1. `scripts/build.mjs` builds the web app (Vite, `packages/web/dist`) and bundles the entry point
   `src/main.ts` with the command line tool and all dependencies into one CommonJS file (esbuild,
   `dist/hsm.cjs`, about 2.6 MB). The web app files become SEA assets.
2. `scripts/sea.mjs` downloads the official Node.js binary (currently v24 LTS, verified against the
   published SHA-256 checksums, cached in `packages/standalone/.cache`), generates the SEA blob and
   injects it into a copy of the binary with [postject](https://github.com/nodejs/postject). On macOS
   the executable is then signed ad hoc (`codesign --sign -`).
3. `scripts/smoke-test.mjs` checks an executable: `--version`, CLI commands on the examples and the UI
   server in the embedding mode.

`src/main.ts` dispatches: no arguments or `ui` → `src/ui-server.ts`; `--version` / `--help`; everything
else is passed to the command line tool of `packages/language` (`src/cli/main.ts`) unchanged.

Locally (Node.js ≥ 20.10 for the build; the result does not need it):

```bash
npm ci
npm run build:exe                                     # packages/standalone/dist/bin/<platform>/hsm
node packages/standalone/scripts/smoke-test.mjs       # test it
node packages/standalone/dist/hsm.cjs ui              # the bundle with the installed Node.js (development)
```

Other targets: `node packages/standalone/scripts/sea.mjs --target linux-x64` (after `scripts/build.mjs`;
targets `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `windows-x64`, `windows-arm64`;
`--archive` also writes the release archive to `dist/release/`). Cross-building works for Linux and
Windows; macOS executables must be built on a Mac (signing). The version is that of
`packages/standalone/package.json`, or `HSM_VERSION` (set by the workflow from the tag `v<version>`).

Why a Node.js SEA (and not Bun or Deno `compile`, or `pkg`): the executable runs exactly the runtime
the tool is developed and tested with (Node.js), with an official, maintained mechanism of Node.js, and the
build only needs npm packages; `pkg` is discontinued, Bun and Deno would be a second runtime with their own
compatibility questions. The price is the size (Node.js binary of about 100 – 120 MB).

## Releases

Pushing a tag `v<version>` (e.g. `git tag v0.2.0 && git push origin v0.2.0`) builds all executables
with that version and attaches the archives and `SHA256SUMS.txt` to the GitHub release of the tag
(created with generated release notes if it does not exist).
