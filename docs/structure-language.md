# The structure language (structure files, `.devm`)

🧪 Experimental: the structure elements of the **Device Modeler**. A structure file describes
the structure of a product – component types, their ports, subsystems, threads, instances and
connections – alongside the state machines that implement the behavior of its components. Ports are
**directed data flow**: every port carries data in a direction – data values (sync ports) or one event
with an optional payload (async ports). The validator checks the ports of a component against its state
machine, and the route analysis follows the data through all levels of the hierarchy.

Structure files and state machine files are both `.devm` files: a file contains **either a state machine
or structure elements** (structs, components, subsystems, systems), never both. A file
starting with `statemachine` (after comments) is a state machine file, every other file – also an empty
one – is a structure file; structure elements after a state machine (or a state machine after structure
elements) are reported: *A .devm file contains either a state machine or structure elements*. The keywords
of state machines can be used as names in structure files (a field `state`, a port `event`) and vice versa.

The complete example is in [`examples/device`](../examples/device): a garage door with a controller and
a drive unit (a subsystem with threads of its own), implemented by `controller.devm` and `drive.devm`; `light.devm`
declares a data type, components and a subsystem in one file.

```
// system.devm
import "types.devm"                          // structs and component types of other files
import "components.devm"
import "drive-unit.devm"

/** The garage door: remote control commands in, statistics out. */
system GarageDoor {
    in async open                           // boundary ports of the system: events of the remote control
    in async close
    in async stop
    out sync report : Diagnostics           // data for the environment

    @priority(5) @period(10 ms)
    thread ControlTask {                    // a thread and the instances running in it
        door : DoorController
        buzzer : Buzzer
    }
    @priority(2) @period(100 ms)
    thread IoTask {
        sensor : PositionSensor
        diag : Diagnosis
    }
    drive : DriveUnit                       // a subsystem: outside of the threads, its parts run in its threads

    connect door.up -> drive.up             // out port -> in port (the direction of the data)
    connect door.down -> drive.down
    connect door.halt -> drive.halt
    connect drive.stopped -> door.stopped
    connect drive.blocked -> door.blocked
    connect door.alarm -> buzzer.alarm
    connect sensor.position -> door.position
    connect door.cycles -> diag.cycles
    connect door.errors -> diag.errors      // inout <-> inout: shared data
    delegate open -> door.open              // in boundary port -> in port of a part
    delegate close -> door.close
    delegate stop -> door.stop
    delegate diag.report -> report          // out port of a part -> out boundary port
}
```

```
// components.devm
import "types.devm"
import "door_types.h"                       // C/C++ types (door::Position)

/** Opens and closes the door; implemented by controller.devm. */
component DoorController {
    behavior "controller.devm"              // the state machine implementing the component
    in async open                           // receives the event `open` (no data)
    in async close
    in async stop
    in async stopped
    in async blocked
    out async up : integer                  // sends the event `up` with a payload
    out async down : integer
    out async halt
    out async alarm
    in sync position : door::Position       // reads data written by another component
    out sync cycles : integer               // writes data
    inout sync errors : integer             // shares data with another component
}
```

```
// types.devm
package types                               // optional: elements can also be referenced as `types.Name`

struct Diagnostics {                        // a data type of ports and struct fields
    cycles : integer
    errors : integer
}
```

## Elements

| Element | Syntax | Meaning |
|---|---|---|
| package | `package types` (first line, optional) | elements of the file can be referenced as `types.Name` |
| import | `import "file.devm" "door.devm" "types.h"` | other structure files, state machine files (for `behavior Door`), C/C++ headers – the kind of a `.devm` file is its content |
| struct | `struct Position { x : real  y : real }` | a data type (fields separated by line breaks, `,` or `;`) |
| component | `component Name "description" { behavior "x.devm"  ports… }` | an atomic component type |
| subsystem | `subsystem Name { ports… threads… instances… connect… delegate… }` | a composite component type, can be instantiated |
| system | `system Name { … }` | the root of a product (same body as `subsystem`, cannot be instantiated) |
| port | `in\|out\|inout sync name : Type`, `in\|out async name` / `in\|out async name : Type` | see [Ports](#ports) |
| thread | `@priority(5) @period(10 ms) @stack(4096) thread Name { a : A  b }` | see [Threads](#threads) |
| instance | `name : ComponentType "description"` | a part of a subsystem or system: an instance of a component in a thread, of a subsystem outside of the threads (see [Threads](#threads)) |
| connection | `connect a.out -> b.in` | connects an out port of a part with an in port of another part (two inout ports: in any order) |
| delegation | `delegate in -> part.in` / `delegate part.out -> out` | connects a boundary port with a port of a part |

Comments are written like in the state machines (`//`, `/* */`); a `/** … */` comment before an element
is its documentation (hover in the editor). Annotations are written before the element they belong to.

**Types** are referenced by name: the built-in types `integer`, `real`, `boolean`, `string`; structs of
the file or of an imported structure file (`Position`, or `types.Position` for a file with
`package types`); C++ types of an imported header (`door::Position`, `motor::Mode`, `uint8_t`, mapped
like in state machines, see [C/C++ header imports](language.md#cc-header-imports)). `void` is not a data
type; an event without payload is written without type (`out async halt`).

**Visibility:** only the elements of the file itself and of the files it imports (directly) are visible.
Names are unique within a file; an element of the file hides an imported element with the same name
(warning), and if two imported files declare the same name, the first import wins (warning; use
`package.Name`). Import cycles between structure files are allowed.

**Earlier syntax.** Ports were written `provides` / `requires` with interfaces (`interface DoorCmd {
event open … }`) and inline event lists in earlier versions. They are gone: the parser reports
*Ports are written 'in|out|inout sync|async name : Type' …* for `provides` / `requires` and *Structure files
have no interface declarations: an async port carries one event …* for `interface` declarations.

## Ports

A port carries data in a direction. Nothing else: no operations, no provided / required services, no
groups of events.

| | `sync` – data values (hollow square) | `async` – one event (filled square) |
|---|---|---|
| `in` | the component reads data written by its source (`in sync position : door::Position`) | the component receives the event `name` (`in async open`, `in async up : integer`) |
| `out` | the component writes data (`out sync cycles : integer`) | the component sends the event `name` (`out async halt`, `out async up : integer`) |
| `inout` | the component shares data with other components: both read and write it (`inout sync errors : integer`) | – (an error: an event is sent or received) |

- A **sync** port has a type: a built-in type, a struct or a C/C++ type of a header (a sync port without
  type is an error).
- An **async** port is exactly **one event, named like the port**; its type is the type of the payload
  of the event. Without type it is a pure signal (`out async halt`).

### Connections and delegations

All arrows point in the **direction of the data** – from the port that writes the data (sends the
event) to the port that reads it (receives the event):

- `connect a.o -> b.i`: `a.o` is an out port of a part, `b.i` an in port of another part. `connect`
  only connects ports of parts (boundary ports are connected with `delegate`). Writing the arrow the wrong
  way round is an error with a hint (`write 'connect b.o -> a.i'`); two out ports or two in ports cannot be
  connected.
- `delegate i -> part.i`: the data of the in boundary port `i` goes to the in port of a part
  (outer → inner).
- `delegate part.o -> o`: the data of the out port of a part goes to the out boundary port `o`
  (inner → outer).
- **inout** ports are connected (and delegated) only with inout ports. The data is shared, so the order
  does not matter: `connect a.s -> b.s` and `connect b.s -> a.s` mean the same (the diagram writes the
  port chosen first on the left); connecting the same pair in the other order again is a duplicate.

**Compatibility** (connections and delegations, source → target): both ports have the same kind
(sync / async); sync: the data of the source must be assignable to the data of the target
(`integer` → `real` is allowed), inout ports share data of the same type; async: both events carry no
payload, or the payload of the source is assignable to the payload of the target. A struct of a
structure file is the same type as a C++ struct with the same unqualified name (`Position` and
`geo::Position`).

**Sources and targets:**

- A **sync in port has one source**: a second connection (or delegation) delivering its data is an error.
  The same holds for an out boundary port (the data of one part leaves the subsystem).
- An **async in port may have several sources**: the events of all sources are merged (e.g. two remote
  controls sending `open`).
- An **out port may have several targets** (fan-out): every target receives the data or the event; an
  in boundary port may be delegated to several parts.

### Rules (validation)

| Check | Severity |
|---|---|
| duplicate names (elements of a file, ports, fields, instances and threads of a subsystem or system); element named like a built-in type | error |
| unknown type, unresolved component type / instance / port / state machine, import or behavior file not found, unsupported import | error |
| a sync port without type, an `inout async` port, `void` as type | error |
| a connection not from an out port to an in port (or between two inout ports), `connect` with a boundary port | error |
| a delegation not between a boundary port and a port of a part, different directions, in delegated inner → outer, out outer → inner | error |
| incompatible kinds / data types / payloads of connected or delegated ports – the message names both ports with their signatures and the reason, e.g. *door.up (out async integer) cannot be connected to buzzer.alarm (in async): the event door.up carries integer, but buzzer.alarm expects no payload* | error |
| a sync in port (or out boundary port) with more than one source | error |
| an instance of a component outside of a thread (neither declared in a thread nor assigned to one), an instance of a subsystem in a thread or assigned to one | error |
| an instance in more than one thread | error |
| recursive instantiation (`A` contains a `B` which contains an `A`), instantiating a `system` | error |
| an in or inout port of a part that is not connected (nor delegated): it receives no data | warning |
| a boundary port that is not delegated (in: nobody receives its data, out: no part sends it, inout) | warning |
| duplicate connection or delegation, same file imported twice, hidden or ambiguous imported names | warning |
| unknown annotation, annotation without effect at its place, annotation given twice | warning |
| a connection between instances of different threads | info |
| ports ↔ state machine (see below) | error / warning |

An **out port of a part may be left unconnected** (nobody uses the data or the event, e.g. the speed of
the motor control in the example): no diagnostic.

## Components and state machines

`behavior "door.devm"` links a component to the state machine of a file (relative to the structure file;
a structure file there is an error); `behavior Door` names a state machine of an imported state machine
file. Every port is an element of the interfaces of the state machine's definition section with the name
of the port:

| Port | State machine |
|---|---|
| `out sync p : T` | `var p : T` – the state machine writes the data |
| `in sync p : T` | `var readonly p : T` – the data is written by the source, the state machine reads it |
| `inout sync p : T` | `var p : T` – shared: read and written |
| `in async p : T` | `in event p : T` (`in event p` without payload) |
| `out async p : T` | `out event p : T` (`out event p` without payload) |

- **Lookup:** the name of the port is looked up in **all interfaces** of the state machine – the
  unnamed interface and every named interface (`interface remote: in event open` for the port `open`,
  raised and triggered as `remote.open` in the state machine); the internal scope does not count. The
  name must be unique there: two elements with the name of a port in different interfaces are an error
  (*The port 'p' is ambiguous …*).
- The type of the variable (the payload of the event) must be the same type as in the port (`integer`
  and `real` are different here); a missing element, a wrong kind (an event for a sync port, a variable or
  operation for an async port, a constant), a wrong direction of the event or a wrong `readonly` is an
  error with the declaration the port expects.
- Every `in` / `out` event and every variable (not constants, not submachine instances) of the
  interfaces of the state machine should belong to a port: otherwise a warning names the port to add
  (*… does not belong to any port of 'C' (add the port 'in async close : integer')*). Operations are not
  ports (they are functions of the application called by the state machine) and are not checked.

The mapping is available as `behaviorMapping(component)` (structure-behavior.ts) for tools (navigation from a
port to the state machine elements).

## Threads

A thread groups the instances of components that run in the same thread of execution. **Instances of
components are always in a thread**, **instances of subsystems never**:

- An instance of a component is declared in a thread (`thread T { door : DoorController }`) or declared
  in the body of the subsystem / system and assigned to a thread by name (`thread T { door }`). An
  instance belongs to exactly one thread; a component instance outside of any thread is an error (the
  message shows both ways to write it).
- An instance of a subsystem is declared in the body, outside of the threads (`drive : DriveUnit`): its
  parts run in the threads of the subsystem (the parts of `DriveUnit` run in `MotorTask` and
  `SwitchTask`). Declaring it in a thread or assigning it to one is an error.
- The grammar accepts `name : Type` in both places – whether `Type` is a component or a subsystem is
  only known after linking – so the validator checks the rules and tells where the instance belongs;
  completion offers components in threads and subsystems outside of them.
- Annotations: `@priority(n)` (integer), `@period(10 ms)` (period of a cyclic thread, units `s`, `ms`,
  `us`, `ns`), `@stack(4096)` (stack size in bytes), and the layout annotations of the diagram (see
  [Diagram](#diagram)). Other annotations are reported as unknown; tools can register further names in
  `STRUCTURE_ANNOTATIONS` (structure-validator.ts).
- A connection between two instances of different threads crosses threads: an info diagnostic (the
  diagram draws it dashed). For an instance of a subsystem, the threads of the component ports the
  connection leads to inside the subsystem count (`door.up -> drive.up` crosses from `ControlTask`
  to `MotorTask`, see `connectionThreads` and `effectiveThread` in structure-routes.ts).

## Route analysis

`structure-routes.ts` computes the data paths of a port or instance across connections, delegations and the
boundaries of composite instances, through all levels of the hierarchy (exported from the package index).
Endpoints are ports in the *instance tree* of a root (by default the subsystem or system containing the
start), so a subsystem that is instantiated several times has separate endpoints per instance path
(`drive.motor.up`). All hops point in the **direction of the data** (see above): from the out port to the
in port of a connection, from the boundary into the part for in ports, from the part to the boundary for
out ports; a `boundary` hop connects the port of a composite instance with the same port seen from inside
the composite. The hops of **inout** ports are followed in both directions (the data is shared).

| Function | Result |
|---|---|
| `portRoute(start, direction = 'both')` | endpoints and hops reachable from the start endpoint(s): the whole net (`both`), in the direction of the data towards the targets (`forward`) or against it towards the sources (`backward`) |
| `routeOf(node, { root? })` | the route of a model element: port reference, connection, delegation, instance, port, subsystem / system |
| `findSources(endpoint)` | where the data of an in port comes from: out ports of components (or in boundary ports of the root: the data comes from the environment); for an inout port the ports sharing the data |
| `findTargets(endpoint)` | where the data of an out port goes: in ports of components (or out boundary ports of the root); for an inout port the ports sharing the data |
| `sharingPorts(endpoint)` | the other ends of the shared data of an inout port |
| `sourcesOf(node, { root? })` | "go to source" of the ports at a model element: the sources of in (and inout) ports, an out port of a component itself |
| `routeEndpointsOf(node, { root? })`, `endpointsOfPort(root, port)`, `structureContexts(root)` | endpoints of model elements, the instance tree |
| `endpointLabel(endpoint)`, `endpointKey(endpoint)`, `sameEndpoint(a, b)` | names (`drive.motor.up`) and identity of endpoints |

## Diagram

The diagram of a structure file is an internal block diagram (IBD) in the style of SysML, in the themes of
the state machine diagrams (PlantUML classic / modern, dark). It is shown and edited by the web editor and
the VS Code extension (palette, rename in place, drag & drop into threads, connectors, properties,
navigation into the state machines and subsystems of the instances – see
[the editor](editor.md#structure-diagrams) and [VS Code](vscode.md)) and rendered by `devm render`
([rendering](rendering.md)):

![The garage door system](examples/GarageDoor.svg)

| Element | Notation |
|---|---|
| subsystem / system | a frame with the tab `ibd [system] GarageDoor` (`ibd [subsystem] DriveUnit`); its boundary ports on the border, labels outside |
| thread | a rounded, tinted frame `«thread» ControlTask` with its settings (`priority 5 · period 10 ms`) enclosing its instances |
| instance | a box `«component»` / `«subsystem»` and `name : Type`; an icon of two linked states: the component has a behavior state machine; the rake icon: a subsystem (it has an internal block diagram of its own) |
| port | a small square on the border, the name inside the box: **hollow** = sync (data values), **filled** = async (an event) |
| direction | an arrow in the square shows the direction of the data: pointing **into the box** = `in`, **out of the box** = `out`, **double-headed** = `inout` (shared data); boundary ports likewise relative to the frame |
| port label | `name : Type` (`up : integer`, `position : door::Position`); the name only for an event without payload (`halt`); double-click the type to open the declaration of a struct |
| connection, delegation | orthogonal lines between the ports with an **arrowhead at the receiving end** (the in port of a connection, the inner port of an in delegation, the boundary port of an out delegation), at **both ends between inout ports**; **dashed** if the connection crosses threads |

**Legend:**

| Symbol | Meaning |
|---|---|
| hollow square, arrow into the box | `in sync` – reads data |
| hollow square, arrow out of the box | `out sync` – writes data |
| hollow square, double-headed arrow | `inout sync` – shares data |
| filled square, arrow into the box | `in async` – receives an event |
| filled square, arrow out of the box | `out async` – sends an event |
| line with an arrowhead | the data flows towards the arrowhead; arrowheads at both ends: shared data (inout) |
| dashed line | the connection crosses threads |

Instances of subsystems are drawn directly in the frame (outside of the threads). Ports are on
the side facing the ports they are connected to (by default in ports left, out and inout ports right),
ordered by the position of their partners, so data flowing back (`drive.stopped -> door.stopped`) needs no
detour.

**Manual layout.** The diagram can be arranged by hand, with the same concept and syntax as the state
machine diagrams ([Manual layout](manual-layout.md#structure-diagrams)): layout annotations in the text
place the frame, threads, instances, component blocks and type boxes (`@at(x, y)`, `@size(w, h)`), the
ports of an instance or the boundary ports (`@port(name, left | right | top | bottom, offset)`) and the
waypoints of connections and delegations (`@via(x1, y1, …)`); a diagram without them is laid out
automatically. They are written by dragging in the diagram and removed by *Automatic layout*:

```
@at(112, 16)
subsystem CourtesyLight {
    in async on
    in async off
    in async dim : integer
    @priority(1) @period(20 ms) @at(41, 48) @size(500, 196)
    thread LightTask {
        @at(26, 52) dimmer : Dimmer
        @at(330, 96) @port(level, top, 40) led : LedDriver
    }
    connect dimmer.level -> led.level
    delegate on -> dimmer.on
    delegate off -> dimmer.off
    delegate dim -> dimmer.dim
}
```

**Choosing what is shown.** The diagram shows the first `system` of the file, else its first
`subsystem`; a file with component types only shows them all as blocks with their ports (or one of
them). If the file declares several elements, a selector at the top of the diagram chooses the shown one;
moving the text cursor into another subsystem shows that one.

**Data types.** The structs declared **in the file** are shown as separate value type boxes
– `«struct» Position` with its fields – in rows below the frame (or
the component blocks), never connected to anything: the ports show their type in the label instead. A file
with data types only (like `types.devm` of the example) shows only these boxes; a file mixing data types,
components and a subsystem (like `light.devm`) shows them next to its diagram. Clicking a box selects the
declaration in the text; double-clicking the type of a port opens the box of the type (also in another
file). The boxes are part of the diagram model (kind `type`, ids `type:Position`, graph kind `types` for a
file without component types), so the export and `devm render` include them.

**Routes.** Selecting a port, a connection or an instance highlights the route of its data
(`ibdRouteElements`, based on `routeOf` / `portRoute` of the route analysis): the ports, connectors and
instances on the route are drawn in orange, everything else is dimmed. The properties panel lists the
*Sources* of an in port, the *Targets* of an out port and the ports an inout port shares its data with
(*Shared with*). Diagnostics are shown as markers at the
element (or at the tab of the frame); an instance also gets a marker if the declaration of its component
type in an imported file or the state machine implementing it has errors.

**Diagram model** (`layoutStructure` in `src/diagram/ibd-layout.ts`, types in `ibd-model.ts`): stable ids
derived from the names – frame `GarageDoor`, boundary port `GarageDoor.open`, thread
`GarageDoor/thread:ControlTask`, instance `GarageDoor/door`, port of an instance `GarageDoor/door.open`,
connection `GarageDoor/door.up->drive.up`, delegation `GarageDoor/open->door.open`; the result maps
ids to AST nodes and back (`elements`, `ids`; ports of instances also to their instance, `instances`). The
layout uses ELK (layered, left to right, orthogonal routing, threads and the frame as compound nodes with
hierarchy handling, ports with fixed positions); the layout annotations of the diagram's elements are
applied on top of it (`applyIbdManualLayout` in `ibd-manual-layout.ts`, read and written by
`ibd-layout-annotations.ts`; `layoutStructure(model, { layout: null })` gives the automatic layout).

**Editing** (`src/edit/structure-edits.ts`): `StructureEditor` turns the diagram operations into minimal text edits
(add threads, instances, ports, connections and component types; move instances between threads; edit
ports, thread annotations and the behavior of components; rename; delete), `planConnection` decides
between `connect` and `delegate` and writes the ends of two chosen ports in the direction of the data
(from the out port to the in port, whichever was chosen first; two inout ports in the order they were
chosen) and refuses ports that cannot be connected (`IncompatiblePortsError` with the message of the
validator, `incompatibilityMessage` in structure-types.ts, for incompatible kinds, types and payloads and
for a second source of a sync in port), `structureRenameEdits` renames an element and its references
in all loaded files (Langium references; qualified references keep their qualifier). An instance of a
component is added to a thread, an instance of a subsystem outside of the threads; moving an instance of a
component out of its thread or an instance of a subsystem into one is refused. Deleting a thread deletes it
together with its instances and their connections and delegations (instances of components only exist in
threads, so keeping them would leave invalid instances behind). Deleting a port also deletes the
connections and delegations using it – in the file by `StructureEditor`, in the other files of the workspace by
`StructureWorkspace.portDeletionEdits` (the editors apply all of them as one step).

**Workspace** (`src/structure-workspace.ts`): `StructureWorkspace` loads all structure files of a workspace (with
their imports) into Langium services of its own for questions across files: `behaviorUsages(uri)` (the
instances implemented by a state machine), `resolveContext(context)` (the structures of an instance path),
`endpoint` / `route` / `routeEnds` (routes and their sources / targets through all levels and files),
`routeIdsAt` / `routeContinuations` (the diagram ids of a route at a level of the instance tree, the
composite parts it continues into), `renameEdits` (renames updating the files that use an element),
`portDeletionEdits` (the connections of other files using deleted ports).
Elements are identified across the separately parsed files by URI and names: a `StructureContext`
(`{ rootUri, root, path }`, the shown subsystem or system as the part `path` of the root – given by the
navigation from a containing structure; a subsystem opened directly is its own root) and a
`StructureLocation` (`{ uri, element, id, context }`, what navigation opens and selects).

## Editor support

Structure files and state machine files are one language (see
[Architecture](architecture.md#one-language-for-two-kinds-of-model-files); `createDevmServices` returns it as
`Devm`), so structure files reference state machine files and are revalidated when a state
machine they use changes. Language server features: formatter, completion (keywords, references,
type names), go to definition (component types, instances, ports, type names – also into C++ headers –,
import paths and the behavior file), go to implementation = **go to source** (on an in port, a port
reference or an instance: the instances – or boundary ports – sending the data, on an inout port the
ports sharing it, on an out port of a component the port itself), hover
(signature and documentation comment) and document symbols. `StructureModelLoader` (model-loader.ts) loads a
structure file with everything it imports outside of a language server.

The web app highlights structure files with the generated Monarch grammar, with the keywords of the kind of the file
(decided by the first token like the parser: a keyword of state machines used as a name in a structure file –
a field `state` – is highlighted as a name, and vice versa), offers completion, hover, formatting and
go to definition, and shows and edits their diagram (see [Diagram](#diagram) and
[the editor](editor.md#structure-diagrams)); all files of `examples/device` are in its list of
examples and resolve their imports against each other. State machines used as the behavior of components
link back to the instances (*Used by*).

The VS Code extension serves structure files with the same language server as the state machines (all
`.devm` files of the workspace are indexed: references, renames and go to source across files), a
TextMate grammar, and opens the structure diagram with **Device Modeler: Open Diagram** like the diagram of a state
machine; navigation between the diagrams and edits of several files go through the extension
([VS Code extension](vscode.md#structure-files)).

Not (yet) supported: simulation and code generation of structure files; state machines cannot use the structs
of structure files (share C/C++ headers instead).
