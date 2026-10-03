import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { DiagramPanel, type DiagramManager } from '../../src/extension/diagram-panel.js';
import type { FromWebview, NavigationLocation, ToWebview } from '../../src/common/protocol.js';
import { textHash } from '../../src/common/text-hash.js';
import { Uri } from '../mocks/vscode.js';

/*
 * The diagram panel and the layout related commands in the extension host (`vscode` is replaced by
 * test/mocks/vscode.ts, see vitest.config.ts). The manual layout consists of layout annotations in the
 * model, so the panel only sends the text; the .sct import writes the annotations, the SVG export applies
 * them and a layout file of earlier builds can be converted into annotations. Structure files: the
 * workspace files sent to the webview, edits of several files, navigation and the SVG export.
 */

const MODEL = 'statemachine Lamp {\n    [*] -> Off\n    state Off\n}\n';
const LAYOUT = JSON.stringify({ version: 1, mode: 'manual', nodes: { Off: { x: 10, y: 20 } }, edges: {} });

const PARTS = 'component Pump {\n    provides async cmd : event start\n}\n';
const SYSTEM = 'import "parts.dmf"\nsystem Plant {\n    pump : Pump\n}\n';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Harness {
    panel: DiagramPanel;
    posted: ToWebview[];
    receive(message: FromWebview): Promise<void>;
    document: { uri: Uri, version: number, text: string };
    /** The calls of `DiagramManager.openLocation`. */
    navigations: Array<{ location: NavigationLocation, from?: NavigationLocation }>;
}

function createPanel(uri: Uri, text = MODEL, workspace: Record<string, string> = {}): Harness {
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
        text,
        isClosed: false,
        getText() {
            return this.text;
        },
        positionAt: (offset: number) => offset
    };
    const navigations: Harness['navigations'] = [];
    const manager = {
        context: { extensionUri: Uri.file('/extension') },
        settings: () => ({ direction: 'DOWN', routing: 'SPLINES', priorities: true, theme: 'classic', showProperties: true }),
        highlight: {},
        history: { state: {} },
        workspaceFiles: { texts: async () => ({ ...workspace }) },
        openLocation: async (location: NavigationLocation, _source: unknown, from?: NavigationLocation) => {
            navigations.push({ location, from });
            return !location.uri.endsWith('missing.dmf');
        }
    } as unknown as DiagramManager;
    const panel = new DiagramPanel(manager, webviewPanel as unknown as vscode.WebviewPanel, document as unknown as vscode.TextDocument);
    return {
        panel,
        posted,
        document,
        navigations,
        receive: async message => {
            // the panel wraps its handler (errors are shown as messages)
            await handler(message);
            await sleep(20);
        }
    };
}

describe('DiagramPanel and its commands', () => {
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
        await vi.waitFor(() => expect(h.posted.map(m => m.type)).toEqual(['settings', 'history', 'text']));
        expect(h.posted[2]).toMatchObject({ type: 'text', text: MODEL, version: 1, fileName: 'lamp.hsm' });
        h.document.text = MODEL.replace('Off', 'Dark');
        h.document.version = 2;
        h.panel.documentChanged(h.document as unknown as vscode.TextDocument);
        expect(h.posted).toHaveLength(3);
        await vi.waitFor(() => expect(h.posted[h.posted.length - 1]).toMatchObject({ type: 'text', version: 2 }));
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

    it('sends the state machines and structure files of the workspace with the text (not the document itself)', async () => {
        const uri = Uri.file(path.join(dir, 'system.dmf'));
        const other = Uri.file(path.join(dir, 'parts.dmf')).toString();
        const h = createPanel(uri, SYSTEM, { [other]: PARTS, [uri.toString()]: 'stale', [Uri.file(modelPath).toString()]: MODEL });
        await h.receive({ type: 'ready' });
        await vi.waitFor(() => expect(h.posted.some(m => m.type === 'text')).toBe(true));
        const text = h.posted.find(m => m.type === 'text') as Extract<ToWebview, { type: 'text' }>;
        expect(text.text).toBe(SYSTEM);
        expect(Object.keys(text.files!).sort()).toEqual([Uri.file(modelPath).toString(), other].sort());
        h.panel.disposeResources();
    });

    it('applies the edits of several files as one workspace edit if the files are unchanged', async () => {
        const systemPath = path.join(dir, 'system.dmf');
        const partsPath = path.join(dir, 'parts.dmf');
        await fs.writeFile(systemPath, SYSTEM);
        await fs.writeFile(partsPath, PARTS);
        const h = createPanel(Uri.file(systemPath), SYSTEM);
        const parts = Uri.file(partsPath).toString();
        const own = Uri.file(systemPath).toString();
        const rename = (offset: number) => [{ offset, length: 'Pump'.length, text: 'Valve' }];
        await h.receive({
            type: 'workspaceEdit', requestId: 1, version: 1,
            edits: { [own]: rename(SYSTEM.indexOf('Pump')), [parts]: rename(PARTS.indexOf('Pump')) },
            hashes: { [own]: textHash(SYSTEM), [parts]: textHash(PARTS) }
        });
        expect(h.posted.pop()).toMatchObject({ type: 'editResult', requestId: 1, ok: true });
        expect(await fs.readFile(partsPath, 'utf-8')).toBe(PARTS.replace('Pump', 'Valve'));
        expect(await fs.readFile(systemPath, 'utf-8')).toBe(SYSTEM.replace('Pump', 'Valve'));
        // computed on an outdated text of the other file: refused, nothing is changed
        await h.receive({
            type: 'workspaceEdit', requestId: 2, version: 1,
            edits: { [parts]: rename(PARTS.indexOf('Pump')) }, hashes: { [parts]: textHash(PARTS) }
        });
        expect(h.posted.pop()).toMatchObject({ type: 'editResult', requestId: 2, ok: false, message: expect.stringContaining('parts.dmf was changed') });
        expect(await fs.readFile(partsPath, 'utf-8')).toBe(PARTS.replace('Pump', 'Valve'));
        // based on an outdated version of the document
        await h.receive({ type: 'workspaceEdit', requestId: 3, version: 0, edits: { [own]: rename(0) }, hashes: {} });
        expect(h.posted.pop()).toMatchObject({ type: 'editResult', requestId: 3, ok: false });
    });

    it('passes navigations to the manager (history) and answers them', async () => {
        const h = createPanel(Uri.file(path.join(dir, 'system.dmf')), SYSTEM);
        const from = { uri: 'file:///w/system.dmf', element: 'Plant' };
        await h.receive({ type: 'openLocation', requestId: 7, location: { uri: 'file:///w/parts.dmf', element: 'Pump', id: 'Pump' }, from });
        expect(h.navigations).toEqual([{ location: { uri: 'file:///w/parts.dmf', element: 'Pump', id: 'Pump' }, from }]);
        expect(h.posted.pop()).toEqual({ type: 'locationResult', requestId: 7, ok: true });
        await h.receive({ type: 'openLocation', requestId: 8, location: { uri: 'file:///w/missing.dmf' }, from });
        expect(h.posted.pop()).toEqual({ type: 'locationResult', requestId: 8, ok: false });
    });

    it('HSM: Export Diagram renders the shown structure of a structure file', async () => {
        await fs.writeFile(path.join(dir, 'parts.dmf'), PARTS);
        const { renderStructureSvg } = await import('../../src/extension/commands.js');
        const document = { uri: Uri.file(path.join(dir, 'system.dmf')), getText: () => SYSTEM } as unknown as vscode.TextDocument;
        const svg = await renderStructureSvg(document);
        expect(svg).toContain('<svg');
        expect(svg).toContain('Plant');
        expect(await renderStructureSvg(document, 'Plant')).toBe(svg);
        const parts = { uri: Uri.file(path.join(dir, 'parts.dmf')), getText: () => PARTS } as unknown as vscode.TextDocument;
        expect(await renderStructureSvg(parts, 'Pump')).toContain('Pump');
        await expect(renderStructureSvg({ uri: document.uri, getText: () => 'system {' } as unknown as vscode.TextDocument)).rejects.toThrow(/syntax errors/);
    });
});
