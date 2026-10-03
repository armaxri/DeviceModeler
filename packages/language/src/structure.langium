/*
 * Structure grammar of the Device Modeler: the structure of a product (component types, ports,
 * subsystems, threads, instances and connections) in `.devm` files, modeled alongside the state machines
 * (also `.devm` files, statemachine.langium) that describe the behavior of its components. A `.devm` file contains
 * either a state machine or structure elements; devm.langium combines both grammars into the one
 * language of `.devm` files.
 *
 *   import "types.devm"
 *
 *   component DoorController "controls the door" {
 *       behavior "door.devm"
 *       in async open                 // an event without data
 *       out async up : integer        // an event carrying data
 *       in sync pos : Position        // data
 *       inout sync errors : integer   // shared data
 *   }
 *
 *   subsystem Car {
 *       in async open
 *       @priority(5) @period(10 ms)
 *       thread ControlTask {
 *           door  : DoorController
 *           motor : MotorDriver
 *       }
 *       connect door.up -> motor.up               // out -> in (data flow)
 *       delegate open -> door.open                // outer in -> inner in
 *   }
 *
 *   system Garage {                               // the closed top level: no ports
 *       thread UiTask { remote : RemoteControl }
 *       car : Car
 *       connect remote.open -> car.open
 *   }
 *
 * Types (built-in types, structs, C++ types of imported headers) are referenced by name
 * and resolved by structure-types.ts, component types, instances and ports are cross-references (see
 * structure-scope.ts). The rules (directions, kinds, types, threads, behavior) are checked by
 * structure-validator.ts and documented in docs/structure-language.md.
 */
grammar Structure
import './statemachine'

// (`package`, then imports, then elements, all optional, but not nothing at all: an alternative that
// can be empty would be predicted for every state machine file with a syntax error, see devm.langium;
// an empty file is an empty structure file, see devm-parser.ts)
entry StructureModel:
    'package' package=StructureQualifiedName imports+=StructureImport* elements+=StructureElement*
    | imports+=StructureImport+ elements+=StructureElement*
    | elements+=StructureElement+;

// ---------------------------------------------------------------------------------------------
// Imports

// `import "motor.devm"` (component types and structs of another structure file, or the
// state machine of a state machine file for `behavior Door`) and `import "types.h"` (C/C++ types of a
// header). Paths are resolved relative to the importing file, headers also relative to the include
// paths (see structure-imports.ts).
StructureImport:
    'import' paths+=StructureImportPath+;

StructureImportPath:
    path=STRING;

// ---------------------------------------------------------------------------------------------
// Types

StructureElement:
    StructDeclaration | ComponentType;

// `struct Position { x : real  y : real }`: a data type of ports.
StructDeclaration:
    annotations+=StructureAnnotation* 'struct' name=StructureId (description=STRING)? '{'
        (fields+=StructField (',' | ';')?)*
    '}';

StructField:
    name=StructureId ':' type=DataTypeReference;

// Built-in types (integer, real, boolean, string), structs (`pkg.Name` for an element of
// an imported file with a package) and C++ types of imported headers (`motor::Mode`, `uint8_t`).
DataTypeReference:
    name=StructureTypeReferenceName;

// ---------------------------------------------------------------------------------------------
// Components, subsystems and systems

ComponentType:
    Component | CompositeType;

// An atomic component type: ports and (optionally) the state machine implementing its behavior.
Component:
    annotations+=StructureAnnotation* 'component' name=StructureId (description=STRING)? '{'
        behavior=Behavior?
        ports+=Port*
    '}';

// `behavior "door.devm"` (the state machine of the file) or `behavior Door` (a state machine of an
// imported state machine file).
Behavior:
    'behavior' (path=STRING | machine=[StateMachine:StructureId]);

// A composite: a `subsystem` (a composite component type, instantiated in other subsystems and
// systems) or the root of a product (`system`, closed: no ports and delegations – checked by the
// validator): boundary ports, threads with the instances of
// components, instances of subsystems (outside of the threads: their parts run in threads of their
// own), connections and delegations. (The AST type `CompositeType` covers both kinds.)
//
// Where an instance may be declared depends on the kind of its type, which is known only after
// linking: instances of components belong into threads, instances of subsystems outside of them.
// The validator checks this (structure-validator.ts checkInstance / checkThreadMember) with messages telling
// where to put the instance; a grammar rule per kind would only report unresolvable references.
CompositeType:
    annotations+=StructureAnnotation* kind=('subsystem' | 'system') name=StructureId (description=STRING)? '{'
        (ports+=Port | threads+=Thread | instances+=ComponentInstance | connections+=Connection | delegations+=Delegation)*
    '}';

// Ports carry data in a direction (data flow): `in sync pos : Position`, `out sync speed : integer`,
// `inout sync errors : integer` (sync: data values), `in async open`, `out async up : integer` (async:
// one event named like the port, with an optional payload). The type is required for sync ports and
// `inout` is not allowed for async ports (both checked by the validator).
Port:
    annotations+=StructureAnnotation* direction=('in' | 'out' | 'inout') kind=('sync' | 'async') name=StructureId
        (':' type=DataTypeReference)?;

// ---------------------------------------------------------------------------------------------
// Threads, instances, connections

// A thread of execution: the component instances declared in it (`door : DoorController`) or assigned
// to it by name (`door`, for a component instance declared in the body of the subsystem). Annotations:
// `@priority(5)`, `@period(10 ms)`, `@stack(4096)`.
Thread:
    annotations+=StructureAnnotation* 'thread' name=StructureId (description=STRING)? '{'
        (instances+=ComponentInstance | members+=ThreadMember)*
    '}';

ThreadMember:
    instance=[ComponentInstance:StructureId];

ComponentInstance:
    annotations+=StructureAnnotation* name=StructureId ':' type=[ComponentType:StructureQualifiedName] (description=STRING)?;

// `connect door.up -> motor.up`: an out port of a part to an in port of another part (the direction of
// the data flow); two inout ports in any order.
Connection:
    annotations+=StructureAnnotation* 'connect' source=PortReference '->' target=PortReference;

// `delegate open -> door.open` (in boundary port to an in port of a part) and `delegate diag.report ->
// report` (out port of a part to an out boundary port): in the direction of the data flow; inout ports in
// any order.
Delegation:
    annotations+=StructureAnnotation* 'delegate' source=PortReference '->' target=PortReference;

// `inst.port` (a port of an instance) or `port` (a boundary port of the enclosing structure).
PortReference:
    (instance=[ComponentInstance:StructureId] '.')? port=[Port:StructureId];

// ---------------------------------------------------------------------------------------------
// Annotations

// `@priority(5)`, `@period(10 ms)`, `@stack(4096)`, `@at(10, -20)`, `@note("text")`.
StructureAnnotation:
    '@' name=StructureId ('(' (arguments+=AnnotationArgument (',' arguments+=AnnotationArgument)*)? ')')?;

AnnotationArgument:
    number=SignedNumber unit=ID? | text=STRING | name=StructureId;

SignedNumber returns string:
    '-'? (INT | REAL | HEX);

// ---------------------------------------------------------------------------------------------
// Names

// A name of the structure language. The keywords of the state machine language are keywords in
// structure files as well (one language, devm.langium); they are accepted as names here (`in`, `state`,
// `entry`, ...), so they can be used like before the merge (completion does not propose them).
StructureId returns string:
    ID | 'statemachine' | 'namespace' | 'internal' | 'in' | 'out' | 'inout' | 'interface' | 'event' | 'const' | 'var' | 'readonly' | 'operation'
    | 'alias' | 'state' | 'region' | 'choice' | 'junction' | 'history' | 'deephistory' | 'entry' | 'exit'
    | 'after' | 'every' | 'always' | 'oncycle' | 'else' | 'default' | 'raise' | 'as' | 'valueof' | 'active'
    | 'true' | 'false' | 'null';

StructureQualifiedName returns string:
    StructureId ('.' StructureId)*;

StructureTypeReferenceName returns string:
    '::'? StructureId (('.' | '::') StructureId)*;
