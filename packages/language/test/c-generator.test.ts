import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateC, generateScenarioHarness, type CGeneratorResult } from '../src/generator/c/index.js';
import { scenarioFiles as filesOfScenario, scenarioText, validateScenario } from '../src/simulation/index.js';
import { CPP_TYPE_SCENARIOS, errors, parse, SUBMACHINE_SCENARIOS } from './helpers.js';
import { CPP_TYPES_NOT_SUPPORTED, SUBMACHINES_NOT_SUPPORTED } from '../src/generator/common/statechart-generator.js';

/**
 * Conformance of the C code generator: every scenario of `test/scenarios` is compiled into a C test
 * harness together with the generated code (gcc, -std=c99 -Wall -Wextra -Wpedantic -Werror) and run.
 * The examples are compiled with gcc and clang. Skipped if no C compiler is available.
 */

const run = promisify(execFile);

function hasCompiler(command: string): boolean {
    try {
        return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
    } catch {
        return false;
    }
}

const GCC = hasCompiler('gcc');
const CLANG = hasCompiler('clang');
const FLAGS = ['-std=c99', '-Wall', '-Wextra', '-Wpedantic', '-Werror'];
/** Additional flags for the scenario harnesses, e.g. `DEVM_CFLAGS='-O2 -fsanitize=address,undefined'`. */
const EXTRA_FLAGS = (process.env.DEVM_CFLAGS ?? '').split(/\s+/).filter(flag => flag);

/**
 * Scenarios that cannot run against the generated C code, with the reason. Keep this list minimal.
 * (`s2-unknown-event` runs: raising an unknown event is rejected when the harness is generated,
 * in C it would be a compile time error.)
 */
const SKIP: Record<string, string> = Object.fromEntries([
    ...SUBMACHINE_SCENARIOS.map(file => [file, 'submachine instances are not supported by the C generator yet (docs/semantics.md §9)']),
    ...CPP_TYPE_SCENARIOS.map(file => [file, 'C++ header types are not supported by the C generator (docs/cpp-integration.md)'])
]);

const scenarioDirectory = path.resolve(__dirname, 'scenarios');
const scenarioFiles = fs.readdirSync(scenarioDirectory).filter(f => f.endsWith('.json')).sort();
const exampleDirectory = path.resolve(__dirname, '../../../examples');
const exampleFiles = fs.readdirSync(exampleDirectory).filter(f => f.endsWith('.devm')).sort();

interface Outcome {
    passed: boolean;
    output: string;
}

/** Runs `task` for all items with at most `limit` tasks at a time. */
async function inParallel<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            await task(items[next++]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function writeFiles(directory: string, result: CGeneratorResult): void {
    for (const file of result.files) {
        fs.writeFileSync(path.join(directory, file.path), file.content);
    }
}

function processOutput(error: unknown): string {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}` || (e.message ?? String(error));
}

describe.skipIf(!GCC)('C code generator: conformance suite', () => {
    const outcomes = new Map<string, Outcome>();
    let workDirectory = '';

    beforeAll(async () => {
        workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devm-c-'));
        await inParallel(scenarioFiles.filter(f => !SKIP[f]), Math.max(2, os.cpus().length), async file => {
            const directory = path.join(workDirectory, file.replace(/\.json$/, ''));
            fs.mkdirSync(directory);
            let stage = 'generate';
            try {
                const scenario = validateScenario(JSON.parse(fs.readFileSync(path.join(scenarioDirectory, file), 'utf-8')), file);
                const text = scenarioText(scenario) ?? fs.readFileSync(path.resolve(scenarioDirectory, scenario.model!), 'utf-8');
                const parsed = await parse(text);
                if (parsed.hasSyntaxErrors || errors(parsed).length > 0) {
                    throw new Error(`invalid model: ${errors(parsed).join('; ')}`);
                }
                const result = generateC(parsed.model);
                if (!result.api) {
                    throw new Error(result.diagnostics.map(d => d.message).join('\n'));
                }
                writeFiles(directory, result);
                fs.writeFileSync(path.join(directory, 'harness.c'), generateScenarioHarness(result.api, scenario));
                stage = 'compile';
                const binary = path.join(directory, 'harness');
                await run('gcc', [...FLAGS, ...EXTRA_FLAGS, '-o', binary, 'harness.c', result.api.source], { cwd: directory });
                if (CLANG) {
                    await run('clang', [...FLAGS, '-fsyntax-only', result.api.source], { cwd: directory });
                }
                stage = 'run';
                const { stdout } = await run(binary, [], { cwd: directory, timeout: 10000 });
                outcomes.set(file, { passed: stdout.trim() === 'PASS', output: stdout });
            } catch (error) {
                outcomes.set(file, { passed: false, output: `${stage} failed (${directory}):\n${processOutput(error)}` });
            }
        });
    }, 300000);

    afterAll(() => {
        if (workDirectory && [...outcomes.values()].every(o => o.passed)) {
            fs.rmSync(workDirectory, { recursive: true, force: true });
        }
    });

    for (const file of scenarioFiles) {
        test.skipIf(SKIP[file] !== undefined)(file, () => {
            const outcome = outcomes.get(file);
            expect(outcome, 'no result').toBeDefined();
            expect(outcome!.passed, outcome!.output).toBe(true);
        });
    }
});

describe.skipIf(!GCC && !CLANG)('C code generator: examples', () => {
    const compilers = [GCC ? 'gcc' : undefined, CLANG ? 'clang' : undefined].filter((c): c is string => c !== undefined);

    for (const file of exampleFiles) {
        test(file, async () => {
            const parsed = await parse(fs.readFileSync(path.join(exampleDirectory, file), 'utf-8'));
            expect(errors(parsed)).toEqual([]);
            const result = generateC(parsed.model);
            expect(result.diagnostics).toEqual([]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devm-c-example-'));
            try {
                writeFiles(directory, result);
                for (const compiler of compilers) {
                    try {
                        await run(compiler, [...FLAGS, '-c', result.api!.source, '-o', `${compiler}.o`], { cwd: directory });
                    } catch (error) {
                        expect.fail(`${compiler}: ${processOutput(error)}`);
                    }
                }
            } finally {
                fs.rmSync(directory, { recursive: true, force: true });
            }
        }, 30000);
    }
});

describe('C code generator', () => {
    test('generates sc_types.h, a header and a source file named after the state machine', async () => {
        const parsed = await parse('statemachine TrafficLight {\n interface:\n in event go\n [*] -> A\n state A\n state B\n A -> B : go\n}');
        const result = generateC(parsed.model, { outDir: 'gen' });
        expect(result.files.map(f => f.path)).toEqual(['gen/sc_types.h', 'gen/traffic_light.h', 'gen/traffic_light.c']);
        const header = result.files[1].content;
        expect(header).toContain('void traffic_light_raise_go(TrafficLight *handle);');
        expect(header).toContain('TrafficLight_A,');
        expect(header).toContain('extern void traffic_light_on_error(TrafficLight *handle, TrafficLightError error, const char *message);');
    });

    test('uses the given prefix and type name', async () => {
        const parsed = await parse('statemachine M {\n interface:\n var x : integer\n operation f(a : real) : boolean\n [*] -> A\n state A\n}');
        const result = generateC(parsed.model, { prefix: 'ctrl', typeName: 'Controller' });
        const header = result.files.find(f => f.path === 'ctrl.h')!.content;
        expect(header).toContain('sc_integer ctrl_get_x(const Controller *handle);');
        expect(header).toContain('extern sc_boolean ctrl_f(Controller *handle, sc_real a);');
    });

    test('reports identifiers that are not unique', async () => {
        const parsed = await parse('statemachine M {\n interface:\n in event x\n [*] -> event_x\n state event_x\n}');
        const result = generateC(parsed.model);
        expect(result.files).toEqual([]);
        expect(result.diagnostics.map(d => d.message)).toEqual([expect.stringContaining("'M_event_x' is not unique")]);
    });
});

describe('C code generator: submachine instances and C++ header types', () => {
    test('the skipped scenarios are exactly the scenarios with submachine instances or C/C++ header imports', () => {
        const withFiles = scenarioFiles.filter(file => {
            const scenario = validateScenario(JSON.parse(fs.readFileSync(path.join(scenarioDirectory, file), 'utf-8')), file);
            return scenario.files !== undefined;
        });
        expect(Object.keys(SKIP).sort()).toEqual(withFiles.sort());
        const withHeaders = withFiles.filter(file => {
            const scenario = validateScenario(JSON.parse(fs.readFileSync(path.join(scenarioDirectory, file), 'utf-8')), file);
            return Object.keys(scenario.files!).some(name => /\.(h|hpp)$/.test(name));
        });
        expect([...CPP_TYPE_SCENARIOS].sort()).toEqual(withHeaders.sort());
    });

    for (const file of Object.keys(SKIP)) {
        test(`${file}: diagnostic instead of code`, async () => {
            const scenario = validateScenario(JSON.parse(fs.readFileSync(path.join(scenarioDirectory, file), 'utf-8')), file);
            const parsed = await parse(scenarioText(scenario)!, filesOfScenario(scenario));
            expect(errors(parsed)).toEqual([]);
            const result = generateC(parsed.model);
            expect(result.files).toEqual([]);
            expect(result.diagnostics.map(d => d.message).join()).toContain(CPP_TYPE_SCENARIOS.includes(file) ? CPP_TYPES_NOT_SUPPORTED : SUBMACHINES_NOT_SUPPORTED);
        });
    }

    test('<cstdint> types need the C++ generator, too', async () => {
        const parsed = await parse('statemachine M {\n    interface:\n        var x : uint8_t\n    [*] -> A\n    state A\n}');
        expect(errors(parsed)).toEqual([]);
        expect(generateC(parsed.model).diagnostics.map(d => d.message).join()).toContain(CPP_TYPES_NOT_SUPPORTED);
    });
});
