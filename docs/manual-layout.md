# Manual layout (experimental)

Status: 🧪 experiment on the branch `claude/layout-annotations` (based on `claude/manual-layout`, which
stored the layout in a sidecar file `<model>.hsm.layout`). The automatic layout (ELK) stays the default:
a model without layout annotations is exactly the diagram computed by `layoutStateMachine`.

This note describes how hand-arranged diagrams are stored and computed, and the trade-offs behind the
design, so the experiment can be evaluated (and removed again) easily.

## Where the layout lives

**Decision:** in **layout annotations** in the `.hsm` text. A model with at least one layout annotation
has a manual layout, a model without has the automatic one – there is no separate mode switch.

| Option | Pro | Contra |
| --- | --- | --- |
| Annotations in the text (chosen) | one file; renames (also typed in the text or via *Rename Symbol*) keep the layout, because the annotation belongs to the element; layout changes are text edits: one undo history, dirty marker and *Save* as for any other change; travels with the model through git, copy & paste, the web app | coordinates in the text and in diffs / reviews; rearranging the same diagram in two branches gives merge conflicts in the model; every drag changes the model text |
| Sidecar file `<model>.hsm.layout` (previous experiment) | the text stays free of layout information | two files to keep together; renames in the text lose the position; a second undo history and file synchronization in the editors |
| Separate section at the end of the text | one file | still noise in the text, fragile when editing by hand, keys by name like the sidecar |

Compatibility: models with layout annotations cannot be opened by builds of the main branch (the
grammar there does not accept annotations in front of states and transitions) until the experiment
is merged. Generated code does not depend on the annotations (`hsm generate --check` stays stable when
only the layout changes).

### Syntax

```
statemachine CdPlayer {
    interface:
        in event play
    @definitions(20, 20)                    // position (and optionally width, height) of the definition box
    @initial(330, 24)                       // the initial state [*] of the state machine
    [*] -> Closed

    @at(300, 80) @size(420, 380)
    state Closed {
        @initial(60, 10) @final(200, 300)   // the [*] states of Closed
        [*] -> Stopped
        @at(14, 40)
        state Stopped
        @at(14, 120)
        choice HasDisc
        @via(120, 60) @label(10, -4)
        Stopped -> HasDisc : play
    }
    @at(40, 500) @regions("horizontal")
    state Active {
        @size(300, 120)
        region {
            ...
        }
    }
}
```

| Annotation | Written before / in | Meaning |
| --- | --- | --- |
| `@at(x, y)` | state, pseudo state, region | position relative to the content area of the parent (composite state or region; the canvas on the top level) |
| `@size(width, height)` | state, region | explicit (minimum) size, only if the user resized it – a state never becomes smaller than its text or content |
| `@regions("vertical" \| "horizontal")` | state | whether the regions are stacked or side by side (default: by layout direction) |
| `@via(x1, y1, x2, y2, …)` | transition | waypoints, relative to the transition's *frame* (the innermost node containing both end points, so waypoints move with a composite state) |
| `@label(dx, dy)` | transition | offset of the label from its computed position |
| `@initial(x, y)`, `@final(x, y)` | in the body of the state machine, a state or a region | position of the implicit `[*]` initial / final state of that container |
| `@definitions(x, y[, width, height])` | in the body of the state machine | position (and size) of the definition box |

- **Element annotations** (`@at`, `@size`, `@regions`, `@via`, `@label`) belong to the state, pseudo
  state, region or transition that follows them; only other annotations may come in between.
  **Container annotations** (`@initial`, `@final`, `@definitions`) belong to the body they are written
  in. Annotations are members of the bodies in the grammar, so there is no ambiguity with the
  annotations of the state machine (`@CycleBased`, …) – those, and the definition section, must come
  before the states and transitions (validation).
- Numbers are written as integers (rounded); the reader also accepts reals and a sign. The validator
  checks the element an annotation belongs to, the number and kind of arguments and duplicates.
  `@size` / `@regions` of a state without `@at` are ignored.
- The annotations belong to the transition itself, so duplicates between the same vertices
  (`A -> B : e1`, `A -> B : e2`) keep their own waypoints.

### Writing the annotations

`layoutTextEdits(machine, text, layout)` computes the minimal text edits that make the annotations of
a model equal to a layout (`undefined` removes all layout annotations; other annotations are kept):
values are updated in place, new annotations are added on a line before the element (with its
indentation) or appended to an existing annotation line of the element, removed annotations take their
line with them if it becomes empty. Applying the same layout again yields no edits. Structural diagram
edits (`ModelEditor`) delete and move elements together with their element annotations; a renamed
element keeps them. A vertex moved into another state keeps its `@at` (relative to the old parent);
the diagram editor writes the drop position relative to the new parent in a second step, computed on
the re-parsed text.

## Layout computation

`layoutFromModel(machine)` (`packages/language/src/diagram/layout-annotations.ts`) collects the layout
annotations into a `ManualLayout` (undefined: no annotations, automatic layout).
`applyManualLayout(auto, layout)` (`packages/language/src/diagram/manual-layout.ts`) runs on top of the
automatic layout, which is always computed first:

1. **Nodes, bottom-up.** Leaves keep the size of their text (or the larger stored size). The children
   of a container are placed next: pinned nodes (with a key) at their stored position; if they would
   overlap the name / body compartment of their state, the whole content is shifted down (this
   happens when an entry action is added, or for imported diagrams); pinned nodes that overlap each
   other (a state became wider, or the layout comes from a tool with other fonts) are pushed right or
   down. Nodes without `@at` are placed at their position in the automatic layout, translated like
   their nearest pinned sibling, and moved to the nearest free spot if that position is taken.
   Composite states grow to fit their content; regions are stacked in their state and fill it.
2. **Edges, per frame node.** A transition keeps the route of the automatic layout (spline /
   orthogonal) as long as both end points are arranged like in the automatic layout (same size, same
   displacement relative to the frame) and no moved vertex lies on the route, so moving a composite
   state keeps its inner routes. All other transitions, and all transitions with stored bend points, are
   **rerouted around the vertices** of their frame
   (`orthogonal-router.ts`): an orthogonal path with few bends on a sparse grid along the inflated
   borders of the vertices and the channels between them; the states containing an end point are
   entered, not run along; running on top of routes placed before is penalized; several ends at the
   same side of a state are spread along the side, and vertices aligned with each other get a straight
   line. Stored bend points are **waypoints**: the route is computed part by part from the source
   through each waypoint to the target (it does not turn back at a waypoint; a waypoint inside a
   state lets the route cross that state; the ends of such routes are not spread). The path is then
   shaped like the **edge routing setting** (`routing` option, the *Edges*
   setting of the web app and `hsm.diagram.edgeRouting` in VS Code): *orthogonal* as it is, *polyline*
   with the corners removed where the shortcut keeps clear of the vertices (but not the waypoints),
   *splines* as a smooth curve through the corners of that polyline which leaves and enters the states perpendicular to their sides
   (like the splines of the automatic layout; flatter, or with only the corners rounded, where a round
   curve would touch a vertex). Their labels are placed
   next to a long segment where they cover no vertex, label or route.
   Transitions between a composite state and its content start at the nearest border of the state
   (with waypoints: straight lines through them), self
   transitions become a small loop (and a transition for which no orthogonal route exists becomes a
   straight line). The stored label offset is added to the computed label position.
3. The result contains the **effective layout** (all nodes pinned at their computed positions). Every
   change in the diagram starts from it and writes it back as annotations, so new elements get an `@at`
   once the user touches the layout, and shifts / pushes are materialized.

The automatic layout is cached by the diagram controller, so dragging only re-runs the (synchronous,
cheap) manual step.

## Diagram editor (web app and VS Code)

The logic lives in the shared `DiagramController` (`packages/web/src/diagram-controller.ts`). It reads
the layout of every parsed model with `layoutFromModel` and turns every layout change into text edits
(`layoutTextEdits`), which the host applies like any other diagram edit (`DiagramHost.applyTextEdits`).

- No *Auto | Manual* toggle: the diagram is manual as soon as the model has a layout annotation.
  The toolbar shows *Positions: automatic* / *stored in model*. *Store positions* (automatic) /
  *Re-arrange* (stored) writes the automatic layout as annotations, *Clear positions* removes all layout
  annotations (it does not restore an earlier arrangement – that is undo). Names, tooltips and status
  messages are defined once in `packages/web/src/layout-actions.ts` (web app and VS Code webview).
  The first drag in an automatic diagram writes the annotations of all elements (the current automatic
  layout plus the move), so nothing jumps.
- Drag a vertex (also initial / final states and the definition box) to move it; the transitions
  attached to it follow as straight lines (through their waypoints) while dragging or resizing and are
  routed on drop. Positions are kept inside the parent's content area; the parent grows.
- **Shift + drop** moves the state into the state / region below the mouse; a plain drop only moves
  it. Shift was chosen because Alt + drag is taken by several window managers and a "dropped
  completely inside" rule is ambiguous for large states.
- A selected state shows a resize handle at its bottom right corner.
- A selected transition shows its waypoints: drag them; double-click the line to add one (it is
  inserted between the waypoints of the clicked part of the route), double-click a waypoint to remove
  it (without waypoints the transition is routed automatically again); drag the label of a selected
  transition to move it.
- **Undo** is the undo of the text: layout changes are text edits, so `Ctrl+Z` / `Ctrl+Y` (in the text
  editor or the diagram) undo them in order with all other edits, they mark the document as modified
  and are saved with it.
- The simulation shows the same (manual) layout.

## VS Code extension

The extension of this branch is packaged as `hsm-vscode-0.1.0-manual-layout.vsix` (display name
*HSM Modeler (manual layout)*). It has the same extension id as the build of the main branch, so only
one of them can be installed at a time (uninstall the other one first, or install with `--force`).

- **Toolbar and commands:** the diagram webview shows *Positions: …*, *Store positions* / *Re-arrange* and
  *Clear positions* like the web app; the same actions are the commands **HSM: Re-arrange Diagram and Store
  Positions in Model** and **HSM: Clear Stored Diagram Positions (Remove Layout Annotations)** (command
  palette and the *…* menu of the diagram panel).
  **HSM: Convert Layout File to Annotations** writes an old `<model>.hsm.layout` into the model.
- The layout is part of the document: diagram edits and layout changes are `WorkspaceEdit`s, undone
  with VS Code's undo, they make the model dirty and are saved with it. The extension no longer reads,
  writes or watches `.hsm.layout` files.
- **Import and export:** **HSM: Import itemis CREATE Model** writes the arrangement of the itemis
  diagram as layout annotations into the imported model; **HSM: Export Diagram…** (SVG / PNG) applies them.

Limitation: no tests in a real VS Code instance (the webview bundle is checked in Chromium with a
mocked VS Code API, the extension code with a `vscode` mock).

## Command line

`hsm layout`, `hsm render`, `hsm doc` and the coverage diagrams of `hsm test` use the layout annotations
(`--auto` ignores them for `layout`, `render` and `doc`). `hsm import model.sct` writes the itemis
diagram as annotations (`--no-layout` to skip them).

## Migration from `.hsm.layout`

`hsm migrate-layout model.hsm [--layout <file>]` reads the layout file of the previous experiment
(default `model.hsm.layout`) and writes it into the model as layout annotations (the keys are the same
diagram ids: qualified names, `<state>#region<n>`, `<container>#initial` / `#final`, `#definitions`,
`<source>-><target>~<n>`). The layout file is kept; delete it once the model looks right.
In VS Code, **HSM: Convert Layout File to Annotations** does the same for the model of the active editor.

## Import from itemis CREATE

`importSct(xml)` writes the diagram (`notation:Diagram`) into the generated text as layout annotations
(option `layout: false` to skip them; the result still contains the `layout`): the bounds become
positions (itemis positions are relative to the compartment of their region; the HSM positions are
offset by the padding of the container, the layout engine moves the content below the state's name),
explicit state sizes become `@size`, `isHorizontal` of a state becomes `@regions`, the bounds of several
top-level regions define the generated `Main` state and its regions, and GMF relative bend points of
transitions between vertices of the same container become `@via` waypoints. Since HSM states are
usually wider than in itemis (the text is not wrapped at the itemis width), overlapping states are
pushed apart; the relative arrangement is kept.

## Limitations and risks

- Coordinate noise: every drag changes the model; reviews and merges see the numbers.
- Models with layout annotations need a build of this branch (see *Compatibility* above).
- A waypoint inside a state lets the route cross that state. If no route through the waypoints is
  found (e.g. a waypoint very close to a state), straight lines through them are drawn.
- The formatter puts container annotations (and `@CycleBased`) each on a line of their own, while the
  layout writer appends to an existing annotation line: formatting can change the annotation lines
  (not the layout).
- A container annotation whose element disappears (e.g. `@initial` after the initial transition was
  deleted in the text) stays until the next layout change in the diagram removes it; it is ignored.
- No alignment guides, snapping, multi-select resize or region resizing.
