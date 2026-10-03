import { normalizeUri, type DiagramSubmachine, type TextEdit } from 'hsm-language';
import type { DiagramController, DiagramHost, DiagramLocation, StatusSeverity, TextRange } from '@hsm-web/diagram-controller.js';
import { isStructureFile } from '@hsm-web/model-service.js';
import { byId, h } from '@hsm-web/ui/dom.js';
import { svgToPng } from '@hsm-web/ui/export-svg.js';
import type { FromWebview, LayoutCommand, NavigationState, OffsetEdit, ToWebview, WebviewSettings } from '../common/protocol.js';
import { textHash } from '../common/text-hash.js';

/** Controls of the toolbar that do not apply to structure files (`.dmf`). */
const STATE_MACHINE_CONTROLS = ['direction-select', 'routing-select', 'priorities-toggle', 'btn-simulate', 'btn-arrange', 'btn-reset-layout', 'btn-cpp'];

export interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

/**
 * The text side of the diagram in the webview: a copy of the document text, kept up to date by the
 * extension. Diagram operations are sent to the extension as text edits, which applies them to the
 * real document. The manual layout (experimental) consists of layout annotations in the text, so layout
 * changes are text edits as well (undone with the document). Navigation to other files (structures, state
 * machines) and edits of several files (renames, deletions in structure files) go through the extension,
 * which owns the navigation history shared by all diagrams.
 */
export class WebviewHost implements DiagramHost {

    private controller!: DiagramController;
    private text = '';
    private version = -1;
    private received = false;
    private requestId = 0;
    private readonly pending = new Map<number, (ok: boolean) => void>();
    private statusTimer?: ReturnType<typeof setTimeout>;
    private settings?: WebviewSettings;
    /** The imported files of the last text message (JSON), to detect changes. */
    private filesKey = '';
    /** The other files of the last text message (the workspace), by URI. */
    private files: Record<string, string> = {};
    private uri = '';
    private readonly locationRequests = new Map<number, (ok: boolean) => void>();

    constructor(private readonly vscode: VsCodeApi) {
        this.buildLayout();
        window.addEventListener('message', event => this.receive(event.data as ToWebview));
        // Back / Forward (as in the web app)
        document.addEventListener('keydown', event => {
            if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                this.navigate(event.key === 'ArrowLeft' ? 'back' : 'forward');
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, { capture: true });
    }

    connect(controller: DiagramController): void {
        this.controller = controller;
    }

    ready(): void {
        this.post({ type: 'ready' });
    }

    private post(message: FromWebview): void {
        this.vscode.postMessage(message);
    }

    // -----------------------------------------------------------------------------------------
    // Layout and toolbar

    private buildLayout(): void {
        const direction = h('select', { id: 'direction-select', title: 'Layout direction' },
            h('option', { value: 'DOWN' }, 'Top → bottom'), h('option', { value: 'RIGHT' }, 'Left → right'));
        const routing = h('select', { id: 'routing-select', title: 'Edge routing' },
            h('option', { value: 'SPLINES' }, 'Splines'), h('option', { value: 'ORTHOGONAL' }, 'Orthogonal'), h('option', { value: 'POLYLINE' }, 'Polyline'));
        const priorities = h('input', { type: 'checkbox', id: 'priorities-toggle' });
        const properties = h('input', { type: 'checkbox', id: 'properties-toggle' });
        direction.addEventListener('change', () => this.post({ type: 'updateSetting', key: 'direction', value: direction.value }));
        routing.addEventListener('change', () => this.post({ type: 'updateSetting', key: 'routing', value: routing.value }));
        priorities.addEventListener('change', () => this.post({ type: 'updateSetting', key: 'priorities', value: priorities.checked }));
        properties.addEventListener('change', () => this.post({ type: 'updateSetting', key: 'showProperties', value: properties.checked }));
        const toolbar = h('header', { class: 'toolbar' },
            h('div', { class: 'group' },
                h('button', { id: 'btn-back', title: 'Back (Alt+←)', 'aria-label': 'Back', disabled: true, onClick: () => this.navigate('back') }, '◀'),
                h('button', { id: 'btn-forward', title: 'Forward (Alt+→)', 'aria-label': 'Forward', disabled: true, onClick: () => this.navigate('forward') }, '▶')),
            h('span', { id: 'file-name', class: 'file-name' }),
            h('div', { class: 'group' },
                h('button', { id: 'btn-simulate', class: 'simulate', title: 'Simulate the state machine (the model must not contain errors)', onClick: () => this.toggleSimulation() }, '▶ Simulate')),
            h('div', { class: 'group' },
                direction,
                routing,
                h('label', { class: 'toggle', title: 'Show the priorities of transitions leaving a state with several outgoing transitions' }, priorities, h('span', {}, 'Priorities')),
                h('label', { class: 'toggle', title: 'Show the properties panel' }, properties, h('span', {}, 'Properties'))),
            h('div', { class: 'group', id: 'layout-group' },
                h('button', { id: 'btn-arrange', title: 'Arrange all elements automatically and write the positions into the model (layout annotations)' }, 'Auto-arrange'),
                h('button', { id: 'btn-reset-layout', title: 'Remove all layout annotations from the model and return to the automatic layout (an earlier arrangement is restored with undo)' }, 'Automatic layout')),
            h('div', { class: 'spacer' }),
            h('div', { class: 'group' },
                h('button', { id: 'btn-export', title: 'Export the diagram as SVG or PNG', onClick: () => this.exportDiagram() }, 'Export…'),
                h('button', { id: 'btn-cpp', title: 'Generate C++ code', onClick: () => this.post({ type: 'command', command: 'generateCpp' }) }, 'C++')));
        const main = h('main', {},
            h('section', { id: 'diagram-pane' },
                h('div', { id: 'palette', role: 'toolbar', 'aria-label': 'Tools' }),
                h('div', { id: 'diagram-area', class: 'theme-classic' },
                    h('div', { id: 'sprotty' }),
                    h('div', { id: 'sprotty_hidden' }),
                    h('div', { id: 'diagram-banner', hidden: true }),
                    h('div', { id: 'diagram-hint' })),
                h('aside', { id: 'properties' })));
        const status = h('footer', { id: 'statusbar' }, h('span', { id: 'status-message' }), h('span', { class: 'spacer' }), h('span', { id: 'status-problems' }));
        document.body.replaceChildren(toolbar, main, status);
    }

    private exportDiagram(): void {
        // structure files: the shown structure or component type
        const element = this.controller.structureMode ? this.controller.currentLocation().element : undefined;
        this.post({ type: 'command', command: 'exportDiagram', element });
    }

    /** Back / Forward in the navigation history of the extension (shared by all diagrams). */
    private navigate(direction: 'back' | 'forward'): void {
        const button = byId<HTMLButtonElement>(direction === 'back' ? 'btn-back' : 'btn-forward');
        if (!button.disabled) {
            this.post({ type: 'navigate', direction, from: this.controller.currentLocation() });
        }
    }

    private updateHistory(state: NavigationState): void {
        const back = byId<HTMLButtonElement>('btn-back');
        const forward = byId<HTMLButtonElement>('btn-forward');
        back.disabled = state.back === undefined;
        forward.disabled = state.forward === undefined;
        back.title = state.back ? `Back to ${state.back} (Alt+←)` : 'Back (Alt+←)';
        forward.title = state.forward ? `Forward to ${state.forward} (Alt+→)` : 'Forward (Alt+→)';
    }

    /**
     * Structure files have no layout settings, simulation, layout annotations and code generation (yet); called
     * when the document of the diagram is set (the layout buttons are also updated by the controller).
     */
    private updateFileControls(): void {
        const structure = isStructureFile(this.uri);
        for (const id of STATE_MACHINE_CONTROLS) {
            const control = document.getElementById(id) as HTMLButtonElement | null;
            if (control) {
                control.disabled = structure;
            }
        }
        byId('btn-simulate').title = structure ? 'Structures cannot be simulated – open the state machine of a component'
            : 'Simulate the state machine (the model must not contain errors)';
    }

    private toggleSimulation(): void {
        if (this.controller.simulation) {
            this.controller.stopSimulation();
        } else {
            this.controller.startSimulation();
        }
    }

    private applySettings(settings: WebviewSettings): void {
        const previous = this.settings;
        this.settings = settings;
        const target = this.controller.settings;
        target.direction = settings.direction;
        target.routing = settings.routing;
        target.priorities = settings.priorities;
        target.theme = settings.theme;
        byId<HTMLSelectElement>('direction-select').value = settings.direction;
        byId<HTMLSelectElement>('routing-select').value = settings.routing;
        byId<HTMLInputElement>('priorities-toggle').checked = settings.priorities;
        byId<HTMLInputElement>('properties-toggle').checked = settings.showProperties;
        byId('diagram-pane').classList.toggle('hide-properties', !settings.showProperties);
        document.body.classList.toggle('ui-dark', document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast'));
        this.controller.applyTheme();
        if (previous && this.received && (previous.direction !== settings.direction || previous.routing !== settings.routing || previous.priorities !== settings.priorities)) {
            this.controller.relayout(previous.direction !== settings.direction);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Messages from the extension

    private receive(message: ToWebview): void {
        switch (message.type) {
            case 'settings':
                this.applySettings(message.settings);
                break;
            case 'text': {
                this.vscode.setState({ uri: message.uri });
                // imports are resolved against the files sent by the extension
                const files = message.files ?? {};
                const key = JSON.stringify([message.uri, files, message.headers ?? {}]);
                const filesChanged = key !== this.filesKey;
                if (filesChanged) {
                    this.filesKey = key;
                    this.files = files;
                    this.controller.language.setWorkspace(message.uri, files, message.headers);
                }
                if (message.uri !== this.uri) {
                    this.uri = message.uri;
                    this.updateFileControls();
                }
                this.textChanged(message.text, message.version, message.fileName, filesChanged);
                break;
            }
            case 'reveal':
                this.controller.revealLocation(message.location);
                if (this.received) {
                    this.controller.update(true);
                }
                break;
            case 'locationResult': {
                const resolve = this.locationRequests.get(message.requestId);
                this.locationRequests.delete(message.requestId);
                resolve?.(message.ok);
                break;
            }
            case 'history':
                this.updateHistory(message.state);
                break;
            case 'navigateRequest':
                this.navigate(message.direction);
                break;
            case 'layoutCommand':
                this.layoutCommand(message.command);
                break;
            case 'rasterize':
                this.rasterize(message.requestId, message.svg, message.scale);
                break;
            case 'cursor':
                this.controller.selectElementAtOffset(message.offset);
                break;
            case 'editResult': {
                this.version = message.version;
                const changed = this.text !== message.text;
                this.text = message.text;
                if (!message.ok && message.message) {
                    this.setStatus(message.message, 'error');
                }
                const resolve = this.pending.get(message.requestId);
                this.pending.delete(message.requestId);
                resolve?.(message.ok);
                if (!message.ok && changed) {
                    this.controller.update();
                }
                break;
            }
            case 'fit':
                this.controller.fit();
                break;
        }
    }

    private textChanged(text: string, version: number, fileName: string, filesChanged = false): void {
        this.version = version;
        byId('file-name').textContent = fileName;
        if (this.received && text === this.text && !filesChanged) {
            return;
        }
        this.text = text;
        if (!this.received) {
            this.received = true;
            this.controller.update(true);
            return;
        }
        if (this.controller.simulation) {
            this.controller.stopSimulation();
            this.setStatus('The model was changed – the simulation has been stopped.', 'warning');
        }
        this.controller.scheduleUpdate(100);
    }

    /** Converts an SVG of the extension into a PNG image (a canvas is only available in the webview). */
    private async rasterize(requestId: number, svg: string, scale: number): Promise<void> {
        try {
            const png = await svgToPng(svg, scale);
            const bytes = new Uint8Array(await png.arrayBuffer());
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) {
                binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            }
            this.post({ type: 'png', requestId, data: btoa(binary) });
        } catch (error) {
            this.post({ type: 'png', requestId, error: error instanceof Error ? error.message : String(error) });
        }
    }

    private layoutCommand(command: LayoutCommand): void {
        switch (command) {
            case 'arrange':
                this.controller.autoArrange();
                break;
            case 'reset':
                this.controller.resetLayout();
                break;
        }
    }

    // -----------------------------------------------------------------------------------------
    // DiagramHost

    getText(): string {
        return this.text;
    }

    applyTextEdits(edits: readonly TextEdit[]): Promise<boolean> {
        const requestId = ++this.requestId;
        return new Promise<boolean>(resolve => {
            this.pending.set(requestId, resolve);
            this.post({ type: 'edit', requestId, version: this.version, edits: edits.map(e => ({ offset: e.offset, length: e.length, text: e.text })) });
        });
    }

    highlightText(range: TextRange | undefined): void {
        this.post({ type: 'highlight', range });
    }

    selectText(range: TextRange): void {
        this.post({ type: 'selectText', range });
    }

    editTextAt(offset: number): void {
        this.post({ type: 'editAt', offset });
    }

    textHasFocus(): boolean {
        // the text editor can only have the focus if the webview does not
        return !document.hasFocus();
    }

    undo(): void {
        this.post({ type: 'undo' });
    }

    redo(): void {
        this.post({ type: 'redo' });
    }

    /** Navigation from the diagram: the extension opens the file and its diagram and records the history. */
    openLocation(location: DiagramLocation): Promise<boolean> {
        const requestId = ++this.requestId;
        return new Promise<boolean>(resolve => {
            this.locationRequests.set(requestId, resolve);
            this.post({ type: 'openLocation', requestId, location, from: this.controller.currentLocation() });
        });
    }

    /**
     * Edits of several files as one workspace edit of the extension (undone together). The other files are
     * identified by the hashes of the texts the edits were computed on.
     */
    applyWorkspaceEdits(edits: ReadonlyMap<string, readonly TextEdit[]>): Promise<boolean> {
        const requestId = ++this.requestId;
        const byUri: Record<string, OffsetEdit[]> = {};
        const hashes: Record<string, number> = {};
        const known = new Map(Object.entries(this.files).map(([uri, text]) => [normalizeUri(uri), text]));
        known.set(normalizeUri(this.uri), this.text);
        for (const [uri, list] of edits) {
            const text = known.get(normalizeUri(uri));
            if (text === undefined) {
                return Promise.resolve(false);
            }
            byUri[uri] = list.map(e => ({ offset: e.offset, length: e.length, text: e.text }));
            hashes[uri] = textHash(text);
        }
        return new Promise<boolean>(resolve => {
            this.pending.set(requestId, resolve);
            this.post({ type: 'workspaceEdit', requestId, version: this.version, edits: byUri, hashes });
        });
    }

    openStateMachine(submachine: DiagramSubmachine): boolean {
        if (!submachine.uri) {
            return false;
        }
        this.post({ type: 'openFile', uri: submachine.uri });
        return true;
    }

    simulationStateChanged(running: boolean): void {
        const button = byId('btn-simulate');
        button.textContent = running ? '■ Stop' : '▶ Simulate';
        button.title = running ? 'Stop the simulation and return to editing' : 'Simulate the state machine (the model must not contain errors)';
        button.classList.toggle('active', running);
        for (const id of ['direction-select', 'routing-select', 'priorities-toggle']) {
            byId<HTMLInputElement>(id).disabled = running;
        }
        this.post({ type: 'simulation', running });
    }

    setStatus(message: string, severity: StatusSeverity = 'info'): void {
        const element = byId('status-message');
        element.textContent = message;
        element.className = severity === 'info' ? '' : severity;
        clearTimeout(this.statusTimer);
        this.statusTimer = setTimeout(() => {
            element.textContent = '';
        }, 6000);
        if (severity === 'error') {
            this.post({ type: 'status', message, severity });
        }
    }

    modelParsed(parsed: { diagnostics: Array<{ severity?: number }> }): void {
        const errors = parsed.diagnostics.filter(d => d.severity === 1).length;
        const warnings = parsed.diagnostics.filter(d => d.severity === 2).length;
        const element = byId('status-problems');
        element.className = errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok';
        element.textContent = errors + warnings === 0 ? '✓ No problems'
            : `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
    }
}
