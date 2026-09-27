import { GrammarUtils, type AstNode, type LangiumDocument } from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import {
    createHsmServices, hasAnnotation, HsmTestWorkspace, runTests, type TestModel, type TestResult, type WorkspaceFile
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
            onTrace: options.onTrace
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
