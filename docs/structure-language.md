# The structure language (`.dmf`)

🧪 Experimental: the structure language of the **Device Modeling Framework**. A `.dmf` file describes
the structure of a product – component types, their ports, composite structures, threads, instances and
connections – alongside the state machines (`.hsm`) that implement the behavior of its components. The
validator checks the ports of a component against its state machine, and the route analysis follows a
signal through all levels of the hierarchy.

The complete example is in [`examples/device`](../examples/device): a garage door with a controller and
a drive unit (a composite with its own motor task), implemented by `controller.hsm` and `drive.hsm`.

```
// system.dmf
import "types.dmf"                          // structs, interfaces, component types of other files
import "components.dmf"
import "drive.dmf"

/** The garage door: remote control commands in, statistics out. */
system GarageDoor {
    provides async remote : DoorCmd         // boundary ports of the system
    provides sync report : Diagnostics

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
    drive : DriveUnit                       // a composite: its parts run in their own threads

    connect door.motor -> drive.ctrl        // required port -> provided port
    connect drive.status -> door.status
    connect door.alarm -> buzzer.alarm
    connect door.position -> sensor.position
    connect diag.cycles -> door.cycles
    delegate remote -> door.cmd             // provided boundary port -> provided port of a part
    delegate report -> diag.report
}
```

```
// components.dmf
import "types.dmf"
import "door_types.h"                       // C/C++ types (door::Position)

/** Opens and closes the door; implemented by controller.hsm. */
component DoorController {
    behavior "controller.hsm"               // the state machine implementing the component
    provides async cmd : DoorCmd            // events (an interface) the component accepts
    provides async status : MotorStatus
    requires async motor : MotorCmd         // events the component sends
    requires async alarm : event alarm      // events can also be listed inline
    provides sync cycles : integer          // data the component provides
    requires sync position : door::Position // data the component needs
}
```

```
// types.dmf
package types                               // optional: elements can also be referenced as `types.Name`

struct Diagnostics {
    cycles : integer
    errors : integer
}

interface MotorCmd {                        // a named group of events: the type of async ports
    event up : integer                      // payload: built-in type, struct or C++ type
    event down : integer
    event halt
}
```

## Elements

| Element | Syntax | Meaning |
|---|---|---|
| package | `package types` (first line, optional) | elements of the file can be referenced as `types.Name` |
| import | `import "file.dmf" "door.hsm" "types.h"` | other structure files, state machines (for `behavior Door`), C/C++ headers |
| struct | `struct Position { x : real  y : real }` | a data type (fields separated by line breaks, `,` or `;`) |
| interface | `interface DoorCmd { event open  event close }` | a group of events: the type of async ports |
| component | `component Name "description" { behavior "x.hsm"  ports… }` | an atomic component type |
| structure | `structure Name { ports… threads… instances… connect… delegate… }` | a composite component type, can be instantiated |
| system | `system Name { … }` | the root of a product (same body as `structure`, cannot be instantiated) |
| port | `provides\|requires sync\|async name : Type` | see [Ports](#ports) |
| thread | `@priority(5) @period(10 ms) @stack(4096) thread Name { a : A  b }` | see [Threads](#threads) |
| instance | `name : ComponentType "description"` | a part of a structure (in its body or in a thread) |
| connection | `connect a.required -> b.provided` | connects a required port of a part with a provided port of another part |
| delegation | `delegate port -> part.port` / `delegate part.port -> port` | connects a boundary port with a port of a part |

Comments are written like in the state machines (`//`, `/* */`); a `/** … */` comment before an element
is its documentation (hover in the editor). Annotations are written before the element they belong to.

**Types** are referenced by name: the built-in types `integer`, `real`, `boolean`, `string`; structs and
interfaces of the file or of an imported structure file (`Position`, or `types.Position` for a file with
`package types`); C++ types of an imported header (`door::Position`, `motor::Mode`, `uint8_t`, mapped
like in state machines, see [C/C++ header imports](language.md#cc-header-imports)). `void` is not a data
type; an event without payload is written without type (`event halt`).

**Visibility:** only the elements of the file itself and of the files it imports (directly) are visible.
Names are unique within a file; an element of the file hides an imported element with the same name
(warning), and if two imported files declare the same name, the first import wins (warning; use
`package.Name`). Import cycles between structure files are allowed.

## Ports

| | `sync` (data / call) | `async` (events) |
|---|---|---|
| `provides` | the component provides data of the type (`provides sync speed : integer`) | the component accepts the events (`provides async cmd : DoorCmd`) |
| `requires` | the component needs data of the type from a provider | the component sends the events (`requires async motor : MotorCmd`) |

An async port is typed by an interface or by an inline list of events (`event start : integer, event
stop`); a sync port by a data type (built-in, struct or C++ type). An async port typed by a struct, a sync
port typed by an interface or with events is an error.

### Connections and delegations

All arrows point in **request direction** – from the side that needs a service to the side that
provides it:

- `connect a.r -> b.p`: `a.r` is a required port of a part, `b.p` a provided port of another part.
  `connect` only connects ports of parts (boundary ports are connected with `delegate`). Writing the
  arrow the wrong way round is an error with a hint (`write 'connect b.p -> a.r'`).
- `delegate p -> part.q`: the provided boundary port `p` is implemented by the provided port `q` of a
  part (outer → inner).
- `delegate part.r -> r`: the required port `r` of a part is passed on to the required boundary port
  `r` (inner → outer).

**Compatibility** (connections and delegations, source → target): both ports have the same kind
(sync/async); for async ports every event of the source must be accepted by the target with an
assignable payload (the target may accept more events); for sync ports the data of the target must be
assignable to the data of the source (`integer` → `real` is allowed). A struct of a structure file is
the same type as a C++ struct with the same unqualified name (`Position` and `geo::Position`).

### Rules (validation)

| Check | Severity |
|---|---|
| duplicate names (elements of a file, ports, fields, events of a port or interface, instances and threads of a structure); element named like a built-in type | error |
| unknown type, unresolved component type / instance / port / state machine, import or behavior file not found, unsupported import | error |
| connection not from a required to a provided port, `connect` with a boundary port | error |
| delegation not between a boundary port and a port of a part, different directions, provided delegated inwards → outwards, required outwards → inwards | error |
| incompatible kinds / events / payload types / data types of connected or delegated ports | error |
| a sync required port connected more than once (one provider), a sync provided boundary port delegated more than once | error |
| an instance in more than one thread | error |
| recursive instantiation (`A` contains a `B` which contains an `A`), instantiating a `system` | error |
| a required port of a part that is not connected (nor delegated) | warning |
| a provided boundary port that is not delegated, a required boundary port that no part uses | warning |
| duplicate connection or delegation, same file imported twice, hidden or ambiguous imported names | warning |
| unknown annotation, annotation without effect at its place, annotation given twice | warning |
| a connection between instances of different threads | info |
| ports ↔ state machine (see below) | error / warning |

## Components and state machines

`behavior "door.hsm"` links a component to the state machine of a file (relative to the structure file);
`behavior Door` names a state machine of an imported `.hsm` file. The ports must match the interfaces of
the state machine's definition section (the internal scope does not count):

| Port | State machine |
|---|---|
| `provides async p : …` | every event `e` of the port is an `in event e` |
| `requires async r : …` | every event `e` of the port is an `out event e` |
| `provides sync p : T` | a variable or constant `p : T` (`var`, `var readonly`, `const`): the data the component provides |
| `requires sync r : T` | an operation `r` – a getter `operation r() : T` (the state machine reads the data) or a setter `operation r(value : T) : void` (the state machine passes the data, e.g. a PWM duty cycle) |

- Events are looked up in the interface named like the port first (`interface cmd: in event open` for the
  port `cmd`), then in the unnamed interface. Variables and operations are looked up in the unnamed
  interface, then in the named interfaces.
- The payload type of an event (and the type of a variable / operation) must be the same type as in the
  port (`integer` and `real` are different here); a missing, misdirected or differently typed element is
  an error.
- Every `in` / `out` event and every operation of the interfaces of the state machine should belong to a
  port: otherwise a warning names the port kind it belongs to.

The mapping is available as `behaviorMapping(component)` (dmf-behavior.ts) for tools (navigation from a
port to the state machine elements).

## Threads

A thread groups instances that run in the same thread of execution. Instances are declared in the thread
(`thread T { door : DoorController }`) or declared in the structure and assigned by name
(`thread T { door }`). An instance belongs to at most one thread.

- Annotations: `@priority(n)` (integer), `@period(10 ms)` (period of a cyclic thread, units `s`, `ms`,
  `us`, `ns`), `@stack(4096)` (stack size in bytes). Other annotations are reported as unknown; tools can
  register further names in `DMF_ANNOTATIONS` (dmf-validator.ts).
- **Instances outside of any thread** are passive: they run in the threads of their callers (e.g. a
  driver called synchronously). A composite instance outside of a thread contributes the threads of its
  own structure (the parts of `DriveUnit` run in `MotorTask`); a composite instance inside a thread runs
  those of its parts that are not assigned to a thread of their own structure in that thread.
- A connection between two instances of different threads crosses threads: an info diagnostic (the
  diagram draws it dashed). For a composite instance outside of any thread, the threads of the component
  ports the connection leads to inside the composite count (`door.motor -> drive.ctrl` crosses from
  `ControlTask` to `MotorTask`, see `connectionThreads` in dmf-routes.ts). Connections to passive instances
  are not reported.

## Route analysis

`dmf-routes.ts` computes the signal paths of a port or instance across connections, delegations and the
boundaries of composite instances, through all levels of the hierarchy (exported from the package index).
Endpoints are ports in the *instance tree* of a root structure (by default the structure containing the
start), so a structure that is instantiated several times has separate endpoints per instance path
(`drive.motor.ctrl`). All hops point in request direction (see above); a `boundary` hop connects the port
of a composite instance with the same port seen from inside the composite.

| Function | Result |
|---|---|
| `portRoute(start, direction = 'both')` | endpoints and hops reachable from the start endpoint(s): the whole net (`both`), towards the providers (`forward`) or the requirers (`backward`) |
| `routeOf(node, { root? })` | the route of a model element: port reference, connection, delegation, instance, port, structure |
| `findProviders(endpoint)` / `findRequirers(endpoint)` | the ends of the route: providing ports of components (or required boundary ports of the root: provided by the environment) / requiring ports |
| `providersOf(node, { root? })` | "go to provider" of the ports at a model element |
| `routeEndpointsOf(node, { root? })`, `endpointsOfPort(root, port)`, `structureContexts(root)` | endpoints of model elements, the instance tree |
| `endpointLabel(endpoint)`, `endpointKey(endpoint)`, `sameEndpoint(a, b)` | names (`drive.motor.ctrl`) and identity of endpoints |

## Diagram

The diagram of a structure file is an internal block diagram (IBD) in the style of SysML, in the themes of
the state machine diagrams (PlantUML classic / modern, dark). It is shown by the web editor (read only: the
text is edited, the diagram follows) and rendered by `hsm render` ([rendering](rendering.md)):

![The garage door system](examples/GarageDoor.svg)

| Element | Notation |
|---|---|
| structure / system | a frame with the tab `ibd [system] GarageDoor`; its boundary ports on the border, labels outside |
| thread | a rounded, tinted frame `«thread» ControlTask` with its settings (`priority 5 · period 10 ms`) enclosing its instances |
| instance | a box `«component»` / `«structure»` and `name : Type`; an icon of two linked states: the component has a behavior state machine; the rake icon: a composite (a structure with an internal diagram of its own) |
| port | a small square on the border, the name inside the box: **filled** = provided, **hollow** = required |
| async / sync | async ports (events) show a chevron pointing in the direction the events flow – into the box for provided ports, out of it for required ports; sync ports (data) are plain squares |
| connection, delegation | solid orthogonal lines between the ports (no arrow heads: the port symbols show the direction); **dashed** if the connection crosses threads |

Instances outside of threads (passive instances, composites) are drawn directly in the frame. Ports are on
the side facing the ports they are connected to (by default provided ports left, required ports right),
ordered by the position of their partners, so a reply (`drive.status -> door.status`) needs no detour.

**Choosing what is shown.** The diagram shows the first `system` of the file, else its first
`structure`; a file with component types only shows them all as blocks with their ports (or one of
them). If the file declares several elements, a selector at the top of the diagram chooses the shown one;
moving the text cursor into another structure shows that one.

**Routes.** Selecting a port, a connection or an instance highlights the route of its signals
(`ibdRouteElements`, based on `routeOf` / `portRoute` of the route analysis): the ports, connectors and
instances on the route are drawn in orange, everything else is dimmed. The properties panel lists the
providers of a required port (the requirers of a provided port). Diagnostics are shown as markers at the
element (or at the tab of the frame).

**Diagram model** (`layoutStructure` in `src/diagram/ibd-layout.ts`, types in `ibd-model.ts`): stable ids
derived from the names – frame `GarageDoor`, boundary port `GarageDoor.remote`, thread
`GarageDoor/thread:ControlTask`, instance `GarageDoor/door`, port of an instance `GarageDoor/door.cmd`,
connection `GarageDoor/door.motor->drive.ctrl`, delegation `GarageDoor/remote->door.cmd`; the result maps
ids to AST nodes and back (`elements`, `ids`; ports of instances also to their instance, `instances`). The
layout uses ELK (layered, left to right, orthogonal routing, threads and the frame as compound nodes with
hierarchy handling, ports with fixed positions). Not supported yet: graphical editing, layout annotations
(manual layout) and navigation into the state machine or structure of an instance.

## Editor support

The structure language shares the services of the state machine languages (`createHsmServices` returns
`Dmf` next to `Hsm` and `HsmTest`), so `.dmf` files reference `.hsm` files and are revalidated when a
state machine they use changes. Language server features: formatter, completion (keywords, references,
type names), go to definition (component types, instances, ports, type names – also into C++ headers –,
import paths and the behavior file), go to implementation = go to the provider of a required port, hover
(signature and documentation comment) and document symbols. `DmfModelLoader` (hsm-document.ts) loads a
structure file with everything it imports outside of a language server.

The web app highlights `.dmf` files (generated Monarch grammar), offers completion, hover, formatting and
go to definition, and shows their diagram (see [Diagram](#diagram)); all files of `examples/device` are in
its list of examples and resolve their imports against each other.

Not (yet) supported: simulation and code generation of structures; state machines cannot use the structs
of structure files (share C/C++ headers instead).
