import * as vscode from 'vscode';
import * as path from 'node:path';
import { CoverageCollector, type MachineCoverage, type WorkspaceFile } from 'hsm-language';
import { discoverTests, failureMessage, lineCoverage, runHsmTests, type TextRange } from './logic/tests.js';

const EXCLUDE = '**/{node_modules,out,dist,build}/**';

type ItemKind = 'file' | 'class' | 'test';

interface ItemData {
    kind: ItemKind;
    uri: vscode.Uri;
    testClass?: string;
    test?: string;
}

/**
 * The unit tests of `.hsmtest` files in the Test Explorer: test classes and their `@Test`
 * operations are discovered by parsing the files; running them loads all models of the workspace
 * and executes the tests on the interpreter of the language package.
 */
export class HsmTestController implements vscode.Disposable {

    readonly controller = vscode.tests.createTestController('hsmTests', 'HSM Tests');
    private readonly data = new WeakMap<vscode.TestItem, ItemData>();
    private readonly disposables: vscode.Disposable[] = [];
    private readonly runProfile: vscode.TestRunProfile;

    constructor(private readonly output: vscode.LogOutputChannel) {
        this.controller.resolveHandler = async item => {
            if (!item) {
                await this.discoverWorkspace();
            }
        };
        this.controller.refreshHandler = () => this.discoverWorkspace();
        this.runProfile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => this.run(request, token, false), true);
        // model coverage: states, transitions and reactions as statements, guard decisions as branches
        const coverageProfile = this.controller.createRunProfile('Run with Model Coverage', vscode.TestRunProfileKind.Coverage,
            (request, token) => this.run(request, token, true), true);
        coverageProfile.loadDetailedCoverage = async (_run, file) => (file as ModelFileCoverage).details;
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.hsmtest');
        this.disposables.push(
            this.controller,
            watcher,
            watcher.onDidCreate(uri => this.updateFromDisk(uri)),
            watcher.onDidChange(uri => this.updateFromDisk(uri)),
            watcher.onDidDelete(uri => this.controller.items.delete(uri.toString())),
            vscode.workspace.onDidOpenTextDocument(document => this.updateFromDocument(document)),
            vscode.workspace.onDidChangeTextDocument(event => this.updateFromDocument(event.document))
        );
        vscode.workspace.textDocuments.forEach(document => this.updateFromDocument(document));
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }

    /** Finds all test files of the workspace. */
    async discoverWorkspace(): Promise<void> {
        const files = await vscode.workspace.findFiles('**/*.hsmtest', EXCLUDE);
        for (const uri of files) {
            await this.updateFromDisk(uri);
        }
    }

    private async updateFromDisk(uri: vscode.Uri): Promise<void> {
        const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        if (open) {
            this.updateFromDocument(open);
            return;
        }
        try {
            this.updateItems(uri, new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
        } catch (error) {
            this.output.warn(`Cannot read ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private updateFromDocument(document: vscode.TextDocument): void {
        if (document.languageId === 'hsmtest' && document.uri.scheme === 'file') {
            this.updateItems(document.uri, document.getText());
        }
    }

    /** Creates or updates the items of a test file: file → test classes → tests. */
    private updateItems(uri: vscode.Uri, text: string): vscode.TestItem {
        const key = uri.toString();
        let file = this.controller.items.get(key);
        if (!file) {
            file = this.controller.createTestItem(key, vscode.workspace.asRelativePath(uri, false) || path.basename(uri.path), uri);
            this.data.set(file, { kind: 'file', uri });
            this.controller.items.add(file);
        }
        const classes = discoverTests(text);
        const classItems: vscode.TestItem[] = [];
        for (const testClass of classes) {
            const classItem = this.controller.createTestItem(`${key}#${testClass.name}`, testClass.name, uri);
            classItem.range = toRange(testClass.range);
            classItem.description = testClass.machine ? `for ${testClass.machine}` : undefined;
            this.data.set(classItem, { kind: 'class', uri, testClass: testClass.name });
            classItem.children.replace(testClass.tests.map(test => {
                const item = this.controller.createTestItem(`${key}#${testClass.name}.${test.name}`, test.name, uri);
                item.range = toRange(test.range);
                this.data.set(item, { kind: 'test', uri, testClass: testClass.name, test: test.name });
                return item;
            }));
            classItems.push(classItem);
        }
        file.children.replace(classItems);
        return file;
    }

    /** `HSM: Run Tests`: runs the tests of a test file (all tests of the workspace without a file). */
    async runFile(uri: vscode.Uri | undefined): Promise<void> {
        let include: vscode.TestItem[] | undefined;
        if (uri) {
            const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
            include = [open ? this.updateItems(uri, open.getText()) : this.updateItems(uri, new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)))];
        } else {
            await this.discoverWorkspace();
        }
        const source = new vscode.CancellationTokenSource();
        try {
            await this.run(new vscode.TestRunRequest(include, undefined, this.runProfile), source.token, false);
        } finally {
            source.dispose();
        }
        vscode.commands.executeCommand('workbench.view.testing.focus').then(undefined, () => undefined);
    }

    private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken, withCoverage: boolean): Promise<void> {
        const run = this.controller.createTestRun(request);
        const coverage = withCoverage ? new CoverageCollector() : undefined;
        try {
            // the tests to run, grouped by test file
            const roots = request.include ?? [...collection(this.controller.items)];
            const excluded = new Set(request.exclude ?? []);
            const tests = new Map<string, vscode.TestItem>();
            const files = new Map<string, vscode.Uri>();
            const collect = (item: vscode.TestItem) => {
                if (excluded.has(item)) {
                    return;
                }
                const data = this.data.get(item);
                if (data?.kind === 'test') {
                    tests.set(item.id, item);
                    files.set(data.uri.toString(), data.uri);
                    run.enqueued(item);
                }
                collection(item.children).forEach(collect);
            };
            roots.forEach(collect);
            if (tests.size === 0) {
                return;
            }
            const testFiles = await Promise.all([...files.values()].map(readFile));
            const models = await Promise.all((await vscode.workspace.findFiles('**/*.hsm', EXCLUDE)).map(readFile));
            if (token.isCancellationRequested) {
                return;
            }
            const itemOf = (uri: string | undefined, testClass: string, test: string) => tests.get(`${uri}#${testClass}.${test}`);
            for (const item of tests.values()) {
                run.started(item);
            }
            const { results, problems } = await runHsmTests(models, testFiles, {
                coverage,
                filter: (uri, testClass, test) => !token.isCancellationRequested && itemOf(uri, testClass, test) !== undefined,
                onResult: result => {
                    const item = itemOf(result.uri, result.testClass, result.name);
                    if (!item) {
                        return;
                    }
                    tests.delete(item.id);
                    if (result.status === 'passed') {
                        run.passed(item, result.durationMs);
                        return;
                    }
                    const message = new vscode.TestMessage(failureMessage(result));
                    const uri = result.uri ? vscode.Uri.parse(result.uri) : item.uri;
                    if (uri && result.line) {
                        message.location = new vscode.Location(uri, new vscode.Position(result.line - 1, 0));
                    }
                    run.appendOutput(`${result.status.toUpperCase()} ${result.testClass}.${result.name}: ${result.message ?? ''}\r\n`
                        + result.trace.map(line => `    | ${line}`).join('\r\n') + '\r\n', message.location, item);
                    if (result.status === 'failed') {
                        run.failed(item, message, result.durationMs);
                    } else {
                        run.errored(item, message, result.durationMs);
                    }
                }
            });
            // tests of files with errors were not executed
            for (const problem of problems) {
                const uri = vscode.Uri.parse(problem.uri);
                const messages = problem.diagnostics.map(d => {
                    const message = new vscode.TestMessage(`${path.basename(uri.path)}:${d.range.start.line + 1}: ${d.message}`);
                    message.location = new vscode.Location(uri, new vscode.Range(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character));
                    return message;
                });
                for (const [id, item] of [...tests]) {
                    if (item.uri?.toString() === problem.uri) {
                        run.errored(item, messages.length > 0 ? messages : new vscode.TestMessage('The test file contains errors.'));
                        tests.delete(id);
                    }
                }
            }
            for (const item of tests.values()) {
                if (token.isCancellationRequested) {
                    run.skipped(item);
                } else {
                    run.errored(item, new vscode.TestMessage('The test was not executed (unknown test or state machine).'));
                }
            }
            if (coverage) {
                const byFile = new Map<string, MachineCoverage[]>();
                for (const machine of coverage.report().machines) {
                    if (machine.uri) {
                        byFile.set(machine.uri, [...byFile.get(machine.uri) ?? [], machine]);
                    }
                }
                for (const [uri, machines] of byFile) {
                    run.addCoverage(new ModelFileCoverage(vscode.Uri.parse(uri), machines));
                }
            }
            this.output.info(`Tests: ${results.filter(r => r.status === 'passed').length} passed, `
                + `${results.filter(r => r.status === 'failed').length} failed, ${results.filter(r => r.status === 'error').length} errors`);
        } catch (error) {
            this.output.error(`Test run failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
            throw error;
        } finally {
            run.end();
        }
    }
}

function collection(items: vscode.TestItemCollection): vscode.TestItem[] {
    const result: vscode.TestItem[] = [];
    items.forEach(item => result.push(item));
    return result;
}

function toRange(range: TextRange): vscode.Range {
    return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

/** The text of a file: the (possibly unsaved) text of an open document or the file content. */
async function readFile(uri: vscode.Uri): Promise<WorkspaceFile> {
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    const text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    return { uri: uri.toString(), text };
}

/** Model coverage of the state machines of a file as file coverage of its `.hsm` file. */
class ModelFileCoverage extends vscode.FileCoverage {

    readonly details: vscode.StatementCoverage[];

    constructor(uri: vscode.Uri, machines: readonly MachineCoverage[]) {
        const details = machines.flatMap(lineCoverage).map(line => new vscode.StatementCoverage(
            line.hits,
            new vscode.Position(line.line, 0),
            line.branches.map(branch => new vscode.BranchCoverage(branch.hits, undefined, branch.label))));
        const statements = new vscode.TestCoverageCount(details.filter(d => Number(d.executed) > 0).length, details.length);
        const branches = details.flatMap(d => d.branches);
        super(uri, statements, branches.length > 0 ? new vscode.TestCoverageCount(branches.filter(b => Number(b.executed) > 0).length, branches.length) : undefined);
        this.details = details;
    }
}
