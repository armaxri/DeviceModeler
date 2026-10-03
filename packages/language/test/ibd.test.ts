import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { beforeAll, describe, expect, test } from 'vitest';
import { runRenderCommand } from '../src/cli/render-commands.js';
import * as ast from '../src/generated/ast.js';
import { defaultIbdElement, ibdChoices, ibdElementAt, ibdNodes, ibdRouteElements, layoutStructure, memberText } from '../src/diagram/ibd-layout.js';
import { IBD_OVERVIEW_ID, IBD_TYPES_ID, type IbdLayoutResult, type IbdNode } from '../src/diagram/ibd-model.js';
import { DmfModelLoader } from '../src/hsm-document.js';
import { createHsmServices } from '../src/hsm-module.js';
import { parseXml, type XmlElement } from '../src/importer/xml.js';
import { renderIbdSvg } from '../src/render/ibd-svg.js';
import { portChevron } from '../src/render/ibd-shapes.js';

const DEVICE = path.resolve(__dirname, '../../../examples/device');
const deviceLoader = new DmfModelLoader(createHsmServices(NodeFileSystem));

async function loadExample(file: string): Promise<ast.DmfModel> {
    const location = path.join(DEVICE, file);
    const parsed = await deviceLoader.load(fs.readFileSync(location, 'utf-8'), URI.file(location).toString());
    expect(parsed.diagnostics.filter(d => d.severity === 1)).toEqual([]);
    return parsed.model;
}

const loader = new DmfModelLoader();
let counter = 0;

async function load(text: string): Promise<ast.DmfModel> {
    const parsed = await loader.load(text, `file:///ibd/model-${counter++}.dmf`);
    expect(parsed.hasSyntaxErrors).toBe(false);
    return parsed.model;
}

function node(layout: IbdLayoutResult, id: string): IbdNode {
    const found = ibdNodes(layout.graph).find(n => n.node.id === id);
    expect(found, id).toBeDefined();
    return found!.node;
}

function elements(root: XmlElement): XmlElement[] {
    return [root, ...root.children.flatMap(elements)];
}

function withClass(root: XmlElement, cls: string): XmlElement[] {
    return elements(root).filter(e => (e.attributes.class ?? '').split(/\s+/).includes(cls));
}

describe('internal block diagram: the garage door system', () => {
    let model: ast.DmfModel;
    let layout: IbdLayoutResult;

    beforeAll(async () => {
        model = await loadExample('system.dmf');
        layout = (await layoutStructure(model))!;
    });

    test('the frame of the system with its boundary ports', () => {
        const graph = layout.graph;
        expect(graph.kind).toBe('system');
        expect(graph.children.map(n => `${n.kind} ${n.id}`)).toEqual(['frame GarageDoor']);
        const frame = graph.children[0];
        expect(frame.details).toBe('ibd [system] GarageDoor');
        expect(frame.ports.map(p => `${p.id} ${p.direction} ${p.kind} ${p.side}`)).toEqual([
            'GarageDoor.remote provides async WEST',
            'GarageDoor.report provides sync WEST'
        ]);
        // centered on the left border, the label outside of the frame
        for (const port of frame.ports) {
            expect(port.x + port.size / 2).toBeCloseTo(0, 0);
            expect(port.label.x + port.label.width).toBeLessThan(0);
        }
        expect(layout.elements.get('GarageDoor')).toBe(model.elements[0]);
    });

    test('threads enclose their instances, instances outside of threads are in the frame', () => {
        const frame = layout.graph.children[0];
        expect(frame.children.map(n => `${n.kind} ${n.id}`)).toEqual([
            'thread GarageDoor/thread:ControlTask', 'thread GarageDoor/thread:IoTask', 'instance GarageDoor/drive'
        ]);
        const control = node(layout, 'GarageDoor/thread:ControlTask');
        expect(control.children.map(n => n.id)).toEqual(['GarageDoor/door', 'GarageDoor/buzzer']);
        expect(control.details).toBe('priority 5 · period 10 ms');
        expect(node(layout, 'GarageDoor/thread:IoTask').children.map(n => n.id)).toEqual(['GarageDoor/sensor', 'GarageDoor/diag']);
        for (const thread of frame.children.filter(n => n.kind === 'thread')) {
            for (const child of thread.children) {
                // inside the thread, below its header
                expect(child.x).toBeGreaterThan(0);
                expect(child.y).toBeGreaterThanOrEqual(thread.headerHeight);
                expect(child.x + child.width).toBeLessThan(thread.width);
                expect(child.y + child.height).toBeLessThan(thread.height);
            }
        }
        // threads and instances do not overlap
        const boxes = frame.children;
        for (const a of boxes) {
            for (const b of boxes) {
                if (a !== b) {
                    const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
                    expect(overlap, `${a.id} / ${b.id}`).toBe(false);
                }
            }
        }
    });

    test('instances: name, type, stereotype, behavior and composite, ports on the borders', () => {
        const door = node(layout, 'GarageDoor/door');
        expect([door.name, door.typeName, door.stereotype]).toEqual(['door', 'DoorController', 'component']);
        expect(door.behavior?.machine).toBe('DoorController');
        expect(door.behavior?.uri).toMatch(/controller\.hsm$/);
        const drive = node(layout, 'GarageDoor/drive');
        expect([drive.stereotype, drive.composite?.structure]).toEqual(['subsystem', 'DriveUnit']);
        expect(drive.composite?.uri).toMatch(/drive\.dmf$/);
        expect(door.ports.map(p => p.name).sort()).toEqual(['alarm', 'cmd', 'cycles', 'motor', 'position', 'status']);
        for (const { node: n } of ibdNodes(layout.graph).filter(n => n.node.kind === 'instance')) {
            for (const port of n.ports) {
                expect(port.id).toBe(`${n.id}.${port.name}`);
                expect(port.x + port.size / 2).toBeCloseTo(port.side === 'WEST' ? 0 : n.width, 5);
                // the label inside the instance, below the header
                expect(port.label.x).toBeGreaterThan(0);
                expect(port.label.x + port.label.width).toBeLessThan(n.width);
                expect(port.y).toBeGreaterThan(n.headerHeight);
                expect(layout.instances.get(port.id)).toBe(layout.elements.get(n.id));
                expect(ast.isPort(layout.elements.get(port.id))).toBe(true);
            }
            // the labels of a side do not overlap
            for (const side of ['WEST', 'EAST']) {
                const ys = n.ports.filter(p => p.side === side).map(p => p.y).sort((a, b) => a - b);
                ys.slice(1).forEach((y, i) => expect(y - ys[i]).toBeGreaterThanOrEqual(20));
            }
        }
        // the cmd port is provided by the system's boundary port on the left
        expect(door.ports.find(p => p.name === 'cmd')!.side).toBe('WEST');
    });

    test('connectors: ids, kinds, cross-thread connections are dashed', () => {
        expect(layout.graph.edges.map(e => `${e.id} ${e.kind}${e.crossThread ? ' cross-thread' : ''}`)).toEqual([
            'GarageDoor/door.motor->drive.ctrl connect cross-thread',
            'GarageDoor/drive.status->door.status connect cross-thread',
            'GarageDoor/door.alarm->buzzer.alarm connect',
            'GarageDoor/door.position->sensor.position connect cross-thread',
            'GarageDoor/diag.cycles->door.cycles connect cross-thread',
            'GarageDoor/remote->door.cmd delegate',
            'GarageDoor/report->diag.report delegate'
        ]);
        const positions = new Map(ibdNodes(layout.graph).flatMap(({ node: n, x, y }) => n.ports.map(p => [p.id, { x: x + p.x, y: y + p.y, size: p.size }] as const)));
        for (const edge of layout.graph.edges) {
            expect(edge.points.length).toBeGreaterThanOrEqual(2);
            // orthogonal
            edge.points.slice(1).forEach((p, i) => expect(p.x === edge.points[i].x || p.y === edge.points[i].y).toBe(true));
            // from the source port to the target port (the edge ends at the border of the squares)
            for (const [point, port] of [[edge.points[0], edge.source], [edge.points[edge.points.length - 1], edge.target]] as const) {
                const square = positions.get(port)!;
                expect(point.x).toBeGreaterThanOrEqual(square.x - 0.5);
                expect(point.x).toBeLessThanOrEqual(square.x + square.size + 0.5);
                expect(point.y).toBeGreaterThanOrEqual(square.y - 0.5);
                expect(point.y).toBeLessThanOrEqual(square.y + square.size + 0.5);
            }
            expect(layout.ids.get(layout.elements.get(edge.id)!)).toBe(edge.id);
        }
    });

    test('the route of a port, an instance and a connector', () => {
        expect([...ibdRouteElements(layout, 'GarageDoor/door.motor')!].sort()).toEqual([
            'GarageDoor/door', 'GarageDoor/door.motor', 'GarageDoor/door.motor->drive.ctrl', 'GarageDoor/drive', 'GarageDoor/drive.ctrl'
        ]);
        // through the delegation to the boundary port
        expect([...ibdRouteElements(layout, 'GarageDoor.remote')!].sort()).toEqual([
            'GarageDoor.remote', 'GarageDoor/door', 'GarageDoor/door.cmd', 'GarageDoor/remote->door.cmd'
        ]);
        expect([...ibdRouteElements(layout, 'GarageDoor/door.alarm->buzzer.alarm')!].sort()).toEqual([
            'GarageDoor/buzzer', 'GarageDoor/buzzer.alarm', 'GarageDoor/door', 'GarageDoor/door.alarm', 'GarageDoor/door.alarm->buzzer.alarm'
        ]);
        const sensor = ibdRouteElements(layout, 'GarageDoor/sensor')!;
        expect([...sensor].sort()).toEqual([
            'GarageDoor/door', 'GarageDoor/door.position', 'GarageDoor/door.position->sensor.position', 'GarageDoor/sensor', 'GarageDoor/sensor.position'
        ]);
        expect(ibdRouteElements(layout, 'GarageDoor/thread:IoTask')).toBeUndefined();
        expect(ibdRouteElements(layout, 'GarageDoor')).toBeUndefined();
    });

    test('rendered as SVG with the classes of the web editor', () => {
        const highlight = new Map([...ibdRouteElements(layout, 'GarageDoor/door.motor')!].map(id => [id, 'on-route']));
        const svg = renderIbdSvg(layout.graph, { theme: 'dark', highlight, routeHighlight: true });
        const root = parseXml(svg);
        expect(root.attributes.class).toBe('sprotty-graph theme-dark hsm-export ibd-diagram route-highlight');
        expect(withClass(root, 'ibd-frame')).toHaveLength(1);
        expect(withClass(root, 'ibd-thread')).toHaveLength(2);
        expect(withClass(root, 'ibd-instance')).toHaveLength(5);
        expect(withClass(root, 'ibd-port')).toHaveLength(2 + 6 + 1 + 1 + 2 + 2);
        expect(withClass(root, 'ibd-connector')).toHaveLength(7);
        expect(withClass(root, 'cross-thread')).toHaveLength(4);
        expect(withClass(root, 'delegation')).toHaveLength(2);
        expect(withClass(root, 'on-route')).toHaveLength(5);
        // async ports have a chevron, sync ports none
        expect(withClass(root, 'ibd-port-chevron')).toHaveLength(withClass(root, 'async').length);
        expect(svg).toContain('door : DoorController');
        expect(svg).toContain('«thread»');
    });
});

describe('internal block diagram: other elements', () => {
    test('the drive unit: two threads, delegations to required boundary ports', async () => {
        const layout = (await layoutStructure(await loadExample('drive.dmf')))!;
        const frame = layout.graph.children[0];
        expect(frame.details).toBe('ibd [subsystem] DriveUnit');
        expect(frame.children.map(n => n.id)).toEqual(['DriveUnit/thread:MotorTask', 'DriveUnit/thread:SwitchTask']);
        expect(frame.ports.map(p => `${p.name} ${p.side}`)).toEqual(['ctrl WEST', 'status EAST']);
        expect(node(layout, 'DriveUnit/thread:MotorTask').details).toBe('priority 8 · period 1 ms · stack 2048');
        expect(layout.graph.edges.find(e => e.id === 'DriveUnit/motor.pwm->pwm.duty')?.crossThread).toBe(false);
        expect(layout.graph.edges.find(e => e.id === 'DriveUnit/switches.events->motor.sensors')?.crossThread).toBe(true);
        // no data types declared in the file: no type boxes
        expect(layout.graph.children.map(n => n.kind)).toEqual(['frame']);
        expect([...ibdRouteElements(layout, 'DriveUnit.status')!].sort()).toEqual([
            'DriveUnit.status', 'DriveUnit/motor', 'DriveUnit/motor.status', 'DriveUnit/motor.status->status'
        ]);
    });

    test('component types: the overview and a single block', async () => {
        const model = await loadExample('components.dmf');
        expect(ibdChoices(model).map(c => c.id)).toEqual([
            'DoorController', 'MotorController', 'PwmDriver', 'EndSwitches', 'PositionSensor', 'Buzzer', 'Diagnosis', IBD_OVERVIEW_ID
        ]);
        expect(defaultIbdElement(model)).toBe(IBD_OVERVIEW_ID);
        const overview = (await layoutStructure(model))!;
        expect(overview.graph.kind).toBe('overview');
        expect(overview.graph.children.map(n => `${n.kind} ${n.id}`)).toContain('block DoorController');
        expect(overview.graph.edges).toEqual([]);
        const single = (await layoutStructure(model, { element: 'Buzzer' }))!;
        expect(single.graph.kind).toBe('component');
        expect(single.graph.children.map(n => n.id)).toEqual(['Buzzer']);
        expect(single.graph.children[0].ports.map(p => p.id)).toEqual(['Buzzer.alarm']);
        expect(ibdRouteElements(single, 'Buzzer.alarm')).toBeUndefined();
        // an unknown element: the default
        expect((await layoutStructure(model, { element: 'Nope' }))!.graph.kind).toBe('overview');
        // ports show their named type in the label
        expect(node(overview, 'DoorController').ports.find(p => p.name === 'cmd')?.label.text).toBe('cmd : DoorCmd');
        expect(node(overview, 'DoorController').ports.find(p => p.name === 'alarm')?.label.text).toBe('alarm');
    });

    test('data types: the structs and interfaces of the file as unconnected type boxes', async () => {
        // a file without component types: only the type boxes
        const types = await loadExample('types.dmf');
        expect(ibdChoices(types).map(c => `${c.kind} ${c.id}`)).toEqual([`types ${IBD_TYPES_ID}`]);
        const layout = (await layoutStructure(types))!;
        expect(layout.graph.kind).toBe('types');
        expect(layout.graph.edges).toEqual([]);
        expect(layout.graph.children.map(n => `${n.kind} ${n.stereotype} ${n.id}`)).toEqual([
            'type struct type:Diagnostics', 'type interface type:DoorCmd', 'type interface type:MotorCmd', 'type interface type:MotorStatus'
        ]);
        expect(node(layout, 'type:MotorCmd').members?.map(memberText)).toEqual(['event up : integer', 'event down : integer', 'event halt']);
        expect(layout.elements.get('type:Diagnostics')?.$type).toBe('StructDeclaration');
        expect(ibdRouteElements(layout, 'type:Diagnostics')).toBeUndefined();
        // a mixed file: the subsystem, the type boxes below its frame (automatic layout: the example is arranged by hand), nothing connected to them
        const light = (await layoutStructure(await loadExample('light.dmf'), { layout: null }))!;
        const [frame, ...boxes] = light.graph.children;
        expect(frame.details).toBe('ibd [subsystem] CourtesyLight');
        expect(boxes.map(b => `${b.kind} ${b.name}`)).toEqual(['type LightLevel', 'type LightCmd']);
        for (const box of boxes) {
            expect(box.y).toBeGreaterThanOrEqual(frame.y + frame.height);
            expect(box.x + box.width).toBeLessThanOrEqual(light.graph.width);
            expect(box.y + box.height).toBeLessThanOrEqual(light.graph.height);
        }
        expect(light.graph.edges.every(e => !e.source.startsWith('type:') && !e.target.startsWith('type:'))).toBe(true);
        const svg = renderIbdSvg(light.graph);
        expect(svg).toContain('class="ibd-node ibd-type"');
        expect(svg).toContain('«struct»');
        expect(svg).toContain('<tspan class="ibd-port-type">LightLevel</tspan>');
    });

    test('several structures: the system is shown by default, the cursor selects another one', async () => {
        const text = `
component A { provides sync p : integer  requires async e : event x }
subsystem Inner { provides sync p : integer  thread I { a : A }  delegate p -> a.p }
system Top {
    thread T { a : A }
    b : A
    inner : Inner
    thread U { b }
    connect a.e -> b.e
    connect b.e -> missing.e
}`;
        const model = await load(text);
        expect(ibdChoices(model).map(c => `${c.kind} ${c.id}`)).toEqual(['component A', 'subsystem Inner', 'system Top']);
        expect(defaultIbdElement(model)).toBe('Top');
        expect(ibdElementAt(model, text.indexOf('delegate'))).toBe('Inner');
        const layout = (await layoutStructure(model))!;
        // `b` is declared outside of the threads and assigned to U by name
        expect(node(layout, 'Top/thread:U').children.map(n => n.id)).toEqual(['Top/b']);
        expect(layout.graph.children[0].children.map(n => n.id)).toEqual(['Top/thread:T', 'Top/thread:U', 'Top/inner']);
        // (b.e is required and b.e is not provided: an invalid connection is still drawn; unresolved ones are not)
        expect(layout.graph.edges.map(e => `${e.id}${e.crossThread ? ' cross-thread' : ''}`)).toEqual(['Top/a.e->b.e cross-thread']);
        const inner = (await layoutStructure(model, { element: 'Inner' }))!;
        expect(inner.graph.edges.map(e => e.id)).toEqual(['Inner/p->a.p']);
    });

    test('the chevrons of async ports point in the direction of the events', () => {
        const chevron = (direction: 'provides' | 'requires', side: 'WEST' | 'EAST') => portChevron({ direction, kind: 'async', side, size: 10 })!;
        const tipX = (d: string) => Number(/L ([\d.]+),/.exec(d)![1]);
        const backX = (d: string) => Number(/M ([\d.]+),/.exec(d)![1]);
        // provided, left border: the events flow into the node (to the right)
        expect(tipX(chevron('provides', 'WEST'))).toBeGreaterThan(backX(chevron('provides', 'WEST')));
        expect(tipX(chevron('requires', 'WEST'))).toBeLessThan(backX(chevron('requires', 'WEST')));
        expect(tipX(chevron('provides', 'EAST'))).toBeLessThan(backX(chevron('provides', 'EAST')));
        expect(portChevron({ direction: 'provides', kind: 'sync', side: 'WEST', size: 10 })).toBeUndefined();
    });
});

describe('hsm render: structure files', () => {
    test('renders the device example (structures and state machines)', async () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-ibd-'));
        const messages: string[] = [];
        const code = await runRenderCommand([DEVICE], { out, theme: 'modern' }, { log: m => messages.push(m), error: m => messages.push(`error: ${m}`) });
        expect(code).toBe(0);
        // drive.dmf and drive.hsm: the structure gets its own name
        expect(fs.readdirSync(out).sort()).toEqual(['components.svg', 'controller.svg', 'drive.dmf.svg', 'drive.svg', 'light.svg', 'system.svg', 'types.svg']);
        expect(fs.readFileSync(path.join(out, 'types.svg'), 'utf-8')).toContain('class="ibd-node ibd-type"');
        const system = fs.readFileSync(path.join(out, 'system.svg'), 'utf-8');
        expect(system).toMatch(/^<\?xml/);
        expect(system).toContain('theme-modern');
        expect(system).toContain('class="ibd-node ibd-frame"');
        expect(system).toContain('GarageDoor');
        expect(fs.readFileSync(path.join(out, 'drive.dmf.svg'), 'utf-8')).toContain('DriveUnit');
        fs.rmSync(out, { recursive: true, force: true });
    });

    test('a single file with --element', async () => {
        const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-ibd-')), 'buzzer.svg');
        const messages: string[] = [];
        const logger = { log: (m: string) => messages.push(m), error: (m: string) => messages.push(`error: ${m}`) };
        expect(await runRenderCommand([path.join(DEVICE, 'components.dmf')], { out, element: 'Buzzer' }, logger)).toBe(0);
        expect(fs.readFileSync(out, 'utf-8')).toContain('Buzzer');
        expect(await runRenderCommand([path.join(DEVICE, 'components.dmf')], { out, element: 'Nope' }, logger)).toBe(1);
        expect(messages.at(-1)).toMatch(/no subsystem, system or component type 'Nope'/);
    });
});
