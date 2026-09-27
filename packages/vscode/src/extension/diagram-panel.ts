import * as vscode from 'vscode';
import * as path from 'node:path';
import type { FromWebview, OffsetEdit, TextRange, ToWebview, WebviewSettings } from '../common/protocol.js';
import { canApplyEdit, toRangeEdits } from './logic/edits.js';
import { effectiveTheme, webviewHtml } from './logic/webview.js';

export const DIAGRAM_VIEW_TYPE = 'hsm.diagram';

/** How long (ms) text changes are collected before the text is sent to the webview. */
const TEXT_DEBOUNCE_MS = 120;
const CURSOR_DEBOUNCE_MS = 200;

function isDarkColorTheme(kind: vscode.ColorThemeKind): boolean {
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}

function readSettings(): WebviewSettings {
    const config = vscode.workspace.getConfiguration('hsm.diagram');
    return {
        direction: config.get<string>('direction') === 'RIGHT' ? 'RIGHT' : 'DOWN',
        routing: (['SPLINES', 'ORTHOGONAL', 'POLYLINE'] as const).find(r => r === config.get<string>('edgeRouting')) ?? 'SPLINES',
        priorities: config.get<boolean>('priorities', true),
        showProperties: config.get<boolean>('showProperties', true),
        theme: effectiveTheme(config.get<string>('theme', 'auto'), config.get<string>('lightTheme', 'classic'), isDarkColorTheme(vscode.window.activeColorTheme.kind))
    };
}

/** Manages the diagram panels: one per `.hsm` document. */
export class DiagramManager implements vscode.Disposable {

    private readonly panels = new Map<string, DiagramPanel>();
    private readonly disposables: vscode.Disposable[] = [];
    /** Documents whose diagram was closed by the user (not opened again automatically). */
    private readonly closedByUser = new Set<string>();
    private lastActive?: DiagramPanel;
    readonly highlight = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        borderRadius: '2px'
    });

    constructor(readonly context: vscode.ExtensionContext) {
        this.disposables.push(
            this.highlight,
            vscode.window.registerWebviewPanelSerializer(DIAGRAM_VIEW_TYPE, {
                deserializeWebviewPanel: async (panel, state: unknown) => {
                    const uri = (state as { uri?: string } | undefined)?.uri;
                    if (!uri) {
                        panel.dispose();
                        return;
                    }
                    try {
                        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
                        this.register(new DiagramPanel(this, panel, document));
                    } catch {
                        panel.dispose();
                    }
                }
            }),
            vscode.workspace.onDidChangeTextDocument(event => this.panels.get(event.document.uri.toString())?.documentChanged(event.document)),
            vscode.window.onDidChangeTextEditorSelection(event => {
                const kind = event.kind;
                if (kind === vscode.TextEditorSelectionChangeKind.Keyboard || kind === vscode.TextEditorSelectionChangeKind.Mouse) {
                    const panel = this.panels.get(event.textEditor.document.uri.toString());
                    panel?.cursorMoved(event.textEditor.document.offsetAt(event.selections[0].active));
                }
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('hsm.diagram')) {
                    this.broadcastSettings();
                }
            }),
            vscode.window.onDidChangeActiveColorTheme(() => this.broadcastSettings()),
            vscode.window.onDidChangeActiveTextEditor(editor => this.autoOpen(editor)),
            vscode.workspace.onDidRenameFiles(event => {
                for (const { oldUri, newUri } of event.files) {
                    const panel = this.panels.get(oldUri.toString());
                    if (panel) {
                        this.panels.delete(oldUri.toString());
                        vscode.workspace.openTextDocument(newUri).then(document => {
                            panel.setDocument(document);
                            this.panels.set(newUri.toString(), panel);
                        });
                    }
                }
            })
        );
        this.autoOpen(vscode.window.activeTextEditor);
    }

    dispose(): void {
        for (const panel of [...this.panels.values()]) {
            panel.dispose();
        }
        this.disposables.forEach(d => d.dispose());
    }

    /** The diagram of the document, if open. */
    get(uri: vscode.Uri): DiagramPanel | undefined {
        return this.panels.get(uri.toString());
    }

    /** The diagram panel that is active or was active last. */
    get active(): DiagramPanel | undefined {
        return this.lastActive && this.panels.has(this.lastActive.key) ? this.lastActive : undefined;
    }

    /** Opens (or reveals) the diagram of the document beside the text editor. */
    async open(uri: vscode.Uri, preserveFocus = false): Promise<DiagramPanel> {
        const existing = this.panels.get(uri.toString());
        if (existing) {
            existing.panel.reveal(undefined, preserveFocus);
            return existing;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const panel = vscode.window.createWebviewPanel(DIAGRAM_VIEW_TYPE, DiagramPanel.title(document), { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        });
        this.closedByUser.delete(uri.toString());
        return this.register(new DiagramPanel(this, panel, document));
    }

    private register(panel: DiagramPanel): DiagramPanel {
        this.panels.set(panel.key, panel);
        this.lastActive = panel;
        panel.panel.onDidChangeViewState(event => {
            if (event.webviewPanel.active) {
                this.lastActive = panel;
            }
        });
        panel.panel.onDidDispose(() => {
            if (this.panels.get(panel.key) === panel) {
                this.panels.delete(panel.key);
                this.closedByUser.add(panel.key);
            }
            panel.disposeResources();
        });
        return panel;
    }

    private autoOpen(editor: vscode.TextEditor | undefined): void {
        if (!editor || editor.document.languageId !== 'hsm' || !vscode.workspace.getConfiguration('hsm.diagram').get<boolean>('autoOpen', false)) {
            return;
        }
        const key = editor.document.uri.toString();
        if (!this.panels.has(key) && !this.closedByUser.has(key)) {
            this.open(editor.document.uri, true);
        }
    }

    private broadcastSettings(): void {
        const settings = readSettings();
        for (const panel of this.panels.values()) {
            panel.post({ type: 'settings', settings });
        }
    }

    settings(): WebviewSettings {
        return readSettings();
    }
}

/** The diagram of one `.hsm` document in a webview panel. */
export class DiagramPanel {

    private textTimer?: ReturnType<typeof setTimeout>;
    private cursorTimer?: ReturnType<typeof setTimeout>;
    private applyingEdit = false;
    private ready = false;
    private svgRequests = new Map<number, (result: { svg?: string, error?: string }) => void>();
    private svgRequestId = 0;
    private readonly readyWaiters: Array<() => void> = [];

    constructor(private readonly manager: DiagramManager, readonly panel: vscode.WebviewPanel, private document: vscode.TextDocument) {
        panel.iconPath = vscode.Uri.joinPath(manager.context.extensionUri, 'media', 'diagram.svg');
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(manager.context.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(manager.context.extensionUri, 'media')]
        };
        panel.webview.html = this.html();
        panel.webview.onDidReceiveMessage((message: FromWebview) => this.receive(message).catch(error => {
            vscode.window.showErrorMessage(`HSM diagram: ${error instanceof Error ? error.message : String(error)}`);
        }));
    }

    static title(document: vscode.TextDocument): string {
        return `Diagram: ${path.basename(document.uri.path)}`;
    }

    get key(): string {
        return this.document.uri.toString();
    }

    get uri(): vscode.Uri {
        return this.document.uri;
    }

    setDocument(document: vscode.TextDocument): void {
        this.document = document;
        this.panel.title = DiagramPanel.title(document);
        this.sendText();
    }

    dispose(): void {
        this.panel.dispose();
    }

    disposeResources(): void {
        clearTimeout(this.textTimer);
        clearTimeout(this.cursorTimer);
        for (const editor of this.textEditors()) {
            editor.setDecorations(this.manager.highlight, []);
        }
    }

    post(message: ToWebview): void {
        this.panel.webview.postMessage(message);
    }

    /** Resolves once the webview has been loaded. */
    whenReady(): Promise<void> {
        return this.ready ? Promise.resolve() : new Promise(resolve => this.readyWaiters.push(resolve));
    }

    /** The rendered diagram as SVG document. */
    async requestSvg(): Promise<string> {
        await this.whenReady();
        const requestId = ++this.svgRequestId;
        const result = await new Promise<{ svg?: string, error?: string }>((resolve, reject) => {
            this.svgRequests.set(requestId, resolve);
            setTimeout(() => {
                if (this.svgRequests.delete(requestId)) {
                    reject(new Error('The diagram did not answer.'));
                }
            }, 10000);
            this.post({ type: 'requestSvg', requestId });
        });
        if (!result.svg) {
            throw new Error(result.error ?? 'The diagram has not been rendered yet.');
        }
        return result.svg;
    }

    documentChanged(document: vscode.TextDocument): void {
        this.document = document;
        if (this.applyingEdit) {
            // the result of the edit is sent with the answer to the edit request
            return;
        }
        clearTimeout(this.textTimer);
        this.textTimer = setTimeout(() => this.sendText(), TEXT_DEBOUNCE_MS);
    }

    cursorMoved(offset: number): void {
        clearTimeout(this.cursorTimer);
        this.cursorTimer = setTimeout(() => this.post({ type: 'cursor', offset }), CURSOR_DEBOUNCE_MS);
    }

    private sendText(): void {
        clearTimeout(this.textTimer);
        this.post({
            type: 'text',
            text: this.document.getText(),
            version: this.document.version,
            fileName: path.basename(this.document.uri.path),
            uri: this.document.uri.toString()
        });
    }

    private async currentDocument(): Promise<vscode.TextDocument> {
        if (this.document.isClosed) {
            this.document = await vscode.workspace.openTextDocument(this.document.uri);
        }
        return this.document;
    }

    private async receive(message: FromWebview): Promise<void> {
        switch (message.type) {
            case 'ready':
                this.ready = true;
                this.post({ type: 'settings', settings: this.manager.settings() });
                this.sendText();
                this.readyWaiters.splice(0).forEach(resolve => resolve());
                break;
            case 'edit':
                await this.applyEdit(message.requestId, message.version, message.edits);
                break;
            case 'highlight':
                this.highlight(message.range);
                break;
            case 'selectText':
                await this.selectText(message.range);
                break;
            case 'editAt': {
                const document = await this.currentDocument();
                const position = document.positionAt(message.offset);
                await vscode.window.showTextDocument(document, { viewColumn: this.textColumn(), preserveFocus: false, selection: new vscode.Range(position, position) });
                break;
            }
            case 'undo':
            case 'redo':
                await this.undoRedo(message.type);
                break;
            case 'status':
                vscode.window.setStatusBarMessage(`$(warning) HSM: ${message.message}`, 6000);
                break;
            case 'svg': {
                const resolve = this.svgRequests.get(message.requestId);
                this.svgRequests.delete(message.requestId);
                resolve?.({ svg: message.svg, error: message.error });
                break;
            }
            case 'updateSetting': {
                const key = message.key === 'routing' ? 'edgeRouting' : message.key;
                await vscode.workspace.getConfiguration('hsm.diagram').update(key, message.value, vscode.ConfigurationTarget.Global);
                break;
            }
            case 'command':
                await vscode.commands.executeCommand(`hsm.${message.command}`, this.document.uri);
                break;
            case 'simulation':
                break;
        }
    }

    /** Applies the text edits of a diagram operation to the document (undoable, marks the document dirty). */
    private async applyEdit(requestId: number, version: number, edits: OffsetEdit[]): Promise<void> {
        const document = await this.currentDocument();
        const answer = (ok: boolean, message?: string) => this.post({
            type: 'editResult', requestId, ok, text: document.getText(), version: document.version, message
        });
        if (!canApplyEdit(version, document.version)) {
            answer(false, 'The document was changed in the meantime – please try again.');
            return;
        }
        let workspaceEdit: vscode.WorkspaceEdit;
        try {
            workspaceEdit = new vscode.WorkspaceEdit();
            const text = document.getText();
            for (const edit of toRangeEdits(edits, text.length, offset => document.positionAt(offset))) {
                workspaceEdit.replace(document.uri, new vscode.Range(edit.start, edit.end), edit.text);
            }
        } catch (error) {
            answer(false, error instanceof Error ? error.message : String(error));
            return;
        }
        this.applyingEdit = true;
        let ok = false;
        try {
            ok = await vscode.workspace.applyEdit(workspaceEdit);
        } finally {
            this.applyingEdit = false;
        }
        clearTimeout(this.textTimer);
        answer(ok, ok ? undefined : 'The edit could not be applied to the document.');
    }

    private textEditors(): vscode.TextEditor[] {
        return vscode.window.visibleTextEditors.filter(editor => editor.document.uri.toString() === this.key);
    }

    /** The column for the text editor: not the one of the diagram. */
    private textColumn(): vscode.ViewColumn {
        const visible = this.textEditors()[0];
        if (visible?.viewColumn) {
            return visible.viewColumn;
        }
        return this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
    }

    private highlight(range: TextRange | undefined): void {
        for (const editor of this.textEditors()) {
            if (!range) {
                editor.setDecorations(this.manager.highlight, []);
                continue;
            }
            const vsRange = new vscode.Range(editor.document.positionAt(range.offset), editor.document.positionAt(range.end));
            editor.setDecorations(this.manager.highlight, [vsRange]);
            editor.revealRange(vsRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
    }

    private async selectText(range: TextRange): Promise<void> {
        const document = await this.currentDocument();
        const vsRange = new vscode.Range(document.positionAt(range.offset), document.positionAt(range.end));
        const editor = await vscode.window.showTextDocument(document, { viewColumn: this.textColumn(), preserveFocus: true, selection: vsRange });
        editor.revealRange(vsRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        editor.setDecorations(this.manager.highlight, [vsRange]);
    }

    /** Undo / redo of the text document, then back to the diagram. */
    private async undoRedo(command: 'undo' | 'redo'): Promise<void> {
        const document = await this.currentDocument();
        await vscode.window.showTextDocument(document, { viewColumn: this.textColumn(), preserveFocus: false });
        await vscode.commands.executeCommand(command);
        this.panel.reveal(this.panel.viewColumn, false);
    }

    private html(): string {
        const webview = this.panel.webview;
        const base = vscode.Uri.joinPath(this.manager.context.extensionUri, 'dist', 'webview');
        const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'webview.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'webview.css'));
        const nonce = createNonce();
        return webviewHtml({ cspSource: webview.cspSource, nonce, script: script.toString(), style: style.toString() });
    }
}

function createNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
