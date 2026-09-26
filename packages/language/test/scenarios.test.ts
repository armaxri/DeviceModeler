import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { formatTraceEntry, runScenario, scenarioText, validateScenario, type TraceEntry } from '../src/simulation/index.js';
import { errors, parse } from './helpers.js';

/** Runs every scenario of `test/scenarios` (the shared conformance suite) against the interpreter. */
const directory = path.resolve(__dirname, 'scenarios');
const files = fs.readdirSync(directory).filter(f => f.endsWith('.json')).sort();

describe('scenarios', () => {
    test('the conformance suite is complete', () => {
        expect(files.length).toBeGreaterThanOrEqual(40);
    });

    for (const file of files) {
        test(file, async () => {
            const scenario = validateScenario(JSON.parse(fs.readFileSync(path.join(directory, file), 'utf-8')), file);
            const text = scenarioText(scenario) ?? fs.readFileSync(path.resolve(directory, scenario.model!), 'utf-8');
            const parsed = await parse(text);
            expect(parsed.hasSyntaxErrors, 'syntax errors').toBe(false);
            expect(errors(parsed), 'validation errors').toEqual([]);
            const trace: TraceEntry[] = [];
            const result = runScenario(parsed.model, scenario, { onTrace: entry => trace.push(entry) });
            const report = result.failures.map(f => `step ${f.step}: ${f.message}`).join('\n');
            expect(report, `trace:\n${trace.map(formatTraceEntry).join('\n')}\n`).toBe('');
        });
    }
});
