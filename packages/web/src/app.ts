import { monaco } from './monaco.js';
import type { Container } from 'inversify';
import { LocalModelSource, TYPES, type IActionDispatcher, type SModelElementImpl } from 'sprotty';
import { FitToScreenAction, SelectAction, SelectAllAction, CenterAction } from 'sprotty-protocol';
import type { AstNode } from 'langium';
import {
    EditError, ModelEditor, generatePlantUml, isScopeContainer, isValidIdentifier, isPseudoState, isRegion, isState, isStateMachine,
    isTransition, isVertex, layoutStateMachine, scopeOf, transitionLabel, MACHINE_ID,
    nodeText as nodeTextOf, type DeletionTarget, type DiagramNode, type DiagramNodeKind, type EdgeRouting, type EditResult, type LayoutDirection, type LayoutResult,
    type ParsedModel, type ScopeContainer, type TransitionSource, type TransitionTarget, type Vertex
} from 'hsm-language';
import { importSct } from 'hsm-language';
import { HsmLanguageSupport, LANGUAGE_ID } from './language-support.js';
import { createDiagramContainer } from './diagram/di.config.js';
import type { DiagramCallbacks } from './diagram/listeners.js';
import { toSchema, type Issue } from './diagram/model.js';
import { canvasTextMeasure } from './diagram/text-measure.js';
import { createWorkerElk } from './diagram/elk.js';
import { byId, download, h } from './ui/dom.js';
import { Icons } from './ui/icons.js';
import { closeInlineEditor, showInlineEditor } from './ui/inline-editor.js';
import { exportSvg } from './ui/export-svg.js';
import { plantUmlServerUrl } from './ui/plantuml.js';
import { renderProperties, type PropertiesHost, type SelectionInfo } from './ui/properties.js';
import { EMPTY_MODEL, EXAMPLES } from './examples.js';

export type Tool = 'select' | 'state' | 'choice' | 'junction' | 'history' | 'deephistory' | 'initial' | 'final' | 'transition' | 'region';

interface ToolDescription {
    tool: Tool;
    label: string;
    key: string;
    icon: string;
    hint: string;
}

const TOOLS: Array<ToolDescription | 'separator'> = [
    { tool: 'select', label: 'Select / move', key: 'V', icon: Icons.select, hint: '' },
    'separator',
    { tool: 'state', label: 'State', key: 'S', icon: Icons.state, hint: 'Click on the canvas, a state or a region to add a state' },
    { tool: 'region', label: 'Orthogonal region', key: 'R', icon: Icons.region, hint: 'Click on a state to add a region' },
    { tool: 'choice', label: 'Choice', key: 'C', icon: Icons.choice, hint: 'Click on the canvas, a state or a region to add a choice' },
    { tool: 'junction', label: 'Junction', key: 'J', icon: Icons.junction, hint: 'Click on the canvas, a state or a region to add a junction' },
    { tool: 'history', label: 'Shallow history', key: 'H', icon: Icons.history, hint: 'Click on a composite state to add a history pseudo state' },
    { tool: 'deephistory', label: 'Deep history', key: 'D', icon: Icons.deephistory, hint: 'Click on a composite state to add a deep history pseudo state' },
    'separator',
    { tool: 'initial', label: 'Initial state', key: 'I', icon: Icons.initial, hint: 'Click on the state that should be the initial state of its parent' },
    { tool: 'final', label: 'Final state', key: 'F', icon: Icons.final, hint: 'Click on a state to add a transition to the final state' },
    { tool: 'transition', label: 'Transition', key: 'T', icon: Icons.transition, hint: 'Click on the source, then on the target of the transition' }
];

interface ModelState {
    parsed: ParsedModel;
    layout: LayoutResult;
    nodes: Map<string, DiagramNode>;
    issues: Map<string, Issue>;
}

interface Settings {
    direction: LayoutDirection;
    routing: EdgeRouting;
    theme: 'classic' | 'modern' | 'dark';
    editorWidth?: string;
}

const STORAGE_TEXT = 'hsm-modeler.text';
const STORAGE_SETTINGS = 'hsm-modeler.settings';
const STORAGE_FILE = 'hsm-modeler.file';

export class HsmApp implements PropertiesHost, DiagramCallbacks {

    readonly language = new HsmLanguageSupport();
    private editor!: monaco.editor.IStandaloneCodeEditor;
    private container!: Container;
    private modelSource!: LocalModelSource;
    private actionDispatcher!: IActionDispatcher;
    private decorations!: monaco.editor.IEditorDecorationsCollection;

    private state?: ModelState;
    private syntaxErrors = false;
    private rendered = false;
    private updateTimer?: ReturnType<typeof setTimeout>;
    private cursorTimer?: ReturnType<typeof setTimeout>;
    private updateVersion = 0;
    private applyingEdit = false;
    private pendingSelectOffset?: number;
    private pendingRename?: string;
    private fileName = 'statemachine.hsm';
    /** Fit the diagram to the screen once the next layout has been rendered. */
    private fitOnNextRender = false;

    private tool: Tool = 'select';
    private stickyTool = false;
    private pendingSource?: string;
    readonly selection = new Set<string>();
    private settings: Settings = { direction: 'DOWN', routing: 'SPLINES', theme: 'classic' };
    private readonly elk = createWorkerElk();

    async start(): Promise<void> {
        this.loadSettings();
        this.language.registerLanguage();
        this.createEditor();
        this.createDiagram();
        this.createPalette();
        this.bindToolbar();
        this.bindKeyboard();
        this.bindSplitter();
        this.applyTheme();
        await this.update();
    }

    // -----------------------------------------------------------------------------------------
    // Setup

    private loadSettings(): void {
        try {
            const stored = localStorage.getItem(STORAGE_SETTINGS);
            if (stored) {
                this.settings = { ...this.settings, ...JSON.parse(stored) };
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
            theme: this.settings.theme === 'dark' ? 'vs-dark' : 'vs'
        });
        this.decorations = this.editor.createDecorationsCollection();
        byId('file-name').textContent = this.fileName;
        this.editor.onDidChangeModelContent(() => {
            try {
                localStorage.setItem(STORAGE_TEXT, this.editor.getValue());
            } catch {
                // storage is not available
            }
            if (!this.applyingEdit) {
                this.scheduleUpdate();
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

    private createDiagram(): void {
        this.container = createDiagramContainer('sprotty', this);
        this.modelSource = this.container.get<LocalModelSource>(TYPES.ModelSource);
        this.actionDispatcher = this.container.get<IActionDispatcher>(TYPES.IActionDispatcher);
        new ResizeObserver(() => this.fitIfSmall()).observe(byId('diagram-area'));
    }

    private createPalette(): void {
        const palette = byId('palette');
        for (const entry of TOOLS) {
            if (entry === 'separator') {
                palette.append(h('div', { class: 'separator' }));
                continue;
            }
            palette.append(h('button', {
                'data-tool': entry.tool,
                title: `${entry.label} (${entry.key})`,
                'aria-label': entry.label,
                html: entry.icon,
                onClick: (event: MouseEvent) => this.setTool(entry.tool, event.shiftKey)
            }));
        }
        palette.append(h('div', { class: 'separator' }));
        palette.append(h('button', { title: 'Delete selection (Del)', 'aria-label': 'Delete', html: Icons.delete, onClick: () => this.deleteSelection() }));
        palette.append(h('button', { title: 'Re-layout diagram', 'aria-label': 'Re-layout', html: Icons.relayout, onClick: () => this.update(true) }));
        palette.append(h('button', { title: 'Fit to screen', 'aria-label': 'Fit to screen', html: Icons.fit, onClick: () => this.fit() }));
        this.updatePalette();
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
        byId('btn-new').addEventListener('click', () => this.loadText(EMPTY_MODEL, 'statemachine.hsm'));
        const fileInput = byId<HTMLInputElement>('file-input');
        byId('btn-open').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (file && /\.sct$/i.test(file.name)) {
                // itemis CREATE / YAKINDU statechart: convert to HSM text
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
                this.loadText(await file.text(), file.name);
            }
            fileInput.value = '';
        });
        byId('btn-save').addEventListener('click', () => download(this.fileName, this.editor.getValue(), 'text/plain'));
        byId('btn-undo').addEventListener('click', () => this.undo());
        byId('btn-redo').addEventListener('click', () => this.redo());
        byId('btn-format').addEventListener('click', () => this.editor.getAction('editor.action.formatDocument')?.run());

        const direction = byId<HTMLSelectElement>('direction-select');
        direction.value = this.settings.direction;
        direction.addEventListener('change', () => {
            this.settings.direction = direction.value as LayoutDirection;
            this.saveSettings();
            this.fitOnNextRender = true;
            this.update(true);
        });
        const routing = byId<HTMLSelectElement>('routing-select');
        routing.value = this.settings.routing;
        routing.addEventListener('change', () => {
            this.settings.routing = routing.value as EdgeRouting;
            this.saveSettings();
            this.update(true);
        });
        const theme = byId<HTMLSelectElement>('theme-select');
        theme.value = this.settings.theme;
        theme.addEventListener('change', () => {
            this.settings.theme = theme.value as Settings['theme'];
            this.saveSettings();
            this.applyTheme();
        });
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
        // note: sprotty replaces its base div when rendering, so listeners are registered on the parent
        const diagram = byId('diagram-area');
        diagram.addEventListener('keydown', event => {
            if (event.target instanceof HTMLInputElement) {
                return;
            }
            const ctrl = event.ctrlKey || event.metaKey;
            if (ctrl && event.key.toLowerCase() === 'z') {
                event.shiftKey ? this.redo() : this.undo();
                event.preventDefault();
            } else if (ctrl && event.key.toLowerCase() === 'y') {
                this.redo();
                event.preventDefault();
            } else if (event.key === 'Delete' || event.key === 'Backspace') {
                this.deleteSelection();
                event.preventDefault();
            } else if (event.key === 'F2') {
                const id = this.singleSelection();
                if (id) {
                    this.startRename(id);
                }
                event.preventDefault();
            } else if (event.key === 'Escape') {
                this.setTool('select');
            } else if (!ctrl && !event.altKey) {
                const entry = TOOLS.find((t): t is ToolDescription => t !== 'separator' && t.key.toLowerCase() === event.key.toLowerCase());
                if (entry) {
                    this.setTool(entry.tool, event.shiftKey);
                    event.preventDefault();
                }
            }
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !byId('modal').hidden) {
                this.closeModal();
            }
        });
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
        const diagram = byId('diagram-area');
        diagram.classList.remove('theme-classic', 'theme-modern', 'theme-dark');
        diagram.classList.add(`theme-${this.settings.theme}`);
        document.body.classList.toggle('ui-dark', this.settings.theme === 'dark');
        monaco.editor.setTheme(this.settings.theme === 'dark' ? 'vs-dark' : 'vs');
    }

    // -----------------------------------------------------------------------------------------
    // Model synchronization: text -> AST -> layout -> diagram

    private scheduleUpdate(delay = 350): void {
        clearTimeout(this.updateTimer);
        this.updateTimer = setTimeout(() => this.update(), delay);
    }

    /** Parses the current text and updates markers, diagram and properties. */
    async update(forceLayout = false): Promise<void> {
        clearTimeout(this.updateTimer);
        const version = ++this.updateVersion;
        const text = this.editor.getValue();
        const parsed = await this.language.parse(text);
        if (version !== this.updateVersion) {
            return;
        }
        const model = this.editor.getModel()!;
        HsmLanguageSupport.setMarkers(model, parsed.diagnostics);
        this.showProblemCount(parsed);
        this.syntaxErrors = parsed.hasSyntaxErrors;
        const banner = byId('diagram-banner');
        if (parsed.hasSyntaxErrors) {
            banner.hidden = false;
            banner.textContent = 'The text contains syntax errors – the diagram shows the last valid state.';
            this.renderPropertiesPanel();
            return;
        }
        banner.hidden = true;
        if (!forceLayout && this.state?.parsed.text === text) {
            return;
        }
        let layout: LayoutResult;
        try {
            layout = await layoutStateMachine(parsed.model, {
                direction: this.settings.direction,
                routing: this.settings.routing,
                measure: canvasTextMeasure,
                elk: this.elk
            });
        } catch (error) {
            console.error(error);
            banner.hidden = false;
            banner.textContent = `The diagram layout failed: ${error instanceof Error ? error.message : error}`;
            return;
        }
        if (version !== this.updateVersion) {
            return;
        }
        const nodes = new Map<string, DiagramNode>();
        const collect = (node: DiagramNode) => {
            nodes.set(node.id, node);
            node.children.forEach(collect);
        };
        layout.graph.children.forEach(collect);
        this.state = { parsed, layout, nodes, issues: this.computeIssues(parsed, layout, nodes) };

        // keep the selection for elements which still exist
        for (const id of [...this.selection]) {
            if (!layout.elements.has(id) || id === MACHINE_ID) {
                this.selection.delete(id);
            }
        }
        if (this.pendingSource && !nodes.has(this.pendingSource)) {
            this.pendingSource = undefined;
        }
        if (this.pendingSelectOffset !== undefined) {
            const id = this.elementAtOffset(this.pendingSelectOffset, true);
            this.pendingSelectOffset = undefined;
            if (id) {
                this.selection.clear();
                this.selection.add(id);
                this.revealInEditor(id);
            }
        }
        await this.render();
        if (this.pendingRename) {
            const name = this.pendingRename;
            this.pendingRename = undefined;
            const vertex = this.findVertex(name);
            const id = vertex && layout.ids.get(vertex);
            if (id) {
                requestAnimationFrame(() => requestAnimationFrame(() => this.startRename(id)));
            }
        }
    }

    private async render(): Promise<void> {
        if (!this.state) {
            return;
        }
        const schema = toSchema(this.state.layout.graph, {
            selected: this.selection,
            issues: this.state.issues,
            pendingSource: this.pendingSource
        });
        if (!this.rendered) {
            this.rendered = true;
            await this.modelSource.setModel(schema);
            requestAnimationFrame(() => this.fit(false));
        } else {
            await this.modelSource.updateModel(schema);
            if (this.fitOnNextRender) {
                this.fitOnNextRender = false;
                requestAnimationFrame(() => this.fit(false));
            }
        }
        this.renderPropertiesPanel();
    }

    private computeIssues(parsed: ParsedModel, layout: LayoutResult, nodes: Map<string, DiagramNode>): Map<string, Issue> {
        const issues = new Map<string, Issue>();
        const textDocument = parsed.document.textDocument;
        for (const diagnostic of parsed.diagnostics) {
            if (diagnostic.severity !== 1 && diagnostic.severity !== 2) {
                continue;
            }
            const id = this.elementAtOffset(textDocument.offsetAt(diagnostic.range.start), false, layout, nodes);
            if (!id) {
                continue;
            }
            const severity = diagnostic.severity === 1 ? 'error' : 'warning';
            const issue = issues.get(id) ?? { severity, messages: [] };
            if (severity === 'error') {
                issue.severity = 'error';
            }
            issue.messages.push(typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value);
            issues.set(id, issue);
        }
        return issues;
    }

    /** Finds the innermost diagram element whose text contains the offset. */
    private elementAtOffset(offset: number, exactStart: boolean, layout = this.state?.layout, nodes = this.state?.nodes): string | undefined {
        if (!layout || !nodes) {
            return undefined;
        }
        let best: { id: string, length: number } | undefined;
        for (const [id, node] of layout.elements) {
            const kind = nodes.get(id)?.kind;
            if (id === MACHINE_ID || kind === 'initial' || kind === 'final') {
                continue;
            }
            const cst = node.$cstNode;
            if (!cst) {
                continue;
            }
            if (exactStart && cst.offset === offset) {
                return id;
            }
            if (cst.offset <= offset && offset <= cst.end && (!best || cst.length < best.length)) {
                best = { id, length: cst.length };
            }
        }
        return best?.id;
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
    // Editing: every diagram operation becomes a text edit

    /**
     * Computes text edits based on the current model and applies them to the editor
     * (undoable with Ctrl+Z), then updates the diagram.
     */
    async applyEdit(producer: (editor: ModelEditor, state: ModelState) => EditResult | undefined): Promise<boolean> {
        if (!this.state || this.state.parsed.text !== this.editor.getValue()) {
            await this.update();
        }
        if (!this.state || this.syntaxErrors) {
            this.setStatus('Please fix the syntax errors in the text first.', 'error');
            return false;
        }
        let result: EditResult | undefined;
        try {
            result = producer(new ModelEditor(this.state.parsed.text, this.state.parsed.model), this.state);
        } catch (error) {
            if (error instanceof EditError) {
                this.setStatus(error.message, 'error');
                return false;
            }
            throw error;
        }
        if (!result || result.edits.length === 0) {
            return false;
        }
        const model = this.editor.getModel()!;
        const edits = result.edits.map(edit => {
            const start = model.getPositionAt(edit.offset);
            const end = model.getPositionAt(edit.offset + edit.length);
            return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: edit.text, forceMoveMarkers: true };
        });
        this.applyingEdit = true;
        try {
            this.editor.pushUndoStop();
            this.editor.executeEdits('diagram', edits);
            this.editor.pushUndoStop();
        } finally {
            this.applyingEdit = false;
        }
        this.pendingSelectOffset = result.selectOffset;
        await this.update();
        return true;
    }

    private undo(): void {
        this.undoRedo('undo');
    }

    private redo(): void {
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

    private loadText(text: string, fileName: string): void {
        this.fileName = fileName;
        byId('file-name').textContent = fileName;
        try {
            localStorage.setItem(STORAGE_FILE, fileName);
        } catch {
            // storage is not available
        }
        this.selection.clear();
        this.pendingSource = undefined;
        this.fitOnNextRender = true;
        this.editor.setValue(text);
        this.update(true);
    }

    // -----------------------------------------------------------------------------------------
    // Tools and diagram interaction

    setTool(tool: Tool, sticky = false): void {
        closeInlineEditor();
        this.tool = tool;
        this.stickyTool = sticky;
        if (this.pendingSource) {
            this.pendingSource = undefined;
            this.render();
        }
        this.updatePalette();
        this.focusDiagram();
    }

    private focusDiagram(): void {
        const svg = document.querySelector<SVGElement>('#sprotty svg');
        (svg ?? byId('sprotty')).focus({ preventScroll: true });
    }

    private toolDone(): void {
        if (!this.stickyTool) {
            this.setTool('select');
        } else {
            this.updatePalette();
        }
    }

    private updatePalette(): void {
        for (const button of byId('palette').querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
            button.classList.toggle('active', button.dataset.tool === this.tool);
        }
        byId('diagram-area').classList.toggle('tool-active', this.tool !== 'select');
        const description = TOOLS.find((t): t is ToolDescription => t !== 'separator' && t.tool === this.tool);
        let hint = description?.hint ?? '';
        if (this.tool === 'transition' && this.pendingSource) {
            hint = 'Now click on the target (Esc to cancel)';
        }
        if (hint && this.stickyTool) {
            hint += ' – tool stays active, Esc to finish';
        }
        const element = byId('diagram-hint');
        element.textContent = hint;
        element.classList.toggle('visible', hint.length > 0);
    }

    /** The id of the diagram element (or its nearest ancestor) known to the layout. */
    private diagramId(target: SModelElementImpl): string | undefined {
        let current: SModelElementImpl | undefined = target;
        while (current) {
            if (this.state?.layout.elements.has(current.id)) {
                return current.id;
            }
            current = 'parent' in current ? (current as { parent?: SModelElementImpl }).parent : undefined;
        }
        return undefined;
    }

    private kindOf(id: string): DiagramNodeKind | 'transition' | 'machine' | undefined {
        if (id === MACHINE_ID) {
            return 'machine';
        }
        const node = this.state?.nodes.get(id);
        if (node) {
            return node.kind;
        }
        return isTransition(this.state?.layout.elements.get(id)) ? 'transition' : undefined;
    }

    private astOf(id: string): AstNode | undefined {
        return this.state?.layout.elements.get(id);
    }

    /** The container (state machine, state or region) new elements are added to when clicking on the element. */
    private containerAt(id: string | undefined): ScopeContainer | undefined {
        if (!id) {
            return undefined;
        }
        const kind = this.kindOf(id);
        const node = this.astOf(id);
        if (kind === 'initial' || kind === 'final') {
            return isScopeContainer(node) ? node : undefined;
        }
        if (isStateMachine(node) || isState(node) || isRegion(node)) {
            return isState(node) && node.regions.length > 0 ? node.regions[0] : node;
        }
        if (isPseudoState(node) || isTransition(node)) {
            return scopeOf(node);
        }
        return undefined;
    }

    private sourceAt(id: string | undefined): TransitionSource | undefined {
        if (!id) {
            return undefined;
        }
        const kind = this.kindOf(id);
        const node = this.astOf(id);
        if (kind === 'initial' && isScopeContainer(node)) {
            return { initialOf: node };
        }
        return isVertex(node) ? node : undefined;
    }

    private targetAt(id: string | undefined): TransitionTarget | undefined {
        if (!id) {
            return undefined;
        }
        const kind = this.kindOf(id);
        const node = this.astOf(id);
        if (kind === 'final' && isScopeContainer(node)) {
            return { finalOf: node };
        }
        return isVertex(node) ? node : undefined;
    }

    mouseDown(target: SModelElementImpl, event: MouseEvent): void {
        // make sure the diagram receives keyboard events (sprotty prevents the default focus handling)
        if (!byId('diagram-area').contains(document.activeElement) && !document.querySelector('.inline-editor')) {
            this.focusDiagram();
        }
        if (event.button !== 0 || this.tool === 'select') {
            return;
        }
        const id = this.diagramId(target);
        const tool = this.tool;
        switch (tool) {
            case 'state':
            case 'choice':
            case 'junction':
            case 'history':
            case 'deephistory': {
                const container = this.containerAt(id);
                if (!container) {
                    return;
                }
                this.applyEdit(editor => {
                    const result = editor.addVertex(container, tool);
                    if (tool === 'state') {
                        this.pendingRename = result.createdName;
                    }
                    return result;
                });
                this.toolDone();
                break;
            }
            case 'region': {
                const node = id ? this.astOf(id) : undefined;
                const state = isState(node) ? node : isRegion(node) ? node.$container : undefined;
                if (!state) {
                    this.setStatus('Click on a state to add a region.', 'warning');
                    return;
                }
                this.applyEdit(editor => editor.addRegion(state));
                this.toolDone();
                break;
            }
            case 'initial': {
                const node = id ? this.astOf(id) : undefined;
                if (!isVertex(node)) {
                    this.setStatus('Click on the state which should become the initial state.', 'warning');
                    return;
                }
                this.applyEdit(editor => editor.setInitial(node));
                this.toolDone();
                break;
            }
            case 'final': {
                const node = id ? this.astOf(id) : undefined;
                if (!isVertex(node)) {
                    this.setStatus('Click on the state which should get a transition to the final state.', 'warning');
                    return;
                }
                this.applyEdit(editor => editor.addTransition(node, { finalOf: scopeOf(node) }));
                this.toolDone();
                break;
            }
            case 'transition':
                this.transitionClick(id, event);
                break;
        }
    }

    private transitionClick(id: string | undefined, event: MouseEvent): void {
        if (!this.pendingSource) {
            if (!this.sourceAt(id)) {
                this.setStatus('Click on the source state of the transition.', 'warning');
                return;
            }
            this.pendingSource = id;
            this.updatePalette();
            this.render();
            return;
        }
        const sourceId = this.pendingSource;
        const source = this.sourceAt(sourceId);
        const target = this.targetAt(id);
        if (!source || !target) {
            this.pendingSource = undefined;
            this.updatePalette();
            this.render();
            this.setStatus('Transition cancelled.', 'info');
            return;
        }
        const isInitial = 'initialOf' in source;
        const finish = (label: string | undefined) => {
            this.pendingSource = undefined;
            this.applyEdit(editor => editor.addTransition(source, target, label)).then(done => {
                if (!done) {
                    this.render();
                }
            });
            this.toolDone();
        };
        if (isInitial) {
            finish(undefined);
            return;
        }
        showInlineEditor({
            rect: { left: event.clientX - 90, top: event.clientY - 15, width: 180, height: 30 },
            value: '',
            placeholder: 'trigger [guard] / effect',
            commit: value => finish(value),
            cancel: () => finish(undefined)
        });
    }

    doubleClick(target: SModelElementImpl): void {
        if (this.tool !== 'select') {
            return;
        }
        const id = this.diagramId(target);
        if (!id) {
            return;
        }
        const kind = this.kindOf(id);
        if (kind === 'machine') {
            // double click on the canvas creates a new state
            this.applyEdit((editor, state) => {
                const result = editor.addVertex(state.parsed.model, 'state');
                this.pendingRename = result.createdName;
                return result;
            });
        } else if (kind !== 'initial' && kind !== 'final') {
            this.startRename(id);
        }
    }

    dragEnd(draggedId: string, dropTargetId: string | undefined): void {
        const vertex = this.astOf(draggedId);
        const container = this.containerAt(dropTargetId);
        const dropNode = dropTargetId ? this.astOf(dropTargetId) : undefined;
        if (!isVertex(vertex) || !container) {
            this.render();
            return;
        }
        const targetContainer = isState(dropNode) && dropNode.regions.length === 0 ? dropNode : container;
        if (targetContainer === vertex.$container) {
            // no structural change: restore the computed layout
            this.render();
            return;
        }
        this.applyEdit(editor => editor.moveVertex(vertex, targetContainer)).then(done => {
            if (!done) {
                this.render();
            }
        });
    }

    selectionChanged(selected: string[], deselected: string[]): void {
        deselected.forEach(id => this.selection.delete(id));
        selected.forEach(id => this.selection.add(id));
        const single = this.singleSelection();
        if (single && selected.includes(single)) {
            this.revealInEditor(single);
        } else if (this.selection.size === 0) {
            this.decorations.clear();
        }
        this.renderPropertiesPanel();
    }

    allSelected(select: boolean): void {
        this.selection.clear();
        if (select && this.state) {
            for (const id of this.state.layout.elements.keys()) {
                if (id !== MACHINE_ID) {
                    this.selection.add(id);
                }
            }
        }
        this.renderPropertiesPanel();
    }

    private singleSelection(): string | undefined {
        return this.selection.size === 1 ? [...this.selection][0] : undefined;
    }

    /** Selects a diagram element programmatically. */
    select(id: string | undefined, center = false): void {
        const deselect = [...this.selection].filter(s => s !== id);
        this.selection.clear();
        if (id) {
            this.selection.add(id);
        }
        this.actionDispatcher.dispatch(SelectAction.create({ selectedElementsIDs: id ? [id] : [], deselectedElementsIDs: deselect }));
        if (id && center) {
            this.actionDispatcher.dispatch(CenterAction.create([id], { animate: true, retainZoom: true }));
        }
        this.renderPropertiesPanel();
    }

    private selectElementAtCursor(): void {
        if (!this.state || this.state.parsed.text !== this.editor.getValue()) {
            return;
        }
        const position = this.editor.getPosition();
        if (!position) {
            return;
        }
        const offset = this.editor.getModel()!.getOffsetAt(position);
        const id = this.elementAtOffset(offset, false);
        if (id !== this.singleSelection()) {
            if (id) {
                this.select(id);
            } else if (this.selection.size > 0) {
                this.actionDispatcher.dispatch(SelectAllAction.create({ select: false }));
            }
        }
        this.decorations.clear();
    }

    private revealInEditor(id: string): void {
        const cst = this.astOf(id)?.$cstNode;
        const model = this.editor.getModel();
        if (!cst || !model || this.editor.hasTextFocus()) {
            return;
        }
        const start = model.getPositionAt(cst.offset);
        const end = model.getPositionAt(cst.end);
        const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
        this.decorations.set([{ range, options: { className: 'hsm-selected-range', isWholeLine: false } }]);
        this.editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
    }

    deleteSelection(): void {
        const targets = [...this.selection].flatMap((id): DeletionTarget[] => {
            const kind = this.kindOf(id);
            const node = this.astOf(id);
            if (!node) {
                return [];
            }
            if (kind === 'initial' && isScopeContainer(node)) {
                return [{ initialOf: node }];
            }
            if (kind === 'final' && isScopeContainer(node)) {
                return [{ finalOf: node }];
            }
            return [node];
        });
        if (targets.length === 0) {
            return;
        }
        this.selection.clear();
        this.applyEdit(editor => editor.deleteElements(targets));
    }

    /** Opens an inline editor to rename a vertex / region or to edit the label of a transition. */
    startRename(id: string): void {
        const node = this.astOf(id);
        const element = document.getElementById(`sprotty_${id}`);
        if (!node || !element) {
            return;
        }
        const bounds = element.getBoundingClientRect();
        const diagramNode = this.state?.nodes.get(id);
        if (isTransition(node)) {
            const labelElement = element.querySelector('.transition-label rect') ?? element;
            const rect = labelElement.getBoundingClientRect();
            showInlineEditor({
                rect,
                value: nodeTextOf(node.spec),
                placeholder: 'trigger [guard] / effect',
                commit: value => this.applyEdit(editor => editor.updateTransitionLabel(node, value))
            });
        } else if (isVertex(node)) {
            const scale = diagramNode ? bounds.width / diagramNode.width : 1;
            const headerHeight = (diagramNode?.headerHeight ?? diagramNode?.height ?? 26) * scale;
            showInlineEditor({
                rect: { left: bounds.left, top: bounds.top, width: bounds.width, height: headerHeight },
                value: node.name,
                validate: value => this.validateName(value, node),
                commit: value => this.applyEdit(editor => editor.renameVertex(node, value.trim()))
            });
        } else if (isRegion(node)) {
            showInlineEditor({
                rect: { left: bounds.left, top: bounds.top, width: Math.min(bounds.width, 200), height: 30 },
                value: node.name ?? '',
                placeholder: 'region name (optional)',
                validate: value => value.trim() && !isValidIdentifier(value.trim()) ? 'Not a valid name' : undefined,
                commit: value => this.applyEdit(editor => editor.renameRegion(node, value))
            });
        }
    }

    validateName(value: string, vertex?: Vertex): string | undefined {
        const name = value.trim();
        if (!isValidIdentifier(name)) {
            return 'Use letters, digits and _ (no keywords), starting with a letter.';
        }
        const existing = this.findVertex(name);
        if (existing && existing !== vertex) {
            return `'${name}' already exists.`;
        }
        return undefined;
    }

    findVertex(name: string): Vertex | undefined {
        for (const node of this.state?.layout.elements.values() ?? []) {
            if (isVertex(node) && node.name === name) {
                return node;
            }
        }
        return undefined;
    }

    transitionLabelText(transition: import('hsm-language').Transition): string {
        return transitionLabel(transition);
    }

    // -----------------------------------------------------------------------------------------
    // Properties panel

    private renderPropertiesPanel(): void {
        const panel = byId('properties');
        if (panel.contains(document.activeElement)) {
            return;
        }
        const id = this.singleSelection();
        const info: SelectionInfo = {
            id,
            kind: id ? this.kindOf(id) : undefined,
            node: id ? this.astOf(id) : undefined,
            issue: id ? this.state?.issues.get(id) : undefined,
            count: this.selection.size,
            model: this.state?.parsed.model,
            syntaxErrors: this.syntaxErrors
        };
        renderProperties(panel, info, this);
    }

    // -----------------------------------------------------------------------------------------
    // Viewport, export

    fit(animate = true): void {
        this.actionDispatcher.dispatch(FitToScreenAction.create([], { padding: 24, maxZoom: 1.3, animate }));
    }

    private lastSize?: { width: number, height: number };

    private fitIfSmall(): void {
        const bounds = byId('diagram-area').getBoundingClientRect();
        if (this.rendered && this.lastSize && (Math.abs(bounds.width - this.lastSize.width) > 50 || Math.abs(bounds.height - this.lastSize.height) > 50)) {
            this.fit(false);
        }
        this.lastSize = { width: bounds.width, height: bounds.height };
    }

    private exportSvg(): void {
        if (!this.state) {
            return;
        }
        const graph = this.state.layout.graph;
        const svg = exportSvg(byId('sprotty'), graph.width, graph.height, `theme-${this.settings.theme}`);
        download(this.fileName.replace(/\.[^.]+$/, '') + '.svg', svg, 'image/svg+xml');
    }

    private async showPlantUml(): Promise<void> {
        if (!this.state) {
            return;
        }
        const text = generatePlantUml(this.state.parsed.model);
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

    setStatus(message: string, severity: 'info' | 'warning' | 'error' = 'info'): void {
        const element = byId('status-message');
        element.textContent = message;
        element.className = severity === 'info' ? '' : severity;
        clearTimeout(this.statusTimer);
        this.statusTimer = setTimeout(() => {
            element.textContent = '';
        }, 6000);
    }
}
