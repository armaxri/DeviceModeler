import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { createHsmServices } from '../hsm-module.js';
import { checkCoverageThresholds, CoverageCollector, parseCoverageThresholds, type CoverageThresholds } from './coverage.js';
import {
    COVERAGE_FORMATS, toCobertura, toCoverageHtml, toCoverageJson, toCoverageText, toLcov, type CoverageDiagramRenderer, type CoverageFormat
} from './coverage-reports.js';
import { toJUnitXml } from './junit.js';
import { layoutStateMachine } from '../diagram/layout.js';
import { renderSvg, type HighlightKind } from '../render/svg.js';
import { HsmTestWorkspace, type WorkspaceFile } from './test-workspace.js';

export interface TestCommandOptions {
    /** Additional `.hsm` files or directories containing `.hsm` files. */
    machine?: string[];
    /** Path of a JUnit XML report. */
    junit?: string;
    /** Print the trace of every test. */
    verbose?: boolean;
    /** Collect the model coverage (implied by the other coverage options). */
    coverage?: boolean;
    /** Directory of the coverage reports. Default: `coverage`. */
    coverageDir?: string;
    /** Comma separated coverage formats: text, json, lcov, cobertura, html. Default: `text,lcov,html`. */
    coverageFormat?: string;
    /** Minimum coverage in percent, e.g. `states=100,transitions=90` (see `parseCoverageThresholds`). */
    coverageThreshold?: string;
    /** Renders the diagrams of the HTML coverage report (without it the report has no diagrams). */
    renderDiagram?: CoverageDiagramRenderer;
}

/** File names of the coverage reports in the coverage directory. */
export const COVERAGE_FILES = { json: 'coverage.json', lcov: 'lcov.info', cobertura: 'cobertura-coverage.xml', html: 'html/index.html' } as const;

const SEVERITIES = ['', 'error', 'warning', 'info', 'hint'];

/**
 * `hsm test <file.hsmtest ...>`: loads the test files together with the `.hsm` files in their
 * directories – or in the parent directories if there are none – (and the given `--machine` files /
 * directories), runs all tests and prints a report.
 * Returns the exit code: 0 if all tests passed, 1 otherwise.
 */
export async function runTestCommand(files: string[], options: TestCommandOptions): Promise<number> {
    const withCoverage = !!(options.coverage || options.coverageDir || options.coverageFormat || options.coverageThreshold);
    let formats: CoverageFormat[] = [];
    let thresholds: CoverageThresholds = {};
    if (withCoverage) {
        try {
            formats = parseFormats(options.coverageFormat ?? 'text,lcov,html');
            thresholds = options.coverageThreshold ? parseCoverageThresholds(options.coverageThreshold) : {};
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            return 1;
        }
    }
    const coverage = withCoverage ? new CoverageCollector() : undefined;
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
        onTrace: options.verbose ? line => console.log(`        | ${line}`) : undefined,
        coverage
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
    let coverageFailures = 0;
    if (coverage) {
        coverageFailures = await writeCoverage(coverage, formats, thresholds, options, file => display(file));
    }
    return failed + errors + problems + coverageFailures > 0 || results.length === 0 ? 1 : 0;
}

function parseFormats(text: string): CoverageFormat[] {
    const formats = text.split(',').map(f => f.trim().toLowerCase()).filter(f => f);
    for (const format of formats) {
        if (!(COVERAGE_FORMATS as readonly string[]).includes(format)) {
            throw new Error(`Unknown coverage format '${format}' (supported: ${COVERAGE_FORMATS.join(', ')})`);
        }
    }
    return formats as CoverageFormat[];
}

/** Prints / writes the coverage reports; returns the number of failed thresholds. */
async function writeCoverage(
    coverage: CoverageCollector, formats: CoverageFormat[], thresholds: CoverageThresholds, options: TestCommandOptions,
    display: (uri: string) => string
): Promise<number> {
    const report = coverage.report();
    const dir = options.coverageDir ?? 'coverage';
    const reportOptions = { fileName: display };
    const written: string[] = [];
    const write = async (file: string, content: string) => {
        const target = path.join(dir, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
        return target;
    };
    for (const format of formats) {
        switch (format) {
            case 'text':
                console.log(`\nModel coverage\n${toCoverageText(report, reportOptions)}`);
                break;
            case 'json':
                written.push(await write(COVERAGE_FILES.json, toCoverageJson(report, reportOptions)));
                break;
            case 'lcov':
                written.push(await write(COVERAGE_FILES.lcov, toLcov(report, reportOptions)));
                break;
            case 'cobertura':
                written.push(await write(COVERAGE_FILES.cobertura, toCobertura(report, { ...reportOptions, sourceRoot: process.cwd() })));
                break;
            case 'html': {
                const pages = await toCoverageHtml(report, {
                    ...reportOptions, renderDiagram: options.renderDiagram ?? renderCoverageDiagram, diagramSource: machine => coverage.diagramSource(machine)
                });
                for (const page of pages) {
                    const target = await write(path.join(path.dirname(COVERAGE_FILES.html), page.path), page.content);
                    if (page.path === 'index.html') {
                        written.push(target);
                    }
                }
                break;
            }
        }
    }
    if (written.length > 0) {
        console.log(`Coverage reports written to ${written.join(', ')}`);
    }
    const failures = checkCoverageThresholds(report, thresholds);
    for (const failure of failures) {
        console.error(`Coverage threshold not met: ${failure}`);
    }
    return failures.length;
}

async function hsmFilesIn(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter(e => e.isFile() && e.name.endsWith('.hsm')).map(e => path.join(directory, e.name)).sort();
}

/** Default diagram of the HTML coverage report: the state machine with covered / uncovered elements highlighted. */
export const renderCoverageDiagram: CoverageDiagramRenderer = async (machine, highlight) => {
    const { graph } = await layoutStateMachine(machine);
    const kinds = new Map<string, HighlightKind>();
    for (const [id, cls] of Object.entries(highlight.classes)) {
        kinds.set(id, cls === 'hsm-covered' ? 'covered' : 'uncovered');
    }
    return renderSvg(graph, { highlight: kinds, legend: true, xmlDeclaration: false });
};
