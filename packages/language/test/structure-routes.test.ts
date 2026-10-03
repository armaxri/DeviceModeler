import * as fs from 'node:fs';
import * as path from 'node:path';
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { beforeAll, describe, expect, test } from 'vitest';
import * as ast from '../src/generated/ast.js';
import { compositeInstances } from '../src/structure-model.js';
import {
    effectiveThread, endpointLabel, endpointsOfPort, findSources, findTargets, portEndpoint, portRoute, sourcesOf, routeEndpointsOf, routeOf,
    connectionThreads, structureContexts, type PortEndpoint, type Route
} from '../src/structure-routes.js';
import { StructureModelLoader } from '../src/model-loader.js';
import { createDevmServices } from '../src/devm-module.js';

const loader = new StructureModelLoader();
let counter = 0;

async function load(text: string): Promise<ast.StructureModel> {
    const parsed = await loader.load(text, `file:///routes/model-${counter++}.devm`);
    expect(parsed.diagnostics.filter(d => d.severity === 1).map(d => d.message)).toEqual([]);
    return parsed.model;
}

function structure(model: ast.StructureModel, name: string): ast.CompositeType {
    return model.elements.find((e): e is ast.CompositeType => ast.isCompositeType(e) && e.name === name)!;
}

/** The endpoint `instance.port` (or a boundary port) of a structure, in its own body (path []). */
function endpoint(owner: ast.CompositeType, text: string): PortEndpoint {
    const [first, second] = text.split('.');
    if (second === undefined) {
        return portEndpoint(owner, undefined, owner.ports.find(p => p.name === first)!);
    }
    const instance = compositeInstances(owner).find(i => i.name === first)!;
    return portEndpoint(owner, instance, instance.type.ref!.ports.find(p => p.name === second)!);
}

const labels = (endpoints: readonly PortEndpoint[]) => endpoints.map(endpointLabel);
const hops = (route: Route) => route.hops.map(h => `${h.kind}: ${endpointLabel(h.from)} -> ${endpointLabel(h.to)}`);

describe('route analysis: the closed garage installation', () => {
    let root: ast.CompositeType;

    beforeAll(async () => {
        const device = new StructureModelLoader(createDevmServices(NodeFileSystem));
        const location = path.resolve(__dirname, '../../../examples/device/system.devm');
        const parsed = await device.load(fs.readFileSync(location, 'utf-8'), URI.file(location).toString());
        root = parsed.model.elements[0] as ast.CompositeType;
    });

    test('the instance tree and routes from the environment into the garage door and back', () => {
        expect(structureContexts(root).map(c => `${c.path.map(i => i.name).join('.') || '(root)'}: ${c.structure.name}`)).toEqual([
            '(root): GarageInstallation', 'door: GarageDoor', 'door.drive: DriveUnit'
        ]);
        // the remote control reaches the door controller through the boundary of the subsystem
        expect(labels(findTargets(endpoint(root, 'remote.open')))).toEqual(['door.door.open']);
        // the display reads the report of the diagnosis
        expect(labels(findSources(endpoint(root, 'display.report')))).toEqual(['door.diag.report']);
    });
});

describe('route analysis: the garage door example', () => {
    let root: ast.CompositeType;

    beforeAll(async () => {
        const device = new StructureModelLoader(createDevmServices(NodeFileSystem));
        const location = path.resolve(__dirname, '../../../examples/device/garage-door.devm');
        const parsed = await device.load(fs.readFileSync(location, 'utf-8'), URI.file(location).toString());
        root = parsed.model.elements[0] as ast.CompositeType;
    });

    /** The endpoint of a port of a part of the drive unit (in the context `drive`). */
    function drivePort(instanceName: string, portName: string): PortEndpoint {
        const drive = structureContexts(root)[1];
        const instance = compositeInstances(drive.structure).find(i => i.name === instanceName)!;
        return portEndpoint(drive.structure, instance, instance.type.ref!.ports.find(p => p.name === portName)!, drive.path);
    }

    test('the instance tree', () => {
        expect(structureContexts(root).map(c => `${c.path.map(i => i.name).join('.') || '(root)'}: ${c.structure.name}`)).toEqual([
            '(root): GarageDoor', 'drive: DriveUnit'
        ]);
    });

    test('targets of an out port, through a composite down to the component', () => {
        expect(labels(findTargets(endpoint(root, 'door.up')))).toEqual(['drive.motor.up']);
        expect(labels(findTargets(endpoint(root, 'sensor.position')))).toEqual(['door.position']);
        // a boundary in port: the data goes to the parts
        expect(labels(findTargets(endpoint(root, 'open')))).toEqual(['door.open']);
    });

    test('sources of an in port', () => {
        expect(labels(findSources(endpoint(root, 'door.position')))).toEqual(['sensor.position']);
        expect(labels(findSources(drivePort('motor', 'up')))).toEqual(['door.up']);
        // the data of `door.open` comes from the environment of the root (its boundary port)
        expect(labels(findSources(endpoint(root, 'door.open')))).toEqual(['open']);
        // a boundary out port: the data comes from the parts
        expect(labels(findSources(endpoint(root, 'report')))).toEqual(['diag.report']);
    });

    test('targets of an out port of a nested part: up through the boundary and across the parent', () => {
        const stopped = drivePort('motor', 'stopped');
        expect(endpointLabel(stopped)).toBe('drive.motor.stopped');
        expect(labels(findTargets(stopped))).toEqual(['door.stopped']);
        expect(hops(portRoute(stopped, 'forward'))).toEqual([
            'delegate: drive.motor.stopped -> drive.stopped',
            'boundary: drive.stopped -> drive.stopped',
            'connect: drive.stopped -> door.stopped'
        ]);
        expect(labels(findSources(endpoint(root, 'door.stopped')))).toEqual(['drive.motor.stopped']);
    });

    test('inout ports: the ports sharing the data', () => {
        expect(labels(findSources(endpoint(root, 'door.errors')))).toEqual(['diag.errors']);
        expect(labels(findTargets(endpoint(root, 'diag.errors')))).toEqual(['door.errors']);
        expect(hops(portRoute(endpoint(root, 'diag.errors'), 'forward'))).toEqual(['connect: door.errors -> diag.errors']);
    });

    test('threads of endpoints', () => {
        expect(effectiveThread(drivePort('motor', 'up'))?.name).toBe('MotorTask');
        expect(effectiveThread(drivePort('pwm', 'duty'))?.name).toBe('MotorTask');
        expect(effectiveThread(drivePort('switches', 'endSwitch'))?.name).toBe('SwitchTask');
        expect(effectiveThread(endpoint(root, 'door.up'))?.name).toBe('ControlTask');
        // an instance of a subsystem has no thread of its own: its parts run in the threads of the subsystem
        expect(effectiveThread(endpoint(root, 'drive.up'))).toBeUndefined();
        expect(effectiveThread(endpoint(root, 'open'))).toBeUndefined();
    });

    test('connections to a subsystem: the threads of the component ports inside', () => {
        const up = root.connections[0];
        const stopped = root.connections[3];
        const errors = root.connections[8];
        expect(connectionThreads(up)).toEqual({ source: expect.objectContaining({ name: 'ControlTask' }), target: expect.objectContaining({ name: 'MotorTask' }) });
        expect(connectionThreads(stopped)).toEqual({ source: expect.objectContaining({ name: 'MotorTask' }), target: expect.objectContaining({ name: 'ControlTask' }) });
        expect(connectionThreads(errors)).toEqual({ source: expect.objectContaining({ name: 'ControlTask' }), target: expect.objectContaining({ name: 'IoTask' }) });
    });

    test('the endpoints of a port of a component type in the instance tree', () => {
        const [up] = endpointsOfPort(root, compositeInstances(structureContexts(root)[1].structure)[0].type.ref!.ports[0]);
        expect(endpointLabel(up)).toBe('drive.motor.up');
        expect(labels(findSources(up))).toEqual(['door.up']);
    });

    test('the whole route of a port', () => {
        const route = portRoute(endpoint(root, 'door.up'));
        expect(labels(route.endpoints)).toEqual(['door.up', 'drive.up', 'drive.up', 'drive.motor.up']);
        // the boundary port `up` inside the drive unit and the port `drive.up` of the instance have the same label
        expect(route.endpoints[2].instance).toBeUndefined();
        expect(route.endpoints[2].path.map(i => i.name)).toEqual(['drive']);
        expect(hops(route)).toEqual([
            'connect: door.up -> drive.up',
            'boundary: drive.up -> drive.up',
            'delegate: drive.up -> drive.motor.up'
        ]);
        expect(route.hops.map(h => h.node?.$type)).toEqual(['Connection', undefined, 'Delegation']);
        // the same route backwards from the end
        expect(labels(portRoute(drivePort('motor', 'up'), 'backward').endpoints)).toEqual(['drive.motor.up', 'drive.up', 'drive.up', 'door.up']);
    });

    test('routes of model elements', () => {
        const door = compositeInstances(root).find(i => i.name === 'door')!;
        expect(labels(routeEndpointsOf(door))).toEqual([
            'door.open', 'door.close', 'door.stop', 'door.stopped', 'door.blocked', 'door.up', 'door.down', 'door.halt', 'door.alarm',
            'door.position', 'door.cycles', 'door.errors'
        ]);
        const route = routeOf(door);
        expect(labels(route.endpoints)).toContain('open');
        expect(labels(route.endpoints)).toContain('drive.motor.stopped');
        expect(labels(route.endpoints)).toContain('diag.cycles');
        expect(labels(route.endpoints)).toContain('diag.errors');
        const connection = root.connections[0];
        expect(labels(routeEndpointsOf(connection))).toEqual(['door.up', 'drive.up']);
        // go to source: the source of an in port, an out port of a component itself
        expect(labels(sourcesOf(connection.target))).toEqual(['door.up']);
        expect(labels(sourcesOf(connection.source))).toEqual(['door.up']);
        expect(labels(sourcesOf(door))).toEqual(['open', 'close', 'stop', 'drive.motor.stopped', 'drive.motor.blocked', 'door.up', 'door.down', 'door.halt',
            'door.alarm', 'sensor.position', 'door.cycles', 'diag.errors']);
        // a port of a component type: its endpoints in the instance tree of the given root
        const up = compositeInstances(structureContexts(root)[1].structure)[0].type.ref!.ports[0];
        expect(labels(routeEndpointsOf(up, { root }))).toEqual(['drive.motor.up']);
        expect(routeEndpointsOf(up)).toEqual([]);
    });
});

describe('route analysis: hierarchy', () => {
    const MODEL = `
component Server { in async p }
component Client { out async r }
subsystem Sub {
    in async i
    out async o
    thread T {
        server : Server
        client : Client
    }
    delegate i -> server.p
    delegate client.r -> o
}
subsystem Middle {
    in async i
    out async o
    sub : Sub
    delegate i -> sub.i
    delegate sub.o -> o
}
system Root {
    a : Middle
    b : Middle
    thread T {
        x : Client
        y : Server
        z : Server
    }
    connect x.r -> a.i
    connect a.o -> y.p
    connect b.o -> z.p
    connect x.r -> b.i
}`;

    test('several uses of a structure keep their paths apart', async () => {
        const model = await load(MODEL);
        const root = structure(model, 'Root');
        expect(structureContexts(root).map(c => c.path.map(i => i.name).join('.'))).toEqual(['', 'a', 'a.sub', 'b', 'b.sub']);
        // an out port may have several targets, an async in port has exactly one sender
        expect(labels(findTargets(endpoint(root, 'x.r')))).toEqual(['a.sub.server.p', 'b.sub.server.p']);
        expect(labels(findSources(endpoint(root, 'y.p')))).toEqual(['a.sub.client.r']);
        expect(labels(findSources(endpoint(root, 'z.p')))).toEqual(['b.sub.client.r']);
        // from inside `a`, the route leaves through `a` only
        const sub = structureContexts(root).find(c => c.path.map(i => i.name).join('.') === 'a.sub')!;
        const client = compositeInstances(sub.structure).find(i => i.name === 'client')!;
        const start = portEndpoint(sub.structure, client, client.type.ref!.ports[0], sub.path);
        expect(labels(findTargets(start))).toEqual(['y.p']);
        expect(labels(portRoute(start).endpoints)).toEqual([
            'a.sub.client.r', 'a.sub.o', 'a.sub.o', 'a.o', 'a.o', 'y.p'
        ]);
    });

    test('without a root, a route ends at the boundary of the structure', async () => {
        const model = await load(MODEL);
        const sub = structure(model, 'Sub');
        expect(labels(findTargets(endpoint(sub, 'client.r')))).toEqual(['o']);
        expect(labels(findSources(endpoint(sub, 'server.p')))).toEqual(['i']);
        // with the root, the uses of `Sub` are found
        const root = structure(model, 'Root');
        const delegation = sub.delegations[1];
        expect(labels(routeEndpointsOf(delegation, { root }))).toEqual(['a.sub.client.r', 'a.sub.o', 'b.sub.client.r', 'b.sub.o']);
    });

    test('inout ports share the data across connections, delegations and boundaries', async () => {
        const model = await load(`
component Store { inout sync v : integer }
subsystem Sub { inout sync v : integer  thread T { s : Store }  delegate v -> s.v }
system Root {
    inout sync env : integer
    a : Sub
    thread T { s : Store  t : Store }
    connect s.v -> a.v
    connect t.v -> s.v
    delegate t.v -> env
}`);
        const root = structure(model, 'Root');
        expect(labels(findSources(endpoint(root, 's.v')))).toEqual(['t.v', 'env', 'a.s.v']);
        expect(labels(findTargets(endpoint(root, 'env')))).toEqual(['t.v', 's.v', 'a.s.v']);
        expect(labels(portRoute(endpoint(root, 't.v'), 'forward').endpoints)).toEqual(['t.v', 's.v', 'env', 'a.v', 'a.v', 'a.s.v']);
    });

    test('unconnected ports have no sources or targets', async () => {
        const model = await load('component C { out async r  in sync i : integer }\nsystem S { thread T { c : C } }');
        expect(findTargets(endpoint(structure(model, 'S'), 'c.r'))).toEqual([]);
        expect(findSources(endpoint(structure(model, 'S'), 'c.i'))).toEqual([]);
        expect(portRoute(endpoint(structure(model, 'S'), 'c.r')).hops).toEqual([]);
    });

    test('recursive instantiation does not loop', async () => {
        const parsed = await loader.load(`
component C { out async r }
subsystem A { in async p  b : B  delegate p -> b.p }
subsystem B { in async p  a : A  delegate p -> a.p }
system S { a : A  thread T { c : C }  connect c.r -> a.p }`, `file:///routes/recursive-${counter++}.devm`);
        const root = structure(parsed.model, 'S');
        expect(structureContexts(root).map(c => c.structure.name)).toEqual(['S', 'A', 'B']);
        expect(labels(findTargets(endpoint(root, 'c.r')))).toEqual(['a.b.a.p']);
    });
});
