import { GrammarUtils, type AstNode, type LangiumDocument } from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import {
    createHsmServices, hasAnnotation, HsmTestWorkspace, runTests, type CoverageCollector, type MachineCoverage, type TestModel, type TestResult,
    type WorkspaceFile
} from 'hsm-language';

export interface TextRange {
    start: { line: number, character: number };
    end: { line: number, character: number };
}

export interface DiscoveredTest {
    name: string;
    /** Range of the whole test operation. */
    range: TextRange;
}

export interface DiscoveredTestClass {
    name: string;
    /** Name of the tested state machine. */
    machine: string;
    range: TextRange;
    tests: DiscoveredTest[];
}

let parserServices: ReturnType<typeof createHsmServices> | undefined;

/**
 * Finds the test classes and their tests (operations annotated with `@Test`) of a `.hsmtest` text.
 * Only the parser is used (fast, no linking), so it works on incomplete texts as well.
 */
export function discoverTests(text: string): DiscoveredTestClass[] {
    parserServices ??= createHsmServices();
    const model = parserServices.HsmTest.parser.LangiumParser.parse<TestModel>(text).value;
    const classes: DiscoveredTestClass[] = [];
    for (const testClass of model?.testClasses ?? []) {
        if (!testClass.name || !testClass.$cstNode) {
            continue;
        }
        const tests: DiscoveredTest[] = [];
        for (const operation of testClass.operations) {
            if (operation.name && operation.$cstNode && hasAnnotation(operation, 'Test')) {
                tests.push({ name: operation.name, range: rangeOf(operation) });
            }
        }
        classes.push({ name: testClass.name, machine: testClass.machine?.$refText ?? '', range: rangeOf(testClass), tests });
    }
    return classes;
}

function rangeOf(node: AstNode): TextRange {
    const name = node.$cstNode && GrammarUtils.findNodeForProperty(node.$cstNode, 'name');
    const range = (name ?? node.$cstNode)!.range;
    return { start: { ...range.start }, end: { ...range.end } };
}

/** A test document which could not be executed because of errors. */
export interface TestFileProblem {
    uri: string;
    diagnostics: Diagnostic[];
}

export interface HsmTestRunResult {
    results: TestResult[];
    problems: TestFileProblem[];
}

export interface HsmTestRunOptions {
    /** Runs only the tests for which the filter returns true. */
    filter?: (uri: string, testClass: string, test: string) => boolean;
    onResult?: (result: TestResult) => void;
    onTrace?: (line: string) => void;
    /** Collects the model coverage of the executed tests. */
    coverage?: CoverageCollector;
}

/**
 * Loads the models and test files into a fresh workspace (so that test classes resolve their state
 * machines) and runs the tests of the given test files. Test files with errors are not executed but
 * reported as problems.
 */
export async function runHsmTests(models: readonly WorkspaceFile[], testFiles: readonly WorkspaceFile[], options: HsmTestRunOptions = {}): Promise<HsmTestRunResult> {
    const testUris = new Set(testFiles.map(file => file.uri));
    const workspace = new HsmTestWorkspace(createHsmServices());
    const documents = await workspace.load([...models.filter(model => !testUris.has(model.uri)), ...testFiles]);
    const results: TestResult[] = [];
    const problems: TestFileProblem[] = [];
    for (const loaded of documents) {
        if (!testUris.has(loaded.uri)) {
            continue;
        }
        if (loaded.hasErrors) {
            problems.push({ uri: loaded.uri, diagnostics: loaded.diagnostics.filter(d => d.severity === 1) });
            continue;
        }
        const filter = options.filter;
        results.push(...runTests(loaded.document as LangiumDocument<TestModel>, undefined, {
            filter: filter ? (testClass, test) => filter(loaded.uri, testClass, test) : undefined,
            onResult: options.onResult,
            onTrace: options.onTrace,
            coverage: options.coverage
        }));
    }
    return { results, problems };
}

/** The message of a failed test with its trace (as shown in the test explorer). */
export function failureMessage(result: TestResult): string {
    const lines = [result.message ?? (result.status === 'error' ? 'Error' : 'Failed')];
    if (result.trace.length > 0) {
        lines.push('', 'Trace:', ...result.trace.map(line => `  ${line}`));
    }
    return lines.join('\n');
}

/** Coverage of one source line of a model (for the coverage view of the test explorer). */
export interface LineCoverage {
    /** 0-based line. */
    line: number;
    /** Hits of the element(s) starting on the line (the minimum if there are several: a line is covered only if all are). */
    hits: number;
    /** Names of the elements on the line. */
    names: string[];
    /** Guards on the line: two branches (true / false) each. */
    branches: Array<{ label: string, hits: number }>;
}

/**
 * Converts the coverage of a state machine into line coverage: states, final states, transitions and
 * local reactions are statements on their source line, guard decisions (true / false) are branches.
 */
export function lineCoverage(machine: MachineCoverage): LineCoverage[] {
    const lines = new Map<number, LineCoverage>();
    const lineOf = (line: number) => {
        let entry = lines.get(line);
        if (!entry) {
            entry = { line, hits: Number.POSITIVE_INFINITY, names: [], branches: [] };
            lines.set(line, entry);
        }
        return entry;
    };
    for (const element of machine.elements) {
        if (element.line === undefined) {
            continue;
        }
        const entry = lineOf(element.line - 1);
        entry.hits = Math.min(entry.hits, element.hits);
        entry.names.push(element.name);
    }
    for (const guard of machine.guards) {
        if (guard.line === undefined) {
            continue;
        }
        const entry = lineOf(guard.line - 1);
        entry.branches.push({ label: `[${guard.expression}] true`, hits: guard.trueHits }, { label: `[${guard.expression}] false`, hits: guard.falseHits });
    }
    return [...lines.values()]
        .map(entry => ({ ...entry, hits: Number.isFinite(entry.hits) ? entry.hits : Math.max(0, ...entry.branches.map(b => b.hits)) }))
        .sort((a, b) => a.line - b.line);
}
