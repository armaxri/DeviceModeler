import * as vscode from 'vscode';
import * as path from 'node:path';
import type { WorkspaceFile } from 'devm-language';
import { CustomEvents, DevmDebugAdapter, type AdapterEnvironment, type LaunchArguments, type LaunchFiles } from '../debug/adapter.js';
import { workerEngineFactory } from '../debug/connection.js';
import type { DiagramSnapshot, TestSelector } from '../debug/protocol.js';
import type { DiagramManager } from './diagram-panel.js';
import { readText, vscodeHeaderSettings } from './diagram-panel.js';
import { discoverTests } from './logic/tests.js';

export const DEBUG_TYPE = 'devm-test';

const EXCLUDE = '**/{node_modules,out,dist,build}/**';

/**
 * Debugging of `.devmtest` tests: an inline debug adapter (Debug Adapter Protocol) running the tests in a
 * worker thread of the extension host, a configuration provider (F5 on a test file without launch.json)
 * and the diagram of the model under test, which shows the active states on every stop.
 */
export function registerTestDebugger(context: vscode.ExtensionContext, diagrams: DiagramManager, output: vscode.LogOutputChannel): void {
    const environment: AdapterEnvironment = {
        prepare: args => prepareLaunch(args),
        readText: uri => readText(uri),
        pathToUri: fsPath => vscode.Uri.file(fsPath).toString(),
        uriToPath: uri => vscode.Uri.parse(uri).fsPath,
        engine: workerEngineFactory(context.asAbsolutePath('dist/debug-worker.cjs'))
    };
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
            createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new DevmDebugAdapter(environment) as unknown as vscode.DebugAdapter)
        }),
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new DevmTestConfigurationProvider()),
        vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
            if (event.session.type === DEBUG_TYPE && event.event === CustomEvents.diagram) {
                const state = event.body as DiagramSnapshot;
                if (state.modelUri) {
                    diagrams.showDebugState(vscode.Uri.parse(state.modelUri), state).catch(error => {
                        output.warn(`Cannot show the diagram of the debug session: ${error instanceof Error ? error.message : String(error)}`);
                    });
                }
            }
        }),
        vscode.debug.onDidTerminateDebugSession(session => {
            if (session.type === DEBUG_TYPE) {
                diagrams.clearDebugState();
            }
        })
    );
}

/** F5 on a test file without launch.json, and the initial configurations of a new launch.json. */
class DevmTestConfigurationProvider implements vscode.DebugConfigurationProvider {

    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [{ type: DEBUG_TYPE, request: 'launch', name: 'Debug Device Modeler tests of the current file', program: '${file}' }];
    }

    resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.DebugConfiguration | undefined {
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor?.document.languageId !== 'devmtest') {
                vscode.window.showInformationMessage('Device Modeler: Open a .devmtest file to debug its tests.');
                return undefined;
            }
            return { type: DEBUG_TYPE, request: 'launch', name: 'Debug Device Modeler tests', program: editor.document.uri.fsPath };
        }
        if (!config.program && !config.tests) {
            const editor = vscode.window.activeTextEditor;
            if (editor?.document.languageId !== 'devmtest') {
                vscode.window.showInformationMessage('Device Modeler: The launch configuration needs a "program" (a .devmtest file).');
                return undefined;
            }
            config.program = editor.document.uri.fsPath;
        }
        return config;
    }
}

/** The files of a launch: the test file(s), all models of the workspace and the tests to run. */
async function prepareLaunch(args: LaunchArguments): Promise<LaunchFiles> {
    let tests: TestSelector[] | undefined = args.tests;
    let testUris: string[];
    if (tests) {
        testUris = [...new Set(tests.map(t => t.uri))];
    } else {
        if (!args.program) {
            throw new Error('The launch configuration has no "program" (the .devmtest file to debug).');
        }
        if (!args.program.toLowerCase().endsWith('.devmtest')) {
            throw new Error(`"program" must be a .devmtest file: ${args.program}`);
        }
        const uri = vscode.Uri.file(args.program).toString();
        testUris = [uri];
        if (args.test) {
            tests = selectTests(uri, await readText(uri) ?? '', args.test);
        }
    }
    const testFiles: WorkspaceFile[] = [];
    for (const uri of testUris) {
        const text = await readText(uri);
        if (text === undefined) {
            throw new Error(`Cannot read ${vscode.Uri.parse(uri).fsPath}`);
        }
        testFiles.push({ uri, text });
    }
    const models: WorkspaceFile[] = [];
    for (const uri of await vscode.workspace.findFiles('**/*.devm', EXCLUDE)) {
        const text = await readText(uri.toString());
        if (text !== undefined) {
            models.push({ uri: uri.toString(), text });
        }
    }
    // models next to a test file outside the workspace
    for (const uri of testUris) {
        const folder = path.dirname(vscode.Uri.parse(uri).fsPath);
        if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(uri))) {
            for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(folder)).then(entries => entries, () => [] as Array<[string, vscode.FileType]>)) {
                const model = vscode.Uri.file(path.join(folder, name)).toString();
                if (type === vscode.FileType.File && name.endsWith('.devm') && !models.some(m => m.uri === model)) {
                    const text = await readText(model);
                    if (text !== undefined) {
                        models.push({ uri: model, text });
                    }
                }
            }
        }
    }
    return { models, testFiles, tests, headers: vscodeHeaderSettings(undefined) };
}

/** The tests selected by the `test` attribute: `TestClass`, `TestClass.test` or `test`. */
export function selectTests(uri: string, text: string, test: string): TestSelector[] {
    const classes = discoverTests(text);
    const [first, second] = test.split('.');
    const selected: TestSelector[] = [];
    for (const testClass of classes) {
        if (second !== undefined) {
            if (testClass.name === first && testClass.tests.some(t => t.name === second)) {
                selected.push({ uri, testClass: testClass.name, test: second });
            }
        } else if (testClass.name === first) {
            selected.push({ uri, testClass: testClass.name });
        } else {
            selected.push(...testClass.tests.filter(t => t.name === first).map(t => ({ uri, testClass: testClass.name, test: t.name })));
        }
    }
    if (selected.length === 0) {
        throw new Error(`No test class or test '${test}' in ${path.basename(vscode.Uri.parse(uri).fsPath)}`);
    }
    return selected;
}
