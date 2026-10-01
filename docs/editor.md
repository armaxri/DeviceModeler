# Web editor

The web app (`npm run dev`, `packages/web`) edits the text and the diagram side by side; the VS Code extension embeds the same diagram editor ([VS Code extension](vscode.md)).

## Editing in the diagram

| Action | How |
| --- | --- |
| Add a state | *State* tool (`S`), then click on the canvas, a state or a region – or double-click the canvas |
| Add a sub state | *State* tool, click on the parent state (a simple state becomes composite) |
| Add a region | *Region* tool (`R`), click on a state – existing sub states are moved into the first region |
| Add choice / junction / history | `C` / `J` / `H` / `D`, then click on the target container |
| Add a synchronization (fork / join) | `B`, then click on the target container |
| Add an entry point / exit node | `E` / `X`, then click on the composite state |
| Add a declaration (event, variable, …) | click the definitions box, use *Add declaration* in the properties panel |
| Show / hide transition priorities | *Priorities* in the toolbar |
| Initial state | *Initial* tool (`I`), click on the state that should be entered first |
| Final state | *Final* tool (`F`), click on the state that should get a transition to the final state |
| Add a transition | *Transition* tool (`T`), click the source, then the target, then type the label (`Tab` completes names) |
| Rename / edit label | double-click or `F2` |
| Move into another state | hold `Shift` while dropping it (a plain drop only moves it, see [Manual layout](#manual-layout-experimental)) |
| Delete | `Del` / `Backspace` or the trash button |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` (shared with the text editor) |
| Keep a tool active | hold `Shift` while choosing it, `Esc` to go back to selection |

## Edge routing

The *Edges* setting of the toolbar (`hsm.diagram.edgeRouting` in VS Code, `--routing` of `hsm render` /
`hsm doc`) chooses how transitions are drawn, from angular to curved:

| Setting | Routes | Drawn as |
| --- | --- | --- |
| *Orthogonal* (`ORTHOGONAL`) | horizontal and vertical segments (ELK orthogonal routing) | straight lines with sharp corners |
| *Rounded* (`ROUNDED`) | the orthogonal routes | circular arcs at the corners (radius 10, smaller where a segment is shorter than 20) – between *Orthogonal* and *Splines* |
| *Polyline* (`POLYLINE`) | straight segments in any direction (ELK polyline routing) | straight lines |
| *Smooth* (`SMOOTH`) | the polyline routes | a smooth curve through all bend points (centripetal Catmull-Rom spline) |
| *Splines* (`SPLINES`, default) | curves computed by ELK | cubic Bézier curves |

*Rounded* and *Smooth* change only the drawing, not the layout: the states are where they are with
*Orthogonal* resp. *Polyline*, labels stay next to their routes, the arrow heads point along the last
segment. In a manual layout the rerouted transitions get the same shapes; a *Smooth* route passes through
its waypoints, a *Rounded* one rounds the corner at a waypoint (the handle stays on the corner, a few pixels
from the line). The setting is a preference of the viewer (stored in the browser / the VS Code settings), not
part of the model.

## Manual layout (experimental)

🧪 By default the diagram is laid out automatically (ELK). As soon as a state is dragged, the diagram
is arranged by hand: the positions are stored as **layout annotations** in the model text (`@at(x, y)`
before a state, `@via(…)` before a transition, …, see [the language](language.md#diagram-layout-annotations)).
A model with layout annotations has a manual layout, one without the automatic layout – there is no
mode switch. Design and trade-offs: [Manual layout](manual-layout.md).

- The first drag writes the annotations of all elements (the current automatic layout plus the move).
  *Auto-arrange* replaces them with the automatic layout, *Automatic layout* removes all layout
  annotations (automatic layout again; an earlier arrangement is restored with undo, not with this button).
- Layout changes are text edits: they are undone with `Ctrl+Z` like every other edit, mark the model as
  modified and are saved with it. Renames (also typed in the text) keep the position, because the
  annotation belongs to the element.
- Elements without `@at` (e.g. new states) are placed automatically near their siblings; composite
  states grow when their content does not fit. Transitions keep their automatic route while their end
  points are arranged as in the automatic layout, otherwise they are rerouted around the other states
  in the shape of the *Edges* setting, through their waypoints if they have any.

| Action (manual layout) | How |
| --- | --- |
| Move a state, pseudo state or the definitions box | drag it (attached transitions follow) |
| Move a state into another state | hold `Shift` while dropping it |
| Resize a state | select it, drag the handle at the bottom right corner |
| Add / move / remove a waypoint | select the transition; double-click its line / drag the point / double-click the point |
| Move a transition label | select the transition, drag its label |
| Arrange automatically / back to the automatic layout | *Auto-arrange* / *Automatic layout* in the toolbar |

Importing an itemis CREATE `.sct` file keeps the arrangement of its diagram (also when several
statecharts are imported together). On the command line, `hsm layout`, `hsm render` and `hsm doc` use
the annotations (`--auto` ignores them), `hsm import` writes them (`--no-layout` to skip them), and
`hsm migrate-layout model.hsm` converts a `model.hsm.layout` file of the earlier sidecar experiment
into annotations.

## Simulation

Click **▶ Simulate** in the toolbar (the model must not contain errors; warnings are fine). The text
becomes read-only, the diagram tools are disabled and the simulation panel replaces the properties
panel. The simulation uses the interpreter of the language package (`StatechartInterpreter`, semantics in
[`docs/semantics.md`](semantics.md)) with a virtual clock; **■ Stop** returns to editing.

| Part of the panel | What it does |
| --- | --- |
| *Run cycle* / *Step* | cycle based: one run cycle with the collected events and expired time events; event driven: a step without events (`Space`) |
| *Real time* | advances the virtual clock with the wall-clock time × *Speed*: cycle based machines run a cycle every `@CycleBased` period, event driven machines fire their time events (`Esc` pauses) |
| *Advance … ms* | advances the virtual clock at once, running the cycles resp. firing the time events that are due |
| *Restart* | re-enters the state machine (breakpoints and operation results are kept) |
| *In events* | one button per `in` event, grouped by interface, with a value field for typed events. Cycle based: with *Run cycle after raising an event* (default) a cycle is run immediately, otherwise the event is shown as *pending* until the next cycle |
| *Variables* | grouped by interface / internal scope; non-constant variables can be edited (checked against the type), changed values flash |
| *Operations* | the value each operation returns (a mock of the host implementation) and the number of calls |
| *Out events*, *Operation calls*, *Trace* | logs with the virtual time; click a trace entry to show the element in the text and in the diagram |

Active states (also inside orthogonal regions) are highlighted in the diagram, the transitions taken in
the last step light up in orange and fade out, a reached final state turns green. Right-click a state or
a transition (or use *Toggle breakpoint* for the selected element) to set a **breakpoint** (red dot):
real-time mode and *Advance* stop when the state is entered or the transition is taken. Errors of the
interpreter (e.g. a division by zero or a choice without enabled branch) stop the simulation and are
shown with a link to the model element.
