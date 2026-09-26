import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { createHsmServices } from '../hsm-module.js';
import { toJUnitXml } from './junit.js';
import { HsmTestWorkspace, type WorkspaceFile } from './test-workspace.js';

export interface TestCommandOptions {
    /** Additional `.hsm` files or directories containing `.hsm` files. */
    machine?: string[];
    /** Path of a JUnit XML report. */
    junit?: string;
    /** Print the trace of every test. */
    verbose?: boolean;
}

const SEVERITIES = ['', 'error', 'warning', 'info', 'hint'];

/**
 * `hsm test <file.hsmtest ...>`: loads the test files together with the `.hsm` files in their
 * directories – or in the parent directories if there are none – (and the given `--machine` files /
 * directories), runs all tests and prints a report.
 * Returns the exit code: 0 if all tests passed, 1 otherwise.
 */
export async function runTestCommand(files: string[], options: TestCommandOptions): Promise<number> {
    const machineFiles = new Set<string>();
    for (const file of files) {
        // the directory of the test file, or its parent if it contains no models (e.g. `examples/tests/`)
        const directory = path.dirname(path.resolve(file));
        let candidates = await hsmFilesIn(directory);
        if (candidates.length === 0) {
            candidates = await hsmFilesIn(path.dirname(directory));
        }
        for (const candidate of candidates) {
            machineFiles.add(candidate);
        }
    }
    for (const machine of options.machine ?? []) {
        const resolved = path.resolve(machine);
        const stat = await fs.stat(resolved);
        for (const candidate of stat.isDirectory() ? await hsmFilesIn(resolved) : [resolved]) {
            machineFiles.add(candidate);
        }
    }
    const testFiles = files.map(file => path.resolve(file));
    const inputs: WorkspaceFile[] = [];
    const displayNames = new Map<string, string>();
    for (const file of [...machineFiles, ...testFiles]) {
        const uri = pathToFileURL(file).toString();
        displayNames.set(uri, path.relative(process.cwd(), file) || file);
        inputs.push({ uri, text: await fs.readFile(file, 'utf-8') });
    }

    const workspace = new HsmTestWorkspace(createHsmServices(NodeFileSystem));
    const documents = await workspace.load(inputs);
    const display = (uri: string | undefined) => (uri && displayNames.get(uri)) ?? uri ?? '?';
    let problems = 0;
    for (const loaded of documents) {
        const isTest = loaded.uri.endsWith('.hsmtest');
        for (const d of loaded.diagnostics) {
            // warnings of models are not interesting here, their errors prevent running tests
            if (d.severity === 1 || isTest) {
                console.error(`${display(loaded.uri)}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${SEVERITIES[d.severity ?? 1]}: ${d.message}`);
            }
        }
        if (isTest && loaded.hasErrors) {
            problems++;
            console.error(`${display(loaded.uri)}: not executed because of errors`);
        }
    }

    const results = workspace.runDocuments(documents, {
        onResult: result => {
            const time = `(${result.durationMs} ms)`;
            if (result.status === 'passed') {
                console.log(`  passed  ${result.testClass}.${result.name} ${time}`);
                return;
            }
            console.log(`  ${result.status === 'failed' ? 'FAILED' : 'ERROR '}  ${result.testClass}.${result.name} ${time}`);
            console.log(`      ${display(result.uri)}${result.line ? `:${result.line}` : ''}: ${result.message}`);
            if (!options.verbose) {
                for (const line of result.trace) {
                    console.log(`        | ${line}`);
                }
            }
        },
        onTrace: options.verbose ? line => console.log(`        | ${line}`) : undefined
    });
    const count = (status: string) => results.filter(r => r.status === status).length;
    const failed = count('failed');
    const errors = count('error');
    console.log(`\n${results.length} tests: ${count('passed')} passed, ${failed} failed, ${errors} errors`
        + (problems > 0 ? `; ${problems} test file${problems === 1 ? '' : 's'} with errors` : ''));
    if (options.junit) {
        await fs.writeFile(options.junit, toJUnitXml(results, { fileName: display }));
        console.log(`JUnit report written to ${options.junit}`);
    }
    return failed + errors + problems > 0 || results.length === 0 ? 1 : 0;
}

async function hsmFilesIn(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter(e => e.isFile() && e.name.endsWith('.hsm')).map(e => path.join(directory, e.name)).sort();
}
