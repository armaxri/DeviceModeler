import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { registerCommands } from './commands.js';
import { DiagramManager, isStructureDocument } from './diagram-panel.js';
import { HsmTestController } from './test-controller.js';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('Device Modeler', { log: true });
    context.subscriptions.push(output);
    trackStructureEditor(context);

    const diagrams = new DiagramManager(context);
    context.subscriptions.push(diagrams);
    const tests = new HsmTestController(output);
    context.subscriptions.push(tests);
    registerCommands(context, { diagrams, tests, output });

    client = startLanguageClient(context);
    await client.start();
}

export async function deactivate(): Promise<void> {
    await client?.stop();
    client = undefined;
}

/**
 * The context key `hsm.structureEditorActive` of the menus: whether the active editor shows a structure
 * file (`.devm` files are state machines or structure files, decided by their text): no code generation.
 */
function trackStructureEditor(context: vscode.ExtensionContext): void {
    let current: boolean | undefined;
    const update = () => {
        const editor = vscode.window.activeTextEditor;
        const structure = editor?.document.languageId === 'devm' && isStructureDocument(editor.document.uri);
        if (structure !== current) {
            current = structure;
            vscode.commands.executeCommand('setContext', 'hsm.structureEditorActive', structure);
        }
    };
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(update),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document === vscode.window.activeTextEditor?.document) {
                update();
            }
        })
    );
    update();
}

/** The language server (both languages) runs in a separate Node process, connected via IPC. */
function startLanguageClient(context: vscode.ExtensionContext): LanguageClient {
    const serverModule = context.asAbsolutePath('dist/server.cjs');
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } }
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'devm' },
            { scheme: 'file', language: 'devmtest' },
            { scheme: 'untitled', language: 'devm' },
            { scheme: 'untitled', language: 'devmtest' }
        ],
        synchronize: {
            // the server indexes all model and test files of the workspace (cross-file references)
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{devm,devmtest}')
        }
    };
    return new LanguageClient('hsm', 'Device Modeler Language Server', serverOptions, clientOptions);
}
