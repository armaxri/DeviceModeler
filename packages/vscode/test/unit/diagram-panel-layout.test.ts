import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { DiagramPanel, type DiagramManager } from '../../src/extension/diagram-panel.js';
import type { FromWebview, ToWebview } from '../../src/common/protocol.js';
import { Uri, TextDocumentChangeReason, watchers } from '../mocks/vscode.js';

/*
 * The manual layout file handling of a diagram panel in the extension host (`vscode` is replaced by
 * test/mocks/vscode.ts, see vitest.config.ts): the layout file is read before the first text is sent,
 * written when the webview reports a change, deleted on reset, external changes are forwarded.
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

describe('DiagramPanel: manual layout file', () => {
    let dir: string;
    let modelPath: string;
    let layoutPath: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hsm-layout-'));
        modelPath = path.join(dir, 'lamp.hsm');
        layoutPath = modelPath + '.layout';
        await fs.writeFile(modelPath, MODEL);
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    const exists = (file: string) => fs.stat(file).then(() => true, () => false);

    it('sends the layout file before the first text', async () => {
        await fs.writeFile(layoutPath, LAYOUT);
        const h = createPanel(Uri.file(modelPath));
        await h.receive({ type: 'ready' });
        expect(h.posted.map(m => m.type)).toEqual(['settings', 'layout', 'text']);
        expect(h.posted[1]).toEqual({ type: 'layout', content: LAYOUT });
        h.panel.disposeResources();
    });

    it('sends "no layout" if there is no file, and does not create one for the automatic mode', async () => {
        const h = createPanel(Uri.file(modelPath));
        await h.receive({ type: 'ready' });
        expect(h.posted[1]).toEqual({ type: 'layout', content: undefined });
        await h.receive({ type: 'layout', content: LAYOUT.replace('manual', 'auto'), mode: 'auto' });
        await h.panel.flushLayout();
        expect(await exists(layoutPath)).toBe(false);
        h.panel.disposeResources();
    });

    it('writes layout changes of the webview (debounced) and deletes the file on reset', async () => {
        const h = createPanel(Uri.file(modelPath));
        await h.receive({ type: 'ready' });
        await h.receive({ type: 'layout', content: LAYOUT, mode: 'manual' });
        expect(await exists(layoutPath)).toBe(false);
        await sleep(400);
        expect(await fs.readFile(layoutPath, 'utf-8')).toBe(LAYOUT);
        await h.receive({ type: 'layout' });
        await h.panel.flushLayout();
        expect(await exists(layoutPath)).toBe(false);
        h.panel.disposeResources();
    });

    it('forwards external changes of the file, but not its own writes', async () => {
        const h = createPanel(Uri.file(modelPath));
        await h.receive({ type: 'ready' });
        const watcher = watchers[watchers.length - 1];
        expect(watcher.pattern.pattern).toBe('lamp.hsm.layout');
        await h.receive({ type: 'layout', content: LAYOUT, mode: 'manual' });
        await h.panel.flushLayout();
        const count = h.posted.length;
        watcher.fire();
        await sleep(50);
        expect(h.posted.length).toBe(count);
        const changed = LAYOUT.replace('"x":10', '"x":99');
        await fs.writeFile(layoutPath, changed);
        watcher.fire();
        await sleep(50);
        expect(h.posted[h.posted.length - 1]).toEqual({ type: 'layout', content: changed });
        await fs.rm(layoutPath);
        watcher.fire();
        await sleep(50);
        expect(h.posted[h.posted.length - 1]).toEqual({ type: 'layout', content: undefined });
        h.panel.disposeResources();
        expect(watcher.disposed).toBe(true);
    });

    it('sends undo / redo of the text immediately and marks them', async () => {
        const h = createPanel(Uri.file(modelPath));
        await h.receive({ type: 'ready' });
        h.document.text = MODEL.replace('Off', 'Dark');
        h.document.version = 2;
        h.panel.documentChanged(h.document as unknown as vscode.TextDocument, TextDocumentChangeReason.Undo as unknown as vscode.TextDocumentChangeReason);
        expect(h.posted[h.posted.length - 1]).toMatchObject({ type: 'text', change: 'undo', version: 2 });
        // typing is debounced and marked as edit
        h.document.text = MODEL;
        h.document.version = 3;
        h.panel.documentChanged(h.document as unknown as vscode.TextDocument);
        await sleep(200);
        expect(h.posted[h.posted.length - 1]).toMatchObject({ type: 'text', change: 'edit', version: 3 });
        h.panel.disposeResources();
    });

    it('keeps the layout of untitled documents in the webview only', async () => {
        const h = createPanel(Uri.parse('untitled:/Untitled-1'));
        const before = watchers.length;
        await h.receive({ type: 'ready' });
        expect(h.posted[1]).toEqual({ type: 'layout', content: undefined });
        await h.receive({ type: 'layout', content: LAYOUT, mode: 'manual' });
        await h.panel.flushLayout();
        expect(watchers.length).toBe(before);
        h.panel.disposeResources();
    });
});
