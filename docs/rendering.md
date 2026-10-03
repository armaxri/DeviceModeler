# Rendering diagrams and model documentation

## Rendering diagrams

`devm render` computes the layout with ELK and renders the diagram as a standalone SVG file – in Node.js, without
a browser, e.g. for reviews or in CI. The SVG has the shapes, classes and style sheet of the web editor
(`DIAGRAM_CSS`, shared by both), so it looks like the SVG of *Export…* in the editor.

```bash
devm render model.devm                            # writes model.svg next to the model
devm render model.devm -o diagram.svg --theme dark --direction RIGHT --routing ORTHOGONAL
devm render models/ 'src/**/*.devm' -o build/diagrams   # directories and glob patterns (also when not expanded by the shell)
```

Structure files (see [the structure language](structure-language.md#diagram)) are rendered as internal
block diagrams: `devm render system.devm` shows the first system (else the first structure, else all component
types of the file), `--element DriveUnit` another structure or a component type. Whether a `.devm` file is a
state machine or a structure file is its content. The layout options do not apply to
structures (always left to right, orthogonal); their layout annotations (manual layout, `@at`, `@port`, …) are
applied like those of state machines (`--auto` ignores them).

Options: `--theme classic|modern|dark` (default `classic`), `--direction DOWN|RIGHT`, `--routing
SPLINES|ORTHOGONAL|POLYLINE`, `--no-priorities`. Only SVG is supported (no PNG: there is no pure JavaScript
rasterizer; convert with e.g. `rsvg-convert` or a browser if needed). Models with syntax errors are skipped
(exit code 1), validation errors are printed but the model is rendered.

Text is measured with a built-in table of the Helvetica character widths (Helvetica, Arial and Liberation Sans
are metric compatible) and a monospace width for the definition section, so the layout computed in Node.js is
close to the one of the editor, which measures with the browser's fonts: for the examples, text widths differ
by 1.5 % on average (at most 2 px) from Chromium with Liberation Sans, the widths of the state boxes by 0.1 %
(at most 1 px). Fonts with other metrics (e.g. *Helvetica Neue* on macOS) make the text slightly wider or
narrower than the boxes.

From code (works in the browser as well):

```ts
import { HsmModelLoader, layoutStateMachine, renderSvg } from 'devm-language';

const { model } = await new HsmModelLoader().load(text);
const layout = await layoutStateMachine(model, { direction: 'DOWN' });
const svg = renderSvg(layout.graph, {
    theme: 'classic',                        // 'classic' | 'modern' | 'dark'
    title: 'CdPlayer – test coverage',       // optional heading above the diagram
    highlight: new Map([                     // diagram element id -> highlight
        [layout.ids.get(playingState)!, 'covered'],       // CSS class devm-covered (green)
        [layout.ids.get(ejectTransition)!, 'uncovered'],  // CSS class devm-uncovered (red, dashed)
        [layout.ids.get(pausedState)!, 'active']          // CSS class active (like the simulation)
    ]),                                      // any other value is used as CSS class name(s)
    legend: true,                            // legend of the used highlights (or [{ kind, label }])
    embedStyles: true,                       // false: the page embedding the SVG provides DIAGRAM_CSS
    xmlDeclaration: true                     // false for inlining into HTML
});
```

`highlight` applies to states, pseudo states (`<g class="devm-node …">`) and transitions (`<g class="transition …">`);
the ids are those of `LayoutResult.ids` (AST node → id) and `LayoutResult.elements` (id → AST node). The
classes `devm-covered` and `devm-uncovered` are defined in `DIAGRAM_CSS` for all themes.

## Model documentation

`devm doc` generates a documentation page per state machine and an index page:

```bash
devm doc examples -o docs/examples                 # Markdown (GitHub flavored) + one SVG per machine
devm doc 'models/**/*.devm' -o site --format html   # self-contained HTML pages (inline SVG and styles)
```

Each page contains the description and doc comment of the state machine, the diagram, the execution semantics
(cycle based with period / event driven, parent first / child first, annotations), per interface (and the
internal scope) tables of the events (direction, type), variables and constants (type, initial value, `readonly`)
and operations (signature, return type), a table of all states and pseudo states (qualified name, kind,
description, entry / exit actions, other local reactions, sub states per region) and of all transitions
(source, target, trigger, guard, effect, priority, entry / exit point). Options: `--format md|html`, `--title`
of the index page and the diagram options of `devm render`. `npm run docs:examples` regenerates
[`docs/examples`](examples/index.md).

**Doc comments**: a `/** … */` comment directly before the state machine, an interface, a declaration, a
state, a pseudo state or a transition documents it (Markdown, JSDoc tags like `@see` are allowed). Plain
comments (`/* … */`, `// …`) are ignored.

```
/** Push button of the pedestrian crossing. */
interface Pedestrian:
    /** A pedestrian has pressed the button and waits for red. */
    var waiting : boolean = false
```

The language server shows the doc comments on hover together with the signature of the element
(`HsmDocumentationProvider`). From code: `describeStateMachine(model)` returns the collected information,
`generateModelDoc(model, { format, svg, svgFile })` and `generateDocIndex(entries, format)` render it,
`docComment(node)` returns the doc comment of an AST node.
