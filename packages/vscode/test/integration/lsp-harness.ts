import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
// @ts-expect-error untyped build helper (ES module script)
import { bundleOptions } from '../../scripts/bundles.mjs';
// @ts-expect-error untyped build helper (ES module script)
import { bundleOptions as cliBundleOptions } from '../../../cli/scripts/bundle-options.mjs';

/**
 * A language server process for integration tests, started with `--stdio` in a temporary workspace
 * with the given files: by default the bundled server of the extension (built into the temporary
 * directory with the options of the extension build); `server: 'cli'` runs `devm lsp --stdio` of the
 * command line executable's bundle (what Eclipse and the JetBrains IDEs start), `command` any other
 * server command (e.g. the built executable).
 */
export interface LspServer {
    readonly dir: string;
    readonly connection: MessageConnection;
    readonly capabilities: Record<string, unknown>;
    /** The capabilities registered dynamically by the server (`client/registerCapability`). */
    readonly registrations: Array<{ method: string, registerOptions?: unknown }>;
    /** The exit code of the server process (after `stop`). */
    readonly exited: Promise<number | null>;
    /** The `file:` URI of a workspace file. */
    uriOf(relative: string): string;
    /** Opens a document (`textDocument/didOpen`). */
    open(relative: string, languageId: string, text: string, version?: number): void;
    /** Waits for diagnostics of a URI that satisfy the predicate. */
    diagnosticsFor(uri: string, predicate?: (d: LspDiagnostic[]) => boolean, timeoutMs?: number): Promise<LspDiagnostic[]>;
    stop(): Promise<void>;
}

export interface LspDiagnostic {
    severity?: number;
    message: string;
    range: { start: { line: number, character: number } };
}

export interface LspServerOptions {
    /** The server: the extension's bundle (default) or `devm lsp` of the command line executable's bundle. */
    server?: 'vscode' | 'cli';
    /** The command line of the server (instead of a bundle), e.g. `['dist/bin/macos-arm64/devm', 'lsp', '--stdio']`. */
    command?: string[];
    /** `initialize` parameters replacing the defaults (e.g. without `workspaceFolders`, as older clients). */
    initialize?: (defaults: Record<string, unknown>) => Record<string, unknown>;
}

/** The command line of the server (bundles are built into `dir/out`). */
async function serverCommand(dir: string, options: LspServerOptions): Promise<string[]> {
    if (options.command) {
        return options.command;
    }
    const outdir = path.join(dir, 'out');
    if (options.server === 'cli') {
        const cliOptions = cliBundleOptions({ outdir });
        await esbuild.build({ ...cliOptions, minify: false });
        // (the bundle is named after its entry point: `devm.cjs`)
        const name = Object.keys(cliOptions.entryPoints as Record<string, string>)[0];
        return [process.execPath, path.join(outdir, `${name}.cjs`), 'lsp', '--stdio'];
    }
    await esbuild.build({ ...bundleOptions('server', { outdir }), logLevel: 'warning', sourcemap: false });
    return [process.execPath, path.join(outdir, 'server.cjs'), '--stdio'];
}

/** Starts the server in a new temporary workspace containing `files` (path relative to the workspace -> text). */
export async function startLspServer(files: Record<string, string>, options: LspServerOptions = {}): Promise<LspServer> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devm-lsp-'));
    for (const [relative, text] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
        await fs.writeFile(path.join(dir, relative), text);
    }
    const [command, ...args] = await serverCommand(dir, options);
    const server: ChildProcess = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    const connection = createMessageConnection(new StreamMessageReader(server.stdout!), new StreamMessageWriter(server.stdin!));
    const diagnostics = new Map<string, LspDiagnostic[]>();
    const waiters: Array<() => void> = [];
    connection.onNotification('textDocument/publishDiagnostics', (params: { uri: string, diagnostics: LspDiagnostic[] }) => {
        diagnostics.set(params.uri, params.diagnostics);
        waiters.splice(0).forEach(resolve => resolve());
    });
    const registrations: Array<{ method: string, registerOptions?: unknown }> = [];
    connection.onRequest('client/registerCapability', (params: { registrations: Array<{ method: string, registerOptions?: unknown }> }) => {
        registrations.push(...params.registrations);
        return null;
    });
    const exited = new Promise<number | null>(resolve => server.on('exit', code => resolve(code)));
    connection.onRequest('workspace/configuration', (params: { items: unknown[] }) => params.items.map(() => null));
    connection.listen();
    const defaults: Record<string, unknown> = {
        processId: process.pid,
        rootUri: pathToFileURL(dir).toString(),
        workspaceFolders: [{ uri: pathToFileURL(dir).toString(), name: 'workspace' }],
        capabilities: {
            workspace: { workspaceFolders: true, configuration: true },
            textDocument: {
                publishDiagnostics: {}, hover: { contentFormat: ['markdown', 'plaintext'] }, synchronization: {},
                definition: { linkSupport: true }, declaration: { linkSupport: true }, typeDefinition: { linkSupport: true }
            }
        }
    };
    const result = await connection.sendRequest<{ capabilities: Record<string, unknown> }>('initialize', options.initialize?.(defaults) ?? defaults);
    await connection.sendNotification('initialized', {});
    const uriOf = (relative: string) => pathToFileURL(path.join(dir, relative)).toString();
    return {
        dir,
        connection,
        capabilities: result.capabilities,
        registrations,
        exited,
        uriOf,
        open(relative, languageId, text, version = 1) {
            void connection.sendNotification('textDocument/didOpen', { textDocument: { uri: uriOf(relative), languageId, version, text } });
        },
        async diagnosticsFor(uri, predicate = () => true, timeoutMs = 20000) {
            const start = Date.now();
            for (;;) {
                const current = diagnostics.get(uri);
                if (current && predicate(current)) {
                    return current;
                }
                if (Date.now() - start > timeoutMs) {
                    throw new Error(`no matching diagnostics for ${uri}: ${JSON.stringify(current)}`);
                }
                await new Promise<void>(resolve => {
                    waiters.push(resolve);
                    setTimeout(resolve, 200);
                });
            }
        },
        async stop() {
            try {
                await connection.sendRequest('shutdown');
                await connection.sendNotification('exit');
            } catch {
                // already gone
            }
            // the server exits on `exit` (killed if it does not within 5 s)
            const timeout = setTimeout(() => server.kill(), 5000);
            await exited;
            clearTimeout(timeout);
            connection.dispose();
            await fs.rm(dir, { recursive: true, force: true });
        }
    };
}

/** The LSP position of the `occurrence`-th match of `search` in `text`, plus `delta` characters. */
export function positionOf(text: string, search: string, delta = 0, occurrence = 0): { line: number, character: number } {
    let offset = -1;
    for (let i = 0; i <= occurrence; i++) {
        offset = text.indexOf(search, offset + 1);
        if (offset < 0) {
            throw new Error(`'${search}' not found (occurrence ${occurrence})`);
        }
    }
    const before = text.slice(0, offset + delta).split('\n');
    return { line: before.length - 1, character: before[before.length - 1].length };
}
