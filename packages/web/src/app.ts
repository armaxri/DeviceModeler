import { monaco } from './monaco.js';
import {
    LAYOUT_FILE_EXTENSION, generatePlantUml, importSct, layoutFileName, parseManualLayout, serializeManualLayout,
    type EdgeRouting, type LayoutDirection, type ManualLayout, type ParsedModel, type TextEdit
} from 'hsm-language';
import { EDITOR_THEMES, HsmLanguageSupport, LANGUAGE_ID } from './language-support.js';
import { DiagramController, type DiagramHost, type DiagramSettings, type StatusSeverity, type TextRange } from './diagram-controller.js';
import { createWorkerElk } from './diagram/elk.js';
import { loadStoredLayout, storeLayout } from './diagram/manual-layout-support.js';
import { byId, download, h } from './ui/dom.js';
import { plantUmlServerUrl } from './ui/plantuml.js';
import type { SimulationSession } from './simulation/session.js';
import { EMPTY_MODEL, EXAMPLES } from './examples.js';

export type { Tool } from './diagram-controller.js';

interface Settings extends DiagramSettings {
    editorWidth?: string;
}

const STORAGE_TEXT = 'hsm-modeler.text';
const STORAGE_SETTINGS = 'hsm-modeler.settings';
const STORAGE_FILE = 'hsm-modeler.file';

/**
 * The web application: the Monaco text editor, the toolbar and the graphical editor
 * ({@link DiagramController}) which shows and edits the text of the Monaco editor.
 */
export class HsmApp implements DiagramHost {

    readonly language = new HsmLanguageSupport();
    private editor!: monaco.editor.IStandaloneCodeEditor;
    private decorations!: monaco.editor.IEditorDecorationsCollection;
    private cursorTimer?: ReturnType<typeof setTimeout>;
    private applyingEdit = false;
    private fileName = 'statemachine.hsm';
    /** `alternativeVersionId` of the text model after the last change (for the combined text / layout undo). */
    private textVersion = 1;
    private settings: Settings = { direction: 'DOWN', routing: 'SPLINES', theme: 'classic', priorities: true };
    diagram!: DiagramController;

    async start(): Promise<void> {
        this.loadSettings();
        this.diagram = new DiagramController({ host: this, language: this.language, settings: this.settings, elk: createWorkerElk() });
        this.language.registerLanguage();
        this.createEditor();
        this.diagram.start();
        // manual layout (experimental): kept per file name in the local storage
        this.diagram.loadLayout(loadStoredLayout(this.fileName));
        this.bindToolbar();
        this.bindKeyboard();
        this.bindSplitter();
        this.applyTheme();
        await this.diagram.update();
    }

    /** The running simulation, if any. */
    get simulation(): SimulationSession | undefined {
        return this.diagram.simulation;
    }

    // -----------------------------------------------------------------------------------------
    // Setup

    private loadSettings(): void {
        try {
            const stored = localStorage.getItem(STORAGE_SETTINGS);
            if (stored) {
                Object.assign(this.settings, JSON.parse(stored));
            }
            this.fileName = localStorage.getItem(STORAGE_FILE) ?? this.fileName;
        } catch {
            // storage is not available
        }
    }

    private saveSettings(): void {
        try {
            localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(this.settings));
        } catch {
            // storage is not available
        }
    }

    private createEditor(): void {
        let text: string | null = null;
        try {
            text = localStorage.getItem(STORAGE_TEXT);
        } catch {
            // storage is not available
        }
        const initial = text ?? EXAMPLES[0]?.text ?? EMPTY_MODEL;
        if (text === null && EXAMPLES[0]) {
            this.fileName = EXAMPLES[0].fileName;
        }
        this.editor = monaco.editor.create(byId('editor'), {
            value: initial,
            language: LANGUAGE_ID,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            tabSize: 4,
            insertSpaces: true,
            scrollBeyondLastLine: false,
            renderWhitespace: 'none',
            fixedOverflowWidgets: true,
            theme: this.settings.theme === 'dark' ? EDITOR_THEMES.dark : EDITOR_THEMES.light
        });
        this.decorations = this.editor.createDecorationsCollection();
        byId('file-name').textContent = this.fileName;
        this.textVersion = this.editor.getModel()!.getAlternativeVersionId();
        this.editor.onDidChangeModelContent(event => {
            try {
                localStorage.setItem(STORAGE_TEXT, this.editor.getValue());
            } catch {
                // storage is not available
            }
            // keeps the layout history in sync with undo / redo in the text editor
            const previous = String(this.textVersion);
            this.textVersion = this.editor.getModel()!.getAlternativeVersionId();
            this.diagram?.textChanged(event.isUndoing ? 'undo' : event.isRedoing ? 'redo' : 'edit', previous);
            if (!this.applyingEdit) {
                this.diagram.scheduleUpdate();
            }
        });
        this.editor.onDidChangeCursorPosition(event => {
            if (event.source === 'api' || !this.editor.hasTextFocus()) {
                return;
            }
            clearTimeout(this.cursorTimer);
            this.cursorTimer = setTimeout(() => this.selectElementAtCursor(), 200);
        });
    }

    private bindToolbar(): void {
        const examples = byId<HTMLSelectElement>('example-select');
        for (const example of EXAMPLES) {
            examples.append(h('option', { value: example.fileName }, example.title));
        }
        examples.addEventListener('change', () => {
            const example = EXAMPLES.find(e => e.fileName === examples.value);
            examples.value = '';
            if (example) {
                this.loadText(example.text, example.fileName);
            }
        });
        byId('btn-new').addEventListener('click', () => this.loadText(EMPTY_MODEL, 'statemachine.hsm', null));
        const fileInput = byId<HTMLInputElement>('file-input');
        byId('btn-open').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
            const files = [...fileInput.files ?? []];
            // a layout file (`model.hsm.layout`) can be opened together with its model or alone (for the current model)
            const layoutFile = files.find(f => f.name.endsWith(LAYOUT_FILE_EXTENSION));
            const file = files.find(f => f !== layoutFile);
            if (layoutFile && !file) {
                await this.openLayoutFile(layoutFile);
                fileInput.value = '';
                return;
            }
            if (file && /\.sct$/i.test(file.name)) {
                // itemis CREATE / YAKINDU statechart: convert to HSM text (and the diagram into a manual layout)
                try {
                    const { text, warnings, layout } = importSct(await file.text());
                    this.loadText(text, file.name.replace(/\.sct$/i, '.hsm'), layout ?? null);
                    warnings.forEach(warning => console.warn(`${file.name}: ${warning}`));
                    this.setStatus(warnings.length > 0 ? `Imported ${file.name} with ${warnings.length} warning(s): ${warnings.join(' ')}` : `Imported ${file.name}.`,
                        warnings.length > 0 ? 'warning' : 'info');
                } catch (error) {
                    this.setStatus(`Import of ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
                }
            } else if (file) {
                let layout: ManualLayout | undefined;
                if (layoutFile) {
                    try {
                        layout = parseManualLayout(await layoutFile.text());
                    } catch (error) {
                        this.setStatus(`${layoutFile.name}: ${error instanceof Error ? error.message : String(error)}`, 'error');
                    }
                }
                this.loadText(await file.text(), file.name, layout);
            }
            fileInput.value = '';
        });
        byId('btn-save').addEventListener('click', () => {
            download(this.fileName, this.editor.getValue(), 'text/plain');
            const layout = this.diagram.manualLayout;
            if (layout) {
                // the layout is saved next to the model (sidecar file)
                setTimeout(() => download(layoutFileName(this.fileName), serializeManualLayout(layout), 'application/json'), 300);
            }
        });
        byId('btn-undo').addEventListener('click', () => this.diagram.undo());
        byId('btn-redo').addEventListener('click', () => this.diagram.redo());
        byId('btn-format').addEventListener('click', () => this.editor.getAction('editor.action.formatDocument')?.run());

        const direction = byId<HTMLSelectElement>('direction-select');
        direction.value = this.settings.direction;
        direction.addEventListener('change', () => {
            this.settings.direction = direction.value as LayoutDirection;
            this.saveSettings();
            this.diagram.directionChanged();
            this.diagram.relayout(true);
        });
        const routing = byId<HTMLSelectElement>('routing-select');
        routing.value = this.settings.routing;
        routing.addEventListener('change', () => {
            this.settings.routing = routing.value as EdgeRouting;
            this.saveSettings();
            this.diagram.relayout();
        });
        const priorities = byId<HTMLInputElement>('priorities-toggle');
        priorities.checked = this.settings.priorities;
        priorities.addEventListener('change', () => {
            this.settings.priorities = priorities.checked;
            this.saveSettings();
            this.diagram.relayout();
        });
        const theme = byId<HTMLSelectElement>('theme-select');
        theme.value = this.settings.theme;
        theme.addEventListener('change', () => {
            this.settings.theme = theme.value as Settings['theme'];
            this.saveSettings();
            this.applyTheme();
        });
        byId('btn-simulate').addEventListener('click', () => this.diagram.simulation ? this.diagram.stopSimulation() : this.diagram.startSimulation());
        byId('btn-svg').addEventListener('click', () => this.exportSvg());
        byId('btn-plantuml').addEventListener('click', () => this.showPlantUml());
        byId('modal-close').addEventListener('click', () => this.closeModal());
        byId('modal').addEventListener('click', event => {
            if (event.target === byId('modal')) {
                this.closeModal();
            }
        });
        byId('status-problems').addEventListener('click', () => {
            this.editor.focus();
            this.editor.getAction('editor.action.marker.next')?.run();
        });
    }

    private bindKeyboard(): void {
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !byId('modal').hidden) {
                this.closeModal();
                event.stopImmediatePropagation();
            }
        }, { capture: true });
    }

    private bindSplitter(): void {
        const splitter = byId('splitter');
        const main = document.querySelector('main')!;
        if (this.settings.editorWidth) {
            main.style.setProperty('--editor-width', this.settings.editorWidth);
        }
        splitter.addEventListener('pointerdown', event => {
            splitter.setPointerCapture(event.pointerId);
            splitter.classList.add('dragging');
            const move = (e: PointerEvent) => {
                const bounds = main.getBoundingClientRect();
                const width = Math.min(Math.max(e.clientX - bounds.left, 180), bounds.width - 300);
                this.settings.editorWidth = `${width}px`;
                main.style.setProperty('--editor-width', this.settings.editorWidth);
            };
            const up = () => {
                splitter.classList.remove('dragging');
                splitter.removeEventListener('pointermove', move);
                splitter.removeEventListener('pointerup', up);
                this.saveSettings();
            };
            splitter.addEventListener('pointermove', move);
            splitter.addEventListener('pointerup', up);
        });
    }

    private applyTheme(): void {
        this.diagram.applyTheme();
        document.body.classList.toggle('ui-dark', this.settings.theme === 'dark');
        monaco.editor.setTheme(this.settings.theme === 'dark' ? EDITOR_THEMES.dark : EDITOR_THEMES.light);
    }

    /**
     * Loads a model. `layout`: its manual layout (undefined: the layout stored for the file name, null: none).
     */
    private loadText(text: string, fileName: string, layout?: ManualLayout | null): void {
        this.diagram.reset();
        this.fileName = fileName;
        const manual = layout === undefined ? loadStoredLayout(fileName) : layout ?? undefined;
        if (layout !== undefined) {
            storeLayout(fileName, manual);
        }
        this.diagram.loadLayout(manual, false);
        byId('file-name').textContent = fileName;
        try {
            localStorage.setItem(STORAGE_FILE, fileName);
        } catch {
            // storage is not available
        }
        this.editor.setValue(text);
        this.diagram.update(true);
    }

    private async openLayoutFile(file: File): Promise<void> {
        try {
            this.diagram.replaceLayout(parseManualLayout(await file.text()));
            this.setStatus(`Layout ${file.name} applied to ${this.fileName}.`);
        } catch (error) {
            this.setStatus(`${file.name}: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
    }

    private selectElementAtCursor(): void {
        const position = this.editor.getPosition();
        if (position) {
            this.diagram.selectElementAtOffset(this.editor.getModel()!.getOffsetAt(position));
        }
    }

    // -----------------------------------------------------------------------------------------
    // DiagramHost: the Monaco editor holds the text

    getText(): string {
        return this.editor.getValue();
    }

    async applyTextEdits(edits: readonly TextEdit[]): Promise<boolean> {
        const operations = edits.map(edit => ({ range: this.toRange({ offset: edit.offset, end: edit.offset + edit.length }), text: edit.text, forceMoveMarkers: true }));
        this.applyingEdit = true;
        try {
            this.editor.pushUndoStop();
            this.editor.executeEdits('diagram', operations);
            this.editor.pushUndoStop();
        } finally {
            this.applyingEdit = false;
        }
        return true;
    }

    modelParsed(parsed: ParsedModel): void {
        HsmLanguageSupport.setMarkers(this.editor.getModel()!, parsed.diagnostics);
        this.showProblemCount(parsed);
    }

    highlightText(range: TextRange | undefined): void {
        if (!range) {
            this.decorations.clear();
            return;
        }
        const monacoRange = this.toRange(range);
        this.decorations.set([{ range: monacoRange, options: { className: 'hsm-selected-range', isWholeLine: false } }]);
        this.editor.revealRangeInCenterIfOutsideViewport(monacoRange, monaco.editor.ScrollType.Smooth);
    }

    selectText(range: TextRange): void {
        const monacoRange = this.toRange(range);
        this.editor.setSelection(monacoRange);
        this.editor.revealRangeInCenterIfOutsideViewport(monacoRange, monaco.editor.ScrollType.Smooth);
        this.decorations.set([{ range: monacoRange, options: { className: 'hsm-selected-range', isWholeLine: false } }]);
    }

    editTextAt(offset: number): void {
        const position = this.editor.getModel()!.getPositionAt(offset);
        this.editor.setPosition(position);
        this.editor.revealPositionInCenterIfOutsideViewport(position);
        this.editor.focus();
    }

    textHasFocus(): boolean {
        return this.editor.hasTextFocus();
    }

    /** Manual layout: kept per file name in the local storage (Save downloads it as `.hsm.layout`). */
    layoutChanged(layout: ManualLayout | undefined): void {
        storeLayout(this.fileName, layout);
    }

    textStateKey(): string {
        return String(this.editor.getModel()!.getAlternativeVersionId());
    }

    undo(): void {
        this.undoRedo('undo');
    }

    redo(): void {
        this.undoRedo('redo');
    }

    /** Undo / redo on the text model, also when the editor does not have the focus. */
    private undoRedo(command: 'undo' | 'redo'): void {
        const model = this.editor.getModel() as unknown as Partial<Record<'undo' | 'redo', () => void>> | null;
        const operation = model?.[command];
        if (typeof operation === 'function') {
            operation.call(model);
        } else {
            this.editor.focus();
            this.editor.trigger('toolbar', command, null);
        }
    }

    simulationStateChanged(running: boolean): void {
        this.editor.updateOptions(running ? { readOnly: true, readOnlyMessage: { value: 'Stop the simulation to edit the model.' } } : { readOnly: false });
        // undo / redo, format and layout settings are disabled while simulating
        for (const id of ['btn-undo', 'btn-redo', 'btn-format', 'direction-select', 'routing-select', 'priorities-toggle']) {
            byId<HTMLButtonElement>(id).disabled = running;
        }
        const button = byId('btn-simulate');
        button.textContent = running ? '■ Stop' : '▶ Simulate';
        button.title = running ? 'Stop the simulation and return to editing' : 'Simulate the state machine (the model must not contain errors)';
        button.classList.toggle('active', running);
    }

    private toRange(range: TextRange): monaco.Range {
        const model = this.editor.getModel()!;
        const start = model.getPositionAt(range.offset);
        const end = model.getPositionAt(range.end);
        return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
    }

    private showProblemCount(parsed: ParsedModel): void {
        const errors = parsed.diagnostics.filter(d => d.severity === 1).length;
        const warnings = parsed.diagnostics.filter(d => d.severity === 2).length;
        const element = byId('status-problems');
        element.className = errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok';
        element.textContent = errors + warnings === 0
            ? '✓ No problems'
            : `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
        element.title = parsed.diagnostics.map(d => `${d.range.start.line + 1}: ${d.message}`).join('\n');
    }

    // -----------------------------------------------------------------------------------------
    // Export

    private exportSvg(): void {
        const svg = this.diagram.exportSvg();
        if (svg) {
            download(this.fileName.replace(/\.[^.]+$/, '') + '.svg', svg, 'image/svg+xml');
        }
    }

    private async showPlantUml(): Promise<void> {
        const state = this.diagram.model;
        if (!state) {
            return;
        }
        const text = generatePlantUml(state.parsed.model);
        const textarea = h('textarea', { readonly: true, spellcheck: 'false' });
        textarea.value = text;
        const copy = h('button', {
            onClick: async () => {
                await navigator.clipboard.writeText(text);
                copy.textContent = 'Copied ✓';
            }
        }, 'Copy');
        const save = h('button', { onClick: () => download(this.fileName.replace(/\.[^.]+$/, '') + '.puml', text, 'text/plain') }, 'Download .puml');
        const link = h('a', { target: '_blank', rel: 'noopener' }, 'Open on plantuml.com ↗');
        plantUmlServerUrl(text, 'uml').then(url => link.setAttribute('href', url)).catch(() => link.remove());
        this.openModal('PlantUML', h('div', {}, textarea, h('div', { class: 'actions' }, copy, save, h('span', { class: 'spacer' }), link)));
    }

    private openModal(title: string, content: HTMLElement): void {
        byId('modal-title').textContent = title;
        const body = byId('modal-body');
        body.replaceChildren(content);
        byId('modal').hidden = false;
    }

    private closeModal(): void {
        byId('modal').hidden = true;
    }

    private statusTimer?: ReturnType<typeof setTimeout>;

    setStatus(message: string, severity: StatusSeverity = 'info'): void {
        const element = byId('status-message');
        element.textContent = message;
        element.className = severity === 'info' ? '' : severity;
        clearTimeout(this.statusTimer);
        this.statusTimer = setTimeout(() => {
            element.textContent = '';
        }, 6000);
    }
}
