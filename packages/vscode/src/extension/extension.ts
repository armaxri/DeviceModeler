import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { registerCommands } from './commands.js';
import { DiagramManager } from './diagram-panel.js';
import { HsmTestController } from './test-controller.js';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('HSM', { log: true });
    context.subscriptions.push(output);

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

/** The language server (all three languages) runs in a separate Node process, connected via IPC. */
function startLanguageClient(context: vscode.ExtensionContext): LanguageClient {
    const serverModule = context.asAbsolutePath('dist/server.cjs');
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } }
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'hsm' },
            { scheme: 'file', language: 'hsmtest' },
            { scheme: 'file', language: 'dmf' },
            { scheme: 'untitled', language: 'hsm' },
            { scheme: 'untitled', language: 'hsmtest' },
            { scheme: 'untitled', language: 'dmf' }
        ],
        synchronize: {
            // the server indexes all models, tests and structure files of the workspace (cross-file references
            // of .hsmtest and .dmf files)
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{hsm,hsmtest,dmf}')
        }
    };
    return new LanguageClient('hsm', 'HSM Language Server', serverOptions, clientOptions);
}
