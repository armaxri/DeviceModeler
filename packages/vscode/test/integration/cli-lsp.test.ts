import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { positionOf, startLspServer, type LspServer } from './lsp-harness.js';

/*
 * `hsm lsp --stdio` of the command line executable (its esbuild bundle, run with Node.js), the language
 * server Eclipse (LSP4E) and the JetBrains IDEs (LSP4IJ) start: a generic LSP client without VS Code
 * specifics (no settings, file watchers registered dynamically by the server, headers found through
 * the include paths of hsm.gen.json, `file:` URIs), and an old client sending only `rootUri`.
 */

const TYPES = `#pragma once
namespace io {
/** Direction of the motor. */
enum class Direction { Up, Down };
constexpr int kSteps = 4;
}
`;

const MOTOR = `statemachine Motor {
    interface:
        in event go
    [*] -> Idle
    state Idle
    Idle -> Idle : go
}
`;

const GATE = `/** The gate. */
statemachine Gate {
    import "types.h"
    import "motor.hsm"
    interface:
        var dir : io::Direction = io::Direction::Up
        var steps : integer = io::kSteps
        var motor : Motor
    [*] -> Closed
    state Closed
    state Open
    Closed -> Open
}
`;

const FILES: Record<string, string> = {
    'include dir/types.h': TYPES,
    'models/motor.hsm': MOTOR,
    'models/gate.hsm': GATE,
    'hsm.gen.json': JSON.stringify({ models: ['models/*.hsm'], cpp: {}, headers: { includePaths: ['include dir'] } })
};

interface Link {
    targetUri: string;
    targetSelectionRange: { start: { line: number, character: number } };
}

describe('hsm lsp --stdio (generic LSP client)', () => {
    let server: LspServer;

    beforeAll(async () => {
        server = await startLspServer(FILES, {
            server: 'cli',
            // like LSP4E / LSP4IJ: dynamic registration of file watchers, no `hsm` settings
            initialize: defaults => ({
                ...defaults,
                capabilities: {
                    ...defaults.capabilities as object,
                    workspace: { workspaceFolders: true, configuration: false, didChangeWatchedFiles: { dynamicRegistration: true } }
                }
            })
        });
    }, 120000);

    afterAll(async () => {
        await server?.stop();
        expect(await server.exited).toBe(0);
    });

    it('announces the language features', () => {
        for (const capability of ['completionProvider', 'hoverProvider', 'definitionProvider', 'declarationProvider', 'typeDefinitionProvider',
            'documentLinkProvider', 'documentFormattingProvider', 'documentSymbolProvider', 'renameProvider', 'referencesProvider', 'semanticTokensProvider']) {
            expect(server.capabilities[capability], capability).toBeTruthy();
        }
    });

    it('validates the opened model with the headers of the include paths', async () => {
        server.open('models/gate.hsm', 'hsm', GATE);
        const diagnostics = await server.diagnosticsFor(server.uriOf('models/gate.hsm'));
        expect(diagnostics.filter(d => d.severity === 1)).toEqual([]);
        // Langium registers a watcher for all files (headers, hsm.gen.json, models changed outside the editor)
        expect(server.registrations.map(r => r.method)).toContain('workspace/didChangeWatchedFiles');
    });

    it('shows the documentation of the header in the hover', async () => {
        const hover = await server.connection.sendRequest<{ contents: { value: string } } | null>('textDocument/hover', {
            textDocument: { uri: server.uriOf('models/gate.hsm') }, position: positionOf(GATE, 'io::Direction =', 5)
        });
        expect(hover?.contents.value).toContain('Direction of the motor.');
    });

    it('leads into the header and to the imported model', async () => {
        const definition = (search: string, delta: number) => server.connection.sendRequest<Link[] | null>('textDocument/definition', {
            textDocument: { uri: server.uriOf('models/gate.hsm') }, position: positionOf(GATE, search, delta)
        });
        const header = await definition('io::kSteps', 5);
        expect(header?.map(l => [l.targetUri, l.targetSelectionRange.start.line])).toEqual([[server.uriOf('include dir/types.h'), 4]]);
        const machine = await definition(': Motor', 3);
        expect(machine?.map(l => l.targetUri)).toEqual([server.uriOf('models/motor.hsm')]);
        const links = await server.connection.sendRequest<Array<{ target: string }>>('textDocument/documentLink', { textDocument: { uri: server.uriOf('models/gate.hsm') } });
        expect(links.map(l => l.target).sort()).toEqual([server.uriOf('include dir/types.h'), server.uriOf('models/motor.hsm')].sort());
    });

    it('formats, lists the symbols and renames', async () => {
        const uri = server.uriOf('models/gate.hsm');
        const symbols = await server.connection.sendRequest<Array<{ name: string }>>('textDocument/documentSymbol', { textDocument: { uri } });
        expect(symbols.map(s => s.name)).toContain('Gate');
        const edits = await server.connection.sendRequest<unknown[] | null>('textDocument/formatting', {
            textDocument: { uri }, options: { tabSize: 4, insertSpaces: true }
        });
        expect(Array.isArray(edits)).toBe(true);
        const rename = await server.connection.sendRequest<{ changes?: Record<string, unknown[]> } | null>('textDocument/rename', {
            textDocument: { uri }, position: positionOf(GATE, 'state Open', 6), newName: 'Opened'
        });
        expect(rename?.changes?.[uri]?.length).toBe(2);
    });

    it('re-reads a header changed on disk (workspace/didChangeWatchedFiles)', async () => {
        const uri = server.uriOf('models/gate.hsm');
        await fs.writeFile(path.join(server.dir, 'include dir/types.h'), TYPES.replace('constexpr int kSteps = 4;', ''));
        await server.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: server.uriOf('include dir/types.h'), type: 2 }] });
        const diagnostics = await server.diagnosticsFor(uri, list => list.some(d => d.severity === 1));
        expect(diagnostics.filter(d => d.severity === 1).map(d => d.message).join('\n')).toContain('kSteps');
    });
});

describe('hsm lsp --stdio (client sending only rootUri)', () => {
    let server: LspServer;

    beforeAll(async () => {
        server = await startLspServer(FILES, {
            server: 'cli',
            initialize: ({ workspaceFolders: _folders, ...defaults }) => ({
                ...defaults, capabilities: { textDocument: { synchronization: {}, publishDiagnostics: {} } }
            })
        });
    }, 120000);

    afterAll(async () => server?.stop());

    it('indexes the root as workspace folder (symbols of models that are not open)', async () => {
        server.open('models/gate.hsm', 'hsm', GATE);
        const diagnostics = await server.diagnosticsFor(server.uriOf('models/gate.hsm'));
        expect(diagnostics.filter(d => d.severity === 1)).toEqual([]);
        const symbols = await server.connection.sendRequest<Array<{ name: string }>>('workspace/symbol', { query: 'Motor' });
        expect(symbols.map(s => s.name)).toContain('Motor');
    });
});
