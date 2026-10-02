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

## Structure diagrams (`.dmf`)

The internal block diagram of a structure file ([the structure language](structure-language.md#diagram))
is edited like the state machine diagrams: every action is a minimal text edit of the `.dmf` file
(comments and formatting are kept, `Ctrl+Z` undoes it, the text editor shows the change at once).

| Action | How |
| --- | --- |
| Add a thread | *Thread* tool (`T`), click into the structure – then type its name |
| Add an instance (part) | *Instance* tool (`I`), click on a thread (or on the frame for a part outside of threads), choose the component type from the list of the types visible in the file (type to filter) – then type its name |
| Add a port | *Port* tools: provided sync `1`, provided async `2`, required sync `3`, required async `4`; click on the frame (a boundary port of the structure), a component block or an instance whose type is declared in the file. New ports are `integer` (sync) or typed by the first interface of the file (async) – change the type in the properties panel |
| Connect two ports | *Connector* tool (`C`): press on a port and drag to the other port (or click both). While drawing, the ports that can be connected turn green, ports with incompatible types orange, the others fade; the hint shows the statement or the reason. Two ports of parts become `connect required -> provided` (drawn the other way round, the ends are swapped), a boundary port and a port of a part a `delegate` (`delegate p -> part.q` for provided, `delegate part.r -> r` for required ports). Incompatible ports are connected with a warning (the validator reports the error) |
| Move an instance into another thread | drag it onto the thread; onto the frame: out of its thread (a passive part). An assignment by name (`thread T { door }`) is replaced |
| Rename | double-click the name (of an instance: on its name, not on its type) or `F2`; also in the properties panel. Component types and ports are renamed in all structure files of the workspace that use them (Langium references); in the web app those other files are changed in the workspace (not undone with `Ctrl+Z` of the edited file) |
| Edit a port | properties panel: name, direction, kind, type (with completion of the built-in types, structs and interfaces) |
| Edit a thread | properties panel: name, priority, period (`10 ms`), stack size – the annotations `@priority(5) @period(10 ms) @stack(4096)` on the line before the thread |
| Change the type or the thread of an instance | properties panel |
| Set the behavior of a component | properties panel of the component (`behavior "door.hsm"`, completion of the state machine files) |
| Add a component type | properties panel of the overview (*Add component / structure / system*) |
| Delete | `Del` / the trash button: an instance with its connections, delegations and assignments; a port with the connections and delegations of the file using it; a thread keeps its instances (they become passive parts of the structure); connections, delegations, component types. Ports shown at an instance belong to its type: they are edited and deleted in the type |

### Navigation

| From | Action | Shows |
| --- | --- | --- |
| an instance with a behavior | double-click it, click its behavior icon or *Open state machine* | the state machine (`.hsm`) of its component |
| a composite instance | double-click it, click its rake icon or *Open DriveUnit* | the internal block diagram of its structure, as the part of the shown structure (breadcrumb *Part of GarageDoor › drive : DriveUnit*) |
| the type name of an instance | double-click it or *Go to type* | the definition of the component type (its file, the type shown and selected) |
| a selected port, connection or instance | *Follow into drive ▸* (properties panel) | the structure of a composite part the highlighted route continues into – the route stays highlighted there, also across files |
| the same, inside a composite | *◂ Follow out to GarageDoor* | the structure using it, the route highlighted |
| a required (provided) port | the *Providers* (*Requirers*) links, *Go to provider* | the port at the end of the route – also in another file (e.g. from `drive.dmf` to the door controller in `system.dmf`) |
| a state machine | *Used by* (breadcrumb at the top of the diagram, properties panel) | the instances of the components implemented by the state machine, in the diagram of their structure |
| anywhere | *◀* / *▶* in the toolbar, `Alt+←` / `Alt+→` | back / forward in the navigation history |

Routes are followed through the levels of the hierarchy and the files of the workspace: a structure
shown on its own is seen as part of the first system that contains it (its breadcrumb), so the
providers of a required port of the drive unit are found in the system. The target of a navigation is
selected in the diagram and its text highlighted.

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
