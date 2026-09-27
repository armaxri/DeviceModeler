import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { approximateTextMeasure, layoutStateMachine } from '../src/diagram/layout.js';
import type { DiagramNode } from '../src/diagram/diagram-model.js';
import { helveticaTextWidth, monospaceTextWidth } from '../src/diagram/text-metrics.js';
import { parseXml, type XmlElement } from '../src/importer/xml.js';
import { allTransitions, allVertices } from '../src/model-utils.js';
import { DIAGRAM_CSS } from '../src/render/diagram-styles.js';
import { DIAGRAM_THEMES, escapeXml, highlightClass, renderSvg } from '../src/render/svg.js';
import { example, parse } from './helpers.js';

const EXAMPLES = ['traffic-light.hsm', 'cd-player.hsm', 'keyboard.hsm', 'door.hsm'];

function elements(root: XmlElement): XmlElement[] {
    return [root, ...root.children.flatMap(elements)];
}

function classes(element: XmlElement): string[] {
    return (element.attributes.class ?? '').split(/\s+/).filter(c => c);
}

function withClass(root: XmlElement, cls: string): XmlElement[] {
    return elements(root).filter(e => classes(e).includes(cls));
}

function flatten(nodes: DiagramNode[]): DiagramNode[] {
    return nodes.flatMap(n => [n, ...flatten(n.children)]);
}

describe('text metrics', () => {
    test('Helvetica widths', () => {
        // AFM widths: H = 722, i = 222, space = 278
        expect(helveticaTextWidth('Hi', 10)).toBeCloseTo(9.44);
        expect(helveticaTextWidth('', 12)).toBe(0);
        expect(helveticaTextWidth('W', 1000)).toBe(944);
        expect(helveticaTextWidth('…', 10)).toBe(10);
        expect(monospaceTextWidth('abcd', 10)).toBeCloseTo(24.08);
        expect(approximateTextMeasure('Playing', 'name')).toEqual({ width: Math.ceil(helveticaTextWidth('Playing', 14)), height: 17 });
        // narrow and wide letters are measured differently
        expect(approximateTextMeasure('iiii', 'body').width).toBeLessThan(approximateTextMeasure('MMMM', 'body').width / 3);
    });
});

describe('renderSvg', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-render-'));

    for (const file of EXAMPLES) {
        for (const direction of ['DOWN', 'RIGHT'] as const) {
            test(`${file} (${direction}) in all themes`, async () => {
                const parsed = await parse(example(file));
                const { graph } = await layoutStateMachine(parsed.model, { direction });
                const nodes = flatten(graph.children);
                for (const theme of DIAGRAM_THEMES) {
                    const svg = renderSvg(graph, { theme });
                    fs.writeFileSync(path.join(dir, `${file.replace('.hsm', '')}-${direction}-${theme}.svg`), svg);
                    expect(svg.startsWith('<?xml')).toBe(true);
                    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
                    const root = parseXml(svg);
                    expect(root.name).toBe('svg');
                    expect(classes(root)).toEqual(expect.arrayContaining(['sprotty-graph', `theme-${theme}`, 'hsm-export']));
                    expect(Number(root.attributes.width)).toBeGreaterThanOrEqual(graph.width);
                    expect(root.attributes.viewBox).toBe(`0 0 ${root.attributes.width} ${root.attributes.height}`);
                    expect(root.children.find(c => c.name === 'style')?.text).toContain('.theme-classic');
                    // one group per diagram element
                    expect(withClass(root, 'hsm-node')).toHaveLength(nodes.length);
                    expect(withClass(root, 'state')).toHaveLength(nodes.filter(n => n.kind === 'state').length);
                    expect(withClass(root, 'region')).toHaveLength(nodes.filter(n => n.kind === 'region').length);
                    expect(withClass(root, 'transition')).toHaveLength(graph.edges.length);
                    expect(withClass(root, 'transition-arrow')).toHaveLength(graph.edges.length);
                    expect(withClass(root, 'transition-label')).toHaveLength(graph.edges.filter(e => e.label).length);
                    expect(withClass(root, 'definition')).toHaveLength(1);
                    // all state names are rendered
                    const names = withClass(root, 'state-name').map(e => e.text);
                    expect(names.sort()).toEqual(nodes.filter(n => n.kind === 'state').map(n => n.name).sort());
                    for (const edge of graph.edges.filter(e => e.label)) {
                        expect(svg).toContain(`>${escapeXml(edge.label!.text)}`);
                    }
                }
            });
        }
    }

    test('pseudo states have the shapes of the web editor', async () => {
        const parsed = await parse(example('door.hsm'));
        const { graph } = await layoutStateMachine(parsed.model);
        const root = parseXml(renderSvg(graph));
        expect(withClass(root, 'entry-point')).toHaveLength(2);
        expect(withClass(root, 'exit-point')).toHaveLength(1);
        expect(withClass(root, 'exit-cross')).toHaveLength(1);
        expect(withClass(root, 'sync-shape')).toHaveLength(2);
        expect(withClass(root, 'region-separator')).toHaveLength(1);
        expect(withClass(root, 'node-label').map(e => e.text).sort()).toEqual(['Blocked', 'Closing', 'Opening']);
        const cd = await parse(example('cd-player.hsm'));
        const cdRoot = parseXml(renderSvg((await layoutStateMachine(cd.model)).graph));
        expect(withClass(cdRoot, 'history-text').map(e => e.text)).toEqual(['H']);
        expect(withClass(cdRoot, 'choice-shape')).toHaveLength(1);
        expect(withClass(cdRoot, 'final-inner')).toHaveLength(1);
        expect(withClass(cdRoot, 'initial-shape')).toHaveLength(3);
    });

    test('highlight, legend, title and styles', async () => {
        const parsed = await parse(example('cd-player.hsm'));
        const layout = await layoutStateMachine(parsed.model);
        const playing = allVertices(parsed.model).find(v => v.name === 'Playing')!;
        const paused = allVertices(parsed.model).find(v => v.name === 'Paused')!;
        const eject = allTransitions(parsed.model).find(t => t.source?.ref?.name === 'Closed' && t.target?.ref?.name === 'Open')!;
        const highlight = new Map([
            [layout.ids.get(playing)!, 'covered'],
            [layout.ids.get(paused)!, 'uncovered'],
            [layout.ids.get(eject)!, 'uncovered'],
            ['#definitions', 'my-class other']
        ]);
        const svg = renderSvg(layout.graph, { theme: 'dark', highlight, legend: true, title: 'Coverage <CdPlayer> & more', embedStyles: false });
        const root = parseXml(svg);
        expect(root.children.some(c => c.name === 'style')).toBe(false);
        const covered = withClass(root, 'hsm-covered');
        const uncovered = withClass(root, 'hsm-uncovered');
        // plus one sample state and transition per legend entry
        expect(covered.filter(e => classes(e).includes('state')).length).toBe(2);
        expect(uncovered.filter(e => classes(e).includes('state')).length).toBe(2);
        expect(uncovered.filter(e => classes(e).includes('transition')).length).toBe(2);
        expect(withClass(root, 'my-class').map(classes)[0]).toEqual(['hsm-node', 'definition', 'my-class', 'other']);
        expect(withClass(root, 'hsm-legend-label').map(e => e.text)).toEqual(['covered', 'not covered']);
        expect(withClass(root, 'hsm-title')[0].text).toBe('Coverage <CdPlayer> & more');
        expect(Number(root.attributes.height)).toBeGreaterThan(layout.graph.height + 30 + 44);
        // the CSS classes are defined in the shared style sheet
        expect(DIAGRAM_CSS).toContain('.hsm-node.hsm-covered > .state-shape');
        expect(DIAGRAM_CSS).toContain('.transition.hsm-uncovered .transition-line');
        expect(highlightClass('active')).toBe('active');
        expect(highlightClass('bad"class x')).toBe('x');
        // explicit legend and inline mode
        const inline = renderSvg(layout.graph, { legend: [{ kind: 'active', label: 'active state' }], xmlDeclaration: false });
        expect(inline.startsWith('<svg')).toBe(true);
        expect(withClass(parseXml(inline), 'hsm-legend-label')[0].text).toBe('active state');
    });

    test('escapes text and survives degenerate graphs', () => {
        const svg = renderSvg({
            id: '#machine', name: 'M', width: NaN, height: 100, direction: 'DOWN',
            children: [{
                id: 'A', kind: 'state', name: 'A<&>"', x: 10, y: Infinity, width: 80, height: 40, headerHeight: 26,
                body: ['  x = 1 && y < 2\u0001'], children: []
            }],
            edges: [
                { id: 'e', source: 'A', target: 'A', routing: 'spline', points: [{ x: 0, y: 0 }] },
                { id: 'f', source: 'A', target: 'A', routing: 'polyline', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], label: { text: 'a < b', x: 1, y: 2, width: 30, height: 15 } }
            ]
        });
        expect(svg).not.toMatch(/NaN|Infinity/);
        const root = parseXml(svg);
        expect(withClass(root, 'state-name')[0].text).toBe('A<&>"');
        expect(withClass(root, 'state-body')[0].text).toBe('  x = 1 && y < 2');
        expect(withClass(root, 'transition')).toHaveLength(1);
    });
});
