import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, test } from 'vitest';
import { runRenderCommand } from '../src/cli/render-commands.js';
import * as ast from '../src/generated/ast.js';
import { ibdNodes, layoutStructure, structureDiagramElements } from '../src/diagram/ibd-layout.js';
import { captureIbdLayout, createIbdLayout, type IbdManualLayout, type IbdManualLayoutResult } from '../src/diagram/ibd-manual-layout.js';
import { hasIbdLayoutAnnotations, ibdLayoutFromModel, ibdLayoutTextEdits, withoutIbdLayoutAnnotations } from '../src/diagram/ibd-layout-annotations.js';
import type { IbdNode } from '../src/diagram/ibd-model.js';
import { StructureEditor, structureRenameEdits } from '../src/edit/structure-edits.js';
import { applyEdits } from '../src/edit/model-edits.js';
import { StructureModelLoader } from '../src/model-loader.js';
import { createDevmServices } from '../src/devm-module.js';

const DEVICE = path.resolve(__dirname, '../../../examples/device');
const services = createDevmServices(NodeFileSystem);
const deviceLoader = new StructureModelLoader(services);
const SYSTEM = fs.readFileSync(path.join(DEVICE, 'system.devm'), 'utf-8');

/** Loads a structure file of the device example (the other files of the example are read from disk). */
async function load(text: string, file = 'system.devm') {
    const location = path.join(DEVICE, file);
    const parsed = await deviceLoader.load(text, URI.file(location).toString());
    expect(parsed.hasSyntaxErrors, text).toBe(false);
    return parsed;
}

async function diagram(text: string, file = 'system.devm', element?: string): Promise<{ model: ast.StructureModel, layout: IbdManualLayoutResult }> {
    const parsed = await load(text, file);
    return { model: parsed.model, layout: (await layoutStructure(parsed.model, { element }))! };
}

/** The text with the layout written as annotations (computed on the diagram of `text`). */
async function withLayout(text: string, change: (layout: IbdManualLayout, current: IbdManualLayoutResult) => void, file = 'system.devm', element?: string): Promise<string> {
    const { model, layout } = await diagram(text, file, element);
    const manual = layout.effective ? structuredClone(layout.effective) : captureIbdLayout(layout.graph);
    change(manual, layout);
    return applyEdits(text, ibdLayoutTextEdits(model, layout, text, manual));
}

function node(layout: IbdManualLayoutResult, id: string): { node: IbdNode, x: number, y: number } {
    const found = ibdNodes(layout.graph).find(n => n.node.id === id);
    expect(found, id).toBeDefined();
    return found!;
}

async function format(text: string): Promise<string> {
    const parsed = await load(text);
    const edits = await services.Devm.lsp.Formatter!.formatDocument(parsed.document, {
        textDocument: { uri: parsed.document.uri.toString() },
        options: { tabSize: 4, insertSpaces: true }
    });
    return TextDocument.applyEdits(parsed.document.textDocument, edits);
}

describe('structure diagrams: manual layout', () => {
    test('the captured automatic layout written as annotations is identical to the automatic layout; the text is formatter-stable', async () => {
        const auto = (await diagram(SYSTEM)).layout;
        expect(auto.effective).toBeUndefined();
        const text = await withLayout(SYSTEM, () => undefined);
        expect(text).toContain('@at(130, 16)\nsystem GarageDoor {');
        expect(text).toContain('    @priority(5) @period(10 ms) @at(41, 48)\n    thread ControlTask {');
        expect(text).toContain('        @at(26, 52) door : DoorController');
        expect(await format(text)).toBe(text);
        const { model, layout } = await diagram(text);
        expect(hasIbdLayoutAnnotations(model, layout)).toBe(true);
        expect(layout.effective).toBeDefined();
        const box = (l: IbdManualLayoutResult) => ibdNodes(l.graph).map(n => ({ id: n.node.id, x: n.x, y: n.y, w: n.node.width, h: n.node.height }));
        expect(box(layout)).toEqual(box(auto));
        expect(layout.graph.edges.map(e => e.points)).toEqual(auto.graph.edges.map(e => e.points));
        expect([layout.graph.width, layout.graph.height]).toEqual([auto.graph.width, auto.graph.height]);
        // writing the same layout again: no edits; reading it back gives the written layout
        expect(ibdLayoutTextEdits(model, layout, text, layout.effective)).toEqual([]);
        expect(ibdLayoutFromModel(model, layout)?.nodes).toEqual(layout.effective!.nodes);
        // the input of the automatic layout is the text without layout annotations
        expect(withoutIbdLayoutAnnotations(model, text)).toBe(SYSTEM);
    });

    test('moved instances keep their position; connectors are rerouted orthogonally from port to port', async () => {
        const text = await withLayout(SYSTEM, layout => {
            layout.nodes['GarageDoor/buzzer'].y += 120;
            layout.nodes['GarageDoor/drive'].x += 80;
        });
        expect(text).toContain('@at(366, 216) buzzer : Buzzer');
        const { layout } = await diagram(text);
        const thread = node(layout, 'GarageDoor/thread:ControlTask');
        const buzzer = node(layout, 'GarageDoor/buzzer');
        expect([buzzer.node.x, buzzer.node.y]).toEqual([366, 216]);
        // the thread grew to fit its instances
        expect(thread.node.y + thread.node.height).toBeGreaterThan(buzzer.node.y + buzzer.node.height);
        const alarm = layout.graph.edges.find(e => e.id === 'GarageDoor/door.alarm->buzzer.alarm')!;
        const port = buzzer.node.ports.find(p => p.name === 'alarm')!;
        // the connector ends at the outer side of the port square, all segments are orthogonal
        expect(alarm.points[alarm.points.length - 1]).toEqual({ x: buzzer.x + port.x, y: buzzer.y + port.y + port.size / 2 });
        for (let i = 0; i + 1 < alarm.points.length; i++) {
            const [p, q] = [alarm.points[i], alarm.points[i + 1]];
            expect(Math.abs(p.x - q.x) < 0.01 || Math.abs(p.y - q.y) < 0.01).toBe(true);
        }
        // connectors whose ports did not move keep the route of the automatic layout
        const auto = (await diagram(SYSTEM)).layout;
        const report = 'GarageDoor/report->diag.report';
        expect(layout.graph.edges.find(e => e.id === report)!.points).toEqual(auto.graph.edges.find(e => e.id === report)!.points);
    });

    test('ports: side and offset (@port), the connector leaves the port perpendicular to its side', async () => {
        const text = await withLayout(SYSTEM, layout => {
            layout.ports['GarageDoor/door.status'] = { side: 'SOUTH', offset: 40 };
            layout.ports['GarageDoor.report'] = { side: 'SOUTH', offset: 300 };
        });
        expect(text).toContain('@at(26, 52) @port(status, bottom, 40) door : DoorController');
        expect(text).toContain('@at(130, 16) @port(report, bottom, 300)\nsystem GarageDoor {');
        expect(await format(text)).toBe(text);
        const { model, layout } = await diagram(text);
        expect(ibdLayoutFromModel(model, layout)?.ports).toEqual({
            'GarageDoor/door.status': { side: 'SOUTH', offset: 40 }, 'GarageDoor.report': { side: 'SOUTH', offset: 300 }
        });
        const door = node(layout, 'GarageDoor/door');
        const status = door.node.ports.find(p => p.name === 'status')!;
        expect(status.side).toBe('SOUTH');
        expect([status.x + status.size / 2, status.y + status.size / 2]).toEqual([40, door.node.height]);
        // the label below the instance, right of the port; the thread contains it
        expect(status.label.y).toBeGreaterThan(door.node.height);
        const thread = node(layout, 'GarageDoor/thread:ControlTask');
        expect(thread.y + thread.node.height).toBeGreaterThan(door.y + status.label.y + status.label.height);
        const edge = layout.graph.edges.find(e => e.id === 'GarageDoor/drive.status->door.status')!;
        const end = edge.points[edge.points.length - 1];
        const before = edge.points[edge.points.length - 2];
        expect(end).toEqual({ x: door.x + 40, y: door.y + door.node.height + status.size / 2 });
        expect(before.x).toBeCloseTo(end.x);
        expect(before.y).toBeGreaterThan(end.y);
        // a boundary port at the bottom of the frame: the connector leaves it upwards (into the frame)
        const frame = node(layout, 'GarageDoor');
        const report = frame.node.ports.find(p => p.name === 'report')!;
        expect(report.side).toBe('SOUTH');
        const delegation = layout.graph.edges.find(e => e.id === 'GarageDoor/report->diag.report')!;
        expect(delegation.points[0]).toEqual({ x: frame.x + 300, y: frame.y + frame.node.height - report.size / 2 });
        expect(delegation.points[1].y).toBeLessThan(delegation.points[0].y);
        // ports of a side keep their distance
        const pushed = await withLayout(SYSTEM, layout => {
            layout.ports['GarageDoor/door.motor'] = { side: 'EAST', offset: 100 };
            layout.ports['GarageDoor/door.alarm'] = { side: 'EAST', offset: 101 };
        });
        const ports = node((await diagram(pushed)).layout, 'GarageDoor/door').node.ports;
        const center = (name: string) => { const p = ports.find(q => q.name === name)!; return p.y + p.size / 2; };
        expect(Math.abs(center('motor') - center('alarm'))).toBeGreaterThanOrEqual(22);
    });

    test('waypoints of connectors (@via), relative to the frame of the connector', async () => {
        const id = 'GarageDoor/diag.cycles->door.cycles';
        const text = await withLayout(SYSTEM, layout => {
            layout.edges[id] = { bends: [{ x: 560, y: 420 }] };
        });
        expect(text).toContain('@via(560, 420) connect diag.cycles -> door.cycles');
        const { layout } = await diagram(text);
        const frame = node(layout, 'GarageDoor');
        const edge = layout.graph.edges.find(e => e.id === id)!;
        expect(edge.waypoints).toEqual([{ x: frame.x + 560, y: frame.y + 420 }]);
        expect(edge.points).toContainEqual({ x: frame.x + 560, y: frame.y + 420 });
        expect(layout.effective!.edges[id]).toEqual({ bends: [{ x: 560, y: 420 }] });
        // waypoints of a connector inside a thread are relative to the thread
        const drive = fs.readFileSync(path.join(DEVICE, 'drive-unit.devm'), 'utf-8');
        const inner = 'DriveUnit/motor.pwm->pwm.duty';
        const moved = await withLayout(drive, layout => {
            layout.edges[inner] = { bends: [{ x: 150, y: 150 }] };
            layout.nodes['DriveUnit/thread:MotorTask'].x += 30;
        }, 'drive-unit.devm');
        const result = (await diagram(moved, 'drive-unit.devm')).layout;
        const thread = node(result, 'DriveUnit/thread:MotorTask');
        expect(result.graph.edges.find(e => e.id === inner)!.waypoints).toEqual([{ x: thread.x + 150, y: thread.y + 150 }]);
    });

    test('sizes (@size): a resized thread keeps its size, but never becomes smaller than its content', async () => {
        const text = await withLayout(SYSTEM, layout => {
            layout.nodes['GarageDoor/thread:IoTask'] = { ...layout.nodes['GarageDoor/thread:IoTask'], width: 500, height: 400 };
            layout.nodes['GarageDoor/thread:ControlTask'] = { ...layout.nodes['GarageDoor/thread:ControlTask'], width: 50, height: 50 };
        });
        expect(text).toContain('@priority(2) @period(100 ms) @at(610, 172) @size(500, 400)');
        const { layout } = await diagram(text);
        expect([node(layout, 'GarageDoor/thread:IoTask').node.width, node(layout, 'GarageDoor/thread:IoTask').node.height]).toEqual([500, 400]);
        const control = node(layout, 'GarageDoor/thread:ControlTask').node;
        const auto = node((await diagram(SYSTEM)).layout, 'GarageDoor/thread:ControlTask').node;
        expect(control.width).toBeGreaterThanOrEqual(auto.width - 1);
        expect(control.height).toBeGreaterThanOrEqual(auto.height - 1);
        // the frame grows with the thread
        const frame = node(layout, 'GarageDoor').node;
        expect(frame.height).toBeGreaterThan(172 + 400);
    });

    test('Automatic layout removes the layout annotations of the diagram, other annotations stay', async () => {
        const text = await withLayout(SYSTEM, layout => {
            layout.ports['GarageDoor/door.status'] = { side: 'NORTH', offset: 30 };
            layout.edges['GarageDoor/diag.cycles->door.cycles'] = { bends: [{ x: 560, y: 420 }] };
        });
        const { model, layout } = await diagram(text);
        expect(applyEdits(text, ibdLayoutTextEdits(model, layout, text, undefined))).toBe(SYSTEM);
    });

    test('only the annotations of the elements of the shown diagram are read and written', async () => {
        const text = `component A { provides sync p : integer  requires sync r : integer }
@at(10, 10)
subsystem Inner {
    provides sync p : integer
    thread I {
        @at(20, 60) a : A
    }
    delegate p -> a.p
}
system Outer {
    thread T {
        a : A
        b : A
    }
    inner : Inner
    connect a.r -> b.p
}
`;
        const outer = await diagram(text, 'two.devm');
        expect(outer.layout.graph.id).toBe('Outer');
        // the annotations of Inner belong to its own diagram
        expect(outer.layout.effective).toBeUndefined();
        const changed = await withLayout(text, layout => { layout.nodes['Outer/b'].x += 50; }, 'two.devm');
        expect(changed).toContain('@at(10, 10)\nsubsystem Inner {');
        expect(changed).toContain('        @at(20, 60) a : A\n    }\n    delegate');
        expect(changed).toMatch(/@at\(\d+, \d+\)\nsystem Outer/);
        const inner = await diagram(changed, 'two.devm', 'Inner');
        expect(inner.layout.effective?.nodes['Inner/a']).toEqual({ x: 20, y: 60 });
        // removing the layout of Outer keeps the layout of Inner
        const back = await diagram(changed, 'two.devm');
        expect(applyEdits(changed, ibdLayoutTextEdits(back.model, back.layout, changed, undefined))).toBe(text);
    });

    test('type boxes and component blocks: one position for all diagrams of the file', async () => {
        const light = fs.readFileSync(path.join(DEVICE, 'light.devm'), 'utf-8');
        const { layout } = await diagram(light, 'light.devm');
        expect(layout.effective).toBeDefined();
        const frame = node(layout, 'CourtesyLight');
        for (const id of ['type:LightLevel', 'type:LightCmd']) {
            // right of the frame (arranged by hand in the example)
            expect(node(layout, id).x).toBeGreaterThanOrEqual(frame.x + frame.node.width);
        }
        expect(node(layout, 'CourtesyLight/led').node.ports[0].side).toBe('NORTH');
        // the overview of the component types shows the type boxes at the same place, the blocks do not overlap them
        const overview = (await diagram(light, 'light.devm', '#components')).layout;
        expect(node(overview, 'type:LightLevel').x).toBe(720);
        const blocks = overview.graph.children.filter(c => c.kind === 'block');
        const types = overview.graph.children.filter(c => c.kind === 'type');
        for (const block of blocks) {
            for (const type of types) {
                expect(block.x + block.width <= type.x || type.x + type.width <= block.x || block.y + block.height <= type.y || type.y + type.height <= block.y).toBe(true);
            }
        }
        const moved = await withLayout(light, layout => { layout.nodes['Dimmer'] = { x: 400, y: 300 }; }, 'light.devm', '#components');
        expect(moved).toContain('/** Fades the lamp in and out. */\n@at(400, 300)\ncomponent Dimmer {');
    });

    test('the automatic layout of a previous run is reused while the diagram has the same elements', async () => {
        const { model, layout } = await diagram(SYSTEM);
        const again = await layoutStructure(model, { reuse: layout.auto });
        expect(again!.graph).toBe(layout.auto);
        const other = await load(SYSTEM.replace('buzzer : Buzzer', 'buzzer : Buzzer\n        beeper : Buzzer'));
        const fresh = await layoutStructure(other.model, { reuse: layout.auto });
        expect(fresh!.graph).not.toBe(layout.auto);
        expect(ibdNodes(fresh!.graph).some(n => n.node.id === 'GarageDoor/beeper')).toBe(true);
        const elements = await structureDiagramElements(model);
        expect([...elements!.elements.keys()].sort()).toEqual([...layout.elements.keys()].sort());
    });

    test('validation of the layout annotations', async () => {
        const text = SYSTEM
            .replace('door : DoorController', '@at(1) @port(nothing, left, 10) @port(cmd, middle) door : DoorController')
            .replace('buzzer : Buzzer', '@at(1, 2) @at(3, 4) @size(-1, 5) buzzer : Buzzer')
            .replace('    connect door.motor -> drive.ctrl', '    @via(1, 2, 3) connect door.motor -> drive.ctrl')
            .replace('    provides async remote : DoorCmd', '    @at(1, 2) provides async remote : DoorCmd')
            .replace('    thread IoTask', '    @via(1, 2) @port(cmd, left)\n    thread IoTask');
        const parsed = await deviceLoader.load(text, URI.file(path.join(DEVICE, 'system.devm')).toString());
        const messages = parsed.diagnostics.map(d => `${d.severity === 1 ? 'error' : 'warning'}: ${d.message}`);
        expect(messages).toEqual(expect.arrayContaining([
            'error: Invalid arguments: position in the structure diagram: @at(x, y).',
            'warning: DoorController has no port \'nothing\' (the annotation is ignored).',
            'error: Invalid arguments: side and offset of a port in the structure diagram: @port(name, left | right | top | bottom, offset).',
            'error: Duplicate annotation \'@at\'.',
            'error: Invalid arguments: size in the structure diagram: @size(width, height).',
            'error: Invalid arguments: waypoints of the connector in the structure diagram: @via(x1, y1, x2, y2, ...).',
            '\'@at\' has no effect here (position in the structure diagram: @at(x, y)).',
            '\'@via\' has no effect here (waypoints of the connector in the structure diagram: @via(x1, y1, x2, y2, ...)).',
            '\'@port\' has no effect here (side and offset of a port in the structure diagram: @port(name, left | right | top | bottom, offset)).'
        ].map(m => m.startsWith('error') || m.startsWith('warning') ? m : `warning: ${m}`)));
        const valid = await withLayout(SYSTEM, layout => {
            layout.ports['GarageDoor/door.status'] = { side: 'NORTH', offset: 30 };
            layout.edges['GarageDoor/diag.cycles->door.cycles'] = { bends: [{ x: 560, y: 420 }] };
            layout.nodes['GarageDoor/thread:IoTask'] = { ...layout.nodes['GarageDoor/thread:IoTask'], width: 400, height: 300 };
        });
        expect((await load(valid)).diagnostics.filter(d => /@|annotation/.test(d.message))).toEqual([]);
    });

    test('structural edits keep the layout annotations: moving an instance, renaming a port', async () => {
        const text = await withLayout(SYSTEM, layout => {
            layout.ports['GarageDoor/door.status'] = { side: 'NORTH', offset: 30 };
            layout.ports['GarageDoor.remote'] = { side: 'NORTH', offset: 100 };
        });
        const parsed = await load(text);
        const structure = parsed.model.elements.find(ast.isCompositeType)!;
        const buzzer = structure.threads[0].instances.find(i => i.name === 'buzzer')!;
        const moved = applyEdits(text, new StructureEditor(text, parsed.model).moveInstance(buzzer, structure.threads[1]).edits);
        expect(moved).toMatch(/thread IoTask \{[^}]*@at\(366, 96\) buzzer : Buzzer/);
        // a renamed boundary port: its @port follows
        const remote = structure.ports.find(p => p.name === 'remote')!;
        const edits = structureRenameEdits(services.Devm, remote, 'command').get(parsed.document.uri.toString())!;
        expect(applyEdits(text, edits)).toContain('@port(command, top, 100)');
    });

    test('devm render honors the layout annotations of structure files (--auto ignores them)', async () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ibd-layout-'));
        const logger = { log: () => undefined, error: (m: string) => { throw new Error(m); } };
        const manual = path.join(out, 'manual.svg');
        const automatic = path.join(out, 'auto.svg');
        expect(await runRenderCommand([path.join(DEVICE, 'light.devm')], { out: manual }, logger)).toBe(0);
        expect(await runRenderCommand([path.join(DEVICE, 'light.devm')], { out: automatic, auto: true }, logger)).toBe(0);
        const width = (file: string) => Number(/<svg[^>]* width="(\d+)"/.exec(fs.readFileSync(file, 'utf-8'))![1]);
        const { layout } = await diagram(fs.readFileSync(path.join(DEVICE, 'light.devm'), 'utf-8'), 'light.devm');
        expect(width(manual)).toBe(Math.ceil(layout.graph.width));
        expect(width(automatic)).not.toBe(width(manual));
        fs.rmSync(out, { recursive: true, force: true });
    });

    test('an empty layout pins nothing: the diagram is the automatic one', async () => {
        const { model, layout } = await diagram(SYSTEM);
        const parsed = await layoutStructure(model, { layout: createIbdLayout() });
        expect(ibdNodes(parsed!.graph).map(n => [n.x, n.y])).toEqual(ibdNodes(layout.graph).map(n => [n.x, n.y]));
    });
});
