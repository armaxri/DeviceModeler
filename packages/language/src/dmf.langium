/*
 * Structure language of the Device Modeling Framework (DMF), file extension `.dmf`: the structure of
 * a product (component types, ports, composite structures, threads, instances and connections),
 * modeled alongside the state machines (`.hsm`) that describe the behavior of its components:
 *
 *   import "types.dmf"
 *
 *   interface DoorCmd {
 *       event open
 *       event close
 *   }
 *
 *   component DoorController "controls the door" {
 *       behavior "door.hsm"
 *       provides async cmd   : DoorCmd
 *       requires async motor : event start : integer, event stop
 *       requires sync  pos   : Position
 *   }
 *
 *   system Car {
 *       provides async diag : event request
 *       @priority(5) @period(10 ms)
 *       thread ControlTask {
 *           door  : DoorController
 *           motor : MotorDriver
 *       }
 *       connect door.motor -> motor.ctrl          // required -> provided
 *       delegate diag -> door.cmd                 // outer provided -> inner provided
 *   }
 *
 * Types (built-in types, structs, interfaces, C++ types of imported headers) are referenced by name
 * and resolved by dmf-types.ts, component types, instances and ports are cross-references (see
 * dmf-scope.ts). The rules (directions, kinds, types, threads, behavior) are checked by
 * dmf-validator.ts and documented in docs/structure-language.md.
 */
grammar Dmf
import './hsm'

entry DmfModel:
    ('package' package=QualifiedName)?
    imports+=DmfImport*
    elements+=DmfElement*;

// ---------------------------------------------------------------------------------------------
// Imports

// `import "motor.dmf"` (component types, structs and interfaces of another structure file),
// `import "door.hsm"` (state machines for `behavior Door`) and `import "types.h"` (C/C++ types of a
// header). Paths are resolved relative to the importing file, headers also relative to the include
// paths (see dmf-imports.ts).
DmfImport:
    'import' paths+=DmfImportPath+;

DmfImportPath:
    path=STRING;

// ---------------------------------------------------------------------------------------------
// Types

DmfElement:
    StructDeclaration | PortInterface | ComponentType;

// `struct Position { x : real  y : real }`: a data type of sync ports and event payloads.
StructDeclaration:
    annotations+=DmfAnnotation* 'struct' name=ID (description=STRING)? '{'
        (fields+=StructField (',' | ';')?)*
    '}';

StructField:
    name=ID ':' type=DataTypeReference;

// A named group of events (the type of async ports): `interface DoorCmd { event open event close }`.
PortInterface:
    annotations+=DmfAnnotation* 'interface' name=ID (description=STRING)? '{'
        (events+=PortEvent (',' | ';')?)*
    '}';

PortEvent:
    'event' name=ID (':' type=DataTypeReference)?;

// Built-in types (integer, real, boolean, string), structs, interfaces (`pkg.Name` for an element of
// an imported file with a package) and C++ types of imported headers (`motor::Mode`, `uint8_t`).
DataTypeReference:
    name=TypeReferenceName;

// ---------------------------------------------------------------------------------------------
// Components and structures

ComponentType:
    Component | Structure;

// An atomic component type: ports and (optionally) the state machine implementing its behavior.
Component:
    annotations+=DmfAnnotation* 'component' name=ID (description=STRING)? '{'
        behavior=Behavior?
        ports+=Port*
    '}';

// `behavior "door.hsm"` (the state machine of the file) or `behavior Door` (a state machine of an
// imported `.hsm` file).
Behavior:
    'behavior' (path=STRING | machine=[StateMachine:ID]);

// A composite component type (`structure`) or the root of a product (`system`): boundary ports,
// threads, instances of component types, connections and delegations.
Structure:
    annotations+=DmfAnnotation* kind=('structure' | 'system') name=ID (description=STRING)? '{'
        (ports+=Port | threads+=Thread | instances+=ComponentInstance | connections+=Connection | delegations+=Delegation)*
    '}';

// `provides async cmd : DoorCmd`, `requires async motor : event start : integer, event stop`,
// `requires sync pos : Position`. Async ports carry events (an interface or an inline list of events),
// sync ports a data type.
Port:
    annotations+=DmfAnnotation* direction=('provides' | 'requires') kind=('sync' | 'async') name=ID ':'
        (events+=PortEvent (',' events+=PortEvent)* | type=DataTypeReference);

// ---------------------------------------------------------------------------------------------
// Threads, instances, connections

// A thread of execution: the instances declared in it (`door : DoorController`) or assigned to it by
// name (`door`, for instances declared outside of any thread). Annotations: `@priority(5)`,
// `@period(10 ms)`, `@stack(4096)`.
Thread:
    annotations+=DmfAnnotation* 'thread' name=ID (description=STRING)? '{'
        (instances+=ComponentInstance | members+=ThreadMember)*
    '}';

ThreadMember:
    instance=[ComponentInstance:ID];

ComponentInstance:
    annotations+=DmfAnnotation* name=ID ':' type=[ComponentType:QualifiedName] (description=STRING)?;

// `connect door.motor -> motor.ctrl`: a required port to a provided port of another instance.
Connection:
    annotations+=DmfAnnotation* 'connect' source=PortReference '->' target=PortReference;

// `delegate diag -> door.cmd` (provided boundary port to a provided port of an instance) and
// `delegate door.log -> log` (required port of an instance to a required boundary port).
Delegation:
    annotations+=DmfAnnotation* 'delegate' source=PortReference '->' target=PortReference;

// `inst.port` (a port of an instance) or `port` (a boundary port of the enclosing structure).
PortReference:
    (instance=[ComponentInstance:ID] '.')? port=[Port:ID];

// ---------------------------------------------------------------------------------------------
// Annotations

// `@priority(5)`, `@period(10 ms)`, `@stack(4096)`, `@at(10, -20)`, `@note("text")`.
DmfAnnotation:
    '@' name=ID ('(' (arguments+=AnnotationArgument (',' arguments+=AnnotationArgument)*)? ')')?;

AnnotationArgument:
    number=SignedNumber unit=ID? | text=STRING | name=ID;

SignedNumber returns string:
    '-'? (INT | REAL | HEX);
