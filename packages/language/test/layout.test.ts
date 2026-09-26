import { describe, expect, test } from 'vitest';
import { DEFINITION_ID, layoutStateMachine, MACHINE_ID, wrapLine } from '../src/diagram/layout.js';
import type { DiagramNode } from '../src/diagram/diagram-model.js';
import { generatePlantUml } from '../src/generator/plantuml.js';
import { example, parse } from './helpers.js';

function flatten(nodes: DiagramNode[], parentX = 0, parentY = 0): Array<DiagramNode & { ax: number, ay: number }> {
    return nodes.flatMap(n => [{ ...n, ax: parentX + n.x, ay: parentY + n.y }, ...flatten(n.children, parentX + n.x, parentY + n.y)]);
}

describe('layout', () => {
    for (const direction of ['DOWN', 'RIGHT'] as const) {
        for (const file of ['traffic-light.hsm', 'cd-player.hsm', 'keyboard.hsm', 'door.hsm']) {
            test(`${file} (${direction})`, async () => {
                const parsed = await parse(example(file));
                const { graph, elements } = await layoutStateMachine(parsed.model, { direction });
                expect(graph.id).toBe(MACHINE_ID);
                expect(graph.width).toBeGreaterThan(0);
                const nodes = flatten(graph.children);
                // children lie within their parents
                const check = (node: DiagramNode) => {
                    for (const child of node.children) {
                        expect(child.x).toBeGreaterThanOrEqual(-0.01);
                        expect(child.y).toBeGreaterThanOrEqual(-0.01);
                        expect(child.x + child.width).toBeLessThanOrEqual(node.width + 0.01);
                        expect(child.y + child.height).toBeLessThanOrEqual(node.height + 0.01);
                        check(child);
                    }
                };
                graph.children.forEach(check);
                for (const edge of graph.edges) {
                    expect(edge.points.length, edge.id).toBeGreaterThanOrEqual(2);
                    expect(elements.get(edge.id)?.$type).toBe('Transition');
                    expect(nodes.some(n => n.id === edge.source)).toBe(true);
                    expect(nodes.some(n => n.id === edge.target)).toBe(true);
                }
            });
        }
    }

    test('regions fill their state', async () => {
        const parsed = await parse(example('keyboard.hsm'));
        const { graph } = await layoutStateMachine(parsed.model);
        const active = graph.children.find(n => n.id === 'Active')!;
        const regions = active.children.filter(c => c.kind === 'region');
        expect(regions).toHaveLength(2);
        expect(regions[0].width).toBe(active.width);
        expect(regions[0].y + regions[0].height).toBeCloseTo(regions[1].y);
        expect(regions[1].y + regions[1].height).toBeCloseTo(active.height);
    });
});

describe('diagram content', () => {
    test('definition section is the first node', async () => {
        const parsed = await parse(example('traffic-light.hsm'));
        const { graph, elements } = await layoutStateMachine(parsed.model);
        const definition = graph.children[0];
        expect(definition.id).toBe(DEFINITION_ID);
        expect(definition.kind).toBe('definition');
        expect(elements.get(DEFINITION_ID)).toBe(parsed.model);
        expect(definition.body).toEqual(expect.arrayContaining(['@CycleBased(100)', 'interface:', '  in event powerOn', 'interface Pedestrian:',
            '  var waiting : boolean = false', 'internal:', '  operation switchOn(mask : integer) : void']));
    });

    test('no definition node without definition section', async () => {
        const parsed = await parse('statemachine M { [*] -> A state A }');
        const { graph } = await layoutStateMachine(parsed.model);
        expect(graph.children.some(n => n.kind === 'definition')).toBe(false);
    });

    test('transition priorities', async () => {
        const parsed = await parse(example('cd-player.hsm'));
        const labels = async (priorities: boolean) => (await layoutStateMachine(parsed.model, { priorities })).graph.edges.map(e => e.label?.text);
        const withPriorities = await labels(true);
        expect(withPriorities).toContain('1: [discInserted() && tracks > 0]');
        expect(withPriorities).toContain('2: else');
        expect(withPriorities).toContain('1: eject');
        expect(withPriorities).toContain('2: powerOff');
        // single outgoing transitions have no priority
        expect(withPriorities).toContain('play');
        const without = await labels(false);
        expect(without).toContain('else');
        expect(without).toContain('eject');
    });

    test('entry points, exit nodes and sync bars', async () => {
        for (const direction of ['DOWN', 'RIGHT'] as const) {
            const parsed = await parse(example('door.hsm'));
            const { graph } = await layoutStateMachine(parsed.model, { direction });
            const nodes = flatten(graph.children);
            const opening = nodes.find(n => n.id === 'Moving.Opening')!;
            expect(opening.kind).toBe('entry');
            expect(opening.label?.text).toBe('Opening');
            expect(nodes.find(n => n.id === 'Moving.Blocked')?.kind).toBe('exit');
            const fork = nodes.find(n => n.id === 'Fork')!;
            expect(fork.kind).toBe('sync');
            if (direction === 'DOWN') {
                expect(fork.width).toBeGreaterThan(fork.height);
            } else {
                expect(fork.height).toBeGreaterThan(fork.width);
            }
            expect(graph.edges.find(e => e.source === 'Closed' && e.target === 'Moving')?.label?.text).toBe('open # >Opening');
        }
    });

    test('long lines are wrapped at statement boundaries', () => {
        expect(wrapLine('entry / lights = RED; switchOn(lights); raise lightsChanged : lights', 40)).toEqual([
            'entry / lights = RED; switchOn(lights);',
            '    raise lightsChanged : lights'
        ]);
        expect(wrapLine('short', 40)).toEqual(['short']);
        expect(wrapLine('x'.repeat(50), 40)).toEqual(['x'.repeat(39) + '…']);
    });
});

describe('PlantUML generator', () => {
    test('pseudo states of itemis CREATE', async () => {
        const parsed = await parse(example('door.hsm'));
        const puml = generatePlantUml(parsed.model);
        expect(puml).toContain('state Fork <<fork>>');
        expect(puml).toContain('state Join <<join>>');
        expect(puml).toContain('  state Opening <<entryPoint>>');
        expect(puml).toContain('  state Blocked <<exitPoint>>');
        expect(puml).toContain('Closed --> Opening : open');
        expect(puml).toContain('Blocked --> Fork : / raise alarm');
        expect(puml).toContain('Locked --> Join');
    });

    test('definition section as legend', async () => {
        const parsed = await parse(example('keyboard.hsm'));
        const puml = generatePlantUml(parsed.model);
        expect(puml).toContain('legend top left\ninterface:\n  in event capsLock\n');
        expect(puml).toContain('internal:\n  const CAPS : integer = 1\n  const NUM : integer = 2\nendlegend');
    });

    test('aliases for duplicate names', async () => {
        const parsed = await parse(`statemachine M {
    [*] -> A
    state A { [*] -> X state X }
    state B { [*] -> X state X }
    A.X -> B.X : go
}`);
        const puml = generatePlantUml(parsed.model);
        expect(puml).toContain('  state "X" as A_X');
        expect(puml).toContain('  state "X" as B_X');
        expect(puml).toContain('  [*] --> A_X');
        expect(puml).toContain('A_X --> B_X : go');
    });

    test('cd player', async () => {
        const parsed = await parse(example('cd-player.hsm'));
        const puml = generatePlantUml(parsed.model);
        expect(puml).toContain('@startuml');
        expect(puml).toContain('state HasDisc <<choice>>');
        expect(puml).toContain('Open --> Closed[H] : eject');
        expect(puml).toContain('  Stopped --> HasDisc : play');
        expect(puml).toContain('Playing : entry / startMotor()');
    });

    test('regions', async () => {
        const parsed = await parse(example('keyboard.hsm'));
        const puml = generatePlantUml(parsed.model);
        expect(puml).toMatch(/CapsOn --> CapsOff : capsLock\n  --\n  state NumOff/);
    });
});
