import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CoverageCollector } from 'hsm-language';
import { discoverTests, failureMessage, lineCoverage, runHsmTests } from '../../src/extension/logic/tests.js';

const examples = path.resolve(__dirname, '../../../../examples');
const file = async (relative: string) => ({ uri: pathToFileURL(path.join(examples, relative)).toString(), text: await fs.readFile(path.join(examples, relative), 'utf-8') });

describe('test discovery', () => {
    it('finds test classes and @Test operations with their ranges', () => {
        const classes = discoverTests([
            'testclass LampTest for statemachine Lamp {',
            '    @SetUp',
            '    operation init() { enter }',
            '    @Test',
            '    operation startsOff() {',
            '        assert active(Off)',
            '    }',
            '    operation helper() { }',
            '    @Test operation toggles() { raise toggle }',
            '}'
        ].join('\n'));
        expect(classes).toHaveLength(1);
        expect(classes[0].name).toBe('LampTest');
        expect(classes[0].machine).toBe('Lamp');
        expect(classes[0].tests.map(t => t.name)).toEqual(['startsOff', 'toggles']);
        expect(classes[0].tests[0].range.start).toEqual({ line: 4, character: 14 });
        expect(classes[0].range.start.line).toBe(0);
    });

    it('works on incomplete texts', () => {
        const classes = discoverTests('testclass T for statemachine Lamp {\n    @Test\n    operation a() {\n        assert\n');
        expect(classes[0]?.name).toBe('T');
    });
});

describe('running tests', () => {
    it('runs the tests of a file against the models of the workspace, with coverage', async () => {
        const models = await Promise.all(['door.hsm', 'traffic-light.hsm', 'keyboard.hsm', 'cd-player.hsm'].map(file));
        const test = await file('tests/door.hsmtest');
        const coverage = new CoverageCollector();
        const seen: string[] = [];
        const { results, problems } = await runHsmTests(models, [test], { coverage, onResult: result => seen.push(result.name) });
        expect(problems).toEqual([]);
        expect(results.length).toBeGreaterThan(2);
        expect(results.every(r => r.status === 'passed')).toBe(true);
        expect(seen).toEqual(results.map(r => r.name));
        const door = coverage.report().machines.find(m => m.machine === 'Door')!;
        expect(door.uri).toBe(models[0].uri);
        const lines = lineCoverage(door);
        expect(lines.length).toBeGreaterThan(5);
        expect(lines.some(l => l.hits > 0)).toBe(true);
        // lines are 0-based and sorted
        const text = models[0].text.split('\n');
        const closed = lines.find(l => l.names.includes('Closed'))!;
        expect(text[closed.line]).toContain('state Closed');
        expect(lines.map(l => l.line)).toEqual([...lines.map(l => l.line)].sort((a, b) => a - b));
    });

    it('filters tests and reports failures with location and trace', async () => {
        const models = [await file('door.hsm')];
        const test = {
            uri: 'file:///virtual/fail.hsmtest',
            text: 'testclass F for statemachine Door {\n    @Test\n    operation fails() {\n        enter\n        assert active(Moving)\n    }\n    @Test\n    operation skipped() { enter }\n}\n'
        };
        const { results } = await runHsmTests(models, [test], { filter: (_uri, _c, name) => name === 'fails' });
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe('failed');
        expect(results[0].line).toBe(5);
        expect(failureMessage(results[0])).toMatch(/Trace:/);
    });

    it('reports test files with errors as problems', async () => {
        const { results, problems } = await runHsmTests([], [{ uri: 'file:///virtual/bad.hsmtest', text: 'testclass B for statemachine Missing {\n}\n' }]);
        expect(results).toEqual([]);
        expect(problems[0].diagnostics.length).toBeGreaterThan(0);
    });
});

describe('lineCoverage', () => {
    it('merges elements of a line (minimum hits) and adds guard branches', () => {
        const lines = lineCoverage({
            machine: 'M', totals: {} as never,
            elements: [
                { id: 'A', kind: 'state', name: 'A', line: 3, hits: 2, tests: [] },
                { id: 'A->B', kind: 'transition', name: 'A -> B', line: 5, hits: 1, tests: [] },
                { id: 'A->B~1', kind: 'transition', name: 'A -> B', line: 5, hits: 0, tests: [] },
                { id: 'X', kind: 'state', name: 'X', hits: 0, tests: [] }
            ],
            guards: [{ id: 'A->B', kind: 'transition', name: 'A -> B', expression: 'x > 1', line: 5, trueHits: 1, falseHits: 0, trueTests: [], falseTests: [] }]
        });
        expect(lines).toEqual([
            { line: 2, hits: 2, names: ['A'], branches: [] },
            { line: 4, hits: 0, names: ['A -> B', 'A -> B'], branches: [{ label: '[x > 1] true', hits: 1 }, { label: '[x > 1] false', hits: 0 }] }
        ]);
    });
});

describe('selectTests (attribute `test` of a launch configuration)', () => {
    const text = 'testclass A for statemachine M {\n@Test operation one() { }\n@Test operation two() { }\n}\n'
        + 'testclass B for statemachine M {\n@Test operation one() { }\n}\n';
    it('selects a test class, a test of a class or a test by name', async () => {
        const { selectTests } = await import('../../src/extension/debug.js');
        expect(selectTests('file:///t.hsmtest', text, 'A')).toEqual([{ uri: 'file:///t.hsmtest', testClass: 'A' }]);
        expect(selectTests('file:///t.hsmtest', text, 'A.two')).toEqual([{ uri: 'file:///t.hsmtest', testClass: 'A', test: 'two' }]);
        expect(selectTests('file:///t.hsmtest', text, 'one').map(s => `${s.testClass}.${s.test}`)).toEqual(['A.one', 'B.one']);
        expect(() => selectTests('file:///t.hsmtest', text, 'A.three')).toThrow(/No test class or test 'A.three'/);
    });
});
