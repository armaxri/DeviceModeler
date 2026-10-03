import * as fs from 'node:fs';
import * as path from 'node:path';
import { AstUtils, URI, type LangiumDocument } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, test } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Diagnostic, LocationLink } from 'vscode-languageserver-types';
import * as ast from '../src/generated/ast.js';
import { behaviorMapping } from '../src/dmf-behavior.js';
import { behaviorMachine, dmfImportKind, resolvedDmfImports, visibleElements } from '../src/dmf-imports.js';
import { structureInstances, threadOf, threadSettings, threadInstances } from '../src/dmf-model.js';
import { dataTypeOf, dmfTypeName, isDataAssignable, portEvents, resolveDataType } from '../src/dmf-types.js';
import { DmfModelLoader } from '../src/hsm-document.js';
import { createHsmServices } from '../src/hsm-module.js';
import { dmfSignature } from '../src/lsp/dmf-lsp.js';

const loader = new DmfModelLoader();
const services = loader.services as ReturnType<typeof createHsmServices>;

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
interface Cmd { event open event close }
struct Point { x : real  y : real }
component Client {
    requires async cmd : Cmd
    requires sync pos : Point
}
component Server {
    provides async cmd : Cmd
    provides sync pos : Point
}
`;

/** A system with the components above and the given body. */
async function system(body: string, extra = '') {
    return load(`${COMPONENTS}\n${extra}\nsystem S {\n${body}\n}`);
}

describe('structure language: parsing', () => {
    test('import kinds', () => {
        expect(dmfImportKind('a.devm')).toBe('model');
        expect(dmfImportKind('door.DEVM')).toBe('model');
        expect(dmfImportKind('types.hpp')).toBe('header');
        expect(dmfImportKind('x.txt')).toBe('unsupported');
    });

    test('the AST of all elements', async () => {
        const parsed = await load(`
package demo
import "a.devm" "b.h"
/** A point. */
struct P { x : real; y : real }
interface I { event a, event b : integer }
component C "a component" {
    behavior "c.devm"
    provides async p : I
    requires async q : event a, event b : integer
    requires sync r : P
}
subsystem Sub { provides async p : I  thread T { c : C }  delegate p -> c.p }
system S {
    provides sync d : P
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
            'StructDeclaration:P', 'PortInterface:I', 'Component:C', 'Structure:Sub', 'Structure:S'
        ]);
        const component = model.elements[2] as ast.Component;
        expect(component.description).toBe('a component');
        expect(component.behavior?.path).toBe('c.devm');
        expect(component.ports.map(p => `${p.direction} ${p.kind} ${p.name}`)).toEqual(['provides async p', 'requires async q', 'requires sync r']);
        expect(component.ports[1].events.map(e => `${e.name}:${e.type?.name ?? ''}`)).toEqual(['a:', 'b:integer']);
        const root = model.elements[4] as ast.Structure;
        expect(root.kind).toBe('system');
        expect((model.elements[3] as ast.Structure).kind).toBe('subsystem');
        expect(structureInstances(root).map(i => i.name)).toEqual(['c', 'u', 'e']);
        const [t, u] = root.threads;
        expect(threadSettings(t)).toEqual({ priority: 5, stack: 4096, periodNs: 10_000_000, period: '10 ms' });
        expect(threadInstances(u).map(i => i.name)).toEqual(['e']);
        expect(threadOf(structureInstances(root)[2])).toBe(u);
        expect(root.connections[0].source.instance?.$refText).toBe('c');
        expect(root.delegations[0].source.instance).toBeUndefined();
    });

    test('syntax errors', async () => {
        const parsed = await load('component C { provides cmd : I }');
        expect(parsed.hasSyntaxErrors).toBe(true);
    });
});

describe('structure language: the example', () => {
    const files = ['system.devm', 'components.devm', 'drive-unit.devm', 'types.devm', 'light.devm'];

    test.each(files)('examples/device/%s has no errors or warnings', async file => {
        const device = new DmfModelLoader(createHsmServices(NodeFileSystem));
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
                "The connection crosses threads ('MotorTask' -> 'ControlTask').",
                "The connection crosses threads ('ControlTask' -> 'IoTask').",
                "The connection crosses threads ('IoTask' -> 'ControlTask')."
            ]);
            const door = (parsed.model.elements[0] as ast.Structure).threads[0].instances[0];
            const type = door.type.ref as ast.Component;
            expect(type.name).toBe('DoorController');
            expect(behaviorMachine(type)?.name).toBe('DoorController');
            // `cmd` is mapped onto the named interface `cmd:` of the state machine
            const mapping = behaviorMapping(type)!;
            expect(mapping.ports[0].events.map(e => e.declaration?.$container.name)).toEqual(['cmd', 'cmd', 'cmd']);
            expect(mapping.unmapped).toEqual([]);
        }
    });
});

describe('structure language: linking across files', () => {
    const TYPES = 'package types\nstruct Position { x : real  y : real }\ninterface Cmd { event go }';
    const PARTS = 'import "types.devm"\ncomponent Motor { provides async ctrl : Cmd  provides sync pos : Position }';

    test('component types, structs and interfaces of imported files', async () => {
        const parsed = await load(`
import "parts.devm"
import "types.devm"
component Ctl { requires async m : types.Cmd  requires sync p : types.Position }
system S { thread T { m : Motor  c : Ctl }  connect c.m -> m.ctrl  connect c.p -> m.pos }`, { 'parts.devm': PARTS, 'types.devm': TYPES });
        expect(errors(parsed)).toEqual([]);
        const root = parsed.model.elements[1] as ast.Structure;
        const motor = root.threads[0].instances[0].type.ref!;
        expect(motor.name).toBe('Motor');
        expect(AstUtils.getDocument(motor).uri.path).toBe(parsed.document.uri.path.replace('main.devm', 'parts.devm'));
        expect(root.connections[0].target.port.ref?.name).toBe('ctrl');
        expect([...visibleElements(parsed.model).keys()]).toEqual(['Ctl', 'S', 'Motor', 'Position', 'types.Position', 'Cmd', 'types.Cmd']);
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
component C { provides sync pos : geo::Position  provides sync mode : geo::Mode  provides sync n : uint8_t  provides sync bad : geo::Missing }`,
        { 'geo.h': header });
        expect(errors(parsed)).toEqual(["Unknown type 'geo::Missing'."]);
        const ports = (parsed.model.elements[0] as ast.Component).ports;
        expect(ports.map(p => dmfTypeName(dataTypeOf(p.type)))).toEqual(['geo::Position', 'geo::Mode', 'integer', 'unknown']);
        expect(resolvedDmfImports(parsed.model)[0].header?.found).toBe(true);
    });

    test('behavior by state machine name (`import "door.devm"`, `behavior Door`)', async () => {
        const parsed = await load('import "door.devm"\ncomponent C { behavior Door  provides async cmd : event open }', {
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
        const resolver = services.Dmf.references.DmfImportResolver;
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
        const parsed = await system('thread T { c : Client  s : Server }  connect c.cmd -> s.cmd  connect c.pos -> s.pos');
        expect(parsed.diagnostics).toEqual([]);
    });

    test('duplicate names', async () => {
        const parsed = await load(`
struct P { x : real  x : integer }
interface I { event a event a }
component P { provides async p : event e, event e  provides sync p : integer }
component K { }
system S { thread T { a : K } thread T { a : K } }
system integer { }`);
        expect(errors(parsed)).toEqual([
            "Duplicate name 'P'.",
            "'integer' is the name of a built-in type.",
            "Duplicate field 'x'.",
            "Duplicate event 'a'.",
            "Duplicate port 'p'.",
            "Duplicate event 'e'.",
            "Duplicate instance 'a'.",
            "Duplicate thread 'T'."
        ]);
    });

    test('types of ports, events and fields', async () => {
        const parsed = await load(`
struct P { self : P  i : I  v : void }
interface I { event a : I }
component C {
    provides async a : P
    provides sync b : I
    provides sync c : event x
    provides sync d : Unknown
    provides async e : I
}`);
        expect(errors(parsed)).toEqual([
            "The struct 'P' contains itself (through 'self').",
            "The interface 'I' is not a data type: it can only be the type of an async port (the field 'i').",
            "'void' is not a data type (the field 'v').",
            "The interface 'I' is not a data type: it can only be the type of an async port (the event 'a').",
            expect.stringContaining("The async port 'a' carries events: its type must be an interface"),
            "The interface 'I' is not a data type: it can only be the type of an async port (the sync port 'b').",
            "The sync port 'c' carries data, not events: write 'sync c : Type' or declare it 'async'.",
            "Unknown type 'Unknown'."
        ]);
    });

    test('connections go from required to provided ports of instances', async () => {
        const parsed = await system(`
    provides async x : Cmd
    thread T { c : Client  s : Server  t : Server }
    connect s.cmd -> c.cmd
    connect c.cmd -> c.cmd
    connect s.pos -> t.pos
    connect c.cmd -> x
    delegate x -> s.cmd`);
        expect(errors(parsed)).toEqual([
            "Connections go from the required to the provided port: write 'connect c.cmd -> s.cmd'.",
            "The target 'c.cmd' of a connection must be a provided port.",
            "The source 's.pos' of a connection must be a required port.",
            "'connect' connects ports of parts ('a.port -> b.port'); boundary ports of 'S' are connected with 'delegate'."
        ]);
    });

    test('kinds and types of connected ports', async () => {
        const parsed = await load(`
interface Small { event open }
interface Big { event open : integer  event close }
component A {
    requires async big : Big
    requires async small : Small
    requires sync n : real
    requires sync i : integer
    requires async k : Small
}
component B {
    provides async big : Big
    provides async small : Small
    provides sync n : integer
    provides sync r : real
}
system S {
    thread T { a : A  b : B }
    connect a.big -> b.small
    connect a.small -> b.big
    connect a.n -> b.n
    connect a.i -> b.r
    connect a.k -> b.n
}`);
        expect(errors(parsed)).toEqual([
            "Incompatible ports 'a.big' and 'b.small': the event 'open' carries integer, but 'small' expects no value; the event 'close' is not accepted by 'small'.",
            "Incompatible ports 'a.small' and 'b.big': the event 'open' carries no value, but 'big' expects integer.",
            "Incompatible ports 'a.i' and 'b.r': the type real of 'r' is not compatible with the type integer of 'i'.",
            "Incompatible ports 'a.k' and 'b.n': 'k' is async, 'n' is sync."
        ]);
    });

    test('delegations: provided outer -> inner, required inner -> outer', async () => {
        const parsed = await system(`
    provides async x : Cmd
    requires async y : Cmd
    provides sync p : Point
    requires async z : event other
    thread T { c : Client  s : Server }
    delegate s.cmd -> x
    delegate y -> c.cmd
    delegate x -> c.cmd
    delegate x -> y
    delegate c.cmd -> z
    delegate p -> s.pos`);
        expect(errors(parsed)).toEqual([
            "A provided port is delegated from the boundary to the part: write 'delegate x -> s.cmd'.",
            "A required port is delegated from the part to the boundary: write 'delegate c.cmd -> y'.",
            "A delegation connects ports of the same direction, but 'x' is provided and 'c.cmd' is required.",
            "A delegation connects a boundary port with a port of a part: 'delegate port -> part.port' (provided) or 'delegate part.port -> port' (required).",
            "Incompatible ports 'c.cmd' and 'z': the event 'open' is not accepted by 'z'; the event 'close' is not accepted by 'z'."
        ]);
    });

    test('unconnected ports and boundary ports', async () => {
        const parsed = await system(`
    provides async x : Cmd
    requires async y : Cmd
    thread T { c : Client  s : Server }`);
        expect(warnings(parsed)).toEqual([
            "The required port 'c.cmd' is not connected.",
            "The required port 'c.pos' is not connected.",
            "The provided port 'x' is not delegated to a part ('delegate x -> part.port').",
            "The required port 'y' is not used by any part ('delegate part.port -> y')."
        ]);
    });

    test('a sync required port has one provider, async ports may have several', async () => {
        const parsed = await system(`
    provides sync p : Point
    thread T { c : Client  s : Server  t : Server }
    connect c.pos -> s.pos
    connect c.pos -> t.pos
    connect c.cmd -> s.cmd
    connect c.cmd -> t.cmd
    connect c.cmd -> t.cmd
    delegate p -> s.pos
    delegate p -> t.pos`);
        expect(errors(parsed)).toEqual([
            "The sync port 'c.pos' requires one provider, but it is connected 2 times.",
            "The sync port 'p' can be delegated to one provider only."
        ]);
        expect(warnings(parsed)).toEqual(['Duplicate connection.']);
    });

    test('an instance belongs to one thread', async () => {
        const parsed = await system(`
    thread A { c : Client  s }
    thread B { c  s  t }
    s : Server  t : Server
    thread C { t }
    connect c.cmd -> s.cmd  connect c.pos -> s.pos`);
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
    connect c.pos -> t.pos`);
        expect(infos(parsed)).toEqual(["The connection crosses threads ('A' -> 'B')."]);
    });

    test('instances of components run in threads, instances of subsystems outside of threads', async () => {
        const parsed = await system(`
    provides async x : Cmd
    thread T { c : Client  inner : Sub }
    s : Server
    t : Server
    u : Sub
    thread U { t  u }
    connect c.cmd -> s.cmd  connect c.pos -> t.pos
    delegate x -> u.p`, 'subsystem Sub { provides async p : Cmd  thread W { s : Server }  delegate p -> s.cmd }');
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
            "The required port 'c.cmd' is not connected.",
            "The required port 'c.pos' is not connected.",
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
        in event close
    interface:
        in event stopped : integer
        out event motor : integer
        out event alarm
        event both
        var count : integer = 0
        var readonly ratio : real = 0.5
        operation position() : real
        operation setPwm(duty : integer) : void
        operation unused() : void
    internal:
        event tick
    [*] -> A
    state A
    A -> A : cmd.open / raise alarm; raise motor : 1
}`;

    async function component(ports: string) {
        return load(`component C {\n    behavior "door.devm"\n${ports}\n}`, { 'door.devm': DOOR });
    }

    test('ports matching the state machine', async () => {
        const parsed = await component(`
    provides async cmd : event open, event close
    provides async status : event stopped : integer, event both
    requires async out : event motor : integer, event alarm
    provides sync count : integer
    provides sync ratio : real
    requires sync position : real
    requires sync setPwm : integer`);
        expect(errors(parsed)).toEqual([]);
        expect(warnings(parsed)).toEqual(["The operation 'unused' of the state machine 'Door' does not belong to any port of 'C' (add it to a required sync port)."]);
    });

    test('mismatches', async () => {
        const parsed = await component(`
    provides async cmd : event open, event shut
    requires async status : event stopped : integer
    provides async x : event motor : integer
    provides async y : event tick
    requires async out : event motor : real, event alarm : integer
    provides sync position : real
    provides sync count : real
    requires sync count2 : integer
    requires sync setPwm : real
    requires sync ratio : real`);
        expect(errors(parsed)).toEqual([
            "The state machine 'Door' has no in event 'shut' for the port 'cmd' (declare 'in event shut' in its interface).",
            "The event 'stopped' of the required port 'status' must be an out event of 'Door', but it is an in event.",
            "The event 'motor' of the provided port 'x' must be an in event of 'Door', but it is an out event.",
            "The state machine 'Door' has no in event 'tick' for the port 'y' (declare 'in event tick' in its interface).",
            "The event 'motor' of the port 'out' carries real, but the event of 'Door' carries integer.",
            "The event 'alarm' of the port 'out' carries integer, but the event of 'Door' carries no value.",
            "The state machine 'Door' has no variable 'position' for the provided sync port 'position' (declare 'var position : real' in its interface).",
            "The variable 'count' of 'Door' has the type integer, but the port has the type real.",
            "The state machine 'Door' has no operation 'count2' for the required sync port 'count2' (declare 'operation count2() : integer' or 'operation count2(value : integer) : void' in its interface).",
            "The operation 'setPwm' of 'Door' must be 'operation setPwm() : real' or 'operation setPwm(value : real) : void' for the required sync port 'setPwm'.",
            "The state machine 'Door' has no operation 'ratio' for the required sync port 'ratio' (declare 'operation ratio() : real' or 'operation ratio(value : real) : void' in its interface)."
        ]);
        expect(warnings(parsed)).toEqual([
            "The in event 'close' of the state machine 'Door' does not belong to any port of 'C' (add it to a provided async port).",
            "The in event 'both' of the state machine 'Door' does not belong to any port of 'C' (add it to a provided async port).",
            "The operation 'position' of the state machine 'Door' does not belong to any port of 'C' (add it to a required sync port).",
            "The operation 'unused' of the state machine 'Door' does not belong to any port of 'C' (add it to a required sync port)."
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
component C { behavior "m.devm"  provides sync pos : Position  provides sync other : geo::Position }`, {
            'geo.h': header,
            'm.devm': 'statemachine M { import "geo.h" interface: var pos : geo::Position var other : geo::Position [*] -> A state A }'
        });
        expect(errors(parsed)).toEqual([]);
        const [pos, other] = (parsed.model.elements[1] as ast.Component).ports;
        expect(isDataAssignable(dataTypeOf(pos.type), dataTypeOf(other.type))).toBe(true);
        expect(resolveDataType(pos.type).kind).toBe('data');
    });

    test('events of an interface type', async () => {
        const parsed = await load('interface I { event a  event b : integer }\ncomponent C { provides async p : I }');
        expect(portEvents((parsed.model.elements[1] as ast.Component).ports[0]).map(e => e.name)).toEqual(['a', 'b']);
    });
});

describe('structure language: formatter and language server', () => {
    async function format(text: string): Promise<string> {
        const parsed = await load(text);
        const edits = await services.Dmf.lsp.Formatter!.formatDocument(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() },
            options: { tabSize: 4, insertSpaces: true }
        });
        return TextDocument.applyEdits(parsed.document.textDocument, edits);
    }

    test('formatter', async () => {
        const text = 'import "a.devm" "b.h"\nstruct P{x:real;y:real}\ninterface I{event a event b:integer}\ncomponent C "doc"{behavior "c.devm" provides async p:I requires sync q : P\nrequires async r:event a,event b : integer}\n/** The system. */\nsystem S{provides async x:I\n@priority( 5 ) @period(10ms)\nthread T{c:C\n  /** doc */\nd : C}\n e:C\nthread U {e}\nconnect c.r->d.p delegate x->c.p}';
        expect(await format(text)).toBe(`import "a.devm" "b.h"
struct P {
    x : real;
    y : real
}
interface I {
    event a
    event b : integer
}
component C "doc" {
    behavior "c.devm"
    provides async p : I
    requires sync q : P
    requires async r : event a, event b : integer
}
/** The system. */
system S {
    provides async x : I
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
component Ctl { behavior "door.devm"  requires async m : Cmd  requires sync p : real }
component Pos { provides sync where : Position }
system S {
    @priority(3)
    thread T { c : Ctl }
    thread M { m : Motor }
    connect c.m -> m.ctrl
}`;
    const LSP_FILES = {
        'parts.devm': 'interface Cmd { event go }\n/** Drives. */\ncomponent Motor { provides async ctrl : Cmd }',
        'door.devm': 'statemachine Door { interface: out event go operation p() : real [*] -> A state A }'
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
        return services.Dmf.lsp.DefinitionProvider!.getDefinition(document, {
            textDocument: { uri: document.uri.toString() }, position: offsetOf(document, text, occurrence)
        });
    }

    test('go to definition', async () => {
        const parsed = await load(LSP_MAIN, LSP_FILES);
        expect(errors(parsed)).toEqual([]);
        const document = parsed.document;
        // type names: struct of the file, interface of an imported file
        const position = await definition(document, 'Position', 1);
        expect(position?.[0].targetUri).toBe(document.uri.toString());
        expect(position?.[0].targetSelectionRange.start.line).toBe(1);
        const cmd = await definition(document, 'Cmd');
        expect(cmd?.[0].targetUri).toMatch(/parts\.devm$/);
        // component type of an instance, port of a connection, behavior file, import path
        expect((await definition(document, 'Motor'))?.[0].targetUri).toMatch(/parts\.devm$/);
        expect((await definition(document, 'ctrl'))?.[0].targetSelectionRange.start).toEqual({ line: 2, character: 33 });
        expect((await definition(document, 'door.devm'))?.[0].targetUri).toMatch(/door\.devm$/);
        expect((await definition(document, 'parts.devm'))?.[0].targetUri).toMatch(/parts\.devm$/);
    });

    test('go to implementation: the providers of a required port', async () => {
        const parsed = await load(LSP_MAIN, LSP_FILES);
        const document = parsed.document;
        const links = await services.Dmf.lsp.ImplementationProvider!.getImplementation(document, {
            textDocument: { uri: document.uri.toString() }, position: offsetOf(document, 'c.m')
        });
        // the instance `m : Motor` provides `c.m`
        expect(links?.map(l => l.targetSelectionRange.start)).toEqual([{ line: 8, character: 15 }]);
    });

    test('hover and signatures', async () => {
        const parsed = await load(LSP_MAIN, LSP_FILES);
        const root = parsed.model.elements[3] as ast.Structure;
        const ctl = parsed.model.elements[1] as ast.Component;
        expect(dmfSignature(ctl)).toBe('component Ctl (behavior "door.devm")');
        expect(dmfSignature(ctl.ports[0])).toBe('requires async m : Cmd');
        expect(dmfSignature(root.threads[0])).toBe('thread T (priority 3)');
        expect(dmfSignature(root.threads[0].instances[0])).toBe('c : component Ctl (thread T)');
        expect(dmfSignature(parsed.model.elements[0])).toBe('struct Position { x : real }');
        const hover = services.Dmf.documentation.DocumentationProvider.getDocumentation(ctl);
        expect(hover).toBe('```devm\ncomponent Ctl (behavior "door.devm")\n```\n\nUses the motor.');
    });

    test('completion of type names', async () => {
        const parsed = await load('import "parts.devm"\nstruct Position { x : real }\ncomponent C { provides sync p : \n}', LSP_FILES);
        const document = parsed.document;
        const list = await services.Dmf.lsp.CompletionProvider!.getCompletion(document, {
            textDocument: { uri: document.uri.toString() }, position: { line: 2, character: 32 }
        });
        const labels = list?.items.map(i => i.label) ?? [];
        expect(labels).toEqual(expect.arrayContaining(['integer', 'real', 'boolean', 'string', 'Position', 'Cmd']));
        expect(labels).not.toContain('void');
    });

    test('completion of instance types: components in threads, subsystems outside of them', async () => {
        const text = 'component A { }\ncomponent B { }\nsubsystem Sub { }\nsystem Top { }\nsystem S {\n    thread T {\n        a : \n    }\n    s : \n}';
        const parsed = await load(text);
        const complete = async (line: number, character: number) => {
            const list = await services.Dmf.lsp.CompletionProvider!.getCompletion(parsed.document, {
                textDocument: { uri: parsed.document.uri.toString() }, position: { line, character }
            });
            return (list?.items ?? []).map(i => i.label).filter(l => /^[A-Z]/.test(l)).sort();
        };
        expect(await complete(6, 12)).toEqual(['A', 'B']);
        expect(await complete(8, 8)).toEqual(['Sub']);
    });

    test('document symbols', async () => {
        const parsed = await load(LSP_MAIN, LSP_FILES);
        const symbols = await services.Dmf.lsp.DocumentSymbolProvider!.getSymbols(parsed.document, { textDocument: { uri: parsed.document.uri.toString() } });
        expect(symbols.map(s => s.name)).toEqual(['Position', 'Ctl', 'Pos', 'S']);
        expect(symbols[3].children?.map(s => s.name)).toEqual(['T', 'M']);
    });
});
