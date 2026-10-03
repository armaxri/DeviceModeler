import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { expandFiles, runDocCommand, runRenderCommand } from '../src/cli/render-commands.js';
import { docComment } from '../src/doc/doc-comments.js';
import { describeStateMachine, generateDocIndex, generateModelDoc, markdownToHtml } from '../src/doc/model-doc.js';
import { parseXml } from '../src/importer/xml.js';
import { allTransitions, allVertices } from '../src/model-utils.js';
import { example, loader, parse } from './helpers.js';

const EXAMPLES_DIR = path.resolve(__dirname, '../../../examples');

const MODEL = `/**
 * A documented machine.
 *
 * Second paragraph with \`code\`.
 */
statemachine Doc "short description" {
    @EventDriven
    @ChildFirstExecution

    /** The default interface. */
    interface:
        /** Starts it. */
        in event start : integer
        out event done
        /** A counter | with a pipe. */
        var count : integer = 1 + 2
        var readonly flag : boolean
        const LIMIT = 10
        /** Computes things. */
        operation compute(a : integer, rest... : string) : real

    interface Named:
        in event go

    internal:
        event tick

    [*] -> Idle

    /** Waiting for start. */
    state Idle {
        entry / count = 0
        exit [count > 0] / raise done
        tick / count += 1
    }
    state Work {
        region First {
            [*] -> A
            state A
        }
        region {
            [*] -> B
            state B
        }
    }
    choice C

    /** Start working. */
    Idle -> C : start [valueof(start) > 0] / count = valueof(start)
    C -> Work : [count > LIMIT]
    C -> Idle : else
    Work -> [*] : Named.go
}
`;

describe('doc comments', () => {
    test('are taken from /** */ comments before elements', async () => {
        const parsed = await parse(MODEL);
        expect(parsed.hasSyntaxErrors).toBe(false);
        expect(docComment(parsed.model)).toBe('A documented machine.\n\nSecond paragraph with `code`.');
        const idle = allVertices(parsed.model).find(v => v.name === 'Idle');
        expect(docComment(idle)).toBe('Waiting for start.');
        expect(docComment(allVertices(parsed.model).find(v => v.name === 'Work'))).toBeUndefined();
        expect(docComment(allTransitions(parsed.model).find(t => t.source?.ref === idle))).toBe('Start working.');
        // plain comments are no documentation
        const cd = await parse('/* plain */\nstatemachine M { // line\n [*] -> A\n state A }');
        expect(docComment(cd.model)).toBeUndefined();
    });

    test('hover shows signature and documentation', async () => {
        const parsed = await parse(MODEL);
        const provider = loader.services.Hsm.documentation.DocumentationProvider;
        const count = parsed.model.scopes[0].declarations[2];
        expect(provider.getDocumentation(count)).toBe('```devm\nvar count : integer = 1 + 2\n```\n\nA counter | with a pipe.');
        const compute = parsed.model.scopes[0].declarations[5];
        expect(provider.getDocumentation(compute)).toContain('operation compute(a : integer, rest... : string) : real');
        const idle = allVertices(parsed.model).find(v => v.name === 'Idle')!;
        expect(provider.getDocumentation(idle)).toBe('```devm\nstate Idle\n```\n\nWaiting for start.');
    });
});

describe('model documentation', () => {
    test('describes declarations, states and transitions', async () => {
        const parsed = await parse(MODEL);
        const doc = describeStateMachine(parsed.model);
        expect(doc.name).toBe('Doc');
        expect(doc.description).toBe('short description');
        expect(doc.execution).toEqual({ mode: 'event', period: undefined, order: 'child-first', annotations: ['@EventDriven', '@ChildFirstExecution'] });
        expect(doc.scopes.map(s => [s.kind, s.name])).toEqual([['interface', undefined], ['interface', 'Named'], ['internal', undefined]]);
        const main = doc.scopes[0];
        expect(main.documentation).toBe('The default interface.');
        expect(main.events).toEqual([
            { name: 'start', direction: 'in', type: 'integer', documentation: 'Starts it.' },
            { name: 'done', direction: 'out', type: 'void', documentation: undefined }
        ]);
        expect(main.variables.map(v => [v.name, v.type, v.constant, v.readonly, v.initialValue])).toEqual([
            ['count', 'integer', false, false, '1 + 2'],
            ['flag', 'boolean', false, true, undefined],
            ['LIMIT', 'integer', true, false, '10']
        ]);
        expect(main.operations[0]).toMatchObject({ signature: 'compute(a : integer, rest... : string) : real', returnType: 'real', documentation: 'Computes things.' });
        expect(doc.scopes[2].events[0].direction).toBe('internal');
        const idle = doc.vertices.find(v => v.name === 'Idle')!;
        expect(idle).toMatchObject({ kind: 'state', entry: ['count = 0'], exit: ['[count > 0] / raise done'], reactions: ['tick / count += 1'], documentation: 'Waiting for start.' });
        expect(doc.vertices.find(v => v.name === 'Work')).toMatchObject({ kind: 'orthogonal state', subStates: ['First: A', 'region 2: B'] });
        expect(doc.vertices.find(v => v.name === 'Work.B')).toMatchObject({ parent: 'Work (region 2)' });
        expect(doc.vertices.find(v => v.name === 'C')?.kind).toBe('choice');
        const start = doc.transitions.find(t => t.source === 'Idle')!;
        expect(start).toMatchObject({ target: 'C', triggers: ['start'], guard: 'valueof(start) > 0', effect: 'count = valueof(start)', documentation: 'Start working.' });
        expect(doc.transitions.filter(t => t.source === 'C').map(t => t.priority)).toEqual([1, 2]);
        expect(doc.transitions.find(t => t.target === '[*]')).toMatchObject({ source: 'Work', scope: 'Doc', triggers: ['Named.go'] });
        expect(doc.transitions[0]).toMatchObject({ source: '[*]', target: 'Idle', scope: 'Doc' });
    });

    test('Markdown page', async () => {
        const parsed = await parse(MODEL);
        const md = generateModelDoc(parsed.model, { svgFile: 'Doc.svg', source: 'models/doc.devm', sourceHref: '../models/doc.devm', indexFile: 'index.md' });
        expect(md).toContain('# Doc\n');
        expect(md).toContain('> short description');
        expect(md).toContain('A documented machine.\n\nSecond paragraph with `code`.');
        expect(md).toContain('![Doc diagram](Doc.svg)');
        expect(md).toContain('Source: [`models/doc.devm`](../models/doc.devm)');
        expect(md).toContain('| Execution | event driven |');
        expect(md).toContain('| `start` | in | `integer` | Starts it. |');
        expect(md).toContain('| `count` | var | `integer` | `1 + 2` | A counter \\| with a pipe. |');
        expect(md).toContain('| `compute(a : integer, rest... : string)` | `real` | Computes things. |');
        expect(md).toContain('### Interface `Named`');
        expect(md).toContain('### Internal scope');
        expect(md).toContain('| `Idle` | state | Waiting for start. | `count = 0` | `[count > 0] / raise done` | `tick / count += 1` |');
        expect(md).toContain('| `Idle` | `C` | `start` | `valueof(start) > 0` | `count = valueof(start)` |   | Start working. |');
        expect(md).toContain('| `C` | `Idle` | `else` |   |   | 2 |');
        // every table row has the same number of cells as its header
        for (const table of md.split('\n\n').filter(b => b.startsWith('|'))) {
            const rows = table.split('\n').filter(r => r);
            const cells = (row: string) => row.replace(/\\\|/g, '').split('|').length;
            expect(rows.every(r => cells(r) === cells(rows[0])), table).toBe(true);
        }
    });

    test('HTML page with inlined diagram', async () => {
        const parsed = await parse(MODEL);
        const svg = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>';
        const html = generateModelDoc(parsed.model, { format: 'html', svg });
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(html).toContain('<title>Doc</title>');
        expect(html).toContain('<figure class="diagram"><svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg></figure>');
        expect(html).not.toContain('<?xml');
        expect(html).toContain('<p>A documented machine.</p>\n<p>Second paragraph with <code>code</code>.</p>');
        expect(html).toContain('<td><code>count</code></td><td>var</td><td><code>integer</code></td><td><code>1 + 2</code></td><td>A counter | with a pipe.</td>');
        expect(html).toContain('<code>valueof(start) &gt; 0</code>');
        // well-formed apart from the doctype
        expect(() => parseXml(html.replace('<!DOCTYPE html>', '').replace(/<br>/g, '<br/>').replace('<meta charset="utf-8">', '<meta charset="utf-8"/>')
            .replace(/<meta name="viewport"[^>]*>/, ''))).not.toThrow();
    });

    test('index page and Markdown to HTML', () => {
        const entries = [{ name: 'A', file: 'A.md', description: 'first', documentation: 'Para 1.\n\nPara 2.', source: 'a.devm', sourceHref: '../a.devm' }];
        expect(generateDocIndex(entries)).toBe('# State machines\n\n| State machine | Description | Source |\n| --- | --- | --- |\n'
            + '| [A](A.md) | first<br>Para 1. | [`a.devm`](../a.devm) |\n');
        expect(generateDocIndex(entries, 'html', 'Models')).toContain('<h1>Models</h1>');
        expect(markdownToHtml('a **b** *c* `<d>`\n\n- x\n- [y](https://e.org)')).toBe(
            '<p>a <strong>b</strong> <em>c</em> <code>&lt;d&gt;</code></p>\n<ul><li>x</li><li><a href="https://e.org">y</a></li></ul>');
    });

    test('examples are documented', async () => {
        for (const file of ['traffic-light.devm', 'cd-player.devm', 'keyboard.devm', 'door.devm']) {
            const parsed = await parse(example(file));
            const doc = describeStateMachine(parsed.model);
            expect(doc.documentation, file).toBeTruthy();
            expect(doc.vertices.length).toBeGreaterThan(2);
            expect(doc.transitions.length).toBe(allTransitions(parsed.model).length);
        }
    });
});

describe('CLI render and doc', () => {
    const logger = () => {
        const messages: string[] = [];
        return { messages, log: (m: string) => messages.push(m), error: (m: string) => messages.push(`ERROR ${m}`) };
    };

    test('expands directories and glob patterns', async () => {
        const all = (await expandFiles([EXAMPLES_DIR])).map(f => path.basename(f));
        // cpp-types/: the example importing a C++ header, device/: the structure example (structure files
        // and state machines), door-with-motor/: the submachine example (two files)
        expect(all).toEqual(['cd-player.devm', 'conveyor.devm', 'components.devm', 'controller.devm', 'drive-unit.devm', 'drive.devm', 'light.devm',
            'system.devm', 'types.devm', 'gate.devm', 'motor.devm', 'door.devm', 'keyboard.devm', 'traffic-light.devm']);
        expect((await expandFiles([path.join(EXAMPLES_DIR, 'k*.devm')])).map(f => path.basename(f))).toEqual(['keyboard.devm']);
        expect(await expandFiles([path.join(EXAMPLES_DIR, '**/*.devm')])).toHaveLength(14);
        expect(await expandFiles([path.join(EXAMPLES_DIR, '*.nothing')])).toEqual([]);
    });

    test('devm render', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-cli-render-'));
        const log = logger();
        expect(await runRenderCommand([EXAMPLES_DIR], { out: dir, theme: 'dark', direction: 'right', routing: 'orthogonal' }, log)).toBe(0);
        // (with the structure files of examples/device)
        expect(fs.readdirSync(dir).sort()).toEqual(['cd-player.svg', 'components.svg', 'controller.svg', 'conveyor.svg', 'door.svg', 'drive-unit.svg', 'drive.svg',
            'gate.svg', 'keyboard.svg', 'light.svg', 'motor.svg', 'system.svg', 'traffic-light.svg', 'types.svg']);
        const svg = fs.readFileSync(path.join(dir, 'door.svg'), 'utf-8');
        expect(parseXml(svg).attributes.class).toContain('theme-dark');
        const single = path.join(dir, 'sub', 'door-classic.svg');
        expect(await runRenderCommand([path.join(EXAMPLES_DIR, 'door.devm')], { out: single }, log)).toBe(0);
        expect(fs.existsSync(single)).toBe(true);
        expect(log.messages.filter(m => m.startsWith('ERROR'))).toEqual([]);
        // errors
        expect(await runRenderCommand([EXAMPLES_DIR], { theme: 'neon' }, log)).toBe(2);
        expect(await runRenderCommand([EXAMPLES_DIR], { format: 'png' }, log)).toBe(2);
        const broken = path.join(dir, 'broken.devm');
        fs.writeFileSync(broken, 'statemachine {');
        expect(await runRenderCommand([broken], { out: dir }, log)).toBe(1);
        expect(log.messages.some(m => m.includes('skipped (syntax errors)'))).toBe(true);
    });

    test('devm doc (Markdown and HTML)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-cli-doc-'));
        const log = logger();
        const md = path.join(dir, 'md');
        expect(await runDocCommand([path.join(EXAMPLES_DIR, '*.devm')], { out: md }, log)).toBe(0);
        expect(fs.readdirSync(md).sort()).toEqual(['CdPlayer.md', 'CdPlayer.svg', 'Door.md', 'Door.svg', 'Keyboard.md', 'Keyboard.svg',
            'TrafficLight.md', 'TrafficLight.svg', 'index.md']);
        const index = fs.readFileSync(path.join(md, 'index.md'), 'utf-8');
        expect(index).toContain('[TrafficLight](TrafficLight.md)');
        const page = fs.readFileSync(path.join(md, 'TrafficLight.md'), 'utf-8');
        expect(page).toContain('![TrafficLight diagram](TrafficLight.svg)');
        expect(page).toContain('Push button of the pedestrian crossing.');
        expect(page).toContain('cycle based, period `100 ms`');
        const html = path.join(dir, 'html');
        expect(await runDocCommand([EXAMPLES_DIR], { out: html, format: 'html', title: 'Examples' }, log)).toBe(0);
        expect(fs.readdirSync(html).sort()).toEqual(['CdPlayer.html', 'Conveyor.html', 'Door.html', 'DoorController.html', 'Drive.html', 'Gate.html', 'Keyboard.html', 'Motor.html', 'TrafficLight.html', 'index.html']);
        const door = fs.readFileSync(path.join(html, 'Door.html'), 'utf-8');
        expect(door).toContain('<svg xmlns="http://www.w3.org/2000/svg" class="sprotty-graph theme-classic hsm-export"');
        expect(door).toContain('Automatic door with obstacle detection');
        expect(fs.readFileSync(path.join(html, 'index.html'), 'utf-8')).toContain('<h1>Examples</h1>');
        expect(log.messages.filter(m => m.startsWith('ERROR'))).toEqual([]);
    });
});
