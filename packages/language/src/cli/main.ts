import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createHsmServices } from '../hsm-module.js';
import { isDmfModel } from '../generated/ast.js';
import { HsmModelLoader } from '../hsm-document.js';
import { layoutFileName, layoutStateMachineWithLayout, parseManualLayout } from '../diagram/manual-layout.js';
import { layoutTextEdits } from '../diagram/layout-annotations.js';
import { applyEdits } from '../edit/model-edits.js';
import { GENERATOR_CONFIG_FILE } from '../generator/config.js';
import { runGenerateCommand, type GenerateCommandOptions } from '../generator/generate-command.js';
import { importSct, importSctFiles } from '../importer/sct-importer.js';
import { StatechartInterpreter } from '../simulation/interpreter.js';
import { formatTraceEntry, runScenario, validateScenario, type ScenarioStep } from '../simulation/scenario.js';
import { runTestCommand, type TestCommandOptions } from '../testing/test-command.js';
import { registerRenderCommands } from './render-commands.js';
import { CppTypeIndex, cppHeaderReport } from '../cpp-header/index.js';
import { cliHeaderSettings, dataModelNamed, installNodeHeaderSupport, parseDefines, type NodeHeaderOptions } from '../node/cpp-headers-node.js';

const severities = ['', 'error', 'warning', 'info', 'hint'];

/** Options of commands that load models: settings of imported C/C++ headers. */
export interface HeaderCommandOptions {
    include?: string[];
    define?: string[];
    dataModel?: string;
}

/** Adds `-I`, `-D` and `--data-model` (settings of imported C/C++ headers, see docs/cpp-integration.md). */
export function headerOptions(command: Command): Command {
    return command
        .option('-I, --include <dirs...>', 'include directories for imported C/C++ headers (after the headers block of hsm.gen.json)')
        .option('-D, --define <macros...>', 'predefined macros for imported C/C++ headers: NAME or NAME=VALUE')
        .option('--data-model <model>', 'data model of the target for C/C++ headers: lp64 (default), llp64 or ilp32 (32-bit long and pointers)');
}

/** The Node header support for the options of a command. */
export function nodeHeaderOptions(options: HeaderCommandOptions): NodeHeaderOptions {
    return { settings: cliHeaderSettings(options) };
}

async function load(file: string, options: HeaderCommandOptions = {}) {
    const services = createHsmServices(NodeFileSystem);
    installNodeHeaderSupport(services.shared, nodeHeaderOptions(options));
    const loader = new HsmModelLoader(services);
    const text = await fs.readFile(file, 'utf-8');
    const parsed = await loader.load(text, `file://${path.resolve(file)}`);
    let errors = 0;
    for (const d of parsed.diagnostics) {
        const severity = severities[d.severity ?? 1];
        if (d.severity === 1) {
            errors++;
        }
        console.error(`${file}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${severity}: ${d.message}`);
    }
    // errors of imported state machines (see imports.ts)
    for (const imported of parsed.imported) {
        const importedFile = path.relative(process.cwd(), URI.parse(imported.uri).fsPath);
        for (const d of imported.diagnostics.filter(d => d.severity === 1)) {
            errors++;
            console.error(`${importedFile}:${d.range.start.line + 1}:${d.range.start.character + 1}: error: ${d.message}`);
        }
    }
    return { parsed, errors };
}

/** Loads a state machine file (`undefined` and an error message for a structure file). */
async function loadMachine(file: string, options: HeaderCommandOptions = {}) {
    const result = await load(file, options);
    if (isDmfModel(result.parsed.model)) {
        console.error(`${file}: a structure file, not a state machine`);
        return undefined;
    }
    return result;
}

export function createProgram(): Command {
    const program = new Command('devm').description('Device Modeler: tools for state machines and structure models (.devm files)');

    headerOptions(program.command('validate'))
        .argument('<file>', '.devm file to validate (state machine or structure file)')
        .description('parses and validates a model')
        .action(async (file: string, options: HeaderCommandOptions) => {
            const { errors } = await load(file, options);
            if (errors > 0) {
                process.exitCode = 1;
            } else {
                console.log(`${file}: OK`);
            }
        });

    headerOptions(program.command('generate'))
        .argument('[target]', 'target language: cpp or c (default: all targets of the configuration)')
        .argument('[files...]', '.devm files of state machines (default: the models of the generator configuration)')
        .option('-c, --config <file>', `generator configuration (default: ${GENERATOR_CONFIG_FILE} in the current directory if no files are given)`)
        .option('-o, --out <dir>', 'output directory (default: outDir of the configuration, or the directory of the model)')
        .option('-n, --namespace <namespace>', 'cpp: namespace of the generated class, e.g. a::b (default: the namespace of the model, "" for none)')
        .option('--class-name <name>', 'cpp: name of the generated class and files (default: the state machine name)')
        .option('--std <standard>', 'cpp: C++ standard of the generated code, 17 or 11 (default: 17)')
        .option('-p, --prefix <prefix>', 'c: prefix of the generated functions and files (default: the state machine name in snake case)')
        .option('--check', 'writes nothing; exits with 1 if a generated file is missing or out of date (for CI)')
        .option('--list-outputs', 'writes nothing; prints the absolute paths of the generated files (for build systems)')
        .option('--list-inputs', 'writes nothing; prints the configuration file and the models (for build systems)')
        .option('--outputs-file <file>', 'fails and updates the file if the generated files differ from the list in it (used by the CMake integration)')
        .description('generates code for state machines (cpp: sc_statemachine.h, <Class>.h, <Class>.cpp; c: sc_types.h, <prefix>.h, <prefix>.c); only changed files are written')
        .action(async (target: string | undefined, files: string[], options: GenerateCommandOptions) => {
            process.exitCode = await runGenerateCommand(target, files, options);
        });

    headerOptions(program.command('layout'))
        .argument('<file>', '.devm file of a state machine')
        .option('-d, --direction <direction>', 'DOWN or RIGHT', 'DOWN')
        .option('--auto', 'lay out automatically, ignoring the layout annotations (@at, ...)')
        .description('prints the computed diagram layout as JSON (the manual layout of the layout annotations, if any)')
        .action(async (file: string, options: { direction: 'DOWN' | 'RIGHT', auto?: boolean } & HeaderCommandOptions) => {
            const loaded = await loadMachine(file, options);
            if (!loaded) {
                process.exitCode = 1;
                return;
            }
            const { parsed } = loaded;
            const { graph } = await layoutStateMachineWithLayout(parsed.model, { direction: options.direction }, options.auto ? null : undefined);
            console.log(JSON.stringify(graph, undefined, 2));
        });

    program.command('migrate-layout')
        .argument('<file>', '.devm file of a state machine')
        .option('-l, --layout <file>', 'layout file of the experimental sidecar format (default: <file>.layout)')
        .description('writes the manual layout of a sidecar layout file (<file>.layout) into the model as layout annotations (@at, @size, @via, ...)')
        .action(async (file: string, options: { layout?: string }) => {
            process.exitCode = await migrateLayout(file, options.layout ?? layoutFileName(file));
        });

    headerOptions(program.command('simulate'))
        .argument('<file>', '.devm file of a state machine')
        .option('-s, --script <scenario>', 'scenario file (JSON, see packages/language/test/scenarios/README.md) to run against the model')
        .option('-e, --events <events>', 'without script: comma separated in events raised one after another (cycle based: each followed by a run cycle)')
        .option('-q, --quiet', 'print only the active states after each step, not the trace')
        .description('runs the state machine in the interpreter and prints the trace and the active states')
        .action(async (file: string, options: { script?: string, events?: string, quiet?: boolean } & HeaderCommandOptions) => {
            const loaded = await loadMachine(file, options);
            if (!loaded || loaded.errors > 0 || loaded.parsed.hasSyntaxErrors) {
                process.exitCode = 1;
                return;
            }
            const { parsed } = loaded;
            const printTrace = options.quiet ? () => { /* quiet */ } : (line: string) => console.log(line);
            if (options.script) {
                const scenario = validateScenario(JSON.parse(await fs.readFile(options.script, 'utf-8')), options.script);
                const result = runScenario(parsed.model, scenario, {
                    onTrace: entry => printTrace(formatTraceEntry(entry)),
                    onStep: (step, index, sim) => {
                        console.log(`#${index} ${describeStep(step)}${step.expect ? '' : `  -> [${sim.activeStates.join(', ')}]`}`);
                    },
                    onFailure: failure => console.log(`   FAILED: ${failure.message}`)
                });
                for (const failure of result.failures) {
                    console.error(`${options.script}: step ${failure.step}: ${failure.message}`);
                }
                console.log(result.passed ? `${scenario.name ?? options.script}: passed` : `${scenario.name ?? options.script}: FAILED`);
                process.exitCode = result.passed ? 0 : 1;
                return;
            }
            const sim = new StatechartInterpreter(parsed.model, { onTrace: entry => printTrace(formatTraceEntry(entry)) });
            console.log(`> enter (${sim.executionMode === 'cycle' ? `cycle based, ${sim.cyclePeriod} ms` : 'event driven'}, ${sim.executionOrder})`);
            sim.enter();
            console.log(`  active: [${sim.activeStates.join(', ')}]`);
            for (const event of (options.events ?? '').split(',').map(e => e.trim()).filter(e => e)) {
                console.log(`> raise ${event}`);
                sim.raise(event);
                if (sim.executionMode === 'cycle') {
                    sim.runCycle();
                }
                console.log(`  active: [${sim.activeStates.join(', ')}]${sim.isFinal() ? ' (final)' : ''}`);
            }
        });

    headerOptions(program.command('test'))
        .argument('<files...>', 'unit test files (.devmtest)')
        .option('-m, --machine <files...>', 'state machine files (.devm) or directories; the .devm files next to the test files are loaded automatically')
        .option('--junit <file>', 'writes a JUnit XML report')
        .option('-v, --verbose', 'prints the trace of every test')
        .option('--coverage', 'collects the model coverage (states, transitions, reactions, guard decisions)')
        .option('--coverage-dir <dir>', 'directory of the coverage reports (default: coverage)')
        .option('--coverage-format <formats>', 'comma separated: text, json, lcov, cobertura, html (default: text,lcov,html)')
        .option('--coverage-threshold <thresholds>', 'minimum coverage in %, e.g. states=100,transitions=90 (exit code 1 if not met)')
        .description('runs the unit tests of state machines')
        .action(async (files: string[], options: TestCommandOptions) => {
            process.exitCode = await runTestCommand(files, options);
        });

    program.command('import')
        .argument('<files...>', 'itemis CREATE / YAKINDU statecharts (.sct); submachine states referencing one of the other files become submachine instances')
        .option('-o, --out <file>', 'output file for a single statechart (default: <file>.devm)')
        .option('--no-layout', 'do not convert the diagrams into layout annotations (@at, ...)')
        .description('converts itemis CREATE (.sct) statecharts into state machine files (.devm; their diagrams into layout annotations)')
        .action(async (files: string[], options: { out?: string, layout: boolean }) => {
            if (options.out && files.length > 1) {
                console.error('--out can only be used with a single statechart');
                process.exitCode = 2;
                return;
            }
            const inputs = await Promise.all(files.map(async fileName => ({ fileName, xml: await fs.readFile(fileName, 'utf-8') })));
            const results = inputs.length === 1
                ? [{ ...importSct(inputs[0].xml, { layout: options.layout }), fileName: inputs[0].fileName.replace(/\.sct$/, '') + '.devm' }]
                : importSctFiles(inputs, { layout: options.layout });
            for (const [index, result] of results.entries()) {
                for (const warning of result.warnings) {
                    console.error(`${files[index]}: warning: ${warning}`);
                }
                const out = options.out ?? result.fileName;
                await fs.writeFile(out, result.text);
                console.log(`Generated ${out}`);
            }
        });

    program.command('cpp-header')
        .argument('<files...>', 'C++ headers (analyzed together, in the given order)')
        .option('-D, --define <macros...>', 'predefined macros: NAME or NAME=VALUE')
        .option('--data-model <model>', 'data model of the target: lp64 (default), llp64 or ilp32')
        .description('prints the types and constants extracted from C++ headers as JSON (for debugging the C++ integration)')
        .action(async (files: string[], options: HeaderCommandOptions) => {
            const sources = await Promise.all(files.map(async fileName => ({ fileName, text: await fs.readFile(fileName, 'utf-8') })));
            const index = CppTypeIndex.fromSources(sources, { defines: parseDefines(options.define), dataModel: dataModelNamed(options.dataModel) });
            console.log(JSON.stringify(cppHeaderReport(index), undefined, 2));
        });

    registerRenderCommands(program);

    return program;
}

/**
 * `devm migrate-layout`: writes the manual layout of a layout file of the experimental sidecar format
 * (`<model>.layout`, e.g. `door.devm.layout`; older files are passed with `--layout door.hsm.layout`) into the model as layout annotations. The layout file is not deleted.
 */
async function migrateLayout(file: string, layoutFile: string): Promise<number> {
    if (!await exists(layoutFile)) {
        console.error(`${layoutFile}: not found`);
        return 1;
    }
    const layout = parseManualLayout(await fs.readFile(layoutFile, 'utf-8'));
    if (layout.mode !== 'manual') {
        console.log(`${layoutFile}: the diagram is laid out automatically (mode "auto"), nothing to migrate.`);
        return 0;
    }
    const loaded = await loadMachine(file);
    if (!loaded) {
        return 1;
    }
    const { parsed } = loaded;
    if (parsed.hasSyntaxErrors) {
        console.error(`${file}: the model has syntax errors`);
        return 1;
    }
    const text = parsed.document.textDocument.getText();
    const edits = layoutTextEdits(parsed.model, text, layout);
    await fs.writeFile(file, applyEdits(text, edits));
    console.log(`${file}: layout of ${layoutFile} written as layout annotations (${edits.length} changes); ${layoutFile} is no longer used and can be deleted.`);
    return 0;
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

/** Short text of a scenario step, e.g. `raise play` or `expect {"active":["Closed"]}`. */
function describeStep(step: ScenarioStep): string {
    const { comment: _comment, expectError, value: eventValue, ...action } = step;
    const [key, value] = Object.entries(action)[0] ?? ['?', ''];
    let text = value === true ? key : `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`;
    if (eventValue !== undefined) {
        text += ` : ${JSON.stringify(eventValue)}`;
    }
    return `${text}${expectError !== undefined ? ` (expecting error '${expectError}')` : ''}`;
}

createProgram().parseAsync(process.argv).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
