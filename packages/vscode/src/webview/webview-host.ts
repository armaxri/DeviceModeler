import { parseManualLayout, serializeManualLayout, type ManualLayout, type TextEdit } from 'hsm-language';
import type { DiagramController, DiagramHost, StatusSeverity, TextRange } from '@hsm-web/diagram-controller.js';
import { textKey } from '@hsm-web/diagram/manual-layout-support.js';
import { byId, h } from '@hsm-web/ui/dom.js';
import type { FromWebview, LayoutCommand, TextChange, ToWebview, WebviewSettings } from '../common/protocol.js';

export interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

/**
 * The text side of the diagram in the webview: a copy of the document text, kept up to date by the
 * extension. Diagram operations are sent to the extension as text edits, which applies them to the
 * real document. The manual layout (experimental) is read and written by the extension as the sidecar
 * file `<model>.hsm.layout`; layout-only changes are undone in the diagram (see `DiagramController.undo`).
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

    constructor(private readonly vscode: VsCodeApi) {
        this.buildLayout();
        window.addEventListener('message', event => this.receive(event.data as ToWebview));
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
            h('span', { id: 'file-name', class: 'file-name' }),
            h('div', { class: 'group' },
                h('button', { id: 'btn-simulate', class: 'simulate', title: 'Simulate the state machine (the model must not contain errors)', onClick: () => this.toggleSimulation() }, '▶ Simulate')),
            h('div', { class: 'group' },
                direction,
                routing,
                h('label', { class: 'toggle', title: 'Show the priorities of transitions leaving a state with several outgoing transitions' }, priorities, h('span', {}, 'Priorities')),
                h('label', { class: 'toggle', title: 'Show the properties panel' }, properties, h('span', {}, 'Properties'))),
            h('div', { class: 'group', id: 'layout-group' },
                h('span', { class: 'label-text layout-label' }, 'Positions'),
                h('span', { class: 'segmented', role: 'group', 'aria-label': 'Layout mode' },
                    h('button', { id: 'btn-layout-auto', title: 'Automatic layout (ELK): positions are computed from the model' }, 'Auto'),
                    h('button', { id: 'btn-layout-manual', title: 'Manual layout (experimental): states keep the positions they are dragged to (saved as .hsm.layout next to the model)' }, 'Manual')),
                h('button', { id: 'btn-arrange', title: 'Arrange all elements automatically and keep the result as manual layout', hidden: true }, 'Auto-arrange'),
                h('button', { id: 'btn-reset-layout', title: 'Discard the manual layout (deletes the .hsm.layout file) and return to the automatic layout', hidden: true }, 'Reset')),
            h('div', { class: 'spacer' }),
            h('div', { class: 'group' },
                h('button', { id: 'btn-svg', title: 'Export the diagram as SVG', onClick: () => this.post({ type: 'command', command: 'exportSvg' }) }, 'SVG'),
                h('button', { id: 'btn-plantuml', title: 'Export the model as PlantUML (.puml)', onClick: () => this.post({ type: 'command', command: 'exportPlantUml' }) }, 'PlantUML'),
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
            case 'text':
                this.vscode.setState({ uri: message.uri });
                this.textChanged(message.text, message.version, message.fileName, message.change);
                break;
            case 'layout':
                this.layoutLoaded(message.content);
                break;
            case 'layoutCommand':
                this.layoutCommand(message.command);
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

    private textChanged(text: string, version: number, fileName: string, change: TextChange = 'edit'): void {
        this.version = version;
        byId('file-name').textContent = fileName;
        if (this.received && text === this.text) {
            return;
        }
        const previousKey = textKey(this.text);
        this.text = text;
        if (this.received) {
            // layout changes of an undone / redone diagram edit are undone / redone with it
            this.controller.textChanged(change, previousKey);
        }
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

    /** The layout file was read (on open) or changed by another tool. */
    private layoutLoaded(content: string | undefined): void {
        let layout: ManualLayout | undefined;
        if (content !== undefined) {
            try {
                layout = parseManualLayout(content);
            } catch (error) {
                this.setStatus(`The layout file is invalid and is ignored: ${error instanceof Error ? error.message : String(error)}`, 'error');
            }
        }
        this.controller.loadLayout(layout);
    }

    private layoutCommand(command: LayoutCommand): void {
        switch (command) {
            case 'auto':
            case 'manual':
                this.controller.setLayoutMode(command);
                break;
            case 'arrange':
                if (!this.controller.isManualLayout()) {
                    this.controller.setLayoutMode('manual');
                }
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

    /** Manual layout: the extension writes the layout file (debounced). */
    layoutChanged(layout: ManualLayout | undefined): void {
        this.post(layout ? { type: 'layout', content: serializeManualLayout(layout), mode: layout.mode } : { type: 'layout' });
    }

    undo(): void {
        this.post({ type: 'undo' });
    }

    redo(): void {
        this.post({ type: 'redo' });
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
