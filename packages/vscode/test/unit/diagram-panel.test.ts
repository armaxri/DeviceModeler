import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { DiagramPanel, type DiagramManager } from '../../src/extension/diagram-panel.js';
import type { FromWebview, ToWebview } from '../../src/common/protocol.js';
import { Uri } from '../mocks/vscode.js';

/*
 * The diagram panel and the layout related commands in the extension host (`vscode` is replaced by
 * test/mocks/vscode.ts, see vitest.config.ts). The manual layout consists of layout annotations in the
 * model, so the panel only sends the text; the .sct import writes the annotations, the SVG export applies
 * them and a layout file of earlier builds can be converted into annotations.
 */

const MODEL = 'statemachine Lamp {\n    [*] -> Off\n    state Off\n}\n';
const LAYOUT = JSON.stringify({ version: 1, mode: 'manual', nodes: { Off: { x: 10, y: 20 } }, edges: {} });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Harness {
    panel: DiagramPanel;
    posted: ToWebview[];
    receive(message: FromWebview): Promise<void>;
    document: { uri: Uri, version: number, text: string };
}

function createPanel(uri: Uri): Harness {
    const posted: ToWebview[] = [];
    let handler: (message: FromWebview) => Promise<void> = async () => undefined;
    const webviewPanel = {
        webview: {
            options: {},
            html: '',
            cspSource: 'vscode-resource:',
            asWebviewUri: (u: Uri) => u,
            postMessage: (message: ToWebview) => {
                posted.push(message);
                return Promise.resolve(true);
            },
            onDidReceiveMessage: (listener: (message: FromWebview) => Promise<void>) => {
                handler = listener as typeof handler;
            }
        },
        reveal: () => undefined,
        viewColumn: 2
    };
    const document = {
        uri,
        version: 1,
        text: MODEL,
        isClosed: false,
        getText() {
            return this.text;
        }
    };
    const manager = {
        context: { extensionUri: Uri.file('/extension') },
        settings: () => ({ direction: 'DOWN', routing: 'SPLINES', priorities: true, theme: 'classic', showProperties: true }),
        highlight: {}
    } as unknown as DiagramManager;
    const panel = new DiagramPanel(manager, webviewPanel as unknown as vscode.WebviewPanel, document as unknown as vscode.TextDocument);
    return {
        panel,
        posted,
        document,
        receive: async message => {
            // the panel wraps its handler (errors are shown as messages)
            await handler(message);
            await sleep(20);
        }
    };
}

describe('DiagramPanel and layout commands', () => {
    let dir: string;
    let modelPath: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hsm-layout-'));
        modelPath = path.join(dir, 'lamp.hsm');
        await fs.writeFile(modelPath, MODEL);
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('sends the settings and the text when the webview is ready, changes debounced', async () => {
        const h = createPanel(Uri.file(modelPath));
        await h.receive({ type: 'ready' });
        // (the text is posted once the imported files are collected)
        await vi.waitFor(() => expect(h.posted.map(m => m.type)).toEqual(['settings', 'text']));
        expect(h.posted[1]).toMatchObject({ type: 'text', text: MODEL, version: 1, fileName: 'lamp.hsm' });
        h.document.text = MODEL.replace('Off', 'Dark');
        h.document.version = 2;
        h.panel.documentChanged(h.document as unknown as vscode.TextDocument);
        expect(h.posted).toHaveLength(2);
        await vi.waitFor(() => expect(h.posted[h.posted.length - 1]).toMatchObject({ type: 'text', version: 2 }));
        h.panel.disposeResources();
    });

    it('shows the state of a debug session (also after a reload of the webview) and refuses edits meanwhile', async () => {
        const h = createPanel(Uri.file(modelPath));
        const state = { title: 'Paused on step', activeOffsets: [MODEL.indexOf('state Off')], transitionOffsets: [], instances: [], activeStates: ['Off'], running: true };
        // not ready yet: sent with the ready message
        h.panel.setDebugState(state);
        expect(h.posted).toHaveLength(0);
        await h.receive({ type: 'ready' });
        await vi.waitFor(() => expect(h.posted.map(m => m.type)).toEqual(['settings', 'debugState', 'text']));
        expect(h.posted[1]).toEqual({ type: 'debugState', state });
        await h.receive({ type: 'edit', requestId: 1, version: 1, edits: [{ offset: 0, length: 0, text: '// x\n' }] });
        expect(h.posted.at(-1)).toMatchObject({ type: 'editResult', requestId: 1, ok: false, message: expect.stringContaining('debugged') });
        // the session ended: back to editing
        h.panel.setDebugState(undefined);
        expect(h.posted.at(-1)).toEqual({ type: 'debugState', state: undefined });
        expect(h.panel.debugState).toBeUndefined();
        h.panel.disposeResources();
    });

    it('HSM: Import itemis CREATE model writes the itemis arrangement as layout annotations, SVG export applies them', async () => {
        const sct = path.join(dir, 'Choice.sct');
        await fs.copyFile(path.resolve(__dirname, '../../../language/test/importer/fixtures/Choice.sct'), sct);
        const { importSctFile, renderModelSvg } = await import('../../src/extension/commands.js');
        const output = { warn: () => undefined, info: () => undefined, error: () => undefined, show: () => undefined };
        const target = await importSctFile(Uri.file(sct) as unknown as vscode.Uri, output as unknown as vscode.LogOutputChannel);
        expect(target?.path).toBe(path.join(dir, 'Choice.hsm'));
        // no sidecar file any more: the arrangement is in the model
        await expect(fs.stat(path.join(dir, 'Choice.hsm.layout'))).rejects.toThrow();
        const text = await fs.readFile(path.join(dir, 'Choice.hsm'), 'utf-8');
        expect(text).toMatch(/@at\(-?\d+, -?\d+\)/);
        const svg = async (model: string) => renderModelSvg({ uri: Uri.file(path.join(dir, 'Choice.hsm')), getText: () => model } as unknown as vscode.TextDocument);
        const manual = await svg(text);
        const auto = await svg(text.split('\n').filter(line => !/^\s*@(at|size|regions|via|label|initial|final|definitions)\(/.test(line)).join('\n'));
        expect(manual).toContain('<svg');
        expect(manual).not.toBe(auto);
    });

    it('HSM: Convert Layout File to Annotations writes the layout file into the model and keeps the file', async () => {
        await fs.writeFile(modelPath + '.layout', LAYOUT);
        const { convertLayoutFile } = await import('../../src/extension/commands.js');
        const layoutFile = await convertLayoutFile(Uri.file(modelPath) as unknown as vscode.Uri);
        expect(layoutFile?.path).toBe(modelPath + '.layout');
        const text = await fs.readFile(modelPath, 'utf-8');
        expect(text).toContain('@at(10, 20)');
        expect(text.replace(/^\s*@at\(10, 20\)\n/m, '')).toBe(MODEL);
        expect(await fs.readFile(modelPath + '.layout', 'utf-8')).toBe(LAYOUT);
        // without a layout file: nothing happens
        await fs.rm(modelPath + '.layout');
        expect(await convertLayoutFile(Uri.file(modelPath) as unknown as vscode.Uri)).toBeUndefined();
    });
});
