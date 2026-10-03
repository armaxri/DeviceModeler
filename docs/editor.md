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

## Structure diagrams

The internal block diagram of a structure file ([the structure language](structure-language.md#diagram))
is shown instead of the state machine diagram when the edited `.devm` file contains structure elements
(decided by its text: a file starting with `statemachine` is a state machine). It is edited like the state machine diagrams: every action is a minimal text edit of the `.devm` file
(comments and formatting are kept, `Ctrl+Z` undoes it, the text editor shows the change at once).

| Action | How |
| --- | --- |
| Add a thread | *Thread* tool (`T`), click into the subsystem or system – then type its name |
| Add an instance (part) | *Instance* tool (`I`), click into a thread and choose the component (instances of components run in threads), or click on the frame and choose a subsystem (placed outside of the threads); choosing a component on the frame asks for its thread next (without a thread nothing is added). The list shows the types visible in the file (type to filter) – then type the name |
| Add a port | *Port* tools: provided sync `1`, provided async `2`, required sync `3`, required async `4`; click on the frame (a boundary port of the subsystem or system), a component block or an instance whose type is declared in the file. New ports are `integer` (sync) or typed by the first interface of the file (async) – change the type in the properties panel |
| Connect two ports | *Connector* tool (`C`): press on a port and drag to the other port (or click both). While drawing, the ports that can be connected turn green, incompatible ports (different kinds, events not accepted, payload or data types not assignable) orange, the others fade; the hint shows the statement or why the ports do not fit. Two ports of parts become `connect required -> provided` (drawn the other way round, the ends are swapped), a boundary port and a port of a part a `delegate` (`delegate p -> part.q` for provided, `delegate part.r -> r` for required ports). A connector dropped onto an incompatible port is refused – nothing is written, the status bar explains why (the message of the validator, e.g. *door.alarm (requires async event alarm) cannot be connected to drive.ctrl (provides async MotorCmd): event 'alarm' is not accepted by drive.ctrl*) |
| Move an instance into another thread | drag it onto the thread (an assignment by name, `thread T { door }`, is replaced). Dropping an instance of a component onto the frame or an instance of a subsystem into a thread is refused with a hint. In a manually arranged diagram the instance keeps the drop position |
| Rename | double-click the name (of an instance: on its name, not on its type) or `F2`; also in the properties panel. Component types and ports are renamed in all structure files of the workspace that use them (Langium references); in the web app those other files are changed in the workspace (not undone with `Ctrl+Z` of the edited file), in VS Code all files are changed by one workspace edit (undone together) |
| Edit a port | properties panel: name, direction, kind, type (with completion of the built-in types, structs and interfaces) |
| Edit a thread | properties panel: name, priority, period (`10 ms`), stack size – the annotations `@priority(5) @period(10 ms) @stack(4096)` on the line before the thread |
| Change the type or the thread of an instance | properties panel (the thread of a component instance; a subsystem instance has no thread) |
| Set the behavior of a component | properties panel of the component (`behavior "door.devm"`, completion of the state machine files) |
| Add a component type | properties panel of the overview (*Add component / subsystem / system*) |
| Delete | `Del` / the trash button: an instance with its connections, delegations and assignments; a port with the connections and delegations using it (also in the other structure files of the workspace); a thread together with its instances and their connections and delegations (instances of components only exist in threads); connections, delegations, component types. Ports shown at an instance belong to its type: they are edited and deleted in the type |

### Layout of structure diagrams

Structure diagrams are arranged by hand like the state machines (see [Manual layout](#manual-layout-experimental)
and [Manual layout: structure diagrams](manual-layout.md#structure-diagrams)): the first drag stores
the positions of all nodes as layout annotations in the `.devm` text (`@at`, `@size`, `@port`, `@via`),
*Auto-arrange* and *Automatic layout* in the toolbar apply to the shown diagram, `Ctrl+Z` undoes layout
changes. The *Layout* direction and *Edges* settings do not apply (structure diagrams are always laid out
from left to right with orthogonal connectors).

| Action (layout) | How |
| --- | --- |
| Move the frame, a thread, an instance, a component block or a type box | drag it (with the *Select* tool; the connectors follow, the content of a thread moves with it) |
| Resize a node | select it, drag the handle at its bottom right corner |
| Move a port to another place or side | drag the port along the border of its instance (or of the frame) |
| Add / move / remove a waypoint of a connector | select the connector; double-click its line / drag the point / double-click the point |
| Arrange automatically / back to the automatic layout | *Auto-arrange* / *Automatic layout* in the toolbar |

### Navigation

| From | Action | Shows |
| --- | --- | --- |
| an instance with a behavior | double-click it, click its behavior icon or *Open state machine* | the state machine (`.devm`) of its component |
| a subsystem instance | double-click it, click its rake icon or *Open DriveUnit* | the internal block diagram of the subsystem, as the part of the shown diagram (breadcrumb *Part of GarageDoor › drive : DriveUnit*, the path of the navigation) |
| the type name of an instance | double-click it or *Go to type* | the definition of the component type (its file, the type shown and selected) |
| the type of a port (`cmd : DoorCmd`) | double-click the type | the «struct» / «interface» box of the type in the diagram of the file declaring it, the declaration selected |
| a «struct» / «interface» box | click it | the declaration selected in the text (double-click: the cursor into it) |
| a selected port, connection or instance | *Follow into drive ▸* (properties panel) | the subsystem the highlighted route continues into – the route stays highlighted there, also across files |
| the same, inside a subsystem reached by navigation | *◂ Follow out to GarageDoor* | the subsystem or system the navigation came from, the route highlighted |
| a required (provided) port | the *Providers* (*Requirers*) links, *Go to provider* | the port at the end of the route – also in another file (e.g. from `drive-unit.devm` to the door controller in `system.devm`) |
| a state machine | *Used by* (breadcrumb at the top of the diagram, properties panel) | the instances of the components implemented by the state machine, in the diagram of their subsystem or system |
| anywhere | *◀* / *▶* in the toolbar, `Alt+←` / `Alt+→` | back / forward in the navigation history |

Routes are followed through the levels of the hierarchy and the files of the workspace. Like in
PlantUML, a subsystem opened directly (its file opened, chosen in the list of examples or with the *Show*
selector, or by moving the text cursor into it) is shown **on its own**: its routes end at its boundary
ports, there is no breadcrumb and no *Follow out*. It is shown as a part of another structure only when
it is reached by navigation from a containing system or subsystem – double-click a subsystem instance,
*Follow into*, a provider at a deeper level, or *Back* / *Forward* to such a place: then the breadcrumb
shows the path of the navigation (*Part of GarageDoor › drive : DriveUnit*), the routes continue into the
containing structures (the providers of a required port of the drive unit are found in the system) and
*Follow out* returns to it. The target of a navigation is selected in the diagram and its text
highlighted.

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
statecharts are imported together). On the command line, `devm layout`, `devm render` and `devm doc` use
the annotations (`--auto` ignores them), `devm import` writes them (`--no-layout` to skip them), and
`devm migrate-layout model.devm` converts a `model.devm.layout` file of the earlier sidecar experiment
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
