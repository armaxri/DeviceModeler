# Manual layout (experimental)

Status: 🧪 experiment on the branch `claude/manual-layout`. The automatic layout (ELK) stays the
default and is not affected: without a layout file, or with the layout mode `auto`, the diagram is
exactly the one computed by `layoutStateMachine`.

This note describes how hand-arranged diagrams are stored and computed, and the trade-offs behind the
design, so the experiment can be evaluated (and removed again) easily.

## Where the layout lives

**Decision:** in a sidecar file `<model>.hsm.layout` (JSON), not in the `.hsm` text.

| Option | Pro | Contra |
| --- | --- | --- |
| Sidecar file (chosen) | the text stays free of layout noise; layout diffs do not disturb model reviews; tools that only need the model ignore it | two files to keep together; renames in a plain text editor do not update the layout |
| Annotations in the text (`@pos(10, 20)`) | one file, travels with the model | noisy text, every drag changes the model, merge conflicts in the model, the grammar and formatter would need to know about it |
| Separate section at the end of the text | one file | still noise in the text, fragile when editing by hand |

In the web editor the layout is kept per file name in the local storage (`hsm-modeler.layout:<file>`).
*Save* downloads the model and, if a layout exists, the `.hsm.layout` file; *Open…* accepts both
files at once (or a `.hsm.layout` alone, which is applied to the current model). The CLI uses the
`.hsm.layout` next to the model (`hsm layout model.hsm`, `--layout <file>`, `--auto`), and
`hsm import model.sct` writes `model.hsm.layout` from the itemis diagram (`--no-layout` to skip it).

### Format

```json
{
  "version": 1,
  "mode": "manual",
  "direction": "DOWN",
  "nodes": {
    "#definitions": { "x": 20, "y": 20 },
    "#machine#initial": { "x": 330, "y": 24 },
    "Closed": { "x": 300, "y": 80, "width": 420, "height": 380 },
    "Closed.Active": { "x": 14, "y": 120 },
    "Active": { "x": 40, "y": 500, "regions": "horizontal" },
    "Active#region1": { "x": 0, "y": 26, "width": 300, "height": 120 }
  },
  "edges": {
    "Closed.Stopped->Closed.HasDisc": { "bends": [{ "x": 120, "y": 60 }], "label": { "x": 10, "y": -4 } }
  }
}
```

- **Identity keys** are the diagram ids, which are derived from the model and stable while other
  elements are added or removed: vertices use their qualified name (`Closed.Active.Playing`), regions
  `<state>#region<n>`, initial / final pseudo states `<container>#initial` / `#final`
  (`#machine#initial` on the top level), the definition box `#definitions`, transitions
  `<source>-><target>` plus `~<n>` for the n-th duplicate of the same pair.
- **Nodes:** `x`, `y` relative to the parent node (composite state or region). `width` / `height` only
  if the user resized the state (or the size was imported); they are minimum sizes, a state never
  becomes smaller than its text or content. `regions` stores whether the regions of a state are
  stacked vertically or placed side by side (default: by layout direction).
- **Edges:** `bends` relative to the edge's *frame* node (the innermost node containing both end
  points, so bend points move with a composite state), `label` is an offset from the computed label
  position.
- Keys are sorted and numbers rounded to one decimal, so the file produces small, stable diffs.

### Keeping keys in sync

Diagram operations go through a `TrackingModelEditor` (web app), which records how ids change:
renaming a vertex renames its key and all keys inside it (sub states, regions, `#initial`, transitions);
moving a vertex into another state renames the keys to the new qualified name and stores the drop
position relative to the new parent; deleting removes the keys (regions after a deleted region are
renumbered); reconnecting a transition drops its bend points. The layout change is recorded together
with the text edit and undone / redone with it.

Not tracked: edits in the text editor (including *Rename symbol* of the language service). A renamed
state then loses its position and is placed automatically near its old neighbours; unused keys stay
in the file until the next change in the diagram, which writes only existing elements.

## Layout computation

`applyManualLayout(auto, layout)` (`packages/language/src/diagram/manual-layout.ts`) runs on top of the
automatic layout, which is always computed first:

1. **Nodes, bottom-up.** Leaves keep the size of their text (or the larger stored size). The children
   of a container are placed next: pinned nodes (with a key) at their stored position; if they would
   overlap the name / body compartment of their state, the whole content is shifted down (this
   happens when an entry action is added, or for imported diagrams); pinned nodes that overlap each
   other (a state became wider, or the layout comes from a tool with other fonts) are pushed right or
   down. Nodes without a key are placed at their position in the automatic layout, translated like
   their nearest pinned sibling, and moved to the nearest free spot if that position is taken.
   Composite states grow to fit their content; regions are stacked in their state and fill it.
2. **Edges, per frame node.** A transition keeps the route of the automatic layout (spline /
   orthogonal) as long as both end points are arranged like in the automatic layout (same size, same
   displacement relative to the frame), so moving a composite state keeps its inner routes. Otherwise
   it is a polyline from the border of the source through the stored bend points to the border of the
   target (border intersection for rectangles, circles and diamonds). Transitions between a composite
   state and its content start at the nearest border of the state, self transitions become a small
   loop, parallel transitions get a symmetric bend so they do not coincide. Labels sit at the middle of
   the route (plus the stored offset).
3. The result contains the **effective layout** (all nodes pinned at their computed positions). Every
   change in the diagram starts from it, so new elements become pinned once the user touches the
   layout, and shifts / pushes are materialized.

The automatic layout is cached in the web app, so dragging only re-runs the (synchronous, cheap)
manual step.

## Web editor

- Toolbar *Positions: Auto | Manual*. Switching to *Manual* the first time pins the current automatic
  layout, so nothing jumps. *Auto* keeps the manual layout for later; *Reset* discards it;
  *Auto-arrange* re-runs ELK and stores the result as the new manual layout.
- Drag a vertex (also initial / final states and the definition box) to move it; the transitions
  attached to it follow as straight lines while dragging and are routed on drop. Positions are kept
  inside the parent's content area; the parent grows.
- **Shift + drop** moves the state into the state / region below the mouse (the automatic mode keeps
  plain drag and drop for this). Shift was chosen because Alt + drag is taken by several window
  managers and a "dropped completely inside" rule is ambiguous for large states.
- A selected state shows a resize handle at its bottom right corner.
- A selected transition shows its bend points: drag them; double-click the line to add one,
  double-click a bend point to remove it; drag the label of a selected transition to move it.
- Undo: `Ctrl+Z` / `Ctrl+Y` in the diagram (and the toolbar buttons) undo layout changes and text
  edits in the order they were made. Layout changes are stored with the text's
  `alternativeVersionId`; a layout change is undone first if the text is still in the state it had
  then, and layout changes caused by a text edit are undone together with it (also with `Ctrl+Z` in
  the text editor). The history is not persisted.
- The simulation shows the same (manual) layout.

## Import from itemis CREATE

`importSct(xml)` returns `{ text, warnings, layout }`: the bounds of the notation model
(`notation:Diagram`) become node positions (itemis positions are relative to the compartment of their
region; the HSM positions are offset by the padding of the container, the layout engine moves the
content below the state's name), explicit state sizes become minimum sizes, `isHorizontal` of a state
becomes the region orientation, the bounds of several top-level regions define the generated `Main`
state and its regions, and GMF relative bend points of transitions between vertices of the same
container become bend points. Since HSM states are usually wider than in itemis (the text is not
wrapped at the itemis width), overlapping states are pushed apart; the relative arrangement is kept.

## Limitations and risks

- Straight edges do not avoid obstacles; long transitions may cross states. The user can add bend
  points, or use *Auto-arrange*.
- Text edits outside the diagram do not update keys (see above).
- No alignment guides, snapping, multi-select resize or region resizing; routing of new edges is
  always a polyline (the *Edges* setting applies to routes of the automatic layout only).
- The layout file is a second artifact that can get out of sync with the model (e.g. edited by
  another tool); unknown keys are ignored, missing ones are placed automatically.
