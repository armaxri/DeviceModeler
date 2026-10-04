import * as vscode from 'vscode';
import * as path from 'node:path';
import type { DebugViewState, FromWebview, LayoutCommand, NavigationLocation, OffsetEdit, TextRange, ToWebview, WebviewSettings } from '../common/protocol.js';
import { textHash } from '../common/text-hash.js';
import { canApplyEdit, toRangeEdits } from './logic/edits.js';
import { effectiveTheme, webviewHtml } from './logic/webview.js';
import { collectImportedFiles } from './logic/imports.js';
import { NavigationHistory } from './logic/navigation.js';
import { WorkspaceFiles } from './workspace-files.js';
import { isStructureText, parseEdgeRouting, type CppHeaderSettings } from 'devm-language';
// Node-only part of the language package (not exported from its index because the web app bundles the index)
import {
    HeaderConfigFinder, headerSettingsForModel, headerSettingsFromSection, type HeaderSettingsSection
} from '../../../language/src/node/cpp-headers-node.js';

export const DIAGRAM_VIEW_TYPE = 'devm.diagram';

/** How long (ms) text changes are collected before the text is sent to the webview. */
const TEXT_DEBOUNCE_MS = 120;
/** How long (ms) changes of other files of the workspace (not imported by the document) are collected. */
const WORKSPACE_DEBOUNCE_MS = 400;
const CURSOR_DEBOUNCE_MS = 200;

function isDarkColorTheme(kind: vscode.ColorThemeKind): boolean {
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}

function readSettings(): WebviewSettings {
    const config = vscode.workspace.getConfiguration('devm.diagram');
    return {
        direction: config.get<string>('direction') === 'RIGHT' ? 'RIGHT' : 'DOWN',
        routing: parseEdgeRouting(config.get<string>('edgeRouting')) ?? 'SPLINES',
        priorities: config.get<boolean>('priorities', true),
        showProperties: config.get<boolean>('showProperties', true),
        theme: effectiveTheme(config.get<string>('theme', 'auto'), config.get<string>('lightTheme', 'classic'), isDarkColorTheme(vscode.window.activeColorTheme.kind))
    };
}

/**
 * Whether the open document is a structure file with a structure diagram (not a state machine; decided by
 * its text like the parser does, see `isStructureText`). `false` for a document that is not open.
 */
export function isStructureDocument(uri: vscode.Uri): boolean {
    const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    return document !== undefined && isStructureText(document.getText());
}

/** Whether the file (open or on disk) is a structure file (not a state machine). */
export async function isStructureFile(uri: vscode.Uri): Promise<boolean> {
    const text = await readText(uri.toString());
    return text !== undefined && isStructureText(text);
}

/**
 * Manages the diagram panels: one per `.devm` document (state machine or structure file). Holds the navigation history shared by
 * all diagrams (Back / Forward) and the texts of the workspace files sent to them.
 */
export class DiagramManager implements vscode.Disposable {

    private readonly panels = new Map<string, DiagramPanel>();
    private readonly disposables: vscode.Disposable[] = [];
    /** Documents whose diagram was closed by the user (not opened again automatically). */
    private readonly closedByUser = new Set<string>();
    private lastActive?: DiagramPanel;
    /** Back / Forward of the navigation between diagrams. */
    readonly history = new NavigationHistory();
    /** The `.devm` files of the workspace (sent to the diagrams). */
    readonly workspaceFiles = new WorkspaceFiles();
    readonly highlight = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        borderRadius: '2px'
    });

    constructor(readonly context: vscode.ExtensionContext) {
        this.disposables.push(
            this.highlight,
            this.workspaceFiles,
            // another state machine or structure file changed: the diagrams get the new texts
            this.workspaceFiles.onDidChange(uri => {
                for (const panel of this.panels.values()) {
                    if (panel.key !== uri) {
                        panel.importsChanged(panel.imports(uri) ? TEXT_DEBOUNCE_MS : WORKSPACE_DEBOUNCE_MS);
                    }
                }
            }),
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
                // diagrams of models importing the changed file (headers; models: see workspaceFiles)
                for (const panel of this.panels.values()) {
                    if (panel.imports(uri) && panel.key !== uri) {
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
                if (event.affectsConfiguration('devm.diagram')) {
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

    /** Opens (or reveals) the diagram of the document beside the text editor (or in the given column). */
    async open(uri: vscode.Uri, preserveFocus = false, viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside): Promise<DiagramPanel> {
        const existing = this.panels.get(uri.toString());
        if (existing) {
            existing.panel.reveal(viewColumn === vscode.ViewColumn.Beside ? undefined : viewColumn, preserveFocus);
            return existing;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const panel = vscode.window.createWebviewPanel(DIAGRAM_VIEW_TYPE, DiagramPanel.title(document), { viewColumn, preserveFocus }, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        });
        this.closedByUser.delete(uri.toString());
        return this.register(new DiagramPanel(this, panel, document));
    }

    /**
     * Opens the diagram of the document explicitly (Open Diagram, a file opened from the diagram): an
     * already open diagram shows its structure on its own again (only a navigation gives a structure the
     * context of a containing subsystem or system, see {@link openLocation}).
     */
    async openStandalone(uri: vscode.Uri, preserveFocus = false): Promise<DiagramPanel> {
        const existing = this.panels.get(uri.toString());
        const panel = await this.open(uri, preserveFocus);
        if (existing) {
            // (a location without element and context: the shown element stays, its context is cleared)
            existing.post({ type: 'reveal', location: { uri: existing.uri.toString() } });
        }
        return panel;
    }

    private register(panel: DiagramPanel): DiagramPanel {
        this.panels.set(panel.key, panel);
        this.lastActive = panel;
        this.updateContext(panel);
        panel.panel.onDidChangeViewState(event => {
            if (event.webviewPanel.active) {
                this.lastActive = panel;
            }
            this.updateContext(event.webviewPanel.active ? panel : undefined);
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

    /** Context keys of the menus: whether the active diagram is a structure diagram (no code generation, no layout file conversion). */
    private updateContext(active: DiagramPanel | undefined): void {
        vscode.commands.executeCommand('setContext', 'devm.structureDiagramActive', active !== undefined && isStructureDocument(active.uri));
    }

    // -----------------------------------------------------------------------------------------
    // Navigation between diagrams and its history

    /**
     * Navigation from a diagram (`source`): opens the document of the location and its diagram (in the column
     * of the source diagram, the text in the column of its text editor) and shows the location there. `from`
     * (the location of the source diagram) is recorded for Back. Returns false if the file cannot be opened.
     */
    async openLocation(location: NavigationLocation, source: DiagramPanel | undefined, from?: NavigationLocation): Promise<boolean> {
        if (!await this.show(location, source)) {
            return false;
        }
        if (from) {
            this.history.record(from);
            this.historyChanged();
        }
        return true;
    }

    /** Back / Forward: `from` is the current location of the diagram the navigation started in. */
    async navigate(direction: 'back' | 'forward', from: NavigationLocation, source: DiagramPanel | undefined): Promise<void> {
        const target = direction === 'back' ? this.history.goBack(from) : this.history.goForward(from);
        this.historyChanged();
        if (target && !await this.show(target, source)) {
            vscode.window.setStatusBarMessage(`$(warning) Device Modeler: ${decodeURIComponent(target.uri.replace(/^.*\//, ''))} is not available.`, 6000);
        }
    }

    /** Back / Forward of the commands: the active diagram sends its location (`navigate` message). */
    requestNavigation(direction: 'back' | 'forward'): boolean {
        const panel = this.active;
        panel?.post({ type: 'navigateRequest', direction });
        return panel !== undefined;
    }

    private async show(location: NavigationLocation, source: DiagramPanel | undefined): Promise<boolean> {
        let uri: vscode.Uri;
        try {
            uri = vscode.Uri.parse(location.uri, true);
        } catch {
            return false;
        }
        const existing = this.panels.get(uri.toString());
        if (existing && existing === source) {
            existing.post({ type: 'reveal', location });
            return true;
        }
        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(uri);
        } catch {
            return false;
        }
        await vscode.window.showTextDocument(document, { viewColumn: source?.textColumn() ?? vscode.ViewColumn.One, preserveFocus: true, preview: false });
        const panel = await this.open(uri, false, source?.panel.viewColumn ?? vscode.ViewColumn.Beside);
        await panel.whenReady();
        panel.post({ type: 'reveal', location });
        return true;
    }

    private historyChanged(): void {
        const state = this.history.state;
        for (const panel of this.panels.values()) {
            panel.post({ type: 'history', state });
        }
        vscode.commands.executeCommand('setContext', 'devm.diagramCanGoBack', state.back !== undefined);
        vscode.commands.executeCommand('setContext', 'devm.diagramCanGoForward', state.forward !== undefined);
    }

    private autoOpen(editor: vscode.TextEditor | undefined): void {
        const language = editor?.document.languageId;
        if (!editor || language !== 'devm' || !vscode.workspace.getConfiguration('devm.diagram').get<boolean>('autoOpen', false)) {
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

    /**
     * Shows the state of a debug session in the diagram of the model (opened beside the editor if
     * necessary, revealed when the session starts showing it); the diagram is read-only meanwhile.
     * Other diagrams showing a debug state return to editing.
     */
    async showDebugState(uri: vscode.Uri, state: DebugViewState): Promise<void> {
        const key = uri.toString();
        for (const panel of this.panels.values()) {
            if (panel.key !== key && panel.debugState) {
                panel.setDebugState(undefined);
            }
        }
        let panel = this.panels.get(key);
        if (!panel) {
            panel = await this.open(uri, true);
        } else if (!panel.debugState && !panel.panel.visible) {
            panel.panel.reveal(undefined, true);
        }
        panel.setDebugState(state);
    }

    /** The debug session ended: all diagrams return to editing. */
    clearDebugState(): void {
        for (const panel of this.panels.values()) {
            if (panel.debugState) {
                panel.setDebugState(undefined);
            }
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

/** The diagram of one `.devm` document in a webview panel. */
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
    /** The state of the debug session shown in the diagram (read-only while set). */
    private debugView?: DebugViewState;
    private readonly rasterizeRequests = new Map<number, { resolve: (data: Uint8Array) => void, reject: (error: Error) => void }>();

    constructor(private readonly manager: DiagramManager, readonly panel: vscode.WebviewPanel, private document: vscode.TextDocument) {
        panel.iconPath = vscode.Uri.joinPath(manager.context.extensionUri, 'media', 'diagram.svg');
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(manager.context.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(manager.context.extensionUri, 'media')]
        };
        panel.webview.html = this.html();
        panel.webview.onDidReceiveMessage((message: FromWebview) => this.receive(message).catch(error => {
            vscode.window.showErrorMessage(`Device Modeler diagram: ${error instanceof Error ? error.message : String(error)}`);
        }));
    }

    static title(document: vscode.TextDocument): string {
        return `Diagram: ${path.basename(document.uri.path)}`;
    }

    get key(): string {
        return this.document.uri.toString();
    }

    get debugState(): DebugViewState | undefined {
        return this.debugView;
    }

    /** Shows the state of a debug session (undefined: back to editing). */
    setDebugState(state: DebugViewState | undefined): void {
        this.debugView = state;
        if (this.ready) {
            this.post({ type: 'debugState', state });
        }
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

    /** An imported file or another file of the workspace changed: the webview gets its new text. */
    importsChanged(delay = TEXT_DEBOUNCE_MS): void {
        clearTimeout(this.textTimer);
        this.textTimer = setTimeout(() => this.sendText(), delay);
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
        // the texts of the imported files (open documents with their unsaved changes, else the files) and of
        // all state machines and structure files of the workspace (queries across files)
        const headers = headerSettingsFor(document.uri);
        const imports = collectImportedFiles(document.uri.toString(), text, readText, 100, headers).catch(() => ({}));
        const workspace = this.manager.workspaceFiles.texts().catch(() => ({}));
        // posted in order (an older text must not overwrite a newer one)
        this.sendQueue = this.sendQueue.then(() => Promise.all([imports, workspace])).then(([imported, all]) => {
            this.importedUris = new Set(Object.keys(imported));
            const files: Record<string, string> = { ...all, ...imported };
            delete files[document.uri.toString()];
            this.post({
                type: 'text',
                text,
                version,
                fileName: path.basename(document.uri.path),
                uri: document.uri.toString(),
                files,
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
                this.post({ type: 'history', state: this.manager.history.state });
                this.sendText();
                if (this.debugView) {
                    this.post({ type: 'debugState', state: this.debugView });
                }
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
                vscode.window.setStatusBarMessage(`$(warning) Device Modeler: ${message.message}`, 6000);
                break;
            case 'updateSetting': {
                const key = message.key === 'routing' ? 'edgeRouting' : message.key;
                await vscode.workspace.getConfiguration('devm.diagram').update(key, message.value, vscode.ConfigurationTarget.Global);
                break;
            }
            case 'command':
                await vscode.commands.executeCommand(`devm.${message.command}`, this.document.uri, message.element);
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
                await this.manager.openStandalone(uri);
                break;
            }
            case 'openLocation': {
                const ok = await this.manager.openLocation(message.location, this, message.from).catch(() => false);
                this.post({ type: 'locationResult', requestId: message.requestId, ok });
                break;
            }
            case 'navigate':
                await this.manager.navigate(message.direction, message.from, this);
                break;
            case 'workspaceEdit':
                await this.applyWorkspaceEdit(message.requestId, message.version, message.edits, message.hashes);
                break;
        }
    }

    /**
     * Applies the edits of several files (e.g. a rename in a structure file that updates the files using the
     * element) as one workspace edit, undone together. The edits of this document must be based on its
     * current version, those of the other files on their current texts (`hashes`).
     */
    private async applyWorkspaceEdit(requestId: number, version: number, edits: Record<string, OffsetEdit[]>, hashes: Record<string, number>): Promise<void> {
        const document = await this.currentDocument();
        const answer = (ok: boolean, message?: string) => this.post({
            type: 'editResult', requestId, ok, text: document.getText(), version: document.version, message
        });
        const workspaceEdit = new vscode.WorkspaceEdit();
        try {
            for (const [key, list] of Object.entries(edits)) {
                const uri = vscode.Uri.parse(key, true);
                const own = uri.toString() === this.key;
                const target = own ? document : await vscode.workspace.openTextDocument(uri);
                const text = target.getText();
                if (own ? !canApplyEdit(version, document.version) : textHash(text) !== hashes[key]) {
                    answer(false, `${path.basename(uri.path)} was changed in the meantime – please try again.`);
                    return;
                }
                for (const edit of toRangeEdits(list, text.length, offset => target.positionAt(offset))) {
                    workspaceEdit.replace(uri, new vscode.Range(edit.start, edit.end), edit.text);
                }
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
        // (the changed texts of the other files are sent with the next text message, see WorkspaceFiles)
        answer(ok, ok ? undefined : 'The edit could not be applied.');
    }

    /** Applies the text edits of a diagram operation to the document (undoable, marks the document dirty). */
    private async applyEdit(requestId: number, version: number, edits: OffsetEdit[]): Promise<void> {
        const document = await this.currentDocument();
        const answer = (ok: boolean, message?: string) => this.post({
            type: 'editResult', requestId, ok, text: document.getText(), version: document.version, message
        });
        if (this.debugView) {
            answer(false, 'The diagram is read-only while a test is being debugged.');
            return;
        }
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
    textColumn(): vscode.ViewColumn {
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
 * `headers` block of the nearest `devm.gen.json` and the settings `devm.headers.*`.
 */
export function headerSettingsFor(uri: vscode.Uri): CppHeaderSettings {
    if (uri.scheme !== 'file') {
        return {};
    }
    headerConfigs.clear();
    return headerSettingsForModel(uri.fsPath, headerConfigs, vscodeHeaderSettings(uri));
}

/** The VS Code settings `devm.headers.*` for a resource (without the settings of `devm.gen.json`). */
export function vscodeHeaderSettings(uri: vscode.Uri | undefined): CppHeaderSettings {
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const section = vscode.workspace.getConfiguration('devm', uri).get<HeaderSettingsSection>('headers');
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
