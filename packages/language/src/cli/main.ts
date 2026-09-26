import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { NodeFileSystem } from 'langium/node';
import { createHsmServices } from '../hsm-module.js';
import { HsmModelLoader } from '../hsm-document.js';
import { generatePlantUml } from '../generator/plantuml.js';
import { layoutStateMachine } from '../diagram/layout.js';
import { importSct } from '../importer/sct-importer.js';
import { StatechartInterpreter } from '../simulation/interpreter.js';
import { formatTraceEntry, runScenario, validateScenario, type ScenarioStep } from '../simulation/scenario.js';
import { runTestCommand, type TestCommandOptions } from '../testing/test-command.js';

const severities = ['', 'error', 'warning', 'info', 'hint'];

async function load(file: string) {
    const loader = new HsmModelLoader(createHsmServices(NodeFileSystem));
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
    return { parsed, errors };
}

export function createProgram(): Command {
    const program = new Command('hsm').description('Tools for hierarchical state machine models (.hsm)');

    program.command('validate')
        .argument('<file>', '.hsm file to validate')
        .description('parses and validates a model')
        .action(async (file: string) => {
            const { errors } = await load(file);
            if (errors > 0) {
                process.exitCode = 1;
            } else {
                console.log(`${file}: OK`);
            }
        });

    program.command('plantuml')
        .argument('<file>', '.hsm file')
        .option('-o, --out <file>', 'output file (default: <file>.puml)')
        .description('generates a PlantUML state diagram')
        .action(async (file: string, options: { out?: string }) => {
            const { parsed, errors } = await load(file);
            if (errors > 0 || parsed.hasSyntaxErrors) {
                process.exitCode = 1;
                return;
            }
            const out = options.out ?? file.replace(/\.hsm$/, '') + '.puml';
            await fs.writeFile(out, generatePlantUml(parsed.model));
            console.log(`Generated ${out}`);
        });

    program.command('layout')
        .argument('<file>', '.hsm file')
        .option('-d, --direction <direction>', 'DOWN or RIGHT', 'DOWN')
        .description('prints the computed diagram layout as JSON')
        .action(async (file: string, options: { direction: 'DOWN' | 'RIGHT' }) => {
            const { parsed } = await load(file);
            const { graph } = await layoutStateMachine(parsed.model, { direction: options.direction });
            console.log(JSON.stringify(graph, undefined, 2));
        });

    program.command('simulate')
        .argument('<file>', '.hsm file')
        .option('-s, --script <scenario>', 'scenario file (JSON, see packages/language/test/scenarios/README.md) to run against the model')
        .option('-e, --events <events>', 'without script: comma separated in events raised one after another (cycle based: each followed by a run cycle)')
        .option('-q, --quiet', 'print only the active states after each step, not the trace')
        .description('runs the state machine in the interpreter and prints the trace and the active states')
        .action(async (file: string, options: { script?: string, events?: string, quiet?: boolean }) => {
            const { parsed, errors } = await load(file);
            if (errors > 0 || parsed.hasSyntaxErrors) {
                process.exitCode = 1;
                return;
            }
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

    program.command('test')
        .argument('<files...>', 'unit test files (.hsmtest)')
        .option('-m, --machine <files...>', 'state machine files (.hsm) or directories; the .hsm files next to the test files are loaded automatically')
        .option('--junit <file>', 'writes a JUnit XML report')
        .option('-v, --verbose', 'prints the trace of every test')
        .description('runs the unit tests of state machines')
        .action(async (files: string[], options: TestCommandOptions) => {
            process.exitCode = await runTestCommand(files, options);
        });

    program.command('import')
        .argument('<file>', 'itemis CREATE / YAKINDU statechart (.sct)')
        .option('-o, --out <file>', 'output file (default: <file>.hsm)')
        .description('converts an itemis CREATE (.sct) statechart into an .hsm model')
        .action(async (file: string, options: { out?: string }) => {
            const { text, warnings } = importSct(await fs.readFile(file, 'utf-8'));
            for (const warning of warnings) {
                console.error(`${file}: warning: ${warning}`);
            }
            const out = options.out ?? file.replace(/\.sct$/, '') + '.hsm';
            await fs.writeFile(out, text);
            console.log(`Generated ${out}`);
        });

    return program;
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
