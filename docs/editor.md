# Web editor

The web app (`npm run dev`, `packages/web`; online at [armaxri.github.io/DeviceModeler/main/](https://armaxri.github.io/DeviceModeler/main/))
edits the text and the diagram side by side – of state machines and of structure files. The VS Code extension
embeds the same diagram editor ([VS Code extension](vscode.md)); the desktop app and the Eclipse and JetBrains
plugins embed the whole web app in its embedded mode ([Installation and usage](installation.md)), so everything
described here works there as well, with the files of the host instead of the virtual file list.
Drag the bar between text and diagram to change their sizes. In windows narrower than 900 px (e.g. an editor tab of an IDE) the text is shown above the diagram and the bar changes its height; width and height are kept separately.

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
| Move into another state | hold `Shift` while dropping it (a plain drop only moves it, see [Manual layout](#manual-layout)) |
| Delete | `Del` / `Backspace` or the trash button |
| Fit the diagram to the view | *Fit to screen* button at the bottom of the palette (the tooltips of the palette name each tool and its key) |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` (shared with the text editor) |
| Keep a tool active | hold `Shift` while choosing it, `Esc` to go back to selection |
| Hide / show the properties panel | panel button at the right end of the toolbar or `Ctrl+Alt+B` (`Cmd+Alt+B` on macOS); the diagram gets the width, the choice is remembered in the browser |

## Structure diagrams

The internal block diagram of a structure file ([the structure language](structure-language.md#diagram))
is shown instead of the state machine diagram when the edited `.devm` file contains structure elements
(decided by its text: a file starting with `statemachine` is a state machine). It is edited like the state machine diagrams: every action is a minimal text edit of the `.devm` file
(comments and formatting are kept, `Ctrl+Z` undoes it, the text editor shows the change at once).

| Action | How |
| --- | --- |
| Add a thread | *Thread* tool (`T`), click into the subsystem or system – then type its name |
| Add an instance (part) | *Instance* tool (`I`), click into a thread and choose the component (instances of components run in threads), or click on the frame and choose a subsystem (placed outside of the threads); choosing a component on the frame asks for its thread next (without a thread nothing is added). The list shows the types visible in the file (type to filter) – then type the name |
| Add a port | *Port* tools – the icons show the port symbol of the diagram (hollow: sync, filled: async, the arrow: the direction of the data): sync in `1`, sync out `2`, sync inout `3`, async in `4`, async out `5`; click on the frame (a boundary port of the subsystem), a component block or an instance whose type is declared in the file. A system is closed and has no ports: a click on its frame is refused with a hint (model the environment as parts, or make it a subsystem); the properties panel of a system shows *Ports: none (closed)*. New sync ports are `integer`, new async ports carry no payload – change the type in the properties panel |
| Connect two ports | *Connector* tool (`C`): press on a port and drag to the other port (or click both). While drawing, the ports that can be connected turn green, incompatible ports (different kinds, data types or payloads not assignable, a second source of a sync in port) orange, the others fade; the hint shows the statement or why the ports do not fit. The connection is written in the **direction of the data**, whichever port you start at: two ports of parts become `connect out -> in` (drawn from the in port, the ends are swapped), two inout ports `connect a.s -> b.s` in the order you chose them, a boundary port and a port of a part a `delegate` (`delegate i -> part.i` for in, `delegate part.o -> o` for out ports). A connector dropped onto an incompatible port is refused – nothing is written, the status bar explains why (the message of the validator, e.g. *door.up (out async integer) cannot be connected to buzzer.alarm (in async): the event door.up carries integer, but buzzer.alarm expects no payload*) |
| Move an instance into another thread | drag it onto the thread (an assignment by name, `thread T { door }`, is replaced). Dropping an instance of a component onto the frame or an instance of a subsystem into a thread is refused with a hint. In a manually arranged diagram the instance keeps the drop position |
| Rename | double-click the name (of an instance: on its name, not on its type) or `F2`; also in the properties panel. Component types and ports are renamed in all structure files of the workspace that use them (Langium references); in the web app those other files are changed in the workspace (not undone with `Ctrl+Z` of the edited file), in VS Code all files are changed by one workspace edit (undone together) |
| Edit a port | properties panel: name, direction (`in` / `out` / `inout`; `inout` only for sync ports), kind (`sync` data / `async` event), type – the data of a sync port, the payload of an async port (empty: an event without data) – with completion of the built-in types and structs. An inout port changed to async becomes an in port, an async port without payload changed to sync gets the type `integer` |
| Edit a thread | properties panel: name, priority, period (`10 ms`), stack size – the annotations `@priority(5) @period(10 ms) @stack(4096)` on the line before the thread |
| Change the type or the thread of an instance | properties panel (the thread of a component instance; a subsystem instance has no thread) |
| Set the behavior of a component | properties panel of the component (`behavior "door.devm"`, completion of the state machine files) |
| Add a component type | properties panel of the overview (*Add component / subsystem / system*) |
| Delete | `Del` / the trash button: an instance with its connections, delegations and assignments; a port with the connections and delegations using it (also in the other structure files of the workspace); a thread together with its instances and their connections and delegations (instances of components only exist in threads); connections, delegations, component types. Ports shown at an instance belong to its type: they are edited and deleted in the type |

### Layout of structure diagrams

Structure diagrams are arranged by hand like the state machines (see [Manual layout](#manual-layout)
and [Manual layout: structure diagrams](manual-layout.md#structure-diagrams)): the first drag stores
the positions of all nodes as layout annotations in the `.devm` text (`@at`, `@size`, `@port`, `@via`),
*Store positions* / *Re-arrange* and *Clear positions* in the toolbar apply to the shown diagram, `Ctrl+Z` undoes layout
changes. The *Layout* direction and *Edges* settings do not apply (structure diagrams are always laid out
from left to right with orthogonal connectors).

| Action (layout) | How |
| --- | --- |
| Move the frame, a thread, an instance, a component block or a type box | drag it (with the *Select* tool; the connectors follow, the content of a thread moves with it) |
| Resize a node | select it, drag the handle at its bottom right corner |
| Move a port to another place or side | drag the port along the border of its instance (or of the frame) |
| Add / move / remove a waypoint of a connector | select the connector; double-click its line / drag the point / double-click the point |
| Arrange automatically / back to the automatic layout | *Store positions* / *Re-arrange* / *Clear positions* in the toolbar |

### Navigation

| From | Action | Shows |
| --- | --- | --- |
| an instance with a behavior | double-click it, click its behavior icon or *Open state machine* | the state machine (`.devm`) of its component |
| a subsystem instance | double-click it, click its rake icon or *Open DriveUnit* | the internal block diagram of the subsystem, as the part of the shown diagram (breadcrumb *Part of GarageInstallation › door : GarageDoor*, *Part of GarageDoor › drive : DriveUnit*, the path of the navigation) |
| the type name of an instance | double-click it or *Go to type* | the definition of the component type (its file, the type shown and selected) |
| the type of a port (`position : Position`) | double-click the type | the «struct» box of the type in the diagram of the file declaring it, the declaration selected |
| a «struct» box | click it | the declaration selected in the text (double-click: the cursor into it) |
| a selected port, connection or instance | *Follow into drive ▸* (properties panel) | the subsystem the highlighted route continues into – the route stays highlighted there, also across files |
| the same, inside a subsystem reached by navigation | *◂ Follow out to GarageDoor* | the subsystem or system the navigation came from, the route highlighted |
| an in port (out port, inout port) | the *Sources* (*Targets*, *Shared with*) links, *Go to source* (*Go to shared port*) | the port at the end of the route – where the data comes from (goes to) – also in another file (e.g. from `drive-unit.devm` to the door controller in `garage-door.devm`) |
| a state machine | *Used by* (breadcrumb at the top of the diagram, properties panel) | the instances of the components implemented by the state machine, in the diagram of their subsystem or system |
| anywhere | *◀* / *▶* in the toolbar, `Alt+←` / `Alt+→` | back / forward in the navigation history |

Routes are followed through the levels of the hierarchy and the files of the workspace. Like in
PlantUML, a subsystem opened directly (its file opened, chosen in the list of examples or with the *Show*
selector, or by moving the text cursor into it) is shown **on its own**: its routes end at its boundary
ports, there is no breadcrumb and no *Follow out*. It is shown as a part of another structure only when
it is reached by navigation from a containing system or subsystem – double-click a subsystem instance,
*Follow into*, a source at a deeper level, or *Back* / *Forward* to such a place: then the breadcrumb
shows the path of the navigation (*Part of GarageDoor › drive : DriveUnit*), the routes continue into the
containing structures (the source of the in port `motor.up` of the drive unit is found in the system) and
*Follow out* returns to it. The target of a navigation is selected in the diagram and its text
highlighted. A target in another file is opened by the host: in the web app the file of the virtual file list,
in VS Code the document and its diagram panel, in the desktop app its window, in Eclipse and the JetBrains
IDEs its editor.

## Side panel

The panel right of the diagram shows the properties of the selection (and the simulation while
simulating). It behaves like the side bars of VS Code; the same panel is used by the standalone app,
the desktop app, the Eclipse and JetBrains plugins and the diagram of the VS Code extension.

| Action | How |
| --- | --- |
| Hide / show the panel | panel button at the right end of the toolbar, the `›` button in the panel's title row or the strip of the hidden panel, `Ctrl+Alt+B` (`⌥⌘B` on macOS; not in VS Code, where this shortcut toggles VS Code's own secondary side bar, and not in the Eclipse plugin and the desktop app, where the host owns its shortcuts – in Eclipse it is *Skip All Breakpoints*) |
| Change its width | drag its left edge; with the edge focused (`Tab`) `←` / `→` (`Shift`: larger steps); double-click or `Home` restores the default width |
| Collapse / expand a section | click its header (*State*, *Actions*, *How to edit*, *Variables*, …) or press `Enter` / `Space` on it |

All sections are expanded at first. Collapsed sections stay collapsed for every element of the same
kind (e.g. *Actions* for all elements, *State* for all states) and across sessions: the web app keeps
the state in its settings (browser storage, in Eclipse the settings of the host), the VS Code
extension in the state of the diagram view; whether the panel is shown there is the setting
`devm.diagram.showProperties`.

## Edge routing

The *Edges* setting of the toolbar (`devm.diagram.edgeRouting` in VS Code, `--routing` of `devm render` /
`devm doc`) chooses how transitions are drawn, from angular to curved:

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

## Manual layout

By default the diagram is laid out automatically (ELK). As soon as a state is dragged, the diagram
is arranged by hand: the positions are stored as **layout annotations** in the model text (`@at(x, y)`
before a state, `@via(…)` before a transition, …, see [the language](language.md#diagram-layout-annotations)).
A model with layout annotations has a manual layout, one without the automatic layout – there is no
mode switch. Design and trade-offs: [Manual layout](manual-layout.md).

- The toolbar shows which of the two it is: **Positions: automatic** or **Positions: stored in model**.
- The first drag writes the annotations of all elements (the current automatic layout plus the move).

| Control (toolbar) | Shown | What it does to the model |
| --- | --- | --- |
| *Direction* (Top → bottom / Left → right) | always | nothing – direction of the automatic arrangement (for stored positions: of new elements and of *Re-arrange*) |
| **Store positions** | positions automatic | writes the current automatic arrangement as layout annotations (the diagram does not change; it can then be adjusted by hand) |
| **Re-arrange** | positions stored | arranges all elements automatically again and replaces the layout annotations with the new positions (waypoints, anchored ends, sizes and label positions are dropped) |
| **Clear positions** | positions stored | removes all layout annotations: the diagram is arranged automatically again and follows every change of the model |

- *Store positions* / *Re-arrange* and *Clear positions* are one text edit each, undone with `Ctrl+Z`
  (an earlier arrangement is restored with undo, not with a button). In VS Code they are also the commands
  **Device Modeler: Re-arrange Diagram and Store Positions in Model** and **Device Modeler: Clear Stored Diagram Positions
  (Remove Layout Annotations)**.
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
| Move the start / end of a transition along the border of its state | select the transition, drag the square at its start / end (it snaps to the nearest point of the border) |
| Place the start / end automatically again | double-click the square, or *Reset endpoints* in the side panel (both ends) |
| Arrange automatically / back to the automatic arrangement | *Store positions* or *Re-arrange* / *Clear positions* in the toolbar |

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
