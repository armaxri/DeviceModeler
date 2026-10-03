import * as fs from 'node:fs';
import * as path from 'node:path';
import { AstUtils, URI, type LangiumDocument } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, test } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Diagnostic, LocationLink } from 'vscode-languageserver-types';
import * as ast from '../src/generated/ast.js';
import { behaviorMapping } from '../src/structure-behavior.js';
import { behaviorMachine, structureImportKind, resolvedStructureImports, visibleElements } from '../src/structure-imports.js';
import { compositeInstances, threadOf, threadSettings, threadInstances } from '../src/structure-model.js';
import { dataTypeOf, dataTypeName, isDataAssignable, portDataType, resolveDataType } from '../src/structure-types.js';
import { StructureModelLoader } from '../src/model-loader.js';
import { createDevmServices } from '../src/devm-module.js';
import { structureSignature } from '../src/lsp/structure-lsp.js';

const loader = new StructureModelLoader();
const services = loader.services as ReturnType<typeof createDevmServices>;

const DEVICE_DIR = path.resolve(__dirname, '../../../examples/device');

/** Loads a structure model; `files` are further files (`.devm` files, headers) by path relative to it. */
async function load(text: string, files?: Record<string, string>) {
    return loader.load(text, `file:///work/model-${counter++}/main.devm`, { files });
}
let counter = 0;

function messages(diagnostics: Diagnostic[], severity: number): string[] {
    return diagnostics.filter(d => d.severity === severity).map(d => d.message);
}
const errors = (parsed: { diagnostics: Diagnostic[] }) => messages(parsed.diagnostics, 1);
const warnings = (parsed: { diagnostics: Diagnostic[] }) => messages(parsed.diagnostics, 2);
const infos = (parsed: { diagnostics: Diagnostic[] }) => messages(parsed.diagnostics, 3);

const COMPONENTS = `
struct Point { x : real  y : real }
component Client {
    out async cmd : integer
    in sync pos : Point
}
component Server {
    in async cmd : integer
    out sync pos : Point
}
`;

/** A system with the components above and the given body. */
async function system(body: string, extra = '') {
    return load(`${COMPONENTS}\n${extra}\nsystem S {\n${body}\n}`);
}

describe('structure language: parsing', () => {
    test('import kinds', () => {
        expect(structureImportKind('a.devm')).toBe('model');
        expect(structureImportKind('door.DEVM')).toBe('model');
        expect(structureImportKind('types.hpp')).toBe('header');
        expect(structureImportKind('x.txt')).toBe('unsupported');
    });

    test('the AST of all elements', async () => {
        const parsed = await load(`
package demo
import "a.devm" "b.h"
/** A point. */
struct P { x : real; y : real }
component C "a component" {
    behavior "c.devm"
    in async p
    out async q : integer
    in sync r : P
    out sync s : P
    inout sync t : integer
}
subsystem Sub { in async p  thread T { c : C }  delegate p -> c.p }
system S {
    in sync d : P
    @priority(5) @period(10 ms) @stack(0x1000)
    thread T {
        c : C "first"
    }
    u : Sub
    e : C
    thread U { e }
    connect c.q -> e.p
    delegate d -> c.r
}`);
        expect(parsed.hasSyntaxErrors).toBe(false);
        const model = parsed.model;
        expect(model.package).toBe('demo');
        expect(model.imports[0].paths.map(p => p.path)).toEqual(['a.devm', 'b.h']);
        expect(model.elements.map(e => `${e.$type}:${e.name}`)).toEqual([
            'StructDeclaration:P', 'Component:C', 'CompositeType:Sub', 'CompositeType:S'
        ]);
        const component = model.elements[1] as ast.Component;
        expect(component.description).toBe('a component');
        expect(component.behavior?.path).toBe('c.devm');
        expect(component.ports.map(p => `${p.direction} ${p.kind} ${p.name}:${p.type?.name ?? ''}`)).toEqual([
            'in async p:', 'out async q:integer', 'in sync r:P', 'out sync s:P', 'inout sync t:integer'
        ]);
        expect(component.ports.map(p => dataTypeName(portDataType(p)))).toEqual(['void', 'integer', 'P', 'P', 'integer']);
        const root = model.elements[3] as ast.CompositeType;
        expect(root.kind).toBe('system');
        expect((model.elements[2] as ast.CompositeType).kind).toBe('subsystem');
        expect(compositeInstances(root).map(i => i.name)).toEqual(['c', 'u', 'e']);
        const [t, u] = root.threads;
        expect(threadSettings(t)).toEqual({ priority: 5, stack: 4096, periodNs: 10_000_000, period: '10 ms' });
        expect(threadInstances(u).map(i => i.name)).toEqual(['e']);
        expect(threadOf(compositeInstances(root)[2])).toBe(u);
        expect(root.connections[0].source.instance?.$refText).toBe('c');
        expect(root.delegations[0].source.instance).toBeUndefined();
    });

    test('syntax errors', async () => {
        const parsed = await load('component C { in cmd : I }');
        expect(parsed.hasSyntaxErrors).toBe(true);
    });

    test('the syntax of earlier versions gets a hint', async () => {
        const port = 'Ports are written \'in|out|inout sync|async name : Type\' (e.g. \'in async open\', \'out sync speed : integer\'); \'provides\' and \'requires\' are no longer supported.';
        for (const text of ['component C { provides async cmd : Cmd }', 'component C { requires sync pos : integer }', 'system S { provides async cmd : Cmd }']) {
            const parsed = await load(text);
            expect(parsed.diagnostics.map(d => d.message), text).toContain(port);
        }
        const parsed = await load('interface Cmd { event open }\ncomponent C { }');
        expect(parsed.diagnostics.map(d => d.message)).toContain(
            "Structure files have no interface declarations: an async port carries one event ('in async open', 'out async up : integer'). (In a state machine, interfaces are declared in its body.)");
        const later = await load('component C { }\ninterface Cmd { event open }');
        expect(later.diagnostics.map(d => d.message)).toContain(
            "Structure files have no interface declarations: an async port carries one event ('in async open', 'out async up : integer'). (In a state machine, interfaces are declared in its body.)");
    });
});

describe('structure language: the example', () => {
    const files = ['system.devm', 'components.devm', 'drive-unit.devm', 'types.devm', 'light.devm'];

    test.each(files)('examples/device/%s has no errors or warnings', async file => {
        const device = new StructureModelLoader(createDevmServices(NodeFileSystem));
        const location = path.join(DEVICE_DIR, file);
        const parsed = await device.load(fs.readFileSync(location, 'utf-8'), URI.file(location).toString());
        expect(errors(parsed)).toEqual([]);
        expect(warnings(parsed)).toEqual([]);
        for (const imported of parsed.imported) {
            expect(imported.hasErrors, imported.uri).toBe(false);
        }
        if (file === 'system.devm') {
            // (drive is a subsystem outside of threads: its parts run in the MotorTask)
            expect(infos(parsed)).toEqual([
                "The connection crosses threads ('ControlTask' -> 'MotorTask').",
                "The connection crosses threads ('ControlTask' -> 'MotorTask').",
                "The connection crosses threads ('ControlTask' -> 'MotorTask').",
                "The connection crosses threads ('MotorTask' -> 'ControlTask').",
                "The connection crosses threads ('MotorTask' -> 'ControlTask').",
                "The connection crosses threads ('IoTask' -> 'ControlTask').",
                "The connection crosses threads ('ControlTask' -> 'IoTask').",
                "The connection crosses threads ('ControlTask' -> 'IoTask')."
            ]);
            const door = (parsed.model.elements[0] as ast.CompositeType).threads[0].instances[0];
            const type = door.type.ref as ast.Component;
            expect(type.name).toBe('DoorController');
            expect(behaviorMachine(type)?.name).toBe('DoorController');
            // the ports are mapped onto the named interfaces `remote:` and `drive:` and the unnamed interface
            const mapping = behaviorMapping(type)!;
            expect(mapping.ports.map(p => `${p.port.name}:${(p.declaration?.$container as ast.InterfaceScope).name ?? ''}`)).toEqual([
                'open:remote', 'close:remote', 'stop:remote', 'stopped:drive', 'blocked:drive', 'up:drive', 'down:drive', 'halt:drive',
                'alarm:', 'position:', 'cycles:', 'errors:'
            ]);
            expect(mapping.ports.filter(p => p.problem)).toEqual([]);
            expect(mapping.unmapped).toEqual([]);
        }
    });
});

describe('structure language: linking across files', () => {
    const TYPES = 'package types\nstruct Position { x : real  y : real }\nstruct Speed { value : integer }';
    const PARTS = 'import "types.devm"\ncomponent Motor { in async ctrl : Speed  out sync pos : Position }';

    test('component types and structs of imported files', async () => {
        const parsed = await load(`
import "parts.devm"
import "types.devm"
component Ctl { out async m : types.Speed  in sync p : types.Position }
system S { thread T { m : Motor  c : Ctl }  connect c.m -> m.ctrl  connect m.pos -> c.p }`, { 'parts.devm': PARTS, 'types.devm': TYPES });
        expect(errors(parsed)).toEqual([]);
        const root = parsed.model.elements[1] as ast.CompositeType;
        const motor = root.threads[0].instances[0].type.ref!;
        expect(motor.name).toBe('Motor');
        expect(AstUtils.getDocument(motor).uri.path).toBe(parsed.document.uri.path.replace('main.devm', 'parts.devm'));
        expect(root.connections[0].target.port.ref?.name).toBe('ctrl');
        expect([...visibleElements(parsed.model).keys()]).toEqual(['Ctl', 'S', 'Motor', 'Position', 'types.Position', 'Speed', 'types.Speed']);
    });

    test('elements of files that are not imported are not visible', async () => {
        const parsed = await load('system S { thread T { m : Motor } }', { 'parts.devm': PARTS });
        expect(errors(parsed)).toEqual([expect.stringContaining("Could not resolve reference to ComponentType named 'Motor'")]);
    });

    test('imports that cannot be resolved', async () => {
        const parsed = await load('import "missing.devm"\nimport "notes.txt"\nimport "missing.h"\nsystem S {}');
        expect(errors(parsed)).toEqual([
            expect.stringMatching(/^Cannot resolve the import 'missing.devm': the file '.*missing.devm' was not found\.$/),
            expect.stringContaining("Cannot import 'notes.txt'"),
            expect.stringContaining("Cannot resolve the import 'missing.h': the header was not found")
        ]);
    });

    test('types of C++ headers', async () => {
        const header = 'namespace geo { struct Position { double x; double y; }; enum class Mode { A, B }; }';
        const parsed = await load(`
import "geo.h"
component C { out sync pos : geo::Position  out sync mode : geo::Mode  out sync n : uint8_t  out sync bad : geo::Missing }`,
        { 'geo.h': header });
        expect(errors(parsed)).toEqual(["Unknown type 'geo::Missing'."]);
        const ports = (parsed.model.elements[0] as ast.Component).ports;
        expect(ports.map(p => dataTypeName(dataTypeOf(p.type)))).toEqual(['geo::Position', 'geo::Mode', 'integer', 'unknown']);
        expect(resolvedStructureImports(parsed.model)[0].header?.found).toBe(true);
    });

    test('behavior by state machine name (`import "door.devm"`, `behavior Door`)', async () => {
        const parsed = await load('import "door.devm"\ncomponent C { behavior Door  in async open }', {
            'door.devm': 'statemachine Door { interface: in event open [*] -> A state A A -> A : open }'
        });
        expect(errors(parsed)).toEqual([]);
        expect(behaviorMachine(parsed.model.elements[0] as ast.Component)?.name).toBe('Door');
        const wrong = await load('component C { behavior Door }');
        expect(errors(wrong)).toEqual([expect.stringContaining("Could not resolve reference to StateMachine named 'Door'")]);
    });

    test('documents are relinked when a file they depend on changes', async () => {
        const parsed = await load('import "parts.devm"\ncomponent C { behavior "door.devm" }', {
            'parts.devm': 'component P { }',
            'door.devm': 'statemachine Door { [*] -> A state A }'
        });
        const resolver = services.Devm.references.StructureImportResolver;
        const sibling = (name: string) => parsed.document.uri.toString().replace('main.devm', name);
        expect(resolver.dependenciesChanged(parsed.model, new Set([sibling('door.devm')]))).toBe(true);
        expect(resolver.dependenciesChanged(parsed.model, new Set([sibling('parts.devm')]))).toBe(true);
        expect(resolver.dependenciesChanged(parsed.model, new Set([sibling('other.devm')]))).toBe(false);
        const missing = await load('component C { behavior "door.devm" }');
        expect(resolver.dependenciesChanged(missing.model, new Set())).toBe(true);
    });

    test('unresolved ports', async () => {
        const parsed = await system('thread T { c : Client  s : Server }  connect c.nothing -> s.cmd  connect x.cmd -> s.cmd  delegate missing -> s.cmd');
        expect(errors(parsed)).toEqual([
            "The component type 'Client' of 'c' has no port 'nothing' (ports: cmd, pos).",
            expect.stringContaining("Could not resolve reference to ComponentInstance named 'x'"),
            "Cannot resolve the port 'x.cmd': the instance 'x' is unknown.",
            "'S' has no boundary port 'missing'. Ports of instances are written 'instance.port'."
        ]);
    });
});

describe('structure language: validation', () => {
    test('a valid system', async () => {
        const parsed = await system('thread T { c : Client  s : Server }  connect c.cmd -> s.cmd  connect s.pos -> c.pos');
        expect(parsed.diagnostics).toEqual([]);
    });

    test('duplicate names', async () => {
        const parsed = await load(`
struct P { x : real  x : integer }
component P { in async p  out sync p : integer }
component K { }
system S { thread T { a : K } thread T { a : K } }
system integer { }`);
        expect(errors(parsed)).toEqual([
            "Duplicate name 'P'.",
            "'integer' is the name of a built-in type.",
            "Duplicate field 'x'.",
            "Duplicate port 'p'.",
            "Duplicate instance 'a'.",
            "Duplicate thread 'T'."
        ]);
    });

    test('types of ports and fields', async () => {
        const parsed = await load(`
struct P { self : P  v : void }
component K { }
component C {
    in async a : P
    out async b
    in sync c
    out sync d : Unknown
    inout sync e : void
    in sync f : K
}`);
        expect(errors(parsed)).toEqual([
            "The struct 'P' contains itself (through 'self').",
            "'void' is not a data type (the field 'v').",
            "The sync port 'c' carries data: write 'in sync c : Type' (a built-in type, a struct or a C/C++ type).",
            "Unknown type 'Unknown'.",
            "'void' is not a data type (the sync port 'e').",
            "'K' is a component type, not a data type."
        ]);
    });

    test('async ports are in or out ports', async () => {
        const parsed = await load('component C { inout async x : integer  inout sync y : integer }');
        expect(errors(parsed)).toEqual([
            "The async port 'x' cannot be 'inout': an event is sent ('out async') or received ('in async'). Shared data is an 'inout sync' port."
        ]);
    });

    test('connections go from out ports to in ports of instances', async () => {
        const parsed = await system(`
    in async x : integer
    thread T { c : Client  s : Server  t : Server }
    connect s.cmd -> c.cmd
    connect c.cmd -> c.cmd
    connect s.pos -> t.pos
    connect s.cmd -> t.cmd
    connect c.cmd -> x
    delegate x -> s.cmd`);
        expect(errors(parsed)).toEqual([
            "s.cmd (in async integer) cannot be connected to c.cmd (out async integer): the data flows from the out port c.cmd to the in port s.cmd: write 'connect c.cmd -> s.cmd'.",
            "c.cmd (out async integer) cannot be connected to c.cmd (out async integer): a connection goes from an out port to an in port, but c.cmd and c.cmd are both out ports.",
            "s.pos (out sync Point) cannot be connected to t.pos (out sync Point): a connection goes from an out port to an in port, but s.pos and t.pos are both out ports.",
            "s.cmd (in async integer) cannot be connected to t.cmd (in async integer): a connection goes from an out port to an in port, but s.cmd and t.cmd are both in ports.",
            "'connect' connects ports of parts ('a.port -> b.port'); boundary ports of 'S' are connected with 'delegate'."
        ]);
    });

    test('kinds, types and payloads of connected ports', async () => {
        const parsed = await load(`
struct P { x : real }
component A {
    out async none
    out async n : integer
    out async b : boolean
    out sync i : integer
    out sync r : real
    out async k
    out sync p : P
}
component B {
    in async none : integer
    in async n
    in async b : integer
    in sync i : real
    in sync r : integer
    in sync k : integer
    in sync p : P
}
system S {
    thread T { a : A  b : B }
    connect a.none -> b.none
    connect a.n -> b.n
    connect a.b -> b.b
    connect a.i -> b.i
    connect a.r -> b.r
    connect a.k -> b.k
    connect a.p -> b.p
}`);
        expect(errors(parsed)).toEqual([
            "a.none (out async) cannot be connected to b.none (in async integer): the event a.none has no payload, but b.none expects integer.",
            "a.n (out async integer) cannot be connected to b.n (in async): the event a.n carries integer, but b.n expects no payload.",
            "a.b (out async boolean) cannot be connected to b.b (in async integer): the payload boolean of a.b is not assignable to integer (expected by b.b).",
            "a.r (out sync real) cannot be connected to b.r (in sync integer): the data real of a.r is not assignable to integer (expected by b.r).",
            "a.k (out async) cannot be connected to b.k (in sync integer): a.k is an async port (an event), b.k is a sync port (data) – sync ports are connected with sync ports, async ports with async ports."
        ]);
        // every incompatibility is an error (integer -> real is allowed)
        expect(parsed.diagnostics.filter(d => d.severity !== 1 && /cannot be/.test(d.message))).toEqual([]);
    });

    test('inout ports share data with inout ports, in any order', async () => {
        const parsed = await load(`
component A { inout sync s : integer  out sync o : integer  inout sync r : real }
component B { inout sync s : integer  in sync i : integer  inout sync r : integer }
system S {
    thread T { a : A  b : B  c : B }
    connect a.s -> b.s
    connect c.s -> a.s
    connect a.s -> b.i
    connect a.o -> c.s
    connect a.r -> b.r
}`);
        expect(errors(parsed)).toEqual([
            "a.s (inout sync integer) cannot be connected to b.i (in sync integer): a.s is an inout port (shared data) and can only be connected to an inout port, but b.i is an in port.",
            "a.o (out sync integer) cannot be connected to c.s (inout sync integer): c.s is an inout port (shared data) and can only be connected to an inout port, but a.o is an out port.",
            "a.r (inout sync real) cannot be connected to b.r (inout sync integer): a.r and b.r share data of different types (real and integer)."
        ]);
        expect(warnings(parsed)).toEqual([
            "The in port 'c.i' is not connected: it receives no data.",
            "The inout port 'c.r' is not connected: it shares its data with no other port."
        ]);
    });

    test('delegations: in outer -> inner, out inner -> outer, inout both ways', async () => {
        const parsed = await system(`
    in async x : integer
    out async y : integer
    in sync p : Point
    out async z : boolean
    inout sync shared : integer
    inout sync other : integer
    thread T { c : Client  s : Server  d : Shared }
    delegate s.cmd -> x
    delegate y -> c.cmd
    delegate x -> c.cmd
    delegate x -> y
    delegate c.cmd -> z
    delegate p -> s.pos
    delegate shared -> d.v
    delegate d.v -> other
    delegate x -> d.v`, 'component Shared { inout sync v : integer }');
        expect(errors(parsed)).toEqual([
            "s.cmd (in async integer) cannot be delegated to x (in async integer): the data of an in port flows from the boundary to the part: write 'delegate x -> s.cmd'.",
            "y (out async integer) cannot be delegated to c.cmd (out async integer): the data of an out port flows from the part to the boundary: write 'delegate c.cmd -> y'.",
            "x (in async integer) cannot be delegated to c.cmd (out async integer): a delegation connects ports of the same direction, but x is an in port and c.cmd is an out port.",
            "A delegation connects a boundary port with a port of a part: 'delegate port -> part.port' (in) or 'delegate part.port -> port' (out).",
            "c.cmd (out async integer) cannot be delegated to z (out async boolean): the payload integer of c.cmd is not assignable to boolean (expected by z).",
            "p (in sync Point) cannot be delegated to s.pos (out sync Point): a delegation connects ports of the same direction, but p is an in port and s.pos is an out port.",
            "x (in async integer) cannot be delegated to d.v (inout sync integer): d.v is an inout port (shared data) and can only be delegated to an inout port, but x is an in port."
        ]);
    });

    test('unconnected ports and boundary ports', async () => {
        const parsed = await system(`
    in async x : integer
    out async y : integer
    inout sync z : integer
    thread T { c : Client  s : Server }`);
        expect(warnings(parsed)).toEqual([
            "The in port 'c.pos' is not connected: it receives no data.",
            "The in port 's.cmd' is not connected: it receives no events.",
            "The in port 'x' is not delegated to a part: nobody receives its events ('delegate x -> part.port').",
            "The out port 'y' is not delegated from a part: no part sends its events ('delegate part.port -> y').",
            "The inout port 'z' is not delegated to a part ('delegate z -> part.port')."
        ]);
        // out ports may be left unconnected
        expect(warnings(parsed).filter(w => w.includes('c.cmd') || w.includes('s.pos'))).toEqual([]);
    });

    test('a sync in port has one source, an async in port exactly one sender', async () => {
        const parsed = await system(`
    in sync p : Point
    out sync q : Point
    thread T { c : Client  s : Server  t : Server }
    connect s.pos -> c.pos
    connect t.pos -> c.pos
    connect c.cmd -> s.cmd
    connect c.cmd -> t.cmd
    connect c.cmd -> t.cmd
    delegate p -> c.pos
    delegate s.pos -> q
    delegate t.pos -> q`, 'component Second { out async cmd : integer }');
        expect(errors(parsed)).toEqual([
            "The sync port 'c.pos' receives its data from one source only, but it has 3 sources.",
            "The sync port 'c.pos' receives its data from one source only, but it has 3 sources.",
            "The sync port 'q' receives its data from one source only, but it has 2 sources."
        ]);
        expect(warnings(parsed)).toEqual(['Duplicate connection.']);
        // an async in port has exactly one sender (connected or delegated), like an async out boundary port
        const senders = await system(`
    in async x : integer
    out async y : integer
    thread T { c : Client  d : Client  s : Server }
    connect c.cmd -> s.cmd
    connect d.cmd -> s.cmd
    delegate x -> s.cmd
    delegate c.cmd -> y
    delegate d.cmd -> y
    connect s.pos -> c.pos
    connect s.pos -> d.pos`);
        expect(errors(senders)).toEqual([
            's.cmd already receives its events from c.cmd (connect) – an async in port has exactly one sender.',
            's.cmd already receives its events from c.cmd (connect) – an async in port has exactly one sender.',
            'y already receives its events from c.cmd (delegate) – an async out boundary port has exactly one sender.'
        ]);
        // an out port may have several targets (sync and async)
        const fanOut = await system(`
    thread T { c : Client  d : Client  s : Server  t : Server }
    connect c.cmd -> s.cmd
    connect c.cmd -> t.cmd
    connect s.pos -> c.pos
    connect s.pos -> d.pos`);
        expect(fanOut.diagnostics).toEqual([]);
    });

    test('an instance belongs to one thread', async () => {
        const parsed = await system(`
    thread A { c : Client  s }
    thread B { c  s  t }
    s : Server  t : Server
    thread C { t }
    connect c.cmd -> s.cmd  connect s.pos -> c.pos`);
        expect(errors(parsed)).toEqual([
            "The instance 'c' is already assigned to the thread 'A'. An instance belongs to one thread only.",
            "The instance 's' is already assigned to the thread 'A'. An instance belongs to one thread only.",
            "The instance 't' is already assigned to the thread 'B'. An instance belongs to one thread only."
        ]);
    });

    test('connections crossing threads are reported (info)', async () => {
        const parsed = await system(`
    thread A { c : Client  t : Server }
    thread B { s : Server }
    connect c.cmd -> s.cmd
    connect t.pos -> c.pos`);
        expect(infos(parsed)).toEqual(["The connection crosses threads ('A' -> 'B')."]);
    });

    test('instances of components run in threads, instances of subsystems outside of threads', async () => {
        const parsed = await system(`
    in async x : integer
    thread T { c : Client  inner : Sub }
    s : Server
    t : Server
    u : Sub
    thread U { t  u }
    connect c.cmd -> s.cmd  connect t.pos -> c.pos
    delegate x -> u.p`, 'subsystem Sub { in async p : integer  thread W { s : Server }  delegate p -> s.cmd }');
        expect(errors(parsed)).toEqual([
            "'inner' is an instance of the subsystem 'Sub' and cannot be placed in the thread 'T': the parts of a subsystem run in the threads of the subsystem. Declare 'inner' outside of the threads.",
            "'u' is an instance of the subsystem 'Sub' and cannot be assigned to the thread 'U': the parts of a subsystem run in the threads of the subsystem. Only instances of components are assigned to threads.",
            "The component instance 's' is outside of a thread: instances of components run in a thread. Declare it in a thread ('thread T { s : Server }') or assign it to one ('thread T { s }')."
        ]);
    });

    test('recursive instantiation and instances of systems', async () => {
        const parsed = await load(`
subsystem A { b : B }
subsystem B { a : A }
subsystem Self { me : Self }
system Root { a : A }
system Other { r : Root }`);
        expect(errors(parsed)).toEqual([
            'Recursive instantiation: A -> B -> A.',
            'Recursive instantiation: B -> A -> B.',
            'Recursive instantiation: Self -> Self.',
            "'Root' is a system and cannot be instantiated; declare it as 'subsystem Root' to use it as a part."
        ]);
    });

    test('thread annotations', async () => {
        const parsed = await system(`
    @priority(high) @period(10) @period(5 min) @stack(-1) @color("red")
    thread T { }
    @priority(1) @priority(2)
    thread U { }
    thread V { @period(1 ms) c : Client }`);
        expect(errors(parsed)).toEqual([
            'Invalid arguments: priority of the thread: @priority(5).',
            'Invalid arguments: period of a cyclic thread: @period(10 ms) (units s, ms, us, ns).',
            'Invalid arguments: period of a cyclic thread: @period(10 ms) (units s, ms, us, ns).',
            'Invalid arguments: stack size of the thread in bytes: @stack(4096).'
        ]);
        expect(warnings(parsed)).toEqual([
            "The in port 'c.pos' is not connected: it receives no data.",
            "'@period' is given more than once; the first one is used.",
            "Unknown annotation '@color'.",
            "'@priority' is given more than once; the first one is used.",
            "'@period' has no effect here (period of a cyclic thread: @period(10 ms) (units s, ms, us, ns))."
        ]);
    });
});

describe('structure language: ports and behavior', () => {
    const DOOR = `
statemachine Door {
    interface cmd:
        in event open
        in event close : integer
    interface:
        in event stopped : integer
        out event motor : integer
        out event alarm
        event both
        var count : integer = 0
        var readonly ratio : real = 0.5
        var shared : integer
        const limit : integer = 3
        operation position() : real
    interface other:
        var count2 : integer
        in event twice
    interface more:
        out event twice
    internal:
        event tick
        var hidden : integer
    [*] -> A
    state A
    A -> A : cmd.open / raise alarm; raise motor : 1
}`;

    async function component(ports: string) {
        return load(`component C {\n    behavior "door.devm"\n${ports}\n}`, { 'door.devm': DOOR });
    }

    test('ports matching the state machine: var, var readonly and events in all interfaces', async () => {
        const parsed = await component(`
    in async open
    in async close : integer
    in async stopped : integer
    in async both
    out async motor : integer
    out async alarm
    out sync count : integer
    in sync ratio : real
    inout sync shared : integer
    out sync count2 : integer`);
        expect(errors(parsed)).toEqual([]);
        // (`twice` is declared in two interfaces: no port can be mapped onto it)
        expect(warnings(parsed)).toEqual([
            "The in event 'twice' of the state machine 'Door' does not belong to any port of 'C' (add the port 'in async twice').",
            "The out event 'twice' of the state machine 'Door' does not belong to any port of 'C' (add the port 'out async twice')."
        ]);
        const mapping = behaviorMapping(parsed.model.elements[0] as ast.Component)!;
        expect(mapping.ports.map(p => `${p.port.name}:${p.declaration?.$type}`)).toEqual([
            'open:EventDeclaration', 'close:EventDeclaration', 'stopped:EventDeclaration', 'both:EventDeclaration', 'motor:EventDeclaration',
            'alarm:EventDeclaration', 'count:VariableDeclaration', 'ratio:VariableDeclaration', 'shared:VariableDeclaration', 'count2:VariableDeclaration'
        ]);
        // constants, operations and the internal scope are not mapped
        expect(mapping.unmapped.map(d => d.name)).toEqual(['twice', 'twice']);
    });

    test('mismatches', async () => {
        const parsed = await component(`
    in async open : integer
    in async shut
    out async stopped : integer
    in async motor : integer
    in async tick
    out async alarm : integer
    in sync count : integer
    out sync ratio : real
    inout sync position : real
    out sync limit : integer
    out sync close : integer
    in async count2
    out sync shared : real
    in async twice`);
        expect(errors(parsed)).toEqual([
            "The port 'open' carries integer, but the event 'open' of 'Door' carries no value.",
            "The state machine 'Door' has no element 'shut' for the port 'shut' (declare 'in event shut' in an interface).",
            "The out async port 'stopped' must be an out event of 'Door', but 'stopped' is an in event.",
            "The in async port 'motor' must be an in event of 'Door', but 'motor' is an out event.",
            "The state machine 'Door' has no element 'tick' for the port 'tick' (declare 'in event tick' in an interface).",
            "The port 'alarm' carries integer, but the event 'alarm' of 'Door' carries no value.",
            "The in port 'count' is written by its source: the variable 'count' of 'Door' must be read-only ('var readonly count : integer').",
            "The out port 'ratio' is written by the state machine: the variable 'ratio' of 'Door' must not be read-only ('var ratio : real').",
            "The sync port 'position' is data: 'position' of 'Door' must be 'var position : real', not an operation.",
            "The sync port 'limit' is data: 'limit' of 'Door' must be 'var limit : integer', not a constant.",
            "The sync port 'close' is data: 'close' of 'Door' must be 'var close : integer', not an event.",
            "The async port 'count2' is an event: 'count2' of 'Door' must be 'in event count2', not a variable.",
            "The variable 'shared' of 'Door' has the type integer, but the port has the type real.",
            "The port 'twice' is ambiguous: the state machine 'Door' declares 'twice' in interface other and interface more (port names are looked up in all interfaces)."
        ]);
        expect(warnings(parsed)).toEqual([
            "The in event 'close' of the state machine 'Door' does not belong to any port of 'C' (add the port 'in async close : integer').",
            "The in event 'both' of the state machine 'Door' does not belong to any port of 'C' (add the port 'in async both').",
            "The variable 'count2' of the state machine 'Door' does not belong to any port of 'C' (add the port 'out sync count2 : integer' or 'inout sync').",
            "The in event 'twice' of the state machine 'Door' does not belong to any port of 'C' (add the port 'in async twice').",
            "The out event 'twice' of the state machine 'Door' does not belong to any port of 'C' (add the port 'out async twice')."
        ]);
    });

    test('state machine elements without a port', async () => {
        const parsed = await component('in async open');
        expect(warnings(parsed)).toEqual([
            "The in event 'close' of the state machine 'Door' does not belong to any port of 'C' (add the port 'in async close : integer').",
            "The in event 'stopped' of the state machine 'Door' does not belong to any port of 'C' (add the port 'in async stopped : integer').",
            "The out event 'motor' of the state machine 'Door' does not belong to any port of 'C' (add the port 'out async motor : integer').",
            "The out event 'alarm' of the state machine 'Door' does not belong to any port of 'C' (add the port 'out async alarm').",
            "The in event 'both' of the state machine 'Door' does not belong to any port of 'C' (add the port 'in async both').",
            "The variable 'count' of the state machine 'Door' does not belong to any port of 'C' (add the port 'out sync count : integer' or 'inout sync').",
            "The read-only variable 'ratio' of the state machine 'Door' does not belong to any port of 'C' (add the port 'in sync ratio : real').",
            "The variable 'shared' of the state machine 'Door' does not belong to any port of 'C' (add the port 'out sync shared : integer' or 'inout sync').",
            "The variable 'count2' of the state machine 'Door' does not belong to any port of 'C' (add the port 'out sync count2 : integer' or 'inout sync').",
            "The in event 'twice' of the state machine 'Door' does not belong to any port of 'C' (add the port 'in async twice').",
            "The out event 'twice' of the state machine 'Door' does not belong to any port of 'C' (add the port 'out async twice')."
        ]);
    });

    test('a missing behavior file', async () => {
        const parsed = await load('component C { behavior "nothing.devm" }\ncomponent D { behavior "door.txt" }');
        expect(errors(parsed)).toEqual([
            expect.stringMatching(/^Cannot resolve the behavior 'nothing.devm': the state machine file '.*nothing.devm' was not found\.$/),
            "The behavior of a component is a state machine file ('.devm'), not 'door.txt'."
        ]);
    });

    test('structs of structure files match C++ structs with the same name', async () => {
        const header = 'namespace geo { struct Position { double x; double y; }; }';
        const parsed = await load(`
import "geo.h"
struct Position { x : real  y : real }
component C { behavior "m.devm"  out sync pos : Position  in async other : geo::Position }`, {
            'geo.h': header,
            'm.devm': 'statemachine M { import "geo.h" interface: var pos : geo::Position in event other : geo::Position [*] -> A state A }'
        });
        expect(errors(parsed)).toEqual([]);
        const [pos, other] = (parsed.model.elements[1] as ast.Component).ports;
        expect(isDataAssignable(dataTypeOf(pos.type), dataTypeOf(other.type))).toBe(true);
        expect(resolveDataType(pos.type).kind).toBe('data');
    });
});

describe('structure language: formatter and language server', () => {
    async function format(text: string): Promise<string> {
        const parsed = await load(text);
        const edits = await services.Devm.lsp.Formatter!.formatDocument(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() },
            options: { tabSize: 4, insertSpaces: true }
        });
        return TextDocument.applyEdits(parsed.document.textDocument, edits);
    }

    test('formatter', async () => {
        const text = 'import "a.devm" "b.h"\nstruct P{x:real;y:real}\ncomponent C "doc"{behavior "c.devm" in   async p:integer in sync q : P\nout async r  inout  sync s:P}\n/** The system. */\nsystem S{in async x:integer\n@priority( 5 ) @period(10ms)\nthread T{c:C\n  /** doc */\nd : C}\n e:C\nthread U {e}\nconnect c.r->d.p delegate x->c.p}';
        expect(await format(text)).toBe(`import "a.devm" "b.h"
struct P {
    x : real;
    y : real
}
component C "doc" {
    behavior "c.devm"
    in async p : integer
    in sync q : P
    out async r
    inout sync s : P
}
/** The system. */
system S {
    in async x : integer
    @priority(5) @period(10 ms)
    thread T {
        c : C
        /** doc */
        d : C
    }
    e : C
    thread U {
        e
    }
    connect c.r -> d.p
    delegate x -> c.p
}`);
    });

    test('the formatter keeps the examples', async () => {
        for (const file of ['system.devm', 'components.devm', 'drive-unit.devm', 'types.devm', 'light.devm']) {
            const text = fs.readFileSync(path.join(DEVICE_DIR, file), 'utf-8');
            expect(await format(text), file).toBe(text);
        }
    });

    const LSP_MAIN = `import "parts.devm"
struct Position { x : real }
/** Uses the motor. */
component Ctl { behavior "door.devm"  out async m : Speed  in sync p : real }
component Pos { out sync where : Position }
system S {
    @priority(3)
    thread T { c : Ctl }
    thread M { m : Motor }
    connect c.m -> m.ctrl
}`;
    const LSP_FILES = {
        'parts.devm': 'struct Speed { value : integer }\n/** Drives. */\ncomponent Motor { in async ctrl : Speed }',
        'door.devm': 'statemachine Door { interface: out event m : Speed var readonly p : real [*] -> A state A }'
    };

    function offsetOf(document: LangiumDocument, text: string, occurrence = 0): { line: number, character: number } {
        const content = document.textDocument.getText();
        let index = -1;
        for (let i = 0; i <= occurrence; i++) {
            index = content.indexOf(text, index + 1);
        }
        return document.textDocument.positionAt(index + 1);
    }

    async function definition(document: LangiumDocument, text: string, occurrence = 0): Promise<LocationLink[] | undefined> {
        return services.Devm.lsp.DefinitionProvider!.getDefinition(document, {
            textDocument: { uri: document.uri.toString() }, position: offsetOf(document, text, occurrence)
        });
    }

    test('go to definition', async () => {
        const parsed = await load(LSP_MAIN, LSP_FILES);
        expect(errors(parsed)).toEqual([]);
        const document = parsed.document;
        // type names: struct of the file, struct of an imported file
        const position = await definition(document, 'Position', 1);
        expect(position?.[0].targetUri).toBe(document.uri.toString());
        expect(position?.[0].targetSelectionRange.start.line).toBe(1);
        const speed = await definition(document, 'Speed');
        expect(speed?.[0].targetUri).toMatch(/parts\.devm$/);
        // component type of an instance, port of a connection, behavior file, import path
        expect((await definition(document, 'Motor'))?.[0].targetUri).toMatch(/parts\.devm$/);
        expect((await definition(document, 'ctrl'))?.[0].targetSelectionRange.start).toEqual({ line: 2, character: 27 });
        expect((await definition(document, 'door.devm'))?.[0].targetUri).toMatch(/door\.devm$/);
        expect((await definition(document, 'parts.devm'))?.[0].targetUri).toMatch(/parts\.devm$/);
    });

    test('go to implementation: the sources of the data of an in port', async () => {
        const parsed = await load(LSP_MAIN, LSP_FILES);
        const document = parsed.document;
        const links = await services.Devm.lsp.ImplementationProvider!.getImplementation(document, {
            textDocument: { uri: document.uri.toString() }, position: offsetOf(document, 'm.ctrl')
        });
        // the instance `c : Ctl` sends the data of `m.ctrl`
        expect(links?.map(l => l.targetSelectionRange.start)).toEqual([{ line: 7, character: 15 }]);
        // an out port of a component: the port itself
        const own = await services.Devm.lsp.ImplementationProvider!.getImplementation(document, {
            textDocument: { uri: document.uri.toString() }, position: offsetOf(document, 'c.m')
        });
        expect(own?.map(l => l.targetSelectionRange.start)).toEqual([{ line: 7, character: 15 }]);
    });

    test('hover and signatures', async () => {
        const parsed = await load(LSP_MAIN, LSP_FILES);
        const root = parsed.model.elements[3] as ast.CompositeType;
        const ctl = parsed.model.elements[1] as ast.Component;
        expect(structureSignature(ctl)).toBe('component Ctl (behavior "door.devm")');
        expect(structureSignature(ctl.ports[0])).toBe('out async m : Speed');
        expect(structureSignature(root.threads[0])).toBe('thread T (priority 3)');
        expect(structureSignature(root.threads[0].instances[0])).toBe('c : component Ctl (thread T)');
        expect(structureSignature(parsed.model.elements[0])).toBe('struct Position { x : real }');
        const hover = services.Devm.documentation.DocumentationProvider.getDocumentation(ctl);
        expect(hover).toBe('```devm\ncomponent Ctl (behavior "door.devm")\n```\n\nUses the motor.');
    });

    test('completion of type names', async () => {
        const parsed = await load('import "parts.devm"\nstruct Position { x : real }\ncomponent C { out sync p : \n}', LSP_FILES);
        const document = parsed.document;
        const list = await services.Devm.lsp.CompletionProvider!.getCompletion(document, {
            textDocument: { uri: document.uri.toString() }, position: { line: 2, character: 32 }
        });
        const labels = list?.items.map(i => i.label) ?? [];
        expect(labels).toEqual(expect.arrayContaining(['integer', 'real', 'boolean', 'string', 'Position', 'Speed']));
        expect(labels).not.toContain('void');
    });

    test('completion of instance types: components in threads, subsystems outside of them', async () => {
        const text = 'component A { }\ncomponent B { }\nsubsystem Sub { }\nsystem Top { }\nsystem S {\n    thread T {\n        a : \n    }\n    s : \n}';
        const parsed = await load(text);
        const complete = async (line: number, character: number) => {
            const list = await services.Devm.lsp.CompletionProvider!.getCompletion(parsed.document, {
                textDocument: { uri: parsed.document.uri.toString() }, position: { line, character }
            });
            return (list?.items ?? []).map(i => i.label).filter(l => /^[A-Z]/.test(l)).sort();
        };
        expect(await complete(6, 12)).toEqual(['A', 'B']);
        expect(await complete(8, 8)).toEqual(['Sub']);
    });

    test('document symbols', async () => {
        const parsed = await load(LSP_MAIN, LSP_FILES);
        const symbols = await services.Devm.lsp.DocumentSymbolProvider!.getSymbols(parsed.document, { textDocument: { uri: parsed.document.uri.toString() } });
        expect(symbols.map(s => s.name)).toEqual(['Position', 'Ctl', 'Pos', 'S']);
        expect(symbols[3].children?.map(s => s.name)).toEqual(['T', 'M']);
    });
});
