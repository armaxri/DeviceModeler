import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { NodeFileSystem } from 'langium/node';
import { createHsmServices } from '../hsm-module.js';
import { HsmModelLoader } from '../hsm-document.js';
import { generatePlantUml } from '../generator/plantuml.js';
import { layoutStateMachine } from '../diagram/layout.js';
import { importSct } from '../importer/sct-importer.js';

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

createProgram().parseAsync(process.argv).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
