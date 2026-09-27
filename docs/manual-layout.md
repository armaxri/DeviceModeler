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
files at once (or a `.hsm.layout` alone, which is applied to the current model). The VS Code extension
reads and writes the `.hsm.layout` file next to the model in the workspace (see
[VS Code extension](#vs-code-extension)). The CLI uses the
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

Diagram operations go through a `TrackingModelEditor` (`packages/web/src/diagram/manual-layout-support.ts`,
used by the shared `DiagramController`, so web app and VS Code webview behave the same), which records how ids change:
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

The automatic layout is cached by the diagram controller, so dragging only re-runs the (synchronous,
cheap) manual step.

## Diagram editor (web app and VS Code)

The logic lives in the shared `DiagramController` (`packages/web/src/diagram-controller.ts`): layout
state, *Auto | Manual*, *Auto-arrange*, *Reset*, dragging, re-parenting, resize handles, bend points,
labels, key tracking and the layout undo history. The host (`DiagramHost`) only persists the layout
(`layoutChanged`), provides a key of the text state for the undo history (`textStateKey`, default: a
hash of the text) and reports text changes with `DiagramController.textChanged('edit' | 'undo' | 'redo')`;
it sets the layout of an opened model with `loadLayout`. The toolbar buttons (`#btn-layout-auto`,
`#btn-layout-manual`, `#btn-arrange`, `#btn-reset-layout`) are bound by the controller if present.

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
  edits in the order they were made. Layout changes are stored with a key of the text state (web app:
  the `alternativeVersionId` of the Monaco model; VS Code: a hash of the text); a layout change is
  undone first if the text is still in the state it had then, and layout changes caused by a text edit
  are undone together with it (also with `Ctrl+Z` in the text editor). The history is not persisted.
- The simulation shows the same (manual) layout.

## VS Code extension

The extension of this branch is packaged as `hsm-vscode-0.1.0-manual-layout.vsix` (display name
*HSM Modeler (manual layout)*). It has the same extension id as the build of the main branch, so only
one of them can be installed at a time (uninstall the other one first, or install with `--force`).

- **Toolbar and commands:** the diagram webview shows *Positions: Auto | Manual*, *Auto-arrange* and
  *Reset* like the web app; the same actions are commands (**HSM: Diagram Positions: Manual
  (experimental)**, **HSM: Diagram Positions: Automatic**, **HSM: Auto-arrange Diagram (keep as manual
  layout)**, **HSM: Reset Manual Diagram Layout**) in the command palette and in the *…* menu of the
  diagram panel.
- **File handling** (`src/extension/logic/layout-file.ts`, `LayoutFileSync`): when the diagram is
  opened, the extension reads `<model>.hsm.layout` and sends it to the webview before the first text,
  so the first diagram already uses it. Layout changes in the webview are sent to the extension
  (serialized, with the mode) and written after 300 ms without further changes: a layout in the manual
  mode is always written; in the automatic mode only if the file exists already (the manual layout is
  kept for later), so merely opening or looking at a diagram never creates a file; *Reset* deletes the
  file. Unchanged content is not rewritten. A file system watcher reports changes by other tools (git
  checkout, another editor, the CLI); they are applied to the diagram unless they are our own writes.
  When a model is renamed or moved in VS Code, a pending change is written first and the layout file is
  moved along (not if the layout file was renamed in the same operation or the target exists).
  Untitled models keep their layout in the webview only.
- **Undo:** the text belongs to the VS Code document – diagram edits are `WorkspaceEdit`s, undone with
  VS Code's undo (in the text editor, or `Ctrl+Z` in the diagram, which runs VS Code's *Undo* on the
  document). Layout-only changes are kept in the undo history of the webview: `Ctrl+Z` / `Ctrl+Y` with
  the diagram focused undo them if the text has not been changed since, otherwise the text is undone.
  The extension sends text changes caused by *Undo* / *Redo* immediately and marked as such
  (`TextDocumentChangeReason`), so layout changes of diagram edits (renamed / moved / deleted keys,
  the drop position of a re-parented state) follow the text – also when the undo is triggered in the
  text editor. Layout changes do not make the model dirty; the layout file is written independently of
  saving the model.
- **Import and export:** **HSM: Import itemis CREATE Model** writes `<model>.hsm.layout` with the
  arrangement of the itemis diagram next to the imported model (an old layout file is removed if the
  `.sct` file has no diagram). **HSM: Export Diagram as SVG** applies a manual layout (mode `manual`).

Limitations in VS Code: the layout file is written even if the model has unsaved changes (keys of
renamed states then refer to the unsaved text; *Revert File* does not revert the layout); a hash of
the text identifies text states for the layout undo, so a layout change can become undoable again when
the text returns to exactly the same content in another way; no tests in a real VS Code instance (the
webview bundle was checked in Chromium with a mocked VS Code API, the panel's file handling with a
`vscode` mock).

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
