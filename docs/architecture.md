# Architecture

```
packages/
  language/     Langium language and tooling (no DOM dependencies, runs in Node.js and in the browser)
    src/hsm.langium             grammar of the state machine language (.hsm)
    src/hsm-test.langium        grammar of the unit test language (.hsmtest), reuses the expressions of hsm.langium
    src/generated/              Langium generated AST, grammar and module (`npm run langium:generate`)
    src/syntaxes/               generated Monarch grammar (syntax highlighting in Monaco)
    src/hsm-module.ts           dependency injection: services of .hsm and .hsmtest, relinking of importing documents
    src/hsm-scope.ts            name resolution: qualified state names (nearest first), declarations, imported machines
    src/hsm-linker.ts           ambiguous vertex names, member access of C++ structs and submachine instances
    src/hsm-typesystem.ts       type system (integer, real, boolean, string, void, C++ types of headers)
    src/hsm-validator.ts        validation rules of the model structure
    src/hsm-expression-validator.ts  type checks of guards, effects and definitions
    src/hsm-import-validator.ts checks of imports and submachine instances
    src/hsm-formatter.ts        formatter
    src/hsm-document.ts         HsmModelLoader: parses, links and validates texts outside a language server
    src/imports.ts              `import "motor.hsm"`: path resolution, imported machines, submachine instances
    src/cpp-headers.ts          `import "motor_types.h"`: header store, settings, path resolution
    src/cpp-types.ts            C++ types and constants of headers in the HSM type system
    src/cpp-storage.ts          storage types (`std::uint8_t`, …): width preserving values
    src/cpp-header/             C++ header analyzer: lexer, preprocessor, parser, type index, constant evaluation
    src/node/                   Node.js host of header imports (file system, `headers` of hsm.gen.json)
    src/lsp/                    hover, go to definition and completion of C++ names (VS Code and web)
    src/model-utils.ts          AST helpers (containers, composite states, …)
    src/diagram/                AST -> PlantUML-like diagram model (layout.ts), laid out with ELK; font metrics
    src/edit/model-edits.ts     ModelEditor: structural edits (add, move, rename, delete, …) as text edits
    src/render/                 SVG renderer without DOM (renderSvg), diagram style sheet shared with the web app
    src/doc/                    model documentation (Markdown / HTML), doc comments, hover documentation
    src/simulation/             interpreter (docs/semantics.md) with virtual clock, scenario runner
    src/testing/                unit test language: scoping, validation, runner, workspace, JUnit XML, coverage reports
    src/generator/common/       shared part of the C / C++ generators (analysis, states, transitions, expressions)
    src/generator/cpp/          C++ code generator and scenario test harness generator
    src/generator/c/            C code generator and scenario test harness generator
    src/generator/config.ts     generator configuration (hsm.gen.json): format, validation, file names (no fs)
    src/generator/generate-command.ts  `hsm generate`: loads the configuration, writes / checks the files (Node)
    src/importer/               itemis CREATE (.sct) importer with a small XML parser
    src/cli/                    command line interface (`hsm`): validate, generate, test, simulate, render, doc, import, …
    schemas/                    JSON schema of hsm.gen.json
    test/                       unit tests; test/scenarios: conformance suite shared with the code generators
  web/          Vite app: Monaco editor + Sprotty diagram
    src/app.ts                  the web app: Monaco editor, toolbar, files; host of the diagram controller
    src/host.ts                 embedded mode (`?host=http`): the file comes from / is saved by the embedding application
    src/host-model.ts           embedded mode: problems and outline of the model for the host (Eclipse markers, Outline)
    src/host-generate.ts        embedded mode: C++ generation in the page (configuration resolution like `hsm generate`)
    src/examples.ts             virtual file list (examples, imported models and headers)
    src/diagram-controller.ts   graphical editor: text -> Langium -> ELK (web worker) -> Sprotty, diagram edits -> text
                                (independent of Monaco: also used by the VS Code webview via the DiagramHost interface)
    src/model-service.ts        Langium parsing / validation of the model text (and its imports) in the browser
    src/language-support.ts     Langium services wired into Monaco (markers, completion, hover, formatting, …)
    src/diagram/                Sprotty model, views (PlantUML look), ELK worker, mouse / selection listeners
    src/simulation/             simulation session: interpreter, real-time clock, logs, operation mocks, breakpoints
    src/ui/                     properties and simulation panels, value editor, inline editor, SVG / PNG export
    src/styles/                 style sheets of the app, the diagram and the simulation
  vscode/       VS Code extension
    src/extension/              extension host: language client, commands, diagram panel, test controller
                                (src/extension/logic: VS Code independent parts, unit tested)
    src/server/                 Langium language server (with C++ header support)
    src/webview/                diagram webview: the DiagramController of packages/web with a VS Code DiagramHost
    src/common/protocol.ts      messages between extension host and webview
    scripts/                    esbuild / Vite bundling and packaging of the .vsix
  desktop/      desktop app "HSM Modeler" (Electron, docs/installation.md)
    src/main.ts                 main process: windows, menus, file dialogs, recent files, dirty state, smoke test mode
    src/server.ts               loopback HTTP server of the windows (Host / Origin checks, tokens)
    src/file-host.ts            the file API of the embedded web app (?host=http, same protocol as the Eclipse plugin)
    scripts/                    build.mjs (Vite + esbuild), package.mjs (electron-builder), smoke-test.mjs
  cli/          self-contained `hsm` command line executable (Node.js single executable application)
    src/main.ts                 entry point: --version / --help, otherwise the CLI of packages/language
    scripts/                    build.mjs (esbuild bundle), sea.mjs (executable), smoke-test.mjs
eclipse-plugin/ Eclipse plugin (prototype, Maven / Tycho): the web app (packages/web/dist, embedded mode of src/host.ts)
                in an SWT browser, served by a small HTTP server of the plugin; workspace files, problem markers,
                outline, edit commands, C++ generation; hsm.eclipse.tools: interfaces for the bundled executable
examples/       sample state machines; tests: their unit tests; door-with-motor: imports and submachines;
                cpp-types: C++ header types; cmake: CMake example
cmake/          CMake integration (HsmGenerate.cmake: hsm_generate, hsm_add_tests; HsmConfig.cmake)
docs/           execution semantics, C++ integration, possible improvements, generated example docs
```

The text is the single source of truth. On every change it is parsed and validated by the Langium
services, which run directly in the browser. Imported models (`import "motor.hsm"`) are loaded into the
same Langium workspace; imported C++ headers are not Langium documents but are analyzed by
`src/cpp-header` and put into a header store, so their types and constants take part in linking,
type checking, simulation and code generation. The AST is converted into a diagram model whose layout is
computed by ELK (layered algorithm with hierarchy support, in a web worker) and rendered by Sprotty with
custom views. Diagram interactions are turned into text edits by `ModelEditor` and applied to the Monaco
model, which triggers the same pipeline again – so undo / redo, comments and formatting just work.

The VS Code extension runs the same pipeline in its diagram webview; instead of the Monaco model its
host is the VS Code document (see [VS Code extension](vscode.md)). The CLI, the language server
and the test runner use the same `packages/language` code in Node.js; the simulator, unit tests,
coverage and the conformance scenarios all execute on the one interpreter in `src/simulation`.
