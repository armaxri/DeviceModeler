import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateCpp, generateCppScenarioHarness, type CppGeneratorResult } from '../src/generator/cpp/index.js';
import { scenarioFiles as filesOfScenario, scenarioText, validateScenario } from '../src/simulation/index.js';
import { CPP_TYPE_SCENARIOS, errors, parse, SUBMACHINE_SCENARIOS } from './helpers.js';
import { SUBMACHINES_NOT_SUPPORTED } from '../src/generator/common/statechart-generator.js';

/**
 * Conformance of the C++ code generator: every scenario of `test/scenarios` is compiled into a C++
 * test harness together with the generated class (g++, -std=c++17 -Wall -Wextra -Wpedantic -Werror
 * -Wshadow -Wconversion) and run; clang++ checks the same code. To keep the run time acceptable,
 * several scenarios are compiled into one program (each machine and harness in its own namespace);
 * if such a batch fails, its scenarios are compiled and run one by one to report the failures.
 * The examples are compiled with g++ and clang++ (C++17, C++11, without exceptions).
 * Skipped if no C++ compiler is available.
 */

const run = promisify(execFile);

function hasCompiler(command: string): boolean {
    try {
        return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
    } catch {
        return false;
    }
}

const GXX = hasCompiler('g++');
const CLANGXX = hasCompiler('clang++');
const FLAGS = ['-std=c++17', '-Wall', '-Wextra', '-Wpedantic', '-Werror', '-Wshadow', '-Wconversion'];
/** Additional flags for the scenario programs, e.g. `HSM_CXXFLAGS='-O2 -fsanitize=address,undefined'`. */
const EXTRA_FLAGS = (process.env.HSM_CXXFLAGS ?? '').split(/\s+/).filter(flag => flag);
/** Number of scenarios compiled into one program. */
const BATCH_SIZE = 12;

/**
 * Scenarios that cannot run against the generated C++ code, with the reason. Keep this list minimal.
 * (`s2-unknown-event` runs: raising an unknown event is rejected when the harness is generated,
 * in C++ it would be a compile time error.)
 */
const SKIP: Record<string, string> = Object.fromEntries(SUBMACHINE_SCENARIOS.map(file =>
    [file, 'submachine instances are not supported by the C++ generator yet (docs/semantics.md §9)']));

const scenarioDirectory = path.resolve(__dirname, 'scenarios');
const scenarioFiles = fs.readdirSync(scenarioDirectory).filter(f => f.endsWith('.json')).sort();
const exampleDirectory = path.resolve(__dirname, '../../../examples');
const exampleFiles = fs.readdirSync(exampleDirectory).filter(f => f.endsWith('.devm')).sort();

interface Outcome {
    passed: boolean;
    output: string;
}

/** A scenario translated to C++: a directory with the generated class and `harness.cpp`. */
interface Prepared {
    file: string;
    /** Directory name, relative to the work directory. */
    directory: string;
    source: string;
    namespace: string;
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

function writeFiles(directory: string, result: CppGeneratorResult): void {
    for (const file of result.files) {
        fs.writeFileSync(path.join(directory, file.path), file.content);
    }
}

function processOutput(error: unknown): string {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}` || (e.message ?? String(error));
}

/** A program running the given scenarios (unity build: the generated sources and harnesses are included). */
function unitySource(items: Prepared[]): string {
    const lines = items.flatMap(item => [`#include "${item.directory}/${item.source}"`, `#include "${item.directory}/harness.cpp"`]);
    lines.push('', '#include <cstdio>', '#include <exception>', '', 'int main() {', '    int failures = 0;');
    for (const item of items) {
        lines.push(
            `    std::printf("=== %s\\n", "${item.file}");`,
            '    std::fflush(stdout);',
            '    try {',
            `        failures += ${item.namespace}::run();`,
            '    } catch (const std::exception& e) {',
            '        std::printf("FAIL exception: %s\\n", e.what());',
            '        failures++;',
            '    }',
            '    std::fflush(stdout);'
        );
    }
    lines.push('    return failures > 0 ? 1 : 0;', '}', '');
    return lines.join('\n');
}

/** Output of a program per scenario (`=== file` markers). */
function splitOutput(stdout: string): Map<string, string> {
    const result = new Map<string, string>();
    let current: string | undefined;
    for (const line of stdout.split('\n')) {
        const marker = /^=== (.*)$/.exec(line);
        if (marker) {
            current = marker[1];
            result.set(current, '');
        } else if (current !== undefined && line) {
            result.set(current, `${result.get(current)}${line}\n`);
        }
    }
    return result;
}

/** Compiles and runs a program for the scenarios; returns an outcome for every scenario (or throws if the program fails as a whole). */
async function runProgram(workDirectory: string, name: string, items: Prepared[]): Promise<Map<string, Outcome>> {
    const source = `${name}.cpp`;
    fs.writeFileSync(path.join(workDirectory, source), unitySource(items));
    const binary = path.join(workDirectory, name);
    try {
        await Promise.all([
            run('g++', [...FLAGS, ...EXTRA_FLAGS, '-o', binary, source], { cwd: workDirectory }),
            CLANGXX ? run('clang++', [...FLAGS, '-fsyntax-only', source], { cwd: workDirectory }) : Promise.resolve()
        ]);
    } catch (error) {
        throw new Error(`compile failed (${workDirectory}/${source}):\n${processOutput(error)}`);
    }
    let stdout: string;
    try {
        stdout = (await run(binary, [], { cwd: workDirectory, timeout: 30000 })).stdout;
    } catch (error) {
        const e = error as { stdout?: string; code?: number; signal?: string };
        if (e.code !== 1 || e.signal) {
            throw new Error(`run failed (${binary}): ${processOutput(error)}`);
        }
        stdout = e.stdout ?? '';
    }
    const outputs = splitOutput(stdout);
    const result = new Map<string, Outcome>();
    for (const item of items) {
        const output = outputs.get(item.file);
        if (output === undefined) {
            throw new Error(`no output for ${item.file} (${binary})`);
        }
        result.set(item.file, { passed: output.trim() === 'PASS', output });
    }
    return result;
}

describe.skipIf(!GXX)('C++ code generator: conformance suite', () => {
    const outcomes = new Map<string, Outcome>();
    let workDirectory = '';

    beforeAll(async () => {
        workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-cpp-'));
        const prepared: Prepared[] = [];
        for (const [i, file] of scenarioFiles.entries()) {
            if (SKIP[file]) {
                continue;
            }
            const directory = file.replace(/\.json$/, '');
            try {
                const scenario = validateScenario(JSON.parse(fs.readFileSync(path.join(scenarioDirectory, file), 'utf-8')), file);
                const text = scenarioText(scenario) ?? fs.readFileSync(path.resolve(scenarioDirectory, scenario.model!), 'utf-8');
                const files = filesOfScenario(scenario);
                const parsed = await parse(text, files);
                if (parsed.hasSyntaxErrors || errors(parsed).length > 0) {
                    throw new Error(`invalid model: ${errors(parsed).join('; ')}`);
                }
                const result = generateCpp(parsed.model, { namespace: `scenario${i}` });
                if (!result.api) {
                    throw new Error(result.diagnostics.map(d => d.message).join('\n'));
                }
                fs.mkdirSync(path.join(workDirectory, directory));
                writeFiles(path.join(workDirectory, directory), result);
                // imported headers next to the model (the generated code includes them by their import paths)
                for (const [name, content] of Object.entries(files)) {
                    fs.mkdirSync(path.dirname(path.join(workDirectory, directory, name)), { recursive: true });
                    fs.writeFileSync(path.join(workDirectory, directory, name), content);
                }
                const namespace = `harness${i}`;
                fs.writeFileSync(path.join(workDirectory, directory, 'harness.cpp'), generateCppScenarioHarness(result.api, scenario, { namespace, main: false }));
                prepared.push({ file, directory, source: result.api.source, namespace });
            } catch (error) {
                outcomes.set(file, { passed: false, output: `generate failed: ${error instanceof Error ? error.stack : String(error)}` });
            }
        }
        // scenarios with C++ headers are compiled one by one (their headers may declare the same names)
        const batches: Prepared[][] = prepared.filter(p => CPP_TYPE_SCENARIOS.includes(p.file)).map(p => [p]);
        const others = prepared.filter(p => !CPP_TYPE_SCENARIOS.includes(p.file));
        for (let i = 0; i < others.length; i += BATCH_SIZE) {
            batches.push(others.slice(i, i + BATCH_SIZE));
        }
        await inParallel(batches, Math.max(2, os.cpus().length), async batch => {
            try {
                for (const [file, outcome] of await runProgram(workDirectory, `batch_${batch[0].directory}`, batch)) {
                    outcomes.set(file, outcome);
                }
            } catch {
                // find the failing scenarios
                for (const item of batch) {
                    try {
                        for (const [file, outcome] of await runProgram(workDirectory, `single_${item.directory}`, [item])) {
                            outcomes.set(file, outcome);
                        }
                    } catch (error) {
                        outcomes.set(item.file, { passed: false, output: error instanceof Error ? error.message : String(error) });
                    }
                }
            }
        });
    }, 600000);

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

describe.skipIf(!GXX && !CLANGXX)('C++ code generator: examples', () => {
    const compilers = [GXX ? 'g++' : undefined, CLANGXX ? 'clang++' : undefined].filter((c): c is string => c !== undefined);
    const variants: Array<{ name: string; standard: 11 | 17; flags: string[] }> = [
        { name: 'C++17', standard: 17, flags: FLAGS },
        { name: 'C++11', standard: 11, flags: [...FLAGS.filter(f => !f.startsWith('-std=')), '-std=c++11'] },
        { name: 'C++17 without exceptions', standard: 17, flags: [...FLAGS, '-fno-exceptions'] }
    ];

    for (const file of exampleFiles) {
        test(file, async () => {
            const parsed = await parse(fs.readFileSync(path.join(exampleDirectory, file), 'utf-8'));
            expect(errors(parsed)).toEqual([]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-cpp-example-'));
            try {
                const tasks: Array<Promise<void>> = [];
                for (const variant of variants) {
                    const result = generateCpp(parsed.model, { standard: variant.standard, namespace: 'examples::generated', outDir: variant.name.replace(/\W+/g, '_') });
                    expect(result.diagnostics).toEqual([]);
                    fs.mkdirSync(path.join(directory, variant.name.replace(/\W+/g, '_')));
                    for (const generated of result.files) {
                        fs.writeFileSync(path.join(directory, generated.path), generated.content);
                    }
                    const source = result.files.find(f => f.path.endsWith('.cpp'))!.path;
                    for (const compiler of compilers) {
                        tasks.push(run(compiler, [...variant.flags, '-c', source, '-o', `${source}.${compiler}.o`], { cwd: directory })
                            .then(() => undefined, error => expect.fail(`${compiler} (${variant.name}): ${processOutput(error)}`)));
                    }
                }
                await Promise.all(tasks);
            } finally {
                fs.rmSync(directory, { recursive: true, force: true });
            }
        }, 60000);
    }

    test('the usage example of docs/cpp-generator.md compiles and runs', async () => {
        const doc = fs.readFileSync(path.resolve(__dirname, '../../../docs/cpp-generator.md'), 'utf-8');
        const example = /```cpp\n([\s\S]*?)```/.exec(doc)?.[1];
        expect(example, 'C++ example in docs/cpp-generator.md').toBeDefined();
        const parsed = await parse(fs.readFileSync(path.join(exampleDirectory, 'traffic-light.devm'), 'utf-8'));
        const result = generateCpp(parsed.model);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-cpp-doc-'));
        try {
            writeFiles(directory, result);
            // a few cycles instead of a minute
            expect(example).toContain('cycle < 600;');
            fs.writeFileSync(path.join(directory, 'main.cpp'), example!.replace('cycle < 600;', 'cycle < 3;'));
            for (const compiler of compilers.slice(1)) {
                await run(compiler, [...FLAGS, '-fsyntax-only', 'main.cpp'], { cwd: directory });
            }
            await run(compilers[0], [...FLAGS, '-o', 'example', 'main.cpp', 'TrafficLight.cpp'], { cwd: directory });
            const { stdout } = await run(path.join(directory, 'example'), [], { cwd: directory, timeout: 20000 });
            expect(stdout).toContain('lights changed: 1');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }, 60000);

    test('names that clash with the generated code are renamed', async () => {
        const parsed = await parse([
            'statemachine M {',
            '    interface Values:',
            '        in event owner : string',
            '        out event callback : real',
            '        var value : integer = 1',
            '        var machine : string = "m"',
            '        operation operationCallback(value : integer, owner... : real) : string',
            '    [*] -> slot',
            '    state slot {',
            '        entry / Values.value = Values.value + 1; raise Values.callback : 1.5',
            '    }',
            '    state value',
            '    slot -> value : Values.owner [valueof(Values.owner) == "x"] / Values.machine = Values.operationCallback(1, 2, 3.5)',
            '}'
        ].join('\n'));
        expect(errors(parsed)).toEqual([]);
        const result = generateCpp(parsed.model);
        expect(result.diagnostics).toEqual([]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-cpp-names-'));
        try {
            writeFiles(directory, result);
            for (const compiler of compilers) {
                await run(compiler, [...FLAGS, '-c', 'M.cpp', '-o', `${compiler}.o`], { cwd: directory });
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }, 60000);

    test('runtime errors are reported to the error handler instead of exceptions', async () => {
        const parsed = await parse([
            'statemachine M {',
            '    interface:',
            '        in event go',
            '        var x : integer = 0',
            '        var y : integer = 0',
            '    [*] -> A',
            '    state A',
            '    state B',
            '    A -> B : go / x = 10 / y; x += 1',
            '}'
        ].join('\n'));
        const result = generateCpp(parsed.model);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-cpp-errors-'));
        try {
            writeFiles(directory, result);
            fs.writeFileSync(path.join(directory, 'main.cpp'), [
                '#include <cstdio>',
                '#include "M.h"',
                '',
                'class Handler : public sc::ErrorHandler {',
                'public:',
                '    void onError(sc::ErrorKind kind, const std::string& message) override {',
                '        std::printf("error %d: %s\\n", static_cast<int>(kind), message.c_str());',
                '    }',
                '};',
                '',
                'int main() {',
                '    M machine;',
                '    Handler handler;',
                '    machine.setErrorHandler(&handler);',
                '    machine.enter();',
                '    machine.raise_go();',
                '    machine.runCycle();',
                '    std::printf("x = %d, B = %d\\n", static_cast<int>(machine.get_x()), machine.isStateActive(M::State::B) ? 1 : 0);',
                '    return 0;',
                '}',
                ''
            ].join('\n'));
            const compiler = compilers[0];
            await run(compiler, [...FLAGS, '-fno-exceptions', '-o', 'main', 'main.cpp', 'M.cpp'], { cwd: directory });
            const { stdout } = await run(path.join(directory, 'main'), [], { cwd: directory });
            expect(stdout).toBe('error 0: Division by zero\nx = 1, B = 1\n');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }, 60000);
});

describe('C++ code generator', () => {
    test('generates the runtime header, a header and a source file named after the state machine', async () => {
        const parsed = await parse('statemachine TrafficLight {\n namespace traffic.control\n interface:\n in event go\n [*] -> A\n state A\n state B\n A -> B : go\n}');
        const result = generateCpp(parsed.model, { outDir: 'gen' });
        expect(result.diagnostics).toEqual([]);
        expect(result.files.map(f => f.path)).toEqual(['gen/sc_statemachine.h', 'gen/TrafficLight.h', 'gen/TrafficLight.cpp']);
        const header = result.files[1].content;
        expect(header).toContain('#ifndef TRAFFIC_CONTROL_TRAFFICLIGHT_H_');
        expect(header).toContain('namespace traffic::control {');
        expect(header).toContain('class TrafficLight : public sc::StatemachineInterface {');
        expect(header).toContain('void raise_go();');
        expect(header).toContain('enum class State {');
        expect(result.api?.qualifiedClassName).toBe('traffic::control::TrafficLight');
    });

    test('uses the given namespace, class name and C++ standard', async () => {
        const parsed = await parse([
            'statemachine M {',
            ' interface Panel:',
            '  var x : integer',
            '  out event shown : integer',
            '  operation f(a : real, rest... : string) : boolean',
            ' internal:',
            '  operation g() : void',
            ' [*] -> A',
            ' state A',
            '}'
        ].join('\n'));
        const result = generateCpp(parsed.model, { namespace: 'a::b', className: 'Controller', standard: 11 });
        expect(result.diagnostics).toEqual([]);
        const header = result.files.find(f => f.path === 'Controller.h')!.content;
        expect(header).toContain('namespace a { namespace b {');
        expect(header).toContain('class Panel {');
        expect(header).toContain('sc::integer get_x() const;');
        expect(header).toContain('sc::rx::Observable<sc::integer>& getShown();');
        expect(header).toContain('virtual sc::boolean f(sc::real a, std::initializer_list<sc::string> rest) = 0;');
        expect(header).toContain('class InternalOperationCallback {');
        expect(header).toContain('void setInternalOperationCallback(InternalOperationCallback* callback);');
        expect(header).toContain('Panel& getPanel();');
    });

    test('reports names that cannot be used in C++', async () => {
        const keyword = await parse('statemachine M {\n interface:\n operation delete() : void\n [*] -> A\n state A\n}');
        expect(generateCpp(keyword.model).diagnostics.map(d => d.message)).toEqual([expect.stringContaining("'delete' is a C++ keyword")]);
        const clash = await parse('statemachine M {\n interface State:\n in event x\n [*] -> A\n state A\n}');
        const result = generateCpp(clash.model);
        expect(result.files).toEqual([]);
        expect(result.diagnostics.map(d => d.message)).toEqual([expect.stringContaining("'State' is not unique")]);
    });
});

describe('C++ code generator: submachine instances', () => {
    test('the skipped scenarios are exactly the scenarios with submachine instances', () => {
        const withInstances = scenarioFiles.filter(file => {
            const scenario = validateScenario(JSON.parse(fs.readFileSync(path.join(scenarioDirectory, file), 'utf-8')), file);
            return scenario.files !== undefined && !CPP_TYPE_SCENARIOS.includes(file);
        });
        expect(Object.keys(SKIP).sort()).toEqual(withInstances.sort());
    });

    for (const file of Object.keys(SKIP)) {
        test(`${file}: diagnostic instead of code`, async () => {
            const scenario = validateScenario(JSON.parse(fs.readFileSync(path.join(scenarioDirectory, file), 'utf-8')), file);
            const parsed = await parse(scenarioText(scenario)!, filesOfScenario(scenario));
            expect(errors(parsed)).toEqual([]);
            const result = generateCpp(parsed.model);
            expect(result.files).toEqual([]);
            expect(result.diagnostics.map(d => d.message).join()).toContain(SUBMACHINES_NOT_SUPPORTED);
        });
    }
});
