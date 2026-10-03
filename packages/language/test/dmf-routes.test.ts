import * as fs from 'node:fs';
import * as path from 'node:path';
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { beforeAll, describe, expect, test } from 'vitest';
import * as ast from '../src/generated/ast.js';
import { structureInstances } from '../src/dmf-model.js';
import {
    effectiveThread, endpointLabel, endpointsOfPort, findProviders, findRequirers, portEndpoint, portRoute, providersOf, routeEndpointsOf, routeOf,
    connectionThreads, structureContexts, type PortEndpoint, type Route
} from '../src/dmf-routes.js';
import { DmfModelLoader } from '../src/hsm-document.js';
import { createHsmServices } from '../src/hsm-module.js';

const loader = new DmfModelLoader();
let counter = 0;

async function load(text: string): Promise<ast.DmfModel> {
    const parsed = await loader.load(text, `file:///routes/model-${counter++}.dmf`);
    expect(parsed.diagnostics.filter(d => d.severity === 1).map(d => d.message)).toEqual([]);
    return parsed.model;
}

function structure(model: ast.DmfModel, name: string): ast.Structure {
    return model.elements.find((e): e is ast.Structure => ast.isStructure(e) && e.name === name)!;
}

/** The endpoint `instance.port` (or a boundary port) of a structure, in its own body (path []). */
function endpoint(owner: ast.Structure, text: string): PortEndpoint {
    const [first, second] = text.split('.');
    if (second === undefined) {
        return portEndpoint(owner, undefined, owner.ports.find(p => p.name === first)!);
    }
    const instance = structureInstances(owner).find(i => i.name === first)!;
    return portEndpoint(owner, instance, instance.type.ref!.ports.find(p => p.name === second)!);
}

const labels = (endpoints: readonly PortEndpoint[]) => endpoints.map(endpointLabel);
const hops = (route: Route) => route.hops.map(h => `${h.kind}: ${endpointLabel(h.from)} -> ${endpointLabel(h.to)}`);

describe('route analysis: the garage door example', () => {
    let root: ast.Structure;

    beforeAll(async () => {
        const device = new DmfModelLoader(createHsmServices(NodeFileSystem));
        const location = path.resolve(__dirname, '../../../examples/device/system.dmf');
        const parsed = await device.load(fs.readFileSync(location, 'utf-8'), URI.file(location).toString());
        root = parsed.model.elements[0] as ast.Structure;
    });

    test('the instance tree', () => {
        expect(structureContexts(root).map(c => `${c.path.map(i => i.name).join('.') || '(root)'}: ${c.structure.name}`)).toEqual([
            '(root): GarageDoor', 'drive: DriveUnit'
        ]);
    });

    test('providers of a required port, through a composite down to the component', () => {
        expect(labels(findProviders(endpoint(root, 'door.motor')))).toEqual(['drive.motor.ctrl']);
        expect(labels(findProviders(endpoint(root, 'door.position')))).toEqual(['sensor.position']);
        // a boundary port: the provider is inside
        expect(labels(findProviders(endpoint(root, 'remote')))).toEqual(['door.cmd']);
    });

    test('providers of a required port of a nested part: up through the boundary and across the parent', () => {
        const drive = structureContexts(root)[1];
        const motor = structureInstances(drive.structure).find(i => i.name === 'motor')!;
        const status = portEndpoint(drive.structure, motor, motor.type.ref!.ports.find(p => p.name === 'status')!, drive.path);
        expect(endpointLabel(status)).toBe('drive.motor.status');
        expect(labels(findProviders(status))).toEqual(['door.status']);
        expect(hops(portRoute(status, 'forward'))).toEqual([
            'delegate: drive.motor.status -> drive.status',
            'boundary: drive.status -> drive.status',
            'connect: drive.status -> door.status'
        ]);
    });

    test('threads of endpoints', () => {
        const drive = structureContexts(root)[1];
        const [motor, pwm, switches] = structureInstances(drive.structure);
        expect(effectiveThread(portEndpoint(drive.structure, motor, motor.type.ref!.ports[0], drive.path))?.name).toBe('MotorTask');
        expect(effectiveThread(portEndpoint(drive.structure, pwm, pwm.type.ref!.ports[0], drive.path))?.name).toBe('MotorTask');
        expect(effectiveThread(portEndpoint(drive.structure, switches, switches.type.ref!.ports[0], drive.path))?.name).toBe('SwitchTask');
        expect(effectiveThread(endpoint(root, 'door.motor'))?.name).toBe('ControlTask');
        // an instance of a subsystem has no thread of its own: its parts run in the threads of the subsystem
        expect(effectiveThread(endpoint(root, 'drive.ctrl'))).toBeUndefined();
        expect(effectiveThread(endpoint(root, 'remote'))).toBeUndefined();
    });

    test('connections to a subsystem: the threads of the component ports inside', () => {
        const [motorCmd, status] = root.connections;
        expect(connectionThreads(motorCmd)).toEqual({ source: expect.objectContaining({ name: 'ControlTask' }), target: expect.objectContaining({ name: 'MotorTask' }) });
        expect(connectionThreads(status)).toEqual({ source: expect.objectContaining({ name: 'MotorTask' }), target: expect.objectContaining({ name: 'ControlTask' }) });
    });

    test('requirers of a provided port', () => {
        const [ctrl] = endpointsOfPort(root, structureInstances(structureContexts(root)[1].structure)[0].type.ref!.ports[0]);
        expect(endpointLabel(ctrl)).toBe('drive.motor.ctrl');
        expect(labels(findRequirers(ctrl))).toEqual(['door.motor']);
    });

    test('the whole route of a port', () => {
        const route = portRoute(endpoint(root, 'door.motor'));
        expect(labels(route.endpoints)).toEqual(['door.motor', 'drive.ctrl', 'drive.ctrl', 'drive.motor.ctrl']);
        // the boundary port `ctrl` inside the drive unit and the port `drive.ctrl` of the instance have the same label
        expect(route.endpoints[2].instance).toBeUndefined();
        expect(route.endpoints[2].path.map(i => i.name)).toEqual(['drive']);
        expect(hops(route)).toEqual([
            'connect: door.motor -> drive.ctrl',
            'boundary: drive.ctrl -> drive.ctrl',
            'delegate: drive.ctrl -> drive.motor.ctrl'
        ]);
        expect(route.hops.map(h => h.node?.$type)).toEqual(['Connection', undefined, 'Delegation']);
    });

    test('routes of model elements', () => {
        const door = structureInstances(root).find(i => i.name === 'door')!;
        expect(labels(routeEndpointsOf(door))).toEqual([
            'door.cmd', 'door.status', 'door.motor', 'door.alarm', 'door.cycles', 'door.position'
        ]);
        const route = routeOf(door);
        expect(labels(route.endpoints)).toContain('remote');
        expect(labels(route.endpoints)).toContain('drive.motor.status');
        expect(labels(route.endpoints)).toContain('diag.cycles');
        const connection = root.connections[0];
        expect(labels(routeEndpointsOf(connection))).toEqual(['door.motor', 'drive.ctrl']);
        expect(labels(providersOf(connection.source))).toEqual(['drive.motor.ctrl']);
        // a port of a component type: its endpoints in the instance tree of the given root
        const ctrl = structureInstances(structureContexts(root)[1].structure)[0].type.ref!.ports[0];
        expect(labels(routeEndpointsOf(ctrl, { root }))).toEqual(['drive.motor.ctrl']);
        expect(routeEndpointsOf(ctrl)).toEqual([]);
    });
});

describe('route analysis: hierarchy', () => {
    const MODEL = `
component Server { provides async p : event e }
component Client { requires async r : event e }
subsystem Sub {
    provides async in : event e
    requires async out : event e
    thread T {
        server : Server
        client : Client
    }
    delegate in -> server.p
    delegate client.r -> out
}
subsystem Middle {
    provides async in : event e
    requires async out : event e
    sub : Sub
    delegate in -> sub.in
    delegate sub.out -> out
}
system Root {
    a : Middle
    b : Middle
    thread T {
        x : Client
        y : Server
    }
    connect x.r -> a.in
    connect a.out -> y.p
    connect b.out -> y.p
    connect x.r -> b.in
}`;

    test('several uses of a structure keep their paths apart', async () => {
        const model = await load(MODEL);
        const root = structure(model, 'Root');
        expect(structureContexts(root).map(c => c.path.map(i => i.name).join('.'))).toEqual(['', 'a', 'a.sub', 'b', 'b.sub']);
        // async ports may have several providers
        expect(labels(findProviders(endpoint(root, 'x.r')))).toEqual(['a.sub.server.p', 'b.sub.server.p']);
        expect(labels(findRequirers(endpoint(root, 'y.p')))).toEqual(['a.sub.client.r', 'b.sub.client.r']);
        // from inside `a`, the route leaves through `a` only
        const sub = structureContexts(root).find(c => c.path.map(i => i.name).join('.') === 'a.sub')!;
        const client = structureInstances(sub.structure).find(i => i.name === 'client')!;
        const start = portEndpoint(sub.structure, client, client.type.ref!.ports[0], sub.path);
        expect(labels(findProviders(start))).toEqual(['y.p']);
        expect(labels(portRoute(start).endpoints)).toEqual([
            'a.sub.client.r', 'a.sub.out', 'a.sub.out', 'a.out', 'a.out', 'y.p', 'b.out', 'b.out', 'b.sub.out', 'b.sub.out', 'b.sub.client.r'
        ]);
    });

    test('without a root, a route ends at the boundary of the structure', async () => {
        const model = await load(MODEL);
        const sub = structure(model, 'Sub');
        expect(labels(findProviders(endpoint(sub, 'client.r')))).toEqual(['out']);
        expect(labels(findRequirers(endpoint(sub, 'server.p')))).toEqual(['in']);
        // with the root, the uses of `Sub` are found
        const root = structure(model, 'Root');
        const delegation = sub.delegations[1];
        expect(labels(routeEndpointsOf(delegation, { root }))).toEqual(['a.sub.client.r', 'a.sub.out', 'b.sub.client.r', 'b.sub.out']);
    });

    test('unconnected ports have no providers', async () => {
        const model = await load('component C { requires async r : event e }\nsystem S { thread T { c : C } }');
        expect(findProviders(endpoint(structure(model, 'S'), 'c.r'))).toEqual([]);
        expect(portRoute(endpoint(structure(model, 'S'), 'c.r')).hops).toEqual([]);
    });

    test('recursive instantiation does not loop', async () => {
        const parsed = await loader.load(`
component C { requires async r : event e }
subsystem A { provides async p : event e  b : B  delegate p -> b.p }
subsystem B { provides async p : event e  a : A  delegate p -> a.p }
system S { a : A  thread T { c : C }  connect c.r -> a.p }`, `file:///routes/recursive-${counter++}.dmf`);
        const root = structure(parsed.model, 'S');
        expect(structureContexts(root).map(c => c.structure.name)).toEqual(['S', 'A', 'B']);
        expect(labels(findProviders(endpoint(root, 'c.r')))).toEqual(['a.b.a.p']);
    });
});
