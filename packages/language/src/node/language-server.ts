import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures, type Connection } from 'vscode-languageserver/node';
import { createHsmLanguageServerServices, installHeaderSupport } from './hsm-lsp.js';

/**
 * The language server of both languages (.hsm and .hsmtest), shared by the VS Code extension (started
 * via IPC) and `hsm lsp` of the command line tool / executable (Eclipse, JetBrains IDEs and any other
 * LSP client, usually with `--stdio`). All .hsm / .hsmtest files of the workspace folders are indexed,
 * so test classes and imports resolve the state machines of other files.
 *
 * Without a connection the transport is taken from the command line arguments of the process
 * (`--stdio`, `--node-ipc`, `--socket=<port>`, `--pipe=<name>`, `--clientProcessId <pid>`; see
 * `vscode-languageserver/node`). With `--stdio` all console output goes to the client's log.
 */
export function startHsmLanguageServer(connection: Connection = createConnection(ProposedFeatures.all)): void {
    const { shared } = createHsmLanguageServerServices({ connection, ...NodeFileSystem });
    // imported C/C++ headers: read from the file system, settings of hsm.gen.json and hsm.headers.*
    installHeaderSupport(shared);
    startLanguageServer(shared);
}

/** Transport arguments of `hsm lsp` (see `languageServerArguments`). */
export interface LanguageServerOptions {
    stdio?: boolean;
    socket?: string;
    pipe?: string;
    nodeIpc?: boolean;
    clientProcessId?: string;
}

/**
 * The process arguments understood by `vscode-languageserver/node` for the options of `hsm lsp`
 * (stdin/stdout if no transport is given).
 */
export function languageServerArguments(options: LanguageServerOptions): string[] {
    const args: string[] = [];
    if (options.socket !== undefined) {
        const port = Number(options.socket);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            throw new Error(`invalid port '${options.socket}'`);
        }
        args.push(`--socket=${port}`);
    } else if (options.pipe !== undefined) {
        args.push(`--pipe=${options.pipe}`);
    } else if (options.nodeIpc) {
        args.push('--node-ipc');
    } else {
        args.push('--stdio');
    }
    if (options.clientProcessId !== undefined) {
        args.push('--clientProcessId', options.clientProcessId);
    }
    return args;
}

/** `hsm lsp`: runs the language server until the client sends `exit` (or closes the connection). */
export function runLanguageServer(options: LanguageServerOptions): void {
    // createConnection reads the transport from process.argv (after the executable and script)
    process.argv = [process.argv[0], process.argv[1] ?? process.argv[0], ...languageServerArguments(options)];
    startHsmLanguageServer();
}
