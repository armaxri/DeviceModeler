import { describe, expect, test } from 'vitest';
import { layoutStateMachine, MACHINE_ID } from '../src/diagram/layout.js';
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

describe('PlantUML generator', () => {
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
