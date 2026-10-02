import * as vscode from 'vscode';
import * as path from 'node:path';
import type { FromWebview, LayoutCommand, OffsetEdit, TextRange, ToWebview, WebviewSettings } from '../common/protocol.js';
import { canApplyEdit, toRangeEdits } from './logic/edits.js';
import { effectiveTheme, webviewHtml } from './logic/webview.js';
import { collectImportedFiles } from './logic/imports.js';
import { parseEdgeRouting, type CppHeaderSettings } from 'hsm-language';
// Node-only part of the language package (not exported from its index because the web app bundles the index)
import {
    HeaderConfigFinder, headerSettingsForModel, headerSettingsFromSection, type HeaderSettingsSection
} from '../../../language/src/node/cpp-headers-node.js';

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
        routing: parseEdgeRouting(config.get<string>('edgeRouting')) ?? 'SPLINES',
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
            vscode.workspace.onDidChangeTextDocument(event => {
                const uri = event.document.uri.toString();
                this.panels.get(uri)?.documentChanged(event.document);
                // diagrams of models importing the changed file
                for (const panel of this.panels.values()) {
                    if (panel.imports(uri)) {
                        panel.importsChanged();
                    }
                }
            }),
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

    /**
     * Converts the SVG into a PNG image in the webview of the model's diagram (a canvas is needed),
     * opening the diagram if necessary.
     */
    async rasterize(uri: vscode.Uri, svg: string, scale = 2): Promise<Uint8Array> {
        const panel = this.panels.get(uri.toString()) ?? await this.open(uri, true);
        await panel.whenReady();
        return panel.rasterize(svg, scale);
    }

    /** Runs a layout command (arrange: Store positions / Re-arrange, reset: Clear positions) in the diagram. */
    layoutCommand(uri: vscode.Uri | undefined, command: LayoutCommand): boolean {
        const panel = uri ? this.panels.get(uri.toString()) : this.active;
        panel?.post({ type: 'layoutCommand', command });
        return panel !== undefined;
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
    /** URIs of the files imported by the model (sent to the webview with the text). */
    private importedUris = new Set<string>();
    private sendQueue: Promise<void> = Promise.resolve();
    private readonly readyWaiters: Array<() => void> = [];
    private rasterizeRequest = 0;
    private readonly rasterizeRequests = new Map<number, { resolve: (data: Uint8Array) => void, reject: (error: Error) => void }>();

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

    /** The document was renamed / moved. */
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
    /** Converts the SVG into a PNG image in the webview. */
    rasterize(svg: string, scale: number): Promise<Uint8Array> {
        const requestId = ++this.rasterizeRequest;
        return new Promise((resolve, reject) => {
            this.rasterizeRequests.set(requestId, { resolve, reject });
            this.post({ type: 'rasterize', requestId, svg, scale });
        });
    }

    whenReady(): Promise<void> {
        return this.ready ? Promise.resolve() : new Promise(resolve => this.readyWaiters.push(resolve));
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

    /** Whether the model imports the file (directly or indirectly). */
    imports(uri: string): boolean {
        return this.importedUris.has(uri);
    }

    /** An imported file changed: the webview gets its new text. */
    importsChanged(): void {
        clearTimeout(this.textTimer);
        this.textTimer = setTimeout(() => this.sendText(), TEXT_DEBOUNCE_MS);
    }

    cursorMoved(offset: number): void {
        clearTimeout(this.cursorTimer);
        this.cursorTimer = setTimeout(() => this.post({ type: 'cursor', offset }), CURSOR_DEBOUNCE_MS);
    }

    private sendText(): void {
        clearTimeout(this.textTimer);
        const document = this.document;
        const text = document.getText();
        const version = document.version;
        // the texts of the imported state machines (open documents with their unsaved changes, else the files)
        const headers = headerSettingsFor(document.uri);
        const files = collectImportedFiles(document.uri.toString(), text, readText, 100, headers).catch(() => ({}));
        // posted in order (an older text must not overwrite a newer one)
        this.sendQueue = this.sendQueue.then(() => files).then(imported => {
            this.importedUris = new Set(Object.keys(imported));
            this.post({
                type: 'text',
                text,
                version,
                fileName: path.basename(document.uri.path),
                uri: document.uri.toString(),
                files: imported,
                headers
            });
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
            case 'updateSetting': {
                const key = message.key === 'routing' ? 'edgeRouting' : message.key;
                await vscode.workspace.getConfiguration('hsm.diagram').update(key, message.value, vscode.ConfigurationTarget.Global);
                break;
            }
            case 'command':
                await vscode.commands.executeCommand(`hsm.${message.command}`, this.document.uri);
                break;
            case 'png': {
                const request = this.rasterizeRequests.get(message.requestId);
                this.rasterizeRequests.delete(message.requestId);
                if (message.data !== undefined) {
                    request?.resolve(Uint8Array.from(Buffer.from(message.data, 'base64')));
                } else {
                    request?.reject(new Error(message.error ?? 'The PNG image could not be created.'));
                }
                break;
            }
            case 'simulation':
                break;
            case 'openFile': {
                // double-click on a submachine state: the file of its state machine and its diagram
                const uri = vscode.Uri.parse(message.uri);
                await vscode.window.showTextDocument(uri, { viewColumn: this.textColumn(), preserveFocus: true });
                await this.manager.open(uri);
                break;
            }
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

/** The text of a file: the open document (with unsaved changes) or the file on disk; `undefined` if it cannot be read. */
const headerConfigs = new HeaderConfigFinder();

/**
 * The settings of imported C/C++ headers for a model, like the language server uses them: the
 * `headers` block of the nearest `hsm.gen.json` and the settings `hsm.headers.*`.
 */
export function headerSettingsFor(uri: vscode.Uri): CppHeaderSettings {
    if (uri.scheme !== 'file') {
        return {};
    }
    headerConfigs.clear();
    return headerSettingsForModel(uri.fsPath, headerConfigs, vscodeHeaderSettings(uri));
}

/** The VS Code settings `hsm.headers.*` for a resource (without the settings of `hsm.gen.json`). */
export function vscodeHeaderSettings(uri: vscode.Uri | undefined): CppHeaderSettings {
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const section = vscode.workspace.getConfiguration('hsm', uri).get<HeaderSettingsSection>('headers');
    return headerSettingsFromSection(section, folder);
}

export async function readText(uri: string): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri);
    if (open) {
        return open.getText();
    }
    try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri)));
    } catch {
        return undefined;
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
