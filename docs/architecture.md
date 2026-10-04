# Architecture

```
packages/
  language/     Langium language and tooling (no DOM dependencies, runs in Node.js and in the browser)
    src/devm.langium                      grammar of the .devm language: a state machine file or a structure file (entry rule)
    src/statemachine.langium              grammar of state machine files (imported by devm.langium and devm-test.langium)
    src/structure.langium                 grammar of structure files (imported by devm.langium, docs/structure-language.md)
    src/devm-test.langium                 grammar of the unit test language (.devmtest), reuses the expressions of statemachine.langium
    src/devm-parser.ts                    parser of .devm files: empty files, messages of mixed kinds, isStructureText
    src/generated/                        Langium generated AST, grammar and module (`npm run langium:generate`)
    src/syntaxes/                         generated Monarch grammar (syntax highlighting in Monaco)
    src/devm-module.ts                    dependency injection: services of .devm and .devmtest, relinking of importing documents
    src/statemachine-scope.ts             name resolution: qualified state names (nearest first), declarations, imported machines
    src/statemachine-linker.ts            ambiguous vertex names, member access of C++ structs and submachine instances
    src/typesystem.ts                     type system (integer, real, boolean, string, void, C++ types of headers)
    src/statemachine-validator.ts         validation rules of the model structure
    src/expression-validator.ts           type checks of guards, effects and definitions
    src/statemachine-import-validator.ts  checks of imports and submachine instances
    src/statemachine-formatter.ts         formatter
    src/model-loader.ts                   StateMachineModelLoader: parses, links and validates texts outside a language server
    src/imports.ts                        `import "motor.devm"`: path resolution, imported machines, submachine instances
    src/cpp-headers.ts                    `import "motor_types.h"`: header store, settings, path resolution
    src/cpp-types.ts                      C++ types and constants of headers in the type system of the models
    src/cpp-storage.ts                    storage types (`std::uint8_t`, …): width preserving values
    src/class-members.ts                  C++ class sections (`public:` …): C++ types of members, members the model cannot use
    src/devm-value-converter.ts           value converter: white space of (C++) type names (`unsigned int`)
    src/cpp-header/                       C++ header analyzer: lexer, preprocessor, parser, type index, constant evaluation
    src/node/                             Node.js host of header imports (file system, `headers` of devm.gen.json) and the
                                          Langium language server (devm-lsp.ts, language-server.ts) of VS Code and `devm lsp`
    src/lsp/                              hover, navigation, semantic tokens, quick fixes and completion (VS Code and web)
    src/model-utils.ts                    AST helpers (containers, composite states, …)
    src/structure-*.ts                    structure language: module, imports, types, scoping / linking, validation,
                                          port <-> state machine mapping (structure-behavior.ts), route analysis (structure-routes.ts),
                                          formatter; src/lsp/structure-lsp.ts: definition, "go to source", hover, completion
    src/diagram/                          AST -> PlantUML-like diagram model (layout.ts), laid out with ELK; font metrics;
                                          structures: internal block diagram (ibd-model.ts, ibd-layout.ts);
                                          manual layouts: layout-core/ (shared), manual-layout.ts + layout-annotations.ts
                                          (state machines, with edge anchors: edge-anchors.ts), ibd-manual-layout.ts +
                                          ibd-layout-annotations.ts (structures)
    src/edit/model-edits.ts               ModelEditor: structural edits (add, move, rename, delete, …) as text edits
    src/edit/structure-edits.ts           StructureEditor: the edits of structure diagrams (threads, instances, ports, connections, …)
    src/structure-workspace.ts            StructureWorkspace: all structure files loaded together (navigation, routes and renames across files)
    src/render/                           SVG renderer without DOM (renderSvg, renderIbdSvg), diagram style sheet shared with the web app
    src/doc/                              model documentation (Markdown / HTML), doc comments (Doxygen), hover documentation
    src/simulation/                       interpreter (docs/semantics.md) with virtual clock, scenario runner
    src/testing/                          unit test language: scoping, validation, runner, workspace, JUnit XML, coverage reports
    src/generator/common/                 shared part of the C / C++ generators (analysis, states, transitions, expressions)
    src/generator/cpp/                    C++ code generator and scenario test harness generator
    src/generator/c/                      C code generator and scenario test harness generator
    src/generator/config.ts               generator configuration (devm.gen.json): format, validation, file names (no fs)
    src/generator/generate-command.ts     `devm generate`: loads the configuration, writes / checks the files (Node)
    src/importer/                         itemis CREATE (.sct) importer with a small XML parser
    src/cli/                              command line interface (`devm`): validate, generate, test, simulate, render, doc, import, lsp, …
    schemas/                              JSON schema of devm.gen.json
    test/                                 unit tests; test/scenarios: conformance suite shared with the code generators
  web/          Vite app: Monaco editor + Sprotty diagram
    src/app.ts                            the web app: Monaco editor, toolbar, files; host of the diagram controller
    src/host.ts                           embedded mode (`?host=http`): the file comes from / is saved by the embedding application
    src/host-model.ts                     embedded mode: problems and outline of the model for the host (Eclipse markers, Outline)
    src/host-generate.ts                  embedded mode: C++ generation in the page (configuration resolution like `devm generate`)
    src/examples.ts                       virtual file list (examples, imported models and headers)
    src/diagram-controller.ts             graphical editor: text -> Langium -> ELK (web worker) -> Sprotty, diagram edits -> text
                                          (independent of Monaco: also used by the VS Code webview via the DiagramHost interface);
                                          structure files: structure-diagram.ts (editing, route highlighting, navigation)
    src/layout-editing.ts                 manual layout editing shared by both diagrams (LayoutEditor: moves, sizes, waypoints)
    src/layout-actions.ts                 names, tooltips and status messages of the layout controls (Store positions, …)
    src/model-service.ts                  Langium parsing / validation of the model text (and its imports) in the browser
    src/language-support.ts               Langium services wired into Monaco (markers, completion, hover, navigation, …)
    src/diagram/                          Sprotty model, views (PlantUML look), ELK worker, mouse / selection listeners;
                                          ibd-model.ts / ibd-views.tsx: internal block diagrams of structures
    src/simulation/                       simulation session: interpreter, real-time clock, logs, operation mocks, breakpoints
    src/ui/                               properties and simulation panels, value editor, inline editor, SVG / PNG export,
                                          tooltips (styled instead of native ones, which webviews / embedded browsers do not show)
    src/styles/                           style sheets of the app, the diagram and the simulation
  vscode/       VS Code extension
    src/extension/                        extension host: language client, commands, diagram panels (navigation history,
                                          workspace edits), workspace files sent to the diagrams, test controller, test
                                          debugging (src/debug: debug adapter of .devmtest files)
                                          (src/extension/logic: VS Code independent parts, unit tested)
    src/server/                           entry point of the language server of .devm and .devmtest (packages/language/src/node/language-server.ts)
    src/webview/                          diagram webview: the DiagramController of packages/web with a VS Code DiagramHost
    src/common/                           messages between extension host and webview (protocol.ts), text hashes
    scripts/                              esbuild / Vite bundling and packaging of the .vsix
  desktop/      desktop app "Device Modeler" (Electron, docs/installation.md)
    src/main.ts                           main process: windows, menus, file dialogs, recent files, dirty state, smoke test mode
    src/server.ts                         loopback HTTP server of the windows (Host / Origin checks, tokens)
    src/file-host.ts                      the file API of the embedded web app (?host=http, same protocol as the Eclipse plugin)
    scripts/                              build.mjs (Vite + esbuild), package.mjs (electron-builder), smoke-test.mjs
  cli/          self-contained `devm` command line executable (Node.js single executable application)
    src/main.ts                           entry point: --version / --help, otherwise the CLI of packages/language
                                          (incl. `devm lsp`: the language server for Eclipse, JetBrains IDEs, other editors)
    scripts/                              build.mjs (esbuild bundle), sea.mjs (executable), smoke-test.mjs
eclipse-plugin/ Eclipse plugin (prototype, Maven / Tycho): the web app (packages/web/dist, embedded mode of src/host.ts)
                in an SWT browser, served by a small HTTP server of the plugin; workspace files, problem markers,
                outline, edit commands, C++ generation; tools bundle: interfaces for the bundled executable
jetbrains-plugin/ JetBrains plugin (prototype, Gradle / Kotlin): the same web app and protocol in a JCEF browser,
                on the IntelliJ document (TextEditorWithPreview), Problems / Structure tool windows, devm validate
examples/       sample state machines; tests: their unit tests; door-with-motor: imports and submachines;
                cpp-types: C++ header types; cpp-class-sections: members of the generated C++ class; cmake: CMake example;
                device: structure files and state machines of a garage door
cmake/          CMake integration (DevmGenerate.cmake: devm_generate, devm_add_tests; DevmConfig.cmake)
docs/           execution semantics, C++ integration, possible improvements, generated example docs
```

The text is the single source of truth. On every change it is parsed and validated by the Langium
services, which run directly in the browser. Imported models (`import "motor.devm"`) are loaded into the
same Langium workspace; imported C++ headers are not Langium documents but are analyzed by
`src/cpp-header` and put into a header store, so their types and constants take part in linking,
type checking, simulation and code generation. The AST is converted into a diagram model whose layout is
computed by ELK (layered algorithm with hierarchy support, in a web worker) and rendered by Sprotty with
custom views. Diagram interactions are turned into text edits by `ModelEditor` and applied to the Monaco
model, which triggers the same pipeline again – so undo / redo, comments and formatting just work.

Structure files run through the same pipeline: the diagram controller switches to its structure
mode (`structure-diagram.ts`), the internal block diagram is computed by `layoutStructure` (ELK) and
diagram interactions become text edits by `StructureEditor`. Questions across files – the components and composites using a state
machine, routes through composites of other files, renames and deletions updating other files – are
answered by `StructureWorkspace`, which loads all structure files of the workspace together; the hosts pass the
texts of all `.devm` files for this, open other files on navigation (`DiagramHost.openLocation`,
with a back / forward history) and apply edits of several files (`DiagramHost.applyWorkspaceEdits`).

The VS Code extension runs the same pipeline in its diagram webview; instead of the Monaco model its
host is the VS Code document, navigation opens the target document and its diagram panel, and edits of
several files are one `WorkspaceEdit` (see [VS Code extension](vscode.md)). The CLI, the language server
and the test runner use the same `packages/language` code in Node.js; the simulator, unit tests,
coverage and the conformance scenarios all execute on the one interpreter in `src/simulation`.

## One language for two kinds of model files

State machine files and structure files have the same extension `.devm` and are one Langium language
(`devm.langium`, generated `DevmGeneratedModule`); a file contains either a state machine or structure
elements, never both.

- **Grammar:** the entry rule `DevmFile: StateMachine | StructureModel` imports the rules of `statemachine.langium` and
  `structure.langium`. The kind is decided by the first token (`statemachine` starts a state machine file), so
  every construct is parsed by the rule of its kind and the keywords both kinds use for different
  constructs (`import`, `interface`, `event`, annotations `@…`) keep their syntax. The structure alternative
  must consume at least one token: an alternative that can be empty would be predicted (ALL(*)) for every
  state machine file with a syntax error. An empty file is an empty structure file (`createDevmParser`,
  devm-parser.ts). Text of the other kind after the model cannot be parsed and is reported as "A .devm file
  contains either a state machine or structure elements" (`DevmParserErrorMessageProvider`).
- **Keywords:** the keywords of one kind are keywords of the other kind as well (one lexer). They are
  accepted as names by the name rules `StateMachineId` (state machines: `component`, `system`, `thread`, …) and
  `StructureId` (structure files: `state`, `in`, `entry`, …), not proposed by completion (`isSoftKeyword`) and
  shown as `ID` in the expected tokens of syntax errors. The TextMate / Monarch grammars highlight them as
  keywords; the semantic highlighting of the language server marks declarations and references.
- **Services** (`DevmModule`, devm-module.ts): the AST types of the two kinds are disjoint, so the validation
  checks of both kinds are registered on the same services. The services that need code of both kinds are
  structure implementations extending the state machine implementations: they handle the nodes of
  structure files and pass everything else on – `StructureScopeProvider` → `StateMachineScopeProvider`, `StructureLinker` →
  `StateMachineLinker` (resolves the imports of the file's kind before linking), `StructureFormatter` → `StateMachineFormatter`,
  `StructureCompletionProvider` → `StateMachineCompletionProvider`, `StructureDefinitionProvider` → `StateMachineDefinitionProvider`
  (lsp/cpp-lsp.ts: C++ names, imported machines), `StructureDocumentationProvider` → `StateMachineDocumentationProvider`.
  References, rename and document symbols are the Langium defaults. `createDevmServices` returns the
  language as `Devm` (and the unit test language as `DevmTest`).
- **Imports across files:** an import path ending in `.devm` is a model import; whether it is a state
  machine or a structure file is the kind of the loaded file (`importKind` = `model`, `structureImportKind`
  resolves to `statemachine` / `structure`). A state machine cannot import a structure file, the behavior of a component
  must be a state machine file (both reported). The loaders (`loadImports`, `StructureWorkspace`) load all
  `.devm` files and use the root of each.
- **Hosts:** the diagram controller shows the structure diagram when the text is a structure file
  (`isStructureText`: the first token, without parsing); the VS Code extension sets the context key
  `devm.structureEditorActive` the same way (menus of code generation), the CLI decides by the parsed root.

## Manual layout: shared core

Both diagrams can be arranged by hand with the same concept (docs/manual-layout.md): the layout is stored
as layout annotations in the model text (`@at`, `@size`, `@via`, …), a model without them is laid out
automatically, and the manual layout is applied on top of the automatic (ELK) layout, which is always
computed first. What is the same for both lives in `packages/language/src/diagram/layout-core/`:

| Module | Content |
| --- | --- |
| `model.ts` | the data model (`BaseManualLayout` with nodes – position relative to the parent, optional size – and edges – waypoints relative to the edge's frame, label offset), geometry helpers, `borderPlacement` (side and offset of a point on a node's border) |
| `annotation-edits.ts` | the minimal text edits making the layout annotations of a model equal to a layout, independent of the language: the languages describe *annotation slots* (the annotations written at one place, the wanted layout annotations, where new ones are inserted); values are replaced in place, new annotations appended or inserted on a line of their own / in front of the element, removed ones take their line with them |
| `tree.ts` | the node hierarchy (`LayoutTree`): paths, absolute positions, the frame of an edge (innermost node containing both ends) |
| `placement.ts` | `placeChildren`: pinned nodes at their stored position (shifted as a whole below a container's header, pushed apart if they overlap), the other nodes near their automatic position at a free spot |
| `routing.ts`, `orthogonal-router.ts` | orthogonal routing around obstacles on a sparse grid, through waypoints part by part |

What stays language specific, and why:

- **Reading / writing the annotations** (`layout-annotations.ts`, `ibd-layout-annotations.ts`): the
  grammars differ – state machines have element *and* container annotations (`@initial`, `@definitions`)
  whose owner is found by position in a body, structure elements own their annotations directly – and so do
  the diagram ids, the elements carrying annotations and the formatting (structure instances and connectors
  have their annotations on the same line).
- **The layout engines** (`ManualLayoutEngine` in manual-layout.ts, `IbdManualLayoutEngine` in
  ibd-manual-layout.ts) use the shared placement, hierarchy and router, but the node sizes (state
  compartments, regions stacked in a state vs. instances with port rows, threads, the frame) and the edge
  ends differ: transitions attach anywhere on a vertex border (spline / polyline shaping, labels, ends spread
  along a side), connectors attach to fixed ports and leave them perpendicular to their side (ports are
  placed by `@port`, structure diagrams have no edge labels and are always orthogonal).

In the web editor (`packages/web`) the mouse interaction (`diagram/listeners.ts`: dragging nodes with the
attached edges following, resize handles, waypoint handles, dragging ports along a border) serves both
diagrams, and `layout-editing.ts` (`LayoutEditor`) turns every change into a new layout based on the
effective layout (all nodes pinned where they are shown; the captured automatic layout for an
automatically laid out diagram) – the diagrams only provide the layout, its conversion into text edits
(`DiagramController.writeLayout`, `StructureDiagram.writeLayout`) and the routes of their edges.
