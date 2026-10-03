/*
 * Structure grammar of the Device Modeler: the structure of a product (component types, ports,
 * subsystems, threads, instances and connections) in `.devm` files, modeled alongside the state machines
 * (also `.devm` files, hsm.langium) that describe the behavior of its components. A `.devm` file contains
 * either a state machine or structure elements; devm.langium combines both grammars into the one
 * language of `.devm` files.
 *
 *   import "types.devm"
 *
 *   interface DoorCmd {
 *       event open
 *       event close
 *   }
 *
 *   component DoorController "controls the door" {
 *       behavior "door.devm"
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

// (`package`, then imports, then elements, all optional, but not nothing at all: an alternative that
// can be empty would be predicted for every state machine file with a syntax error, see devm.langium;
// an empty file is an empty structure file, see devm-parser.ts)
entry DmfModel:
    'package' package=DmfQualifiedName imports+=DmfImport* elements+=DmfElement*
    | imports+=DmfImport+ elements+=DmfElement*
    | elements+=DmfElement+;

// ---------------------------------------------------------------------------------------------
// Imports

// `import "motor.devm"` (component types, structs and interfaces of another structure file, or the
// state machine of a state machine file for `behavior Door`) and `import "types.h"` (C/C++ types of a
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
    annotations+=DmfAnnotation* 'struct' name=DmfId (description=STRING)? '{'
        (fields+=StructField (',' | ';')?)*
    '}';

StructField:
    name=DmfId ':' type=DataTypeReference;

// A named group of events (the type of async ports): `interface DoorCmd { event open event close }`.
PortInterface:
    annotations+=DmfAnnotation* 'interface' name=DmfId (description=STRING)? '{'
        (events+=PortEvent (',' | ';')?)*
    '}';

PortEvent:
    'event' name=DmfId (':' type=DataTypeReference)?;

// Built-in types (integer, real, boolean, string), structs, interfaces (`pkg.Name` for an element of
// an imported file with a package) and C++ types of imported headers (`motor::Mode`, `uint8_t`).
DataTypeReference:
    name=DmfTypeReferenceName;

// ---------------------------------------------------------------------------------------------
// Components, subsystems and systems

ComponentType:
    Component | Structure;

// An atomic component type: ports and (optionally) the state machine implementing its behavior.
Component:
    annotations+=DmfAnnotation* 'component' name=DmfId (description=STRING)? '{'
        behavior=Behavior?
        ports+=Port*
    '}';

// `behavior "door.devm"` (the state machine of the file) or `behavior Door` (a state machine of an
// imported state machine file).
Behavior:
    'behavior' (path=STRING | machine=[StateMachine:DmfId]);

// A composite: a `subsystem` (a composite component type, instantiated in other subsystems and
// systems) or the root of a product (`system`): boundary ports, threads with the instances of
// components, instances of subsystems (outside of the threads: their parts run in threads of their
// own), connections and delegations. (The AST type `Structure` covers both kinds.)
//
// Where an instance may be declared depends on the kind of its type, which is known only after
// linking: instances of components belong into threads, instances of subsystems outside of them.
// The validator checks this (dmf-validator.ts checkInstance / checkThreadMember) with messages telling
// where to put the instance; a grammar rule per kind would only report unresolvable references.
Structure:
    annotations+=DmfAnnotation* kind=('subsystem' | 'system') name=DmfId (description=STRING)? '{'
        (ports+=Port | threads+=Thread | instances+=ComponentInstance | connections+=Connection | delegations+=Delegation)*
    '}';

// `provides async cmd : DoorCmd`, `requires async motor : event start : integer, event stop`,
// `requires sync pos : Position`. Async ports carry events (an interface or an inline list of events),
// sync ports a data type.
Port:
    annotations+=DmfAnnotation* direction=('provides' | 'requires') kind=('sync' | 'async') name=DmfId ':'
        (events+=PortEvent (',' events+=PortEvent)* | type=DataTypeReference);

// ---------------------------------------------------------------------------------------------
// Threads, instances, connections

// A thread of execution: the component instances declared in it (`door : DoorController`) or assigned
// to it by name (`door`, for a component instance declared in the body of the subsystem). Annotations:
// `@priority(5)`, `@period(10 ms)`, `@stack(4096)`.
Thread:
    annotations+=DmfAnnotation* 'thread' name=DmfId (description=STRING)? '{'
        (instances+=ComponentInstance | members+=ThreadMember)*
    '}';

ThreadMember:
    instance=[ComponentInstance:DmfId];

ComponentInstance:
    annotations+=DmfAnnotation* name=DmfId ':' type=[ComponentType:DmfQualifiedName] (description=STRING)?;

// `connect door.motor -> motor.ctrl`: a required port to a provided port of another instance.
Connection:
    annotations+=DmfAnnotation* 'connect' source=PortReference '->' target=PortReference;

// `delegate diag -> door.cmd` (provided boundary port to a provided port of an instance) and
// `delegate door.log -> log` (required port of an instance to a required boundary port).
Delegation:
    annotations+=DmfAnnotation* 'delegate' source=PortReference '->' target=PortReference;

// `inst.port` (a port of an instance) or `port` (a boundary port of the enclosing structure).
PortReference:
    (instance=[ComponentInstance:DmfId] '.')? port=[Port:DmfId];

// ---------------------------------------------------------------------------------------------
// Annotations

// `@priority(5)`, `@period(10 ms)`, `@stack(4096)`, `@at(10, -20)`, `@note("text")`.
DmfAnnotation:
    '@' name=DmfId ('(' (arguments+=AnnotationArgument (',' arguments+=AnnotationArgument)*)? ')')?;

AnnotationArgument:
    number=SignedNumber unit=ID? | text=STRING | name=DmfId;

SignedNumber returns string:
    '-'? (INT | REAL | HEX);

// ---------------------------------------------------------------------------------------------
// Names

// A name of the structure language. The keywords of the state machine language are keywords in
// structure files as well (one language, devm.langium); they are accepted as names here (`in`, `state`,
// `entry`, ...), so they can be used like before the merge (completion does not propose them).
DmfId returns string:
    ID | 'statemachine' | 'namespace' | 'internal' | 'in' | 'out' | 'const' | 'var' | 'readonly' | 'operation'
    | 'alias' | 'state' | 'region' | 'choice' | 'junction' | 'history' | 'deephistory' | 'entry' | 'exit'
    | 'after' | 'every' | 'always' | 'oncycle' | 'else' | 'default' | 'raise' | 'as' | 'valueof' | 'active'
    | 'true' | 'false' | 'null';

DmfQualifiedName returns string:
    DmfId ('.' DmfId)*;

DmfTypeReferenceName returns string:
    '::'? DmfId (('.' | '::') DmfId)*;
