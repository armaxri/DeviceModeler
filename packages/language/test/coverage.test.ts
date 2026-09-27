import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { LangiumDocument } from 'langium';
import * as ast from '../src/generated/ast.js';
import { layoutStateMachine } from '../src/diagram/layout.js';
import { StatechartInterpreter } from '../src/simulation/interpreter.js';
import {
    checkCoverageThresholds, CoverageCollector, diagramIds, HsmTestWorkspace, parseCoverageThresholds, runTests, toCobertura,
    toCoverageHtml, toCoverageJson, toCoverageText, toLcov, type CoverageReport, type MachineCoverage
} from '../src/testing/index.js';
import { runTestCommand } from '../src/testing/test-command.js';

const workspace = new HsmTestWorkspace();
let counter = 0;

const CHOICE = `
statemachine Choice {
    @EventDriven
    interface:
        in event go
        in event back
        var x : integer = 0
    [*] -> A
    state A {
        entry / x += 1
        back [x > 5] / x = 0
    }
    state B
    state C
    state Unused
    choice c
    A -> c : go
    c -> B : [x > 1]
    c -> C : else
    B -> A : back [x > 0]
    C -> A : back
}`;

const HISTORY = `
statemachine Hist {
    @EventDriven
    interface:
        in event e
        in event f
        in event g
    [*] -> Q
    state P {
        [*] -> P1
        state P1
        state P2
        history Hi
        Hi -> P2
        P1 -> P2 : e
    }
    state Q
    P -> Q : f
    Q -> P.Hi : f
    Q -> [*] : g
}`;

const REGIONS = `
statemachine Regions {
    @EventDriven
    interface:
        in event a
        in event b
    [*] -> F
    sync F
    F -> S.X1
    F -> S.Y1
    state S {
        region r1 {
            [*] -> X1
            state X1
            state X2
            X1 -> X2 : a
            X2 -> [*] : b
        }
        region {
            [*] -> Y1
            state Y1
            Y1 -> [*] : b
        }
    }
}`;

interface Loaded {
    machines: ast.StateMachine[];
    test: LangiumDocument<ast.TestModel>;
}

async function load(model: string, tests: string): Promise<Loaded> {
    const id = counter++;
    const documents = await workspace.load([
        { uri: `file:///cov${id}/model.hsm`, text: model },
        { uri: `file:///cov${id}/test.hsmtest`, text: tests }
    ]);
    for (const loaded of documents) {
        expect(loaded.diagnostics.filter(d => d.severity === 1).map(d => d.message)).toEqual([]);
    }
    return {
        machines: [documents[0].document.parseResult.value as ast.StateMachine],
        test: documents[1].document as LangiumDocument<ast.TestModel>
    };
}

async function coverageOf(model: string, tests: string): Promise<{ report: CoverageReport, machine: MachineCoverage, collector: CoverageCollector }> {
    const loaded = await load(model, tests);
    const collector = new CoverageCollector();
    const results = runTests(loaded.test, undefined, { coverage: collector });
    expect(results.filter(r => r.status !== 'passed')).toEqual([]);
    const report = collector.report();
    return { report, machine: report.machines[0], collector };
}

function covered(machine: MachineCoverage, kind?: string): string[] {
    return machine.elements.filter(e => e.hits > 0 && (!kind || e.kind === kind)).map(e => e.id);
}

function uncovered(machine: MachineCoverage, kind?: string): string[] {
    return machine.elements.filter(e => e.hits === 0 && (!kind || e.kind === kind)).map(e => e.id);
}

describe('coverage collection', () => {

    test('choice, guards (true / false / never evaluated) and reactions', async () => {
        const { machine, report } = await coverageOf(CHOICE, `
testclass T for statemachine Choice {
    @SetUp
    operation init() { enter }
    @Test
    operation elseBranch() {
        raise go
        assert active(C)
    }
    @Test
    operation guardedBranch() {
        raise go; raise back; raise back; raise go
        assert active(B)
    }
}`);
        expect(report.tests).toBe(2);
        expect(machine.totals.states).toEqual({ covered: 3, total: 4, percent: 75 });
        expect(uncovered(machine, 'state')).toEqual(['Unused']);
        expect(machine.totals.transitions).toEqual({ covered: 5, total: 6, percent: 83.33 });
        expect(uncovered(machine, 'transition')).toEqual(['B->A']);
        expect(covered(machine, 'transition')).toEqual(['#machine#initial->A', 'A->c', 'c->B', 'c->C', 'C->A']);
        expect(machine.totals.reactions).toEqual({ covered: 1, total: 2, percent: 50 });
        expect(uncovered(machine, 'reaction')).toEqual(['A#reaction2']);
        // [x > 5]: false only, [x > 1]: true and false, [x > 0]: never evaluated
        expect(machine.totals.guards).toEqual({ covered: 3, total: 6, percent: 50 });
        expect(machine.guards.map(g => [g.id, g.expression, g.trueHits, g.falseHits])).toEqual([
            ['A#reaction2', 'x > 5', 0, 1],
            ['c->B', 'x > 1', 1, 2],
            ['B->A', 'x > 0', 0, 0]
        ]);
        // per-test attribution
        const byId = (id: string) => machine.elements.find(e => e.id === id)!;
        expect(byId('c->C').tests).toEqual(['T.elseBranch', 'T.guardedBranch']);
        expect(byId('c->B').tests).toEqual(['T.guardedBranch']);
        expect(byId('A').hits).toBe(3);
        expect(byId('A#reaction1')).toMatchObject({ kind: 'reaction', name: 'A: entry / x += 1', line: 10, diagramId: 'A' });
        expect(byId('c->B')).toMatchObject({ name: 'c -> B : [x > 1]', line: 18 });
        expect(machine.guards[1].trueTests).toEqual(['T.guardedBranch']);
    });

    test('history with default transition and final state', async () => {
        const { machine } = await coverageOf(HISTORY, `
testclass T for statemachine Hist {
    @Test
    operation history() {
        enter
        raise f
        assert active(P.P2) message "default transition of the history"
        raise f; raise f
        assert active(P.P2)
        raise f; raise g
        assert is_final
    }
}`);
        expect(uncovered(machine)).toEqual(['P.P1', 'P#initial->P.P1', 'P.P1->P.P2']);
        expect(machine.totals.states).toEqual({ covered: 4, total: 5, percent: 80 });
        expect(machine.totals.transitions).toEqual({ covered: 5, total: 7, percent: 71.43 });
        expect(machine.elements.find(e => e.kind === 'final')).toMatchObject({ id: '#machine#final', name: '[*]', hits: 1, line: 20 });
        expect(machine.elements.find(e => e.id === 'P.Hi->P.P2')?.hits).toBe(1);
        expect(machine.elements.find(e => e.id === 'P.P2')?.hits).toBe(2);
    });

    test('orthogonal regions, final states per region and fork', async () => {
        const { machine } = await coverageOf(REGIONS, `
testclass T for statemachine Regions {
    @Test
    operation regions() {
        enter
        raise a
        raise b
        assert !active(S.X2)
    }
}`);
        expect(machine.elements.filter(e => e.kind === 'state' || e.kind === 'final').map(e => [e.id, e.region, e.hits])).toEqual([
            ['S', '#machine', 1],
            ['S.X1', 'S#region1', 1],
            ['S.X2', 'S#region1', 1],
            ['S#region1#final', 'S#region1', 1],
            ['S.Y1', 'S#region2', 1],
            ['S#region2#final', 'S#region2', 1]
        ]);
        expect(machine.elements.find(e => e.id === 'S#region2#final')?.name).toBe('S.region2.[*]');
        expect(uncovered(machine)).toEqual(['S#region1#initial->S.X1', 'S#region2#initial->S.Y1']);
        expect(machine.totals.transitions).toEqual({ covered: 6, total: 8, percent: 75 });
        expect(machine.totals.guards).toEqual({ covered: 0, total: 0 });
    });

    test('entry / exit points and join of the door example', async () => {
        const examples = path.resolve(__dirname, '../../../examples');
        const loaded = await load(fs.readFileSync(path.join(examples, 'door.hsm'), 'utf-8'), `
testclass T for statemachine Door {
    @Test
    operation all() {
        enter
        raise open; raise obstacle; raise serviceDone
        assert active(Closed)
    }
}`);
        const collector = new CoverageCollector();
        runTests(loaded.test, undefined, { coverage: collector });
        const machine = collector.report().machines[0];
        expect(covered(machine, 'transition')).toEqual([
            '#machine#initial->Closed', 'Moving.Opening->Moving.Up', 'Moving.Up->Moving.Blocked', 'Closed->Moving', 'Moving->Fork',
            'Fork->Service.Locked', 'Fork->Service.On', 'Service.Locked->Join', 'Service.On->Join', 'Join->Closed'
        ]);
        expect(machine.elements.find(e => e.id === 'Closed->Moving')?.name).toBe('Closed -> Moving : open # >Opening');
        expect(machine.elements.find(e => e.id === 'Moving->Fork')?.name).toBe('Moving -> Fork : / raise alarm # Blocked>');
    });

    test('the collector can be attached to any interpreter', async () => {
        const loaded = await load(CHOICE, 'testclass T for statemachine Choice { }');
        const collector = new CoverageCollector();
        const onTrace = vi.fn();
        const sim = new StatechartInterpreter(loaded.machines[0], collector.attach({ onTrace }));
        sim.enter();
        sim.raise('go');
        expect(onTrace).toHaveBeenCalled();
        const coverage = collector.machineCoverage(loaded.machines[0])!;
        expect(covered(coverage)).toEqual(['A', 'C', '#machine#initial->A', 'A->c', 'c->C', 'A#reaction1']);
        expect(coverage.elements.every(e => e.tests.length === 0)).toBe(true);
        const highlight = collector.highlight(loaded.machines[0])!;
        expect(highlight.classes['c']).toBe('hsm-covered');
        expect(highlight.classes['#machine#initial']).toBe('hsm-covered');
        expect(highlight.classes['B']).toBe('hsm-uncovered');
        expect(highlight.uncovered).toContain('B->A');
        collector.reset();
        expect(covered(collector.machineCoverage(loaded.machines[0])!)).toEqual([]);
    });

    test('runTests without coverage is unchanged', async () => {
        const loaded = await load(CHOICE, `
testclass T for statemachine Choice {
    @Test
    operation t() { enter; assert active(A) }
}`);
        expect(runTests(loaded.test).map(r => r.status)).toEqual(['passed']);
    });

    test('diagram ids equal the ids of the diagram layout', async () => {
        const examples = path.resolve(__dirname, '../../../examples');
        const models = [...fs.readdirSync(examples).filter(f => f.endsWith('.hsm')).map(f => fs.readFileSync(path.join(examples, f), 'utf-8')),
            CHOICE, HISTORY, REGIONS];
        for (const text of models) {
            const loaded = await load(text, '');
            const machine = loaded.machines[0];
            const layout = await layoutStateMachine(machine);
            const ids = diagramIds(machine);
            for (const [node, id] of layout.ids) {
                expect(ids.nodes.get(node)).toBe(id);
            }
            expect(ids.nodes.size).toBe(layout.ids.size);
            const pseudo = [...ids.initial.values(), ...ids.final.values()].sort();
            const layoutPseudo = [...layout.elements.keys()].filter(id => /#(initial|final)$/.test(id) && !id.includes('->')).sort();
            expect(pseudo).toEqual(layoutPseudo);
        }
    });
});

describe('coverage reports', () => {

    async function sampleReport() {
        return coverageOf(CHOICE, `
testclass T for statemachine Choice {
    @Test
    operation t() { enter; raise go; raise back; raise back; raise go }
}`);
    }

    test('text summary lists uncovered elements with lines', async () => {
        const { report } = await sampleReport();
        const text = toCoverageText(report, { fileName: () => 'choice.hsm' });
        expect(text).toMatch(/\nChoice\s+3\/4 75\.0%\s+5\/6 83\.3%\s+1\/2 50\.0%\s+3\/6 50\.0%\n/);
        expect(text).toContain('Not covered in Choice (choice.hsm):');
        expect(text).toContain('    15: state Unused');
        expect(text).toContain('    20: transition B -> A : back [x > 0]');
        expect(text).toContain('    11: guard [x > 5] of A: back [x > 5] / x = 0: never true');
        expect(text).toContain('    20: guard [x > 0] of B -> A : back [x > 0]: never evaluated');
    });

    test('JSON', async () => {
        const { report } = await sampleReport();
        const json = JSON.parse(toCoverageJson(report, { fileName: () => 'choice.hsm' }));
        expect(json.version).toBe(1);
        expect(json.machines[0].file).toBe('choice.hsm');
        expect(json.machines[0].totals.states).toEqual({ covered: 3, total: 4, percent: 75 });
        expect(json.totals).toEqual(report.totals);
    });

    test('LCOV', async () => {
        const { report } = await sampleReport();
        const lcov = toLcov(report, { fileName: () => 'choice.hsm' });
        const lines = lcov.trim().split('\n');
        expect(lines[0]).toBe('TN:');
        expect(lines[1]).toBe('SF:choice.hsm');
        expect(lines[lines.length - 1]).toBe('end_of_record');
        for (const line of lines) {
            expect(line).toMatch(/^(TN:.*|SF:.+|FN:\d+,\S+|FNDA:\d+,\S+|FNF:\d+|FNH:\d+|BRDA:\d+,\d+,[01],(\d+|-)|BRF:\d+|BRH:\d+|DA:\d+,\d+|LF:\d+|LH:\d+|end_of_record)$/);
        }
        const da = lines.filter(l => l.startsWith('DA:'));
        expect(lines).toContain(`LF:${da.length}`);
        expect(lines).toContain(`LH:${da.filter(l => !l.endsWith(',0')).length}`);
        expect(lines).toContain('DA:15,0');   // state Unused
        expect(lines).toContain('DA:10,2');   // entry reaction of A
        expect(lines).toContain('FN:15,Choice.Unused');
        expect(lines).toContain('FNDA:0,Choice.Unused');
        expect(lines).toContain('FNF:4');
        expect(lines).toContain('FNH:3');
        expect(lines.filter(l => l.startsWith('BRDA:'))).toEqual(['BRDA:11,0,0,0', 'BRDA:11,0,1,1', 'BRDA:18,1,0,1', 'BRDA:18,1,1,1', 'BRDA:20,2,0,-', 'BRDA:20,2,1,-']);
        expect(lines).toContain('BRF:6');
        expect(lines).toContain('BRH:3');
    });

    test('Cobertura', async () => {
        const { report } = await sampleReport();
        const xml = toCobertura(report, { fileName: () => 'models/choice.hsm', sourceRoot: '/work', timestamp: 1 });
        expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
        expectWellFormed(xml);
        expect(xml).toContain('<source>/work</source>');
        expect(xml).toContain('<class name="Choice" filename="models/choice.hsm"');
        expect(xml).toContain('<line number="15" hits="0" branch="false"/>');
        expect(xml).toContain('<line number="18" hits="1" branch="true" condition-coverage="100% (2/2)"/>');
        expect(xml).toContain('<line number="20" hits="0" branch="true" condition-coverage="0% (0/2)"/>');
        expect(xml).toMatch(/<coverage line-rate="[\d.]+" branch-rate="0\.5000" lines-covered="\d+" lines-valid="\d+" branches-covered="3" branches-valid="6"/);
    });

    test('HTML with and without diagram', async () => {
        const { report, collector } = await sampleReport();
        const plain = await toCoverageHtml(report, { fileName: () => 'choice.hsm' });
        expect(plain.map(f => f.path)).toEqual(['index.html', 'Choice.html']);
        expect(plain[0].content).toContain('<a href="Choice.html">Choice</a>');
        expect(plain[1].content).toContain('<tr class="uncovered" id="Unused">');
        expect(plain[1].content).not.toContain('class="diagram"');

        const renderDiagram = vi.fn((machine: ast.StateMachine, highlight: { classes: Record<string, string> }) =>
            `<svg data-machine="${machine.name}" data-unused="${highlight.classes['Unused']}"></svg>`);
        const withDiagram = await toCoverageHtml(report, { renderDiagram, diagramSource: m => collector.diagramSource(m) });
        expect(renderDiagram).toHaveBeenCalledTimes(1);
        expect(withDiagram[1].content).toContain('<svg data-machine="Choice" data-unused="hsm-uncovered"></svg>');
    });

    test('thresholds', async () => {
        const { report } = await sampleReport();
        expect(parseCoverageThresholds('states=100, transitions=90')).toEqual({ states: 100, transitions: 90 });
        expect(parseCoverageThresholds('80')).toEqual({ states: 80, transitions: 80, reactions: 80, guards: 80 });
        expect(parseCoverageThresholds('decisions=50%')).toEqual({ guards: 50 });
        expect(() => parseCoverageThresholds('lines=3')).toThrow(/Unknown coverage metric/);
        expect(() => parseCoverageThresholds('states=abc')).toThrow(/Invalid coverage threshold/);
        expect(checkCoverageThresholds(report, { states: 75, guards: 50 })).toEqual([]);
        expect(checkCoverageThresholds(report, { states: 100, transitions: 90 })).toEqual([
            'states coverage 75% (3/4) is below the threshold of 100%',
            'transitions coverage 83.33% (5/6) is below the threshold of 90%'
        ]);
    });
});

describe('hsm test --coverage', () => {
    const examples = path.resolve(__dirname, '../../../examples');

    async function run(args: Parameters<typeof runTestCommand>[1], testFiles?: string[]): Promise<{ code: number, output: string, dir: string }> {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-coverage-'));
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { output.push(parts.join(' ')); });
        const error = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { output.push(parts.join(' ')); });
        try {
            const files = testFiles ?? fs.readdirSync(path.join(examples, 'tests')).filter(f => f.endsWith('.hsmtest'))
                .map(f => path.join(examples, 'tests', f));
            const code = await runTestCommand(files, { coverageDir: dir, ...args });
            return { code, output: output.join('\n'), dir };
        } finally {
            log.mockRestore();
            error.mockRestore();
        }
    }

    test('writes all formats and reports the coverage of the examples', async () => {
        const { code, output, dir } = await run({ coverageFormat: 'text,json,lcov,cobertura,html' });
        expect(code).toBe(0);
        expect(output).toContain('Model coverage');
        for (const file of ['coverage.json', 'lcov.info', 'cobertura-coverage.xml', 'html/index.html', 'html/Door.html']) {
            expect(fs.existsSync(path.join(dir, file))).toBe(true);
        }
        const report = JSON.parse(fs.readFileSync(path.join(dir, 'coverage.json'), 'utf-8')) as CoverageReport;
        const summary = Object.fromEntries(report.machines.map(m => [m.machine,
            [m.totals.states, m.totals.transitions, m.totals.reactions, m.totals.guards].map(c => `${c.covered}/${c.total}`).join(' ')]));
        // states, transitions, reactions, guard decisions
        expect(summary).toEqual({
            CdPlayer: '7/7 13/13 4/4 4/4',
            Door: '9/9 20/20 1/1 0/0',
            Keyboard: '7/7 10/10 4/4 0/0',
            TrafficLight: '7/7 11/11 7/7 2/2'
        });
        expectWellFormed(fs.readFileSync(path.join(dir, 'cobertura-coverage.xml'), 'utf-8'));
        // the HTML pages contain the diagram with highlighted elements
        const page = fs.readFileSync(path.join(dir, 'html/Door.html'), 'utf-8');
        expect(page).toContain('<svg');
        expect(page).toContain('hsm-covered');
    });

    test('thresholds which are not met fail the run', async () => {
        // a test which only enters the door covers 1 of its 9 states
        const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-partial-'));
        fs.copyFileSync(path.join(examples, 'door.hsm'), path.join(partial, 'door.hsm'));
        fs.writeFileSync(path.join(partial, 'enter.hsmtest'), 'testclass EnterOnly for statemachine Door {\n    @Test\n    operation enters() {\n        enter\n        assert active(Closed)\n    }\n}\n');
        const failing = await run({ coverageFormat: 'text', coverageThreshold: 'states=100' }, [path.join(partial, 'enter.hsmtest')]);
        expect(failing.code).toBe(1);
        expect(failing.output).toContain('Coverage threshold not met: states coverage 11.11% (1/9) is below the threshold of 100%');
        const passing = await run({ coverageFormat: 'json', coverageThreshold: 'reactions=100,guards=100' });
        expect(passing.code).toBe(0);
        const invalid = await run({ coverageFormat: 'pdf' });
        expect(invalid.code).toBe(1);
        expect(invalid.output).toContain("Unknown coverage format 'pdf'");
    });
});

/** Minimal XML well-formedness check: balanced tags. */
function expectWellFormed(xml: string): void {
    const stack: string[] = [];
    const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '');
    for (const match of body.matchAll(/<(\/?)([\w:-]+)[^>]*?(\/?)>/g)) {
        const [, closing, name, selfClosing] = match;
        if (selfClosing) {
            continue;
        }
        if (closing) {
            expect(stack.pop()).toBe(name);
        } else {
            stack.push(name);
        }
    }
    expect(stack).toEqual([]);
}
