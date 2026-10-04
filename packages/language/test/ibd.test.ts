import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { beforeAll, describe, expect, test } from 'vitest';
import { runRenderCommand } from '../src/cli/render-commands.js';
import * as ast from '../src/generated/ast.js';
import { defaultIbdElement, ibdChoices, ibdElementAt, ibdNodes, ibdRouteElements, layoutStructure, memberText } from '../src/diagram/ibd-layout.js';
import { ibdDiagramElementAt, ibdIssues } from '../src/diagram/ibd-issues.js';
import { IBD_OVERVIEW_ID, IBD_TYPES_ID, type IbdLayoutResult, type IbdNode } from '../src/diagram/ibd-model.js';
import { StructureModelLoader } from '../src/model-loader.js';
import { createDevmServices } from '../src/devm-module.js';
import { parseXml, type XmlElement } from '../src/importer/xml.js';
import { renderIbdSvg } from '../src/render/ibd-svg.js';
import { connectorArrowheads, portArrow, portClasses } from '../src/render/ibd-shapes.js';

const DEVICE = path.resolve(__dirname, '../../../examples/device');
const deviceLoader = new StructureModelLoader(createDevmServices(NodeFileSystem));

async function loadExample(file: string): Promise<ast.StructureModel> {
    const location = path.join(DEVICE, file);
    const parsed = await deviceLoader.load(fs.readFileSync(location, 'utf-8'), URI.file(location).toString());
    expect(parsed.diagnostics.filter(d => d.severity === 1)).toEqual([]);
    return parsed.model;
}

const loader = new StructureModelLoader();
let counter = 0;

async function load(text: string): Promise<ast.StructureModel> {
    const parsed = await loader.load(text, `file:///ibd/model-${counter++}.devm`);
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

describe('internal block diagram: the garage door subsystem', () => {
    let model: ast.StructureModel;
    let layout: IbdLayoutResult;

    beforeAll(async () => {
        model = await loadExample('garage-door.devm');
        layout = (await layoutStructure(model))!;
    });

    test('the frame of the subsystem with its boundary ports', () => {
        const graph = layout.graph;
        expect(graph.kind).toBe('subsystem');
        expect(graph.children.map(n => `${n.kind} ${n.id}`)).toEqual(['frame GarageDoor']);
        const frame = graph.children[0];
        expect(frame.details).toBe('ibd [subsystem] GarageDoor');
        expect(frame.ports.map(p => `${p.id} ${p.direction} ${p.kind} ${p.side}`)).toEqual([
            'GarageDoor.open in async WEST',
            'GarageDoor.close in async WEST',
            'GarageDoor.stop in async WEST',
            'GarageDoor.report out sync EAST'
        ]);
        // centered on the left (in) or right (out) border, the label outside of the frame
        for (const port of frame.ports) {
            if (port.side === 'WEST') {
                expect(port.x + port.size / 2).toBeCloseTo(0, 0);
                expect(port.label.x + port.label.width).toBeLessThan(0);
            } else {
                expect(port.x + port.size / 2).toBeCloseTo(frame.width, 0);
                expect(port.label.x).toBeGreaterThan(frame.width);
            }
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
        expect(door.behavior?.uri).toMatch(/controller\.devm$/);
        const drive = node(layout, 'GarageDoor/drive');
        expect([drive.stereotype, drive.composite?.structure]).toEqual(['subsystem', 'DriveUnit']);
        expect(drive.composite?.uri).toMatch(/drive-unit\.devm$/);
        expect(door.ports.map(p => p.name).sort()).toEqual(['alarm', 'blocked', 'close', 'cycles', 'down', 'errors', 'halt', 'open', 'position', 'stop', 'stopped', 'up']);
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
        // the in port `open` receives the events of the subsystem's boundary port on the left; the in port
        // `stopped` faces its source in the drive unit on the right
        expect(door.ports.find(p => p.name === 'open')!.side).toBe('WEST');
        expect(door.ports.find(p => p.name === 'stopped')!.side).toBe('EAST');
        expect(node(layout, 'GarageDoor/buzzer').ports.map(p => `${p.name}:${p.side}`)).toEqual(['alarm:WEST']);
        // ports show their type in the label (the name only for an event without payload)
        expect(door.ports.find(p => p.name === 'up')!.label.text).toBe('up : integer');
        expect(door.ports.find(p => p.name === 'open')!.label.text).toBe('open');
        expect(door.ports.find(p => p.name === 'up')!.title).toBe('out async up : integer');
    });

    test('connectors: ids, kinds, cross-thread connections are dashed', () => {
        expect(layout.graph.edges.map(e => `${e.id} ${e.kind}${e.crossThread ? ' cross-thread' : ''}${e.bidirectional ? ' both-ways' : ''}`)).toEqual([
            'GarageDoor/door.up->drive.up connect cross-thread',
            'GarageDoor/door.down->drive.down connect cross-thread',
            'GarageDoor/door.halt->drive.halt connect cross-thread',
            'GarageDoor/drive.stopped->door.stopped connect cross-thread',
            'GarageDoor/drive.blocked->door.blocked connect cross-thread',
            'GarageDoor/door.alarm->buzzer.alarm connect',
            'GarageDoor/sensor.position->door.position connect cross-thread',
            'GarageDoor/door.cycles->diag.cycles connect cross-thread',
            'GarageDoor/door.errors->diag.errors connect cross-thread both-ways',
            'GarageDoor/open->door.open delegate',
            'GarageDoor/close->door.close delegate',
            'GarageDoor/stop->door.stop delegate',
            'GarageDoor/diag.report->report delegate'
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
        expect([...ibdRouteElements(layout, 'GarageDoor/door.up')!].sort()).toEqual([
            'GarageDoor/door', 'GarageDoor/door.up', 'GarageDoor/door.up->drive.up', 'GarageDoor/drive', 'GarageDoor/drive.up'
        ]);
        // through the delegation to the boundary port
        expect([...ibdRouteElements(layout, 'GarageDoor.open')!].sort()).toEqual([
            'GarageDoor.open', 'GarageDoor/door', 'GarageDoor/door.open', 'GarageDoor/open->door.open'
        ]);
        // shared data of inout ports
        expect([...ibdRouteElements(layout, 'GarageDoor/diag.errors')!].sort()).toEqual([
            'GarageDoor/diag', 'GarageDoor/diag.errors', 'GarageDoor/door', 'GarageDoor/door.errors', 'GarageDoor/door.errors->diag.errors'
        ]);
        expect([...ibdRouteElements(layout, 'GarageDoor/door.alarm->buzzer.alarm')!].sort()).toEqual([
            'GarageDoor/buzzer', 'GarageDoor/buzzer.alarm', 'GarageDoor/door', 'GarageDoor/door.alarm', 'GarageDoor/door.alarm->buzzer.alarm'
        ]);
        const sensor = ibdRouteElements(layout, 'GarageDoor/sensor')!;
        expect([...sensor].sort()).toEqual([
            'GarageDoor/door', 'GarageDoor/door.position', 'GarageDoor/sensor', 'GarageDoor/sensor.position', 'GarageDoor/sensor.position->door.position'
        ]);
        expect(ibdRouteElements(layout, 'GarageDoor/thread:IoTask')).toBeUndefined();
        expect(ibdRouteElements(layout, 'GarageDoor')).toBeUndefined();
    });

    test('rendered as SVG with the classes of the web editor', () => {
        const highlight = new Map([...ibdRouteElements(layout, 'GarageDoor/door.up')!].map(id => [id, 'on-route']));
        const svg = renderIbdSvg(layout.graph, { theme: 'dark', highlight, routeHighlight: true });
        const root = parseXml(svg);
        expect(root.attributes.class).toBe('sprotty-graph theme-dark devm-export ibd-diagram route-highlight');
        expect(withClass(root, 'ibd-frame')).toHaveLength(1);
        expect(withClass(root, 'ibd-thread')).toHaveLength(2);
        expect(withClass(root, 'ibd-instance')).toHaveLength(5);
        expect(withClass(root, 'ibd-port')).toHaveLength(4 + 12 + 1 + 1 + 3 + 5);
        expect(withClass(root, 'ibd-connector')).toHaveLength(13);
        expect(withClass(root, 'cross-thread')).toHaveLength(8);
        expect(withClass(root, 'delegation')).toHaveLength(4);
        expect(withClass(root, 'on-route')).toHaveLength(5);
        // every port has an arrow (the direction of the data), async ports are filled, sync ports hollow
        expect(withClass(root, 'ibd-port-arrow')).toHaveLength(withClass(root, 'ibd-port').length);
        expect(withClass(root, 'async').length + withClass(root, 'sync').length).toBe(withClass(root, 'ibd-port').length);
        expect(withClass(root, 'flow-inout')).toHaveLength(2);
        // an arrowhead at the receiving end of every connector, two between inout ports
        expect(withClass(root, 'ibd-connector-arrow')).toHaveLength(13 + 1);
        expect(svg).toContain('door : DoorController');
        expect(svg).toContain('«thread»');
    });
});

describe('internal block diagram: the closed garage installation system', () => {
    test('a frame without ports: the garage door subsystem and its environment as parts', async () => {
        const layout = (await layoutStructure(await loadExample('system.devm')))!;
        expect(layout.graph.kind).toBe('system');
        const frame = layout.graph.children[0];
        expect(`${frame.kind} ${frame.id}`).toBe('frame GarageInstallation');
        expect(frame.details).toBe('ibd [system] GarageInstallation');
        expect(frame.ports).toEqual([]);
        expect(frame.children.map(n => `${n.kind} ${n.id}`)).toEqual([
            'thread GarageInstallation/thread:RadioTask', 'thread GarageInstallation/thread:DisplayTask', 'instance GarageInstallation/door'
        ]);
        expect(layout.graph.edges.map(e => `${e.id} ${e.kind}`)).toEqual([
            'GarageInstallation/remote.open->door.open connect',
            'GarageInstallation/remote.close->door.close connect',
            'GarageInstallation/remote.stop->door.stop connect',
            'GarageInstallation/door.report->display.report connect'
        ]);
        expect(node(layout, 'GarageInstallation/door').composite?.structure).toBe('GarageDoor');
    });
});

describe('internal block diagram: other elements', () => {
    test('the drive unit: two threads, delegations to and from the boundary ports', async () => {
        const layout = (await layoutStructure(await loadExample('drive-unit.devm')))!;
        const frame = layout.graph.children[0];
        expect(frame.details).toBe('ibd [subsystem] DriveUnit');
        expect(frame.children.map(n => n.id)).toEqual(['DriveUnit/thread:MotorTask', 'DriveUnit/thread:SwitchTask']);
        expect(frame.ports.map(p => `${p.name} ${p.side}`)).toEqual(['up WEST', 'down WEST', 'halt WEST', 'stopped EAST', 'blocked EAST']);
        expect(node(layout, 'DriveUnit/thread:MotorTask').details).toBe('priority 8 · period 1 ms · stack 2048');
        expect(layout.graph.edges.find(e => e.id === 'DriveUnit/motor.duty->pwm.duty')?.crossThread).toBe(false);
        expect(layout.graph.edges.find(e => e.id === 'DriveUnit/switches.endSwitch->motor.endSwitch')?.crossThread).toBe(true);
        // in ports left, out ports right (the unconnected out port `speed` too)
        expect(node(layout, 'DriveUnit/motor').ports.map(p => `${p.name}:${p.side}`).sort()).toEqual([
            'blocked:EAST', 'down:WEST', 'duty:EAST', 'endSwitch:WEST', 'halt:WEST', 'overcurrent:WEST', 'speed:EAST', 'stopped:EAST', 'up:WEST'
        ]);
        // no data types declared in the file: no type boxes
        expect(layout.graph.children.map(n => n.kind)).toEqual(['frame']);
        expect([...ibdRouteElements(layout, 'DriveUnit.stopped')!].sort()).toEqual([
            'DriveUnit.stopped', 'DriveUnit/motor', 'DriveUnit/motor.stopped', 'DriveUnit/motor.stopped->stopped'
        ]);
    });

    test('component types: the overview and a single block', async () => {
        const model = await loadExample('components.devm');
        expect(ibdChoices(model).map(c => c.id)).toEqual([
            'DoorController', 'MotorController', 'PwmDriver', 'EndSwitches', 'PositionSensor', 'Buzzer', 'Diagnosis', 'RemoteControl', 'StatusDisplay', IBD_OVERVIEW_ID
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
        // ports show their type in the label
        expect(node(overview, 'DoorController').ports.find(p => p.name === 'position')?.label.text).toBe('position : door::Position');
        expect(node(overview, 'DoorController').ports.find(p => p.name === 'alarm')?.label.text).toBe('alarm');
        // blocks: in ports left, out and inout ports right
        expect(node(overview, 'Diagnosis').ports.map(p => `${p.name}:${p.side}`)).toEqual(['cycles:WEST', 'errors:EAST', 'report:EAST']);
    });

    test('data types: the structs of the file as unconnected type boxes', async () => {
        // a file without component types: only the type boxes
        const types = await loadExample('types.devm');
        expect(ibdChoices(types).map(c => `${c.kind} ${c.id}`)).toEqual([`types ${IBD_TYPES_ID}`]);
        const layout = (await layoutStructure(types))!;
        expect(layout.graph.kind).toBe('types');
        expect(layout.graph.edges).toEqual([]);
        expect(layout.graph.children.map(n => `${n.kind} ${n.stereotype} ${n.id}`)).toEqual(['type struct type:Diagnostics']);
        expect(node(layout, 'type:Diagnostics').members?.map(memberText)).toEqual(['cycles : integer', 'errors : integer']);
        expect(layout.elements.get('type:Diagnostics')?.$type).toBe('StructDeclaration');
        expect(ibdRouteElements(layout, 'type:Diagnostics')).toBeUndefined();
        // a mixed file: the subsystem, the type boxes below its frame (automatic layout: the example is arranged by hand), nothing connected to them
        const light = (await layoutStructure(await loadExample('light.devm'), { layout: null }))!;
        const [frame, ...boxes] = light.graph.children;
        expect(frame.details).toBe('ibd [subsystem] CourtesyLight');
        expect(boxes.map(b => `${b.kind} ${b.name}`)).toEqual(['type LightLevel']);
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
component A { in sync p : integer  out async e }
subsystem Inner { in sync p : integer  thread I { a : A }  delegate p -> a.p }
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
        // (a.e and b.e are both out ports: an invalid connection is still drawn; unresolved ones are not)
        expect(layout.graph.edges.map(e => `${e.id}${e.crossThread ? ' cross-thread' : ''}`)).toEqual(['Top/a.e->b.e cross-thread']);
        const inner = (await layoutStructure(model, { element: 'Inner' }))!;
        expect(inner.graph.edges.map(e => e.id)).toEqual(['Inner/p->a.p']);
    });

    test('the arrows of the ports point in the direction of the data', () => {
        const arrow = (direction: 'in' | 'out' | 'inout', side: 'WEST' | 'EAST') => portArrow({ direction, side, size: 10 });
        // the line of the arrow: `M tail L tip`, then the arrowhead(s)
        const tipX = (d: string) => Number(/^M [\d.]+,[\d.]+ L ([\d.]+),/.exec(d)![1]);
        const tailX = (d: string) => Number(/^M ([\d.]+),/.exec(d)![1]);
        // in, left border: the data flows into the node (to the right)
        expect(tipX(arrow('in', 'WEST'))).toBeGreaterThan(tailX(arrow('in', 'WEST')));
        expect(tipX(arrow('out', 'WEST'))).toBeLessThan(tailX(arrow('out', 'WEST')));
        expect(tipX(arrow('in', 'EAST'))).toBeLessThan(tailX(arrow('in', 'EAST')));
        expect(tipX(arrow('out', 'EAST'))).toBeGreaterThan(tailX(arrow('out', 'EAST')));
        // inout: arrowheads at both ends
        expect(arrow('inout', 'WEST').split('M').length - 1).toBe(3);
        expect(arrow('in', 'WEST').split('M').length - 1).toBe(2);
        expect(portClasses({ direction: 'inout', kind: 'sync' })).toEqual(['ibd-port', 'flow-inout', 'sync']);
    });

    test('connectors: an arrowhead at the receiving end, at both ends between inout ports', () => {
        const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 30 }];
        const [head] = connectorArrowheads(points);
        // the tip at the end of the route, pointing down (the direction of the last segment)
        expect(head).toMatch(/^M 20,30 L 23.5,22 L 16.5,22 Z$/);
        expect(connectorArrowheads(points, true)).toHaveLength(2);
        expect(connectorArrowheads(points, true)[1]).toMatch(/^M 0,0 /);
        expect(connectorArrowheads([{ x: 0, y: 0 }])).toEqual([]);
    });
});

describe('devm render: structure files', () => {
    test('renders the device example (structures and state machines)', async () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'devm-ibd-'));
        const messages: string[] = [];
        const code = await runRenderCommand([DEVICE], { out, theme: 'modern' }, { log: m => messages.push(m), error: m => messages.push(`error: ${m}`) });
        expect(code).toBe(0);
        expect(fs.readdirSync(out).sort()).toEqual(['components.svg', 'controller.svg', 'drive-unit.svg', 'drive.svg', 'garage-door.svg', 'light.svg', 'system.svg', 'types.svg']);
        expect(fs.readFileSync(path.join(out, 'types.svg'), 'utf-8')).toContain('class="ibd-node ibd-type"');
        const system = fs.readFileSync(path.join(out, 'system.svg'), 'utf-8');
        expect(system).toMatch(/^<\?xml/);
        expect(system).toContain('theme-modern');
        expect(system).toContain('class="ibd-node ibd-frame"');
        expect(system).toContain('GarageInstallation');
        expect(fs.readFileSync(path.join(out, 'garage-door.svg'), 'utf-8')).toContain('[subsystem] <tspan class="ibd-frame-name">GarageDoor');
        expect(fs.readFileSync(path.join(out, 'drive-unit.svg'), 'utf-8')).toContain('DriveUnit');
        fs.rmSync(out, { recursive: true, force: true });
    });

    test('a single file with --element', async () => {
        const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devm-ibd-')), 'buzzer.svg');
        const messages: string[] = [];
        const logger = { log: (m: string) => messages.push(m), error: (m: string) => messages.push(`error: ${m}`) };
        expect(await runRenderCommand([path.join(DEVICE, 'components.devm')], { out, element: 'Buzzer' }, logger)).toBe(0);
        expect(fs.readFileSync(out, 'utf-8')).toContain('Buzzer');
        expect(await runRenderCommand([path.join(DEVICE, 'components.devm')], { out, element: 'Nope' }, logger)).toBe(1);
        expect(messages.at(-1)).toMatch(/no subsystem, system or component type 'Nope'/);
    });
});

describe('internal block diagram: problems as markers on the diagram elements', () => {
    async function issuesOf(text: string, element?: string) {
        const parsed = await loader.load(text, `file:///ibd/issues-${counter++}.devm`);
        expect(parsed.hasSyntaxErrors).toBe(false);
        const layout = (await layoutStructure(parsed.model, { element }))!;
        const issues = ibdIssues(layout, parsed.document, parsed.diagnostics);
        return { parsed, layout, issues: Object.fromEntries([...issues].map(([id, issue]) => [id, `${issue.severity}: ${issue.messages.join(' | ')}`])) };
    }

    test('a port of a system: the error is shown at the boundary port of the frame (not at the frame)', async () => {
        const { issues } = await issuesOf(`
component A { in async e  out async f }
system Top {
    in async light
    thread T { a : A  b : A }
    connect b.f -> a.e
}`);
        expect(issues['Top.light']).toMatch(/^error: 'Top' is a system: the closed top level has no ports/);
        expect(issues.Top).toBeUndefined();
    });

    test('a boundary port of a subsystem that is not delegated: a warning at the port', async () => {
        const { issues } = await issuesOf(`
component A { in async e  out async f }
subsystem Sub {
    in async go
    out async done
    thread T { a : A }
    delegate go -> a.e
}`);
        expect(issues['Sub.done']).toMatch(/^warning: The out port 'done' is not delegated from a part/);
        expect(issues['Sub.go']).toBeUndefined();
        expect(Object.keys(issues)).toEqual(['Sub.done']);
    });

    test('delegations, connections and threads get their own markers', async () => {
        const { issues } = await issuesOf(`
component A { in async e  out async f  in sync v : integer  out sync w : real }
subsystem Sub {
    in async go
    out async done
    thread T { a : A  b : A }
    thread U { a }
    delegate go -> a.e
    delegate go -> a.e
    delegate b.f -> done
    connect a.w -> b.v
    connect a.f -> b.e
    connect b.w -> a.v
}`);
        expect(issues['Sub/go->a.e~1']).toMatch(/^warning: Duplicate delegation/);
        expect(issues['Sub/a.w->b.v']).toMatch(/^error: /);
        expect(issues['Sub/thread:U']).toMatch(/^error: The instance 'a' is already assigned to the thread 'T'/);
        expect(issues['Sub/a.f->b.e']).toBeUndefined();
    });

    test('the innermost element at an offset: boundary port, connector, instance, frame', async () => {
        const text = `
component A { in async e }
subsystem Sub {
    in async go
    thread T { a : A }
    delegate go -> a.e
}`;
        const { parsed, layout } = await issuesOf(text);
        const at = (snippet: string, frame = true) => ibdDiagramElementAt(layout, parsed.document, text.indexOf(snippet), frame);
        expect(at('in async go')).toBe('Sub.go');
        expect(at('delegate go')).toBe('Sub/go->a.e');
        expect(at('a : A')).toBe('Sub/a');
        expect(at('thread T')).toBe('Sub/thread:T');
        expect(at('subsystem Sub')).toBe('Sub');
        expect(at('subsystem Sub', false)).toBeUndefined();
        // the component type A is not part of the diagram of Sub
        expect(at('component A')).toBeUndefined();
    });

    test('a port of a component block (the diagram of a component type)', async () => {
        const { issues } = await issuesOf(`
component A { in async e  in sync v : Missing }`, 'A');
        expect(Object.keys(issues)).toEqual(['A.v']);
        expect(issues['A.v']).toMatch(/^error: .*Missing/);
    });
});
