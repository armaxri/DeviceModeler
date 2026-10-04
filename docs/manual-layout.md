# Manual layout (experimental)

Status: merged into main (PR #4) from the experiment branch `claude/layout-annotations` (based on
`claude/manual-layout`, which stored the layout in a sidecar file `<model>.layout`). The automatic layout (ELK) stays the default:
a model without layout annotations is exactly the diagram computed by `layoutStateMachine`.

This note describes how hand-arranged diagrams are stored and computed, and the trade-offs behind the
design, so the experiment can be evaluated (and removed again) easily. The structure diagrams of `.devm`
files are arranged with the same concept and syntax, see [Structure diagrams](#structure-diagrams);
the parts both share are in `packages/language/src/diagram/layout-core/` (see
[Architecture](architecture.md#manual-layout-shared-core)).

## Where the layout lives

**Decision:** in **layout annotations** in the `.devm` text. A model with at least one layout annotation
has a manual layout, a model without has the automatic one – there is no separate mode switch.

| Option | Pro | Contra |
| --- | --- | --- |
| Annotations in the text (chosen) | one file; renames (also typed in the text or via *Rename Symbol*) keep the layout, because the annotation belongs to the element; layout changes are text edits: one undo history, dirty marker and *Save* as for any other change; travels with the model through git, copy & paste, the web app | coordinates in the text and in diffs / reviews; rearranging the same diagram in two branches gives merge conflicts in the model; every drag changes the model text |
| Sidecar file `<model>.layout` (previous experiment) | the text stays free of layout information | two files to keep together; renames in the text lose the position; a second undo history and file synchronization in the editors |
| Separate section at the end of the text | one file | still noise in the text, fragile when editing by hand, keys by name like the sidecar |

Compatibility: models with layout annotations cannot be opened by builds from before the merge (their
grammar does not accept annotations in front of states and transitions). Generated code does not depend on the annotations (`devm generate --check` stays stable when
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

`layoutTextEdits(machine, text, layout)` computes (with the shared `annotationSlotEdits` of layout-core)
the minimal text edits that make the annotations of a model equal to a layout (`undefined` removes all layout annotations; other annotations are kept):
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
   setting of the web app and `devm.diagram.edgeRouting` in VS Code): *orthogonal* as it is, *polyline*
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
  *Auto-arrange* writes the automatic layout as annotations, *Automatic layout* removes all layout
  annotations (it does not restore an earlier arrangement – that is undo).
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

- **Toolbar and commands:** the diagram webview shows *Auto-arrange* and *Automatic layout* like the web app; the
  same actions are the commands **Device Modeler: Auto-arrange Diagram** and **Device Modeler: Use Automatic Diagram Layout** (command
  palette and the *…* menu of the diagram panel).
  **Device Modeler: Convert Layout File to Annotations** writes an old `<model>.devm.layout` into the model.
- The layout is part of the document: diagram edits and layout changes are `WorkspaceEdit`s, undone
  with VS Code's undo, they make the model dirty and are saved with it. The extension no longer reads,
  writes or watches `.devm.layout` files.
- **Import and export:** **Device Modeler: Import itemis CREATE Model** writes the arrangement of the itemis
  diagram as layout annotations into the imported model; **Device Modeler: Export Diagram…** (SVG / PNG) applies them.

Limitation: no tests in a real VS Code instance (the webview bundle is checked in Chromium with a
mocked VS Code API, the extension code with a `vscode` mock).

## Command line

`devm layout`, `devm render`, `devm doc` and the coverage diagrams of `devm test` use the layout annotations
(`--auto` ignores them for `layout`, `render` and `doc`); `devm render` also those of structure files. `devm import model.sct` writes the itemis
diagram as annotations (`--no-layout` to skip them).

## Migration from sidecar layout files

`devm migrate-layout model.devm [--layout <file>]` reads the layout file of the previous experiment
(default `model.devm.layout`; files of that experiment named after the formerly used extension
`.hsm`, e.g. `model.hsm.layout`, are passed with `--layout`) and writes it into the model as layout annotations (the keys are the same
diagram ids: qualified names, `<state>#region<n>`, `<container>#initial` / `#final`, `#definitions`,
`<source>-><target>~<n>`). The layout file is kept; delete it once the model looks right.
In VS Code, **Device Modeler: Convert Layout File to Annotations** does the same for the model of the active editor.

## Import from itemis CREATE

`importSct(xml)` writes the diagram (`notation:Diagram`) into the generated text as layout annotations
(option `layout: false` to skip them; the result still contains the `layout`): the bounds become
positions (itemis positions are relative to the compartment of their region; the Device Modeler positions are
offset by the padding of the container, the layout engine moves the content below the state's name),
explicit state sizes become `@size`, `isHorizontal` of a state becomes `@regions`, the bounds of several
top-level regions define the generated `Main` state and its regions, and GMF relative bend points of
transitions between vertices of the same container become `@via` waypoints. Since the states of the Device Modeler are
usually wider than in itemis (the text is not wrapped at the itemis width), overlapping states are
pushed apart; the relative arrangement is kept.

## Structure diagrams

The internal block diagrams of structure files are arranged by hand the same way: layout annotations in
the `.devm` text, no mode switch (a diagram with at least one layout annotation is arranged by hand),
applied on top of the automatic ELK layout, the same editor gestures, *Auto-arrange* / *Automatic layout*,
undo of the text.

```
@at(720, 16)                                    // a type box (struct) of the file
struct LightLevel { brightness : integer }

@at(112, 16) @port(on, left, 155)               // the frame and the place of its boundary port on
subsystem CourtesyLight {
    in async on
    @priority(1) @period(20 ms) @at(41, 48) @size(500, 196)
    thread LightTask {
        @at(26, 52) dimmer : Dimmer
        @at(330, 96) @port(level, top, 40) led : LedDriver
    }
    @via(300, 120) connect dimmer.level -> led.level
    delegate on -> dimmer.on
}
```

| Annotation | Written before | Meaning |
| --- | --- | --- |
| `@at(x, y)` | `system` / `subsystem` (the frame), `thread`, an instance, `component` (its block in the overview of the component types), `struct` (type box) | position relative to the parent node (the frame or a thread; the canvas for the frame, blocks and type boxes) |
| `@size(width, height)` | the same | explicit (minimum) size, only if the user resized the node – a node never becomes smaller than its content |
| `@port(name, side, offset)` | an instance (the ports of its type), `system` / `subsystem` (its boundary ports) | the side of the port (`left`, `right`, `top`, `bottom`) and the offset of its center along the side, from the top / left corner (optional) |
| `@via(x1, y1, …)` | `connect`, `delegate` | waypoints relative to the connector's frame (the innermost node containing the nodes of both ports: a thread for a connector within a thread, otherwise the frame) |

- The annotations belong to the element they are written before (in the grammar they are part of the
  element), so they move, are deleted and renamed with it. They are checked by the validator (the known
  annotations of structure files, `STRUCTURE_ANNOTATIONS`): misplaced or unknown annotations are warnings,
  wrong arguments and duplicates errors, `@port` of a port the type does not have is a warning. Renaming a
  port in the diagram updates the `@port` annotations of the instances of its type.
- Only the annotations of the elements of the shown diagram are read and written: every subsystem / system
  of a file has its own diagram. The structs of a file are shown in every diagram of the
  file (and blocks in the overview of the component types): they have one position for all of them.
- As written by the layout writer and the formatter, the annotations of the frame, threads, components
  and types stand on the line before them, those of instances, ports, connections and delegations in front
  of them on the same line (formatter-stable).
- **Ports**: a port without `@port` keeps the side and offset of the automatic layout (which puts each
  port on the side facing its partners); ports of a side keep a minimum distance (later ones are pushed
  along the side), the node grows if they do not fit. The labels of ports on the top / bottom side of an
  instance are outside of it, right of the port; connectors leave a port perpendicular to its side.
- **Computation** (`applyIbdManualLayout`, ibd-manual-layout.ts; `layoutStructure` applies the annotations
  unless `layout: null`): bottom-up like the state machines – the shared `placeChildren` for the frame,
  threads and canvas, threads and the frame grow to fit their content (their stored size is the minimum);
  a connector keeps the route of the automatic layout while both its ports and their nodes are arranged like
  in the automatic layout (relative to its frame) and no moved node lies on the route, other connectors and
  connectors with waypoints are routed orthogonally around the instances (the shared router; threads are
  crossed). A captured automatic layout reproduces the automatic layout exactly. The automatic layout is
  reused while only the layout annotations change (dragging re-runs only the manual step).
- **Layout settings**: structure diagrams are always laid out from left to right with orthogonal
  connectors, so the *Layout* direction and *Edges* settings do not apply to them (they are disabled for
  `.devm` files); *Auto-arrange* and *Automatic layout* do.

Editing (web app and VS Code, `StructureDiagram` with the shared `LayoutEditor` and mouse listener):

- Drag the frame, a thread, an instance, a block or a type box to move it (the selection moves together;
  the content of a thread or the frame moves with it). The connectors attached to moved nodes follow as
  orthogonal lines while dragging and are routed on drop. The first drag in an automatically laid out
  diagram writes the positions of all nodes (nothing jumps).
- Dropping an instance onto another thread still moves it into that thread (the model changes, with the
  rules of the structure language: an instance of a component is refused on the frame, an instance of a
  subsystem in a thread); in a manual layout it keeps the drop position (`@at` relative to the new thread),
  written together with the move as one undoable edit.
- A selected node shows a resize handle at its bottom right corner (`@size`).
- Drag a port of an instance or a boundary port along the border of its node: it snaps to the nearest side
  (`@port`); its connectors follow while dragging.
- A selected connector shows its waypoints: drag them, double-click the connector to add one, double-click
  a waypoint to remove it (`@via`).
- *Auto-arrange* writes the automatic layout of the diagram as annotations, *Automatic layout* removes the
  layout annotations of the diagram (other annotations such as `@priority` stay).
- `devm render` and the SVG / PNG export (web app and VS Code) use the annotations (`devm render --auto`
  ignores them).

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
- Structure diagrams: the type boxes of a file share one position in all diagrams of the file; deleting a
  port in a component type leaves `@port` annotations of other files until their diagram is arranged again
  (they are reported and ignored); the labels of ports are not obstacles of the connector routes.
