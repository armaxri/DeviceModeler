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
| Move into another state | drag and drop |
| Delete | `Del` / `Backspace` or the trash button |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` (shared with the text editor) |
| Keep a tool active | hold `Shift` while choosing it, `Esc` to go back to selection |

## Manual layout (experimental)

🧪 By default the diagram is laid out automatically (ELK). With *Positions: Manual* in the toolbar the
diagram can be arranged by hand instead; the automatic layout is not affected as long as no manual
layout is active. Design, format and trade-offs: [Manual layout](manual-layout.md).

- The positions are stored next to the model in `<model>.hsm.layout` (JSON, keyed by qualified names),
  the `.hsm` text stays free of layout information. The web editor keeps the layout per file in the
  browser; *Save* downloads the model and its `.hsm.layout`, *Open…* accepts both files together.
  The VS Code extension of this branch reads and writes the `.hsm.layout` file next to the model in
  the workspace (see [VS Code extension](vscode.md)).
- Switching to *Manual* starts from the current automatic layout. *Auto-arrange* re-runs the automatic
  layout and keeps it as manual layout, *Reset* discards the manual layout, *Auto* shows the automatic
  layout but keeps the manual one for later.
- Elements without a stored position (e.g. new states) are placed automatically near their siblings;
  composite states grow when their content does not fit. Transitions keep their automatic route while
  their end points are arranged as in the automatic layout, otherwise they are rerouted around the
  other states in the shape of the *Edges* setting, through their bend points (waypoints) if they have any.

| Action (manual layout) | How |
| --- | --- |
| Move a state, pseudo state or the definitions box | drag it (attached transitions follow) |
| Move a state into another state | hold `Shift` while dropping it |
| Resize a state | select it, drag the handle at the bottom right corner |
| Add / move / remove a waypoint (bend point) | select the transition; double-click its line / drag the point / double-click the point |
| Move a transition label | select the transition, drag its label |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` in the diagram – layout changes and text edits in the order they were made |

Renames, moves and deletions done in the diagram update the layout; renames typed in the text editor do
not (the element is then placed automatically). Importing an itemis CREATE `.sct` file keeps the
arrangement of its diagram (also when several statecharts are imported together). On the command line,
`hsm layout model.hsm` uses `model.hsm.layout` if it exists (`--layout <file>`, `--auto`), and
`hsm import` writes the `.hsm.layout` next to each model (`--no-layout` to skip it).

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
