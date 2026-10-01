import { monaco } from './monaco.js';
import {
    importSct, importSctFiles, type DiagramSubmachine, type EdgeRouting, type LayoutDirection, type ParsedModel, type TextEdit
} from 'hsm-language';
import { EDITOR_THEMES, HsmLanguageSupport, LANGUAGE_ID } from './language-support.js';
import { DiagramController, type DiagramHost, type DiagramSettings, type StatusSeverity, type TextRange } from './diagram-controller.js';
import { createWorkerElk } from './diagram/elk.js';
import { byId, download, h } from './ui/dom.js';
import type { SimulationSession } from './simulation/session.js';
import { EMPTY_MODEL, EXAMPLE_HEADERS, EXAMPLES } from './examples.js';
import { HttpHost } from './host.js';

export type { Tool } from './diagram-controller.js';

interface Settings extends DiagramSettings {
    editorWidth?: string;
}

const STORAGE_TEXT = 'hsm-modeler.text';
const STORAGE_SETTINGS = 'hsm-modeler.settings';
const STORAGE_FILE = 'hsm-modeler.file';
const STORAGE_FILES = 'hsm-modeler.files';
/** Directory of the virtual files of the web app: imports are resolved against it. */
const FILE_BASE = 'memory:///';
/** Value prefix of the files in the example list. */
const FILE_OPTION = 'file:';

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
    /**
     * The virtual workspace: opened files and edited files by file name (flat, all in one directory).
     * Imports (`import "motor.hsm"`) are resolved against these files and the examples.
     */
    private readonly files = new Map<string, string>();
    private settings: Settings = { direction: 'DOWN', routing: 'SPLINES', theme: 'classic', priorities: true };
    /**
     * The application that embeds the app (`?host=http`, e.g. the Eclipse plugin): it holds the edited file,
     * its text is not kept in the browser storage and examples are not offered.
     */
    private readonly host = HttpHost.detect();
    /** The text of the host's file (embedded app only). */
    private hostText?: string;
    diagram!: DiagramController;

    async start(): Promise<void> {
        this.loadSettings();
        if (this.host) {
            await this.loadHostDocument();
        }
        this.diagram = new DiagramController({ host: this, language: this.language, settings: this.settings, elk: createWorkerElk() });
        this.language.registerLanguage();
        this.createEditor();
        this.diagram.start();
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
            if (this.host) {
                return;
            }
            this.fileName = localStorage.getItem(STORAGE_FILE) ?? this.fileName;
            const files = JSON.parse(localStorage.getItem(STORAGE_FILES) ?? '{}') as Record<string, string>;
            for (const [name, text] of Object.entries(files)) {
                if (typeof text === 'string') {
                    this.files.set(name, text);
                }
            }
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
        let text: string | null = this.hostText ?? null;
        try {
            text ??= localStorage.getItem(STORAGE_TEXT);
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
        this.updateWorkspace();
        this.editor.onDidChangeModelContent(() => {
            if (this.host) {
                this.host.changed(() => this.editor.getValue());
            } else {
                try {
                    localStorage.setItem(STORAGE_TEXT, this.editor.getValue());
                } catch {
                    // storage is not available
                }
            }
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
        const exampleGroup = h('optgroup', { label: 'Examples' });
        for (const example of EXAMPLES) {
            exampleGroup.append(h('option', { value: example.fileName }, example.title));
        }
        examples.append(exampleGroup);
        examples.addEventListener('change', () => {
            const value = examples.value;
            const example = EXAMPLES.find(e => e.fileName === value);
            examples.value = '';
            if (value.startsWith(FILE_OPTION)) {
                // a file of the virtual workspace (with its edits)
                this.openFile(value.slice(FILE_OPTION.length));
            } else if (example) {
                this.loadText(example.text, example.fileName);
            }
        });
        byId('btn-new').addEventListener('click', () => this.loadText(EMPTY_MODEL, 'statemachine.hsm'));
        const fileInput = byId<HTMLInputElement>('file-input');
        byId('btn-open').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
            const all = [...fileInput.files ?? []];
            // C/C++ headers: added to the virtual workspace (models import them), not edited
            const headers = all.filter(f => isHeaderFile(f.name));
            const selected = all.filter(f => !isHeaderFile(f.name));
            for (const header of headers) {
                this.files.set(header.name, await header.text());
            }
            if (headers.length > 0) {
                this.saveFiles();
                if (selected.length === 0) {
                    this.updateWorkspace();
                    this.diagram.update(true);
                    this.setStatus(`Added ${headers.map(f => f.name).join(', ')}: models import ${headers.length === 1 ? 'it' : 'them'} with import "${headers[0].name}".`);
                    fileInput.value = '';
                    return;
                }
            }
            const models = selected.filter(f => !/\.sct$/i.test(f.name));
            const statecharts = selected.filter(f => /\.sct$/i.test(f.name));
            if (statecharts.length > 1) {
                // several itemis CREATE statecharts: submachine states referencing each other become instances
                try {
                    const results = importSctFiles(await Promise.all(statecharts.map(async f => ({ fileName: f.name, xml: await f.text() }))));
                    // (the diagrams are imported as layout annotations)
                    for (const result of results) {
                        this.files.set(result.fileName, result.text);
                    }
                    this.saveFiles();
                    this.loadText(results[0].text, results[0].fileName);
                    const warnings = results.flatMap(r => r.warnings);
                    this.setStatus(`Imported ${statecharts.map(f => f.name).join(', ')}${warnings.length > 0 ? ` with ${warnings.length} warning(s): ${warnings.join(' ')}` : '.'}`,
                        warnings.length > 0 ? 'warning' : 'info');
                } catch (error) {
                    this.setStatus(`Import failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
                }
                fileInput.value = '';
                return;
            }
            if (models.length > 1 || (models.length === 1 && selected.length > 1)) {
                // several files: all of them are available for imports, the first one is edited
                for (const model of models) {
                    this.files.set(model.name, await model.text());
                }
                this.saveFiles();
                const first = models[0];
                this.loadText(this.files.get(first.name)!, first.name);
                this.setStatus(`Opened ${first.name}; ${models.slice(1).map(m => m.name).join(', ')} can be imported (and opened from the list of examples and files).`);
                fileInput.value = '';
                return;
            }
            const file = selected[0];
            if (file && /\.sct$/i.test(file.name)) {
                // itemis CREATE / YAKINDU statechart: convert to HSM text (the diagram into layout annotations)
                try {
                    const { text, warnings } = importSct(await file.text());
                    this.loadText(text, file.name.replace(/\.sct$/i, '.hsm'));
                    warnings.forEach(warning => console.warn(`${file.name}: ${warning}`));
                    this.setStatus(warnings.length > 0 ? `Imported ${file.name} with ${warnings.length} warning(s): ${warnings.join(' ')}` : `Imported ${file.name}.`,
                        warnings.length > 0 ? 'warning' : 'info');
                } catch (error) {
                    this.setStatus(`Import of ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
                }
            } else if (file) {
                this.files.set(file.name, await file.text());
                this.saveFiles();
                this.loadText(this.files.get(file.name)!, file.name);
            }
            fileInput.value = '';
        });
        byId('btn-save').addEventListener('click', () => this.save());
        if (this.host) {
            // the files come from the host (e.g. the Eclipse workspace)
            for (const id of ['example-select', 'btn-new', 'btn-open']) {
                byId(id).hidden = true;
            }
            byId('btn-save').title = 'Save the model (Ctrl+S)';
        }
        byId('btn-undo').addEventListener('click', () => this.diagram.undo());
        byId('btn-redo').addEventListener('click', () => this.diagram.redo());
        byId('btn-format').addEventListener('click', () => this.editor.getAction('editor.action.formatDocument')?.run());

        const direction = byId<HTMLSelectElement>('direction-select');
        direction.value = this.settings.direction;
        direction.addEventListener('change', () => {
            this.settings.direction = direction.value as LayoutDirection;
            this.saveSettings();
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
        byId('btn-export').addEventListener('click', () => this.showExport());
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
            } else if (this.host && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
                event.preventDefault();
                event.stopImmediatePropagation();
                this.save();
            }
        }, { capture: true });
    }

    /** *Save*: downloads the model, or saves it in the host. */
    private save(): void {
        if (this.host) {
            this.host.save(this.editor.getValue()).then(
                () => this.setStatus(`Saved ${this.fileName}.`),
                error => this.setStatus(`Save failed: ${error instanceof Error ? error.message : String(error)}`, 'error'));
        } else {
            download(this.fileName, this.editor.getValue(), 'text/plain');
        }
    }

    // -----------------------------------------------------------------------------------------
    // Embedded app (`?host=http`)

    /** Takes the edited file and the files it may import from the host. */
    private async loadHostDocument(): Promise<void> {
        const document = await this.host!.load();
        this.fileName = document.fileName;
        this.hostText = document.text;
        this.files.clear();
        for (const [name, text] of Object.entries(document.files ?? {})) {
            this.files.set(name, text);
        }
        this.files.set(this.fileName, document.text);
    }

    /**
     * Called by the host when files were changed outside of the app: loads the files the model may
     * import again and, with `replaceText` (the edited file was changed, e.g. by another editor), its text.
     */
    async reloadFromHost(replaceText = false): Promise<void> {
        if (!this.host) {
            return;
        }
        const text = this.editor.getValue();
        await this.loadHostDocument();
        if (!replaceText) {
            this.files.set(this.fileName, text);
        } else if (text !== this.hostText) {
            if (this.diagram.simulation) {
                this.diagram.stopSimulation();
            }
            // an edit (not setValue): undo stays possible
            const model = this.editor.getModel()!;
            this.applyingEdit = true;
            try {
                this.editor.pushUndoStop();
                this.editor.executeEdits('host', [{ range: model.getFullModelRange(), text: this.hostText! }]);
                this.editor.pushUndoStop();
            } finally {
                this.applyingEdit = false;
            }
        }
        this.updateWorkspace();
        await this.diagram.update(true);
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

    /** Loads a model (its layout annotations, if any, are its manual layout). */
    private loadText(text: string, fileName: string): void {
        if (this.diagram.simulation) {
            this.diagram.stopSimulation();
        }
        // the edited text of the current file stays available (for imports and to switch back)
        if (this.editor && fileName !== this.fileName && this.files.has(this.fileName)) {
            this.files.set(this.fileName, this.editor.getValue());
        }
        if (!this.files.has(fileName) && (/\.hsm$/i.test(fileName))) {
            this.files.set(fileName, text);
        }
        this.saveFiles();
        this.diagram.reset();
        this.fileName = fileName;
        this.updateWorkspace();
        byId('file-name').textContent = fileName;
        try {
            localStorage.setItem(STORAGE_FILE, fileName);
        } catch {
            // storage is not available
        }
        this.editor.setValue(text);
        this.diagram.update(true);
    }

    private selectElementAtCursor(): void {
        const position = this.editor.getPosition();
        if (position) {
            this.diagram.selectElementAtOffset(this.editor.getModel()!.getOffsetAt(position));
        }
    }

    // -----------------------------------------------------------------------------------------
    // Virtual workspace (imports)

    /** The texts the edited file may import: the examples, overridden by the opened / edited files. */
    private workspaceFiles(): Record<string, string> {
        const files: Record<string, string> = {};
        if (!this.host) {
            for (const example of EXAMPLES) {
                files[FILE_BASE + example.fileName] = example.text;
            }
            for (const [name, text] of Object.entries(EXAMPLE_HEADERS)) {
                files[FILE_BASE + name] = text;
            }
        }
        for (const [name, text] of this.files) {
            files[FILE_BASE + name] = text;
        }
        delete files[FILE_BASE + this.fileName];
        return files;
    }

    /** Passes the virtual workspace to the language service and updates the file list. */
    private updateWorkspace(): void {
        if (this.editor && this.files.has(this.fileName)) {
            this.files.set(this.fileName, this.editor.getValue());
        }
        this.language.setWorkspace(FILE_BASE + this.fileName, this.workspaceFiles());
        this.updateFileList();
    }

    /** The file list: opened / edited files, the edited file and the files it imports. */
    private updateFileList(imported: string[] = []): void {
        const select = byId<HTMLSelectElement>('example-select');
        const names = [...new Set([...this.files.keys(), this.fileName, ...imported])].filter(name => name !== this.fileName).sort();
        if (select.dataset.files === names.join('\n')) {
            return;
        }
        select.dataset.files = names.join('\n');
        select.querySelector('optgroup.files')?.remove();
        if (names.length > 0) {
            select.append(h('optgroup', { label: 'Files (imports resolve against them)', class: 'files' },
                ...names.map(name => h('option', { value: FILE_OPTION + name }, name))));
        }
    }

    /** Opens a file of the virtual workspace or an example by file name; false if it is not available. */
    private openFile(fileName: string): boolean {
        if (isHeaderFile(fileName)) {
            this.setStatus(`${fileName} is a C/C++ header: models import it with import "${fileName}" (hover a C++ name to see its declaration).`);
            return true;
        }
        const text = this.files.get(fileName) ?? EXAMPLES.find(e => e.fileName === fileName)?.text;
        if (text === undefined) {
            return false;
        }
        this.loadText(text, fileName);
        return true;
    }

    private saveFiles(): void {
        if (this.host) {
            return;
        }
        try {
            localStorage.setItem(STORAGE_FILES, JSON.stringify(Object.fromEntries(this.files)));
        } catch {
            // storage is not available
        }
    }

    /** Double-click on a submachine state: opens the file of its state machine if it is available. */
    openStateMachine(submachine: DiagramSubmachine): boolean {
        if (this.host && submachine.uri?.startsWith(FILE_BASE)) {
            // the host opens the file in its own editor
            const path = decodeURIComponent(submachine.uri.substring(FILE_BASE.length));
            this.host.open(path).then(opened => {
                if (!opened) {
                    this.setStatus(`The file ${path} of the state machine ${submachine.machine} could not be opened.`, 'warning');
                }
            }, error => this.setStatus(String(error), 'error'));
            return true;
        }
        const fileName = submachine.uri?.startsWith('memory:') ? decodeURIComponent(submachine.uri.replace(/^.*\//, '')) : undefined;
        if (fileName && this.openFile(fileName)) {
            this.setStatus(`Opened ${fileName} (state machine ${submachine.machine} of the instance ${submachine.instance}).`);
            return true;
        }
        this.setStatus(`The file of the state machine ${submachine.machine} is not available – open it with Open….`, 'warning');
        return false;
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
        this.updateFileList(parsed.imported.map(i => decodeURIComponent(i.uri.replace(/^.*\//, ''))));
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

    /** Export of the diagram as SVG or PNG (chosen in a dialog). */
    private showExport(): void {
        const base = this.fileName.replace(/\.[^.]+$/, '');
        const store = async (fileName: string, content: string | Blob, type: string) => {
            if (this.host) {
                // embedded browsers do not offer downloads: the host stores the file
                this.setStatus(await this.host.export(fileName, content));
            } else {
                download(fileName, content, type);
            }
        };
        const choose = (format: 'svg' | 'png') => async () => {
            this.closeModal();
            try {
                if (format === 'svg') {
                    const svg = this.diagram.exportSvg();
                    if (svg) {
                        await store(`${base}.svg`, svg, 'image/svg+xml');
                    }
                } else {
                    const png = await this.diagram.exportPng();
                    if (png) {
                        await store(`${base}.png`, png, 'image/png');
                    }
                }
            } catch (error) {
                this.setStatus(`Export failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
            }
        };
        this.openModal('Export diagram', h('div', { class: 'export-choice' },
            h('p', {}, 'The diagram as shown (theme and layout), without the selection.'),
            h('div', { class: 'actions' },
                h('button', { title: 'Scalable vector graphic, e.g. for the web or for further editing', onClick: choose('svg') }, 'SVG'),
                h('button', { title: 'Image with twice the screen resolution, e.g. for documents and slides', onClick: choose('png') }, 'PNG'))));
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

/** Whether a file name is a C/C++ header (imported by models, not edited). */
function isHeaderFile(fileName: string): boolean {
    return /\.(h|hh|hpp|hxx|h\+\+|inl)$/i.test(fileName);
}
