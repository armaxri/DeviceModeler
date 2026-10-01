import type { Container } from 'inversify';
import { LocalModelSource, TYPES, type IActionDispatcher, type SModelElementImpl } from 'sprotty';
import { FitToScreenAction, SelectAction, SelectAllAction, CenterAction } from 'sprotty-protocol';
import type { AstNode } from 'langium';
import {
    EditError, ModelEditor, allVertices, applyEdits, definitionRange, isEventDeclaration, isInterfaceScope, isOperationDeclaration,
    isScopeContainer, isValidIdentifier, isPseudoState, isRegion, isState, isStateMachine, isTransition, isVertex, layoutStateMachine,
    qualifiedName, scopeOf, siblingVertices, transitionLabel, finalNodeId, DEFINITION_ID, MACHINE_ID,
    nodeText as nodeTextOf, type DeletionTarget, type DiagramEdge, type DiagramNode, type DiagramNodeKind, type EdgeRouting, type EditResult, type LayoutDirection, type LayoutResult,
    type NewVertexKind, type ParsedModel, type ScopeContainer, type TextEdit, type Transition, type TransitionSource, type TransitionTarget, type Vertex
} from 'hsm-language';
import {
    applyManualLayout, captureLayout, cloneManualLayout, contentOrigin, createManualLayout, toFrameCoordinates, type ManualLayout, type Point
} from 'hsm-language';
import { describeSyntaxProblem, type HsmModelService } from './model-service.js';
import { createDiagramContainer } from './diagram/di.config.js';
import type { DiagramCallbacks, DragInfo } from './diagram/listeners.js';
import { LayoutHistory, TrackingModelEditor, applyKeyChanges, movedId, textKey } from './diagram/manual-layout-support.js';
import { toSchema, type Issue } from './diagram/model.js';
import { canvasTextMeasure } from './diagram/text-measure.js';
import { byId, h } from './ui/dom.js';
import { Icons } from './ui/icons.js';
import { closeInlineEditor, showInlineEditor } from './ui/inline-editor.js';
import { exportSvg } from './ui/export-svg.js';
import { renderProperties, type PropertiesHost, type SelectionInfo } from './ui/properties.js';
import { SimulationPanel } from './ui/simulation-panel.js';
import { SimulationSession, canHaveBreakpoint } from './simulation/session.js';

export type Tool = 'select' | 'state' | 'choice' | 'junction' | 'history' | 'deephistory' | 'sync' | 'entry' | 'exit' | 'initial' | 'final'
    | 'transition' | 'region';

/** Tools which add a vertex to the container that is clicked. */
const VERTEX_TOOLS: ReadonlySet<Tool> = new Set<Tool>(['state', 'choice', 'junction', 'history', 'deephistory', 'sync', 'entry', 'exit']);

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
    { tool: 'sync', label: 'Synchronization (fork / join)', key: 'B', icon: Icons.sync, hint: 'Click on the canvas, a state or a region to add a synchronization bar' },
    { tool: 'entry', label: 'Entry point', key: 'E', icon: Icons.entry, hint: 'Click on a composite state to add a named entry point' },
    { tool: 'exit', label: 'Exit node', key: 'X', icon: Icons.exit, hint: 'Click on a composite state to add an exit node' },
    'separator',
    { tool: 'initial', label: 'Initial state', key: 'I', icon: Icons.initial, hint: 'Click on the state that should be the initial state of its parent' },
    { tool: 'final', label: 'Final state', key: 'F', icon: Icons.final, hint: 'Click on a state to add a transition to the final state' },
    { tool: 'transition', label: 'Transition', key: 'T', icon: Icons.transition, hint: 'Click on the source, then on the target of the transition' }
];

export interface ModelState {
    parsed: ParsedModel;
    /** The automatic layout (reused for changes of the manual layout). */
    auto: LayoutResult;
    /** The diagram shown: the automatic layout or the manual layout applied to it. */
    layout: LayoutResult;
    /** Manual layout mode: all nodes pinned at their current positions (the base of layout changes). */
    effective?: ManualLayout;
    nodes: Map<string, DiagramNode>;
    /** diagram id -> id of the parent node (MACHINE_ID for top-level nodes) */
    parents: Map<string, string>;
    issues: Map<string, Issue>;
}

/** How a text change came about (for the combined undo history of text and layout). */
export type TextChangeKind = 'edit' | 'undo' | 'redo';

/** Buttons of the layout mode (optional, bound if present): Auto | Manual, Auto-arrange, Reset. */
const LAYOUT_CONTROLS = ['btn-layout-auto', 'btn-layout-manual', 'btn-arrange', 'btn-reset-layout'];

export type DiagramTheme = 'classic' | 'modern' | 'dark';

/** Settings of the diagram. The controller reads them on every layout / theme update. */
export interface DiagramSettings {
    direction: LayoutDirection;
    routing: EdgeRouting;
    theme: DiagramTheme;
    /** Show the priorities of transitions leaving a vertex with several outgoing transitions. */
    priorities: boolean;
}

/** A range of the model text (offsets). */
export interface TextRange {
    offset: number;
    end: number;
}

export type StatusSeverity = 'info' | 'warning' | 'error';

/**
 * The text side of the diagram: the text editor holding the model (Monaco in the web app, the VS Code
 * text editor for the webview). The text is the single source of truth; every diagram operation
 * becomes a text edit applied by the host.
 */
export interface DiagramHost {
    /** The current text of the model. */
    getText(): string;
    /**
     * Applies the edits (offsets relative to {@link getText}) as one undoable step. Resolves to true
     * once {@link getText} returns the changed text, false if the edits could not be applied.
     */
    applyTextEdits(edits: readonly TextEdit[]): Promise<boolean>;
    /** Called after the text has been parsed (e.g. to show markers and the number of problems). */
    modelParsed?(parsed: ParsedModel): void;
    /** Highlights (and reveals) the text of the selected diagram element; undefined removes the highlight. */
    highlightText(range: TextRange | undefined): void;
    /** Selects and reveals a text range (e.g. an element of the simulation trace). */
    selectText(range: TextRange): void;
    /** Moves the cursor of the text editor to the offset and focuses the text editor. */
    editTextAt(offset: number): void;
    /** Whether the text editor has the keyboard focus. */
    textHasFocus(): boolean;
    undo(): void;
    redo(): void;
    /** The simulation mode was entered or left (e.g. to make the text read-only and to disable toolbar buttons). */
    simulationStateChanged?(running: boolean): void;
    setStatus(message: string, severity?: StatusSeverity): void;
    /**
     * Manual layout (experimental): the layout of the model was changed in the diagram (including undo /
     * redo and key updates of diagram edits); the host persists it (undefined: no manual layout any more).
     * Not called for layouts set by the host with {@link DiagramController.loadLayout}.
     */
    layoutChanged?(layout: ManualLayout | undefined): void;
    /**
     * A key of the current state of the text for the combined text / layout undo history; it must return
     * to the previous value when an edit is undone. Default: {@link textKey} of the text.
     */
    textStateKey?(): string;
}

export interface DiagramControllerOptions {
    host: DiagramHost;
    language: HsmModelService;
    settings: DiagramSettings;
    /** The ELK instance used for the layout (e.g. running in a web worker). */
    elk?: unknown;
}

/** Keywords offered by the completion of the inline editors (in addition to the declarations). */
const REACTION_KEYWORDS = ['after', 'every', 'always', 'oncycle', 'else', 'default', 'raise', 'valueof', 'active', 'entry', 'exit', 'true', 'false'];

/** How long (ms) a taken transition keeps its highlight before it fades out (see diagram.css). */
const TAKEN_HIGHLIGHT_MS = 350;

/**
 * The graphical editor: the Sprotty diagram with palette, properties panel and simulation, kept in
 * sync with the model text of a {@link DiagramHost}. Used by the web app and by the diagram webview
 * of the VS Code extension. Expects the elements `#diagram-area` (containing `#sprotty`,
 * `#sprotty_hidden`, `#diagram-banner` and `#diagram-hint`), `#palette` and `#properties`.
 */
export class DiagramController implements PropertiesHost, DiagramCallbacks {

    readonly host: DiagramHost;
    readonly language: HsmModelService;
    readonly settings: DiagramSettings;
    private container!: Container;
    private modelSource!: LocalModelSource;
    private actionDispatcher!: IActionDispatcher;

    private state?: ModelState;
    private syntaxErrors = false;
    private rendered = false;
    private updateTimer?: ReturnType<typeof setTimeout>;
    private updateVersion = 0;
    private pendingSelectOffset?: number;
    /** Start renaming the element selected after the next update (a newly created vertex). */
    private pendingRename = false;
    /** Fit the diagram to the screen once the next layout has been rendered. */
    private fitOnNextRender = false;

    private tool: Tool = 'select';
    private stickyTool = false;
    private pendingSource?: string;
    readonly selection = new Set<string>();
    private readonly elk: unknown;

    /** The running simulation (simulation mode), if any. */
    private simulationSession?: SimulationSession;
    private simulationPanel?: SimulationPanel;
    /** Key of the simulation flags last rendered (to skip identical diagram updates). */
    private renderedFlags = '';
    private flagTimer?: ReturnType<typeof setTimeout>;

    /** The manual layout of the model (sidecar `.hsm.layout`); undefined: automatic layout only. */
    private layoutData?: ManualLayout;
    private readonly layoutHistory = new LayoutHistory();

    constructor(options: DiagramControllerOptions) {
        this.host = options.host;
        this.language = options.language;
        this.settings = options.settings;
        this.elk = options.elk;
    }

    /** Creates the diagram and the palette and registers the keyboard handlers. */
    start(): void {
        this.createDiagram();
        this.createPalette();
        this.bindKeyboard();
        this.bindLayoutControls();
        this.applyTheme();
    }

    /** The last successfully parsed and laid out model. */
    get model(): ModelState | undefined {
        return this.state;
    }

    get simulation(): SimulationSession | undefined {
        return this.simulationSession;
    }

    get hasSyntaxErrors(): boolean {
        return this.syntaxErrors;
    }

    // -----------------------------------------------------------------------------------------
    // Setup

    private createDiagram(): void {
        this.container = createDiagramContainer('sprotty', this);
        this.modelSource = this.container.get<LocalModelSource>(TYPES.ModelSource);
        this.actionDispatcher = this.container.get<IActionDispatcher>(TYPES.IActionDispatcher);
        new ResizeObserver(() => {
            // sprotty updates its canvas bounds on window resize events only
            window.dispatchEvent(new Event('resize'));
            this.fitIfSmall();
        }).observe(byId('diagram-area'));
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

    private bindKeyboard(): void {
        // note: sprotty replaces its base div when rendering, so listeners are registered on the parent
        const diagram = byId('diagram-area');
        diagram.addEventListener('keydown', event => {
            if (event.target instanceof HTMLInputElement || this.simulationSession) {
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
            if (this.simulationSession && !event.ctrlKey && !event.metaKey && !event.altKey) {
                const target = event.target;
                const inField = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLButtonElement
                    || (target instanceof HTMLTextAreaElement && !target.closest('#editor'));
                if (event.key === ' ' && !inField) {
                    this.simulationSession.runCycle();
                    event.preventDefault();
                } else if (event.key === 'Escape' && this.simulationSession.isPlaying) {
                    this.simulationSession.pause();
                    event.preventDefault();
                }
            }
        });
        diagram.addEventListener('contextmenu', event => {
            if (!this.simulationSession) {
                return;
            }
            event.preventDefault();
            const id = this.elementIdAt(event.target);
            const node = id ? this.astOf(id) : undefined;
            if (canHaveBreakpoint(node)) {
                this.toggleBreakpoint(node);
            } else {
                this.setStatus('Right-click a state or a transition to toggle its breakpoint.', 'info');
            }
        });
    }

    /** Applies the diagram theme of the settings. */
    applyTheme(): void {
        const diagram = byId('diagram-area');
        diagram.classList.remove('theme-classic', 'theme-modern', 'theme-dark');
        diagram.classList.add(`theme-${this.settings.theme}`);
    }

    private setStatus(message: string, severity: StatusSeverity = 'info'): void {
        this.host.setStatus(message, severity);
    }

    // -----------------------------------------------------------------------------------------
    // Model synchronization: text -> AST -> layout -> diagram

    /** Updates the diagram after a delay (e.g. while typing). */
    scheduleUpdate(delay = 350): void {
        clearTimeout(this.updateTimer);
        this.updateTimer = setTimeout(() => this.update(), delay);
    }

    /** Recomputes the layout (e.g. after a change of the settings), optionally fitting the diagram to the screen. */
    relayout(fit = false): Promise<void> {
        if (fit) {
            this.fitOnNextRender = true;
        }
        return this.update(true);
    }

    /**
     * Prepares the diagram for a different model: clears the selection and fits the diagram to the
     * screen after the next update.
     */
    reset(): void {
        this.stopSimulation();
        this.selection.clear();
        this.pendingSource = undefined;
        this.fitOnNextRender = true;
    }

    /** Parses the current text and updates markers, diagram and properties. */
    async update(forceLayout = false): Promise<void> {
        clearTimeout(this.updateTimer);
        const version = ++this.updateVersion;
        const text = this.host.getText();
        const parsed = await this.language.parse(text);
        if (version !== this.updateVersion) {
            return;
        }
        this.host.modelParsed?.(parsed);
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
        let auto: LayoutResult;
        try {
            auto = await layoutStateMachine(parsed.model, {
                direction: this.settings.direction,
                routing: this.settings.routing,
                measure: canvasTextMeasure,
                elk: this.elk,
                priorities: this.settings.priorities
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
        this.state = this.createState(parsed, auto);
        const layout = this.state.layout;
        const nodes = this.state.nodes;

        // keep the selection for elements which still exist
        for (const id of [...this.selection]) {
            if (!layout.elements.has(id) || id === MACHINE_ID) {
                this.selection.delete(id);
            }
        }
        if (this.pendingSource && !nodes.has(this.pendingSource)) {
            this.pendingSource = undefined;
        }
        let createdId: string | undefined;
        if (this.pendingSelectOffset !== undefined) {
            createdId = this.elementAtOffset(this.pendingSelectOffset, true);
            this.pendingSelectOffset = undefined;
            if (createdId) {
                this.selection.clear();
                this.selection.add(createdId);
                this.revealInEditor(createdId);
            }
        }
        await this.render();
        if (this.pendingRename) {
            // rename the created vertex: it is identified by its offset in the text (names need not be unique)
            this.pendingRename = false;
            const id = createdId;
            if (id && isVertex(layout.elements.get(id))) {
                requestAnimationFrame(() => requestAnimationFrame(() => this.startRename(id)));
            }
        }
    }

    /** The diagram of the model: the automatic layout, adjusted by the manual layout in the manual layout mode. */
    private createState(parsed: ParsedModel, auto: LayoutResult): ModelState {
        let layout: LayoutResult = auto;
        let effective: ManualLayout | undefined;
        if (this.layoutData?.mode === 'manual') {
            const result = applyManualLayout(auto, this.layoutData, {
                direction: this.settings.direction, measure: canvasTextMeasure, routing: this.settings.routing
            });
            layout = result;
            effective = result.effective;
        }
        const nodes = new Map<string, DiagramNode>();
        const parents = new Map<string, string>();
        const collect = (node: DiagramNode, parent: string) => {
            nodes.set(node.id, node);
            parents.set(node.id, parent);
            node.children.forEach(child => collect(child, node.id));
        };
        layout.graph.children.forEach(child => collect(child, MACHINE_ID));
        return { parsed, auto, layout, effective, nodes, parents, issues: this.computeIssues(parsed, layout, nodes) };
    }

    /** Applies a changed manual layout (the automatic layout of the unchanged text is reused). */
    private applyLayoutChange(): void {
        if (!this.state) {
            return;
        }
        this.state = this.createState(this.state.parsed, this.state.auto);
        for (const id of [...this.selection]) {
            if (!this.state.layout.elements.has(id)) {
                this.selection.delete(id);
            }
        }
        this.render();
    }

    private async render(): Promise<void> {
        if (!this.state) {
            return;
        }
        const flags = this.simulationFlags();
        this.renderedFlags = flags?.key ?? '';
        const schema = toSchema(this.state.layout.graph, {
            selected: this.selection,
            issues: this.state.issues,
            pendingSource: this.pendingSource,
            activeStates: flags?.active,
            recentTransitions: flags?.recent,
            breakpoints: flags?.breakpoints,
            manualLayout: this.isManualLayout()
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

    /** Text range of a diagram element: the definition node covers the whole definition section. */
    rangeOf(id: string, node: AstNode | undefined = this.astOf(id)): TextRange | undefined {
        if (id === DEFINITION_ID) {
            return isStateMachine(node) ? definitionRange(node) : undefined;
        }
        const cst = node?.$cstNode;
        return cst ? { offset: cst.offset, end: cst.end } : undefined;
    }

    /** Finds the innermost diagram element whose text contains the offset. */
    elementAtOffset(offset: number, exactStart: boolean, layout = this.state?.layout, nodes = this.state?.nodes): string | undefined {
        if (!layout || !nodes) {
            return undefined;
        }
        let best: { id: string, length: number } | undefined;
        for (const [id, node] of layout.elements) {
            const kind = nodes.get(id)?.kind;
            if (id === MACHINE_ID || kind === 'initial' || kind === 'final') {
                continue;
            }
            const range = this.rangeOf(id, node);
            if (!range) {
                continue;
            }
            if (exactStart && range.offset === offset) {
                return id;
            }
            const length = range.end - range.offset;
            if (range.offset <= offset && offset <= range.end && (!best || length < best.length)) {
                best = { id, length };
            }
        }
        return best?.id;
    }

    // -----------------------------------------------------------------------------------------
    // Editing: every diagram operation becomes a text edit

    /**
     * Computes text edits based on the current model and applies them to the text (undoable),
     * then updates the diagram. If there is a manual layout, its keys follow renamed, moved and deleted
     * elements (`layoutChange` may adjust it further, e.g. the position of a moved state); the layout
     * change is undone together with the text edit.
     */
    async applyEdit(producer: (editor: ModelEditor, state: ModelState) => EditResult | undefined,
        layoutChange?: (layout: ManualLayout) => ManualLayout): Promise<boolean> {
        if (this.simulationSession) {
            this.setStatus('Stop the simulation to edit the model.', 'warning');
            return false;
        }
        if (!this.state || this.state.parsed.text !== this.host.getText()) {
            await this.update();
        }
        if (!this.state || this.syntaxErrors) {
            this.setStatus('Please fix the syntax errors in the text first.', 'error');
            return false;
        }
        let result: EditResult | undefined;
        const editor = new TrackingModelEditor(this.state.parsed.text, this.state.parsed.model, this.state.layout.ids);
        try {
            result = producer(editor, this.state);
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
        // a button of the properties panel keeps the focus otherwise, which prevents updates of the panel
        const focused = document.activeElement;
        if (focused instanceof HTMLButtonElement && byId('properties').contains(focused)) {
            focused.blur();
        }
        const layoutBase = this.layoutData && (this.state.effective ? { ...this.state.effective, mode: this.layoutData.mode } : this.layoutData);
        if (!await this.host.applyTextEdits(result.edits)) {
            this.pendingRename = false;
            return false;
        }
        if (layoutBase && (editor.changes.length > 0 || layoutChange)) {
            let layout = applyKeyChanges(layoutBase, editor.changes);
            layout = layoutChange ? layoutChange(layout) : layout;
            this.setLayout(layout, { record: true, linked: true, relayout: false });
        }
        this.pendingSelectOffset = result.selectOffset;
        await this.update();
        return true;
    }

    /**
     * Checks whether the edit computed by `producer` results in a syntactically valid text.
     * Returns the error message (of the edit operation or of the parser) or undefined.
     */
    checkEdit(producer: (editor: ModelEditor) => EditResult | undefined): string | undefined {
        if (!this.state || this.syntaxErrors || this.state.parsed.text !== this.host.getText()) {
            // applyEdit reports the problem
            return undefined;
        }
        const text = this.state.parsed.text;
        let result: EditResult | undefined;
        try {
            result = producer(new ModelEditor(text, this.state.parsed.model));
        } catch (error) {
            if (error instanceof EditError) {
                return error.message;
            }
            throw error;
        }
        if (!result || result.edits.length === 0) {
            return undefined;
        }
        const errors = this.language.syntaxErrors(applyEdits(text, result.edits));
        if (errors.length === 0) {
            return undefined;
        }
        // range of the changed text in the new text (to tell whether the input is just incomplete)
        let delta = 0;
        let start = Number.POSITIVE_INFINITY;
        let end = 0;
        for (const edit of [...result.edits].sort((x, y) => x.offset - y.offset)) {
            start = Math.min(start, edit.offset + delta);
            end = Math.max(end, edit.offset + delta + edit.text.length);
            delta += edit.text.length - edit.length;
        }
        return `Syntax error: ${describeSyntaxProblem(errors[0], start, end)}`;
    }

    /** Words offered by the completion of reaction texts: declarations, keywords and state names. */
    completions(): string[] {
        const model = this.state?.parsed.model;
        if (!model) {
            return REACTION_KEYWORDS;
        }
        const result: string[] = [];
        for (const scope of model.scopes) {
            for (const declaration of scope.declarations) {
                const name = isInterfaceScope(scope) && scope.name ? `${scope.name}.${declaration.name}` : declaration.name;
                result.push(isOperationDeclaration(declaration) ? `${name}()` : name);
                if (isInterfaceScope(scope) && scope.name && !isEventDeclaration(declaration)) {
                    // also offer the name without the interface to find it while typing
                    result.push(declaration.name);
                }
            }
        }
        result.push(...REACTION_KEYWORDS);
        result.push(...allVertices(model).filter(isState).map(v => qualifiedName(v)));
        return result;
    }

    /**
     * Undo in the diagram: layout changes made after the last text edit (the text still has the state it
     * had then) are undone here, everything else by the text editor of the host.
     */
    undo(): void {
        this.undoRedo('undo');
    }

    redo(): void {
        this.undoRedo('redo');
    }

    private undoRedo(command: 'undo' | 'redo'): void {
        if (this.simulationSession) {
            return;
        }
        const key = this.currentTextKey();
        const entry = command === 'undo' ? this.layoutHistory.layoutUndo(key) : this.layoutHistory.layoutRedo(key);
        if (entry) {
            this.setLayout(command === 'undo' ? entry.before : entry.after, { record: false });
            this.setStatus(`${command === 'undo' ? 'Undid' : 'Redid'} the layout change.`);
            return;
        }
        if (command === 'undo') {
            this.host.undo();
        } else {
            this.host.redo();
        }
    }

    // -----------------------------------------------------------------------------------------
    // Tools and diagram interaction

    setTool(tool: Tool, sticky = false): void {
        closeInlineEditor();
        if (this.simulationSession) {
            tool = 'select';
        }
        this.tool = tool;
        this.stickyTool = sticky;
        if (this.pendingSource) {
            this.pendingSource = undefined;
            this.render();
        }
        this.updatePalette();
        this.focusDiagram();
    }

    focusDiagram(): void {
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
        if (VERTEX_TOOLS.has(tool)) {
            const kind = tool as NewVertexKind;
            const container = this.containerAt(id);
            if (!container) {
                return;
            }
            if ((kind === 'entry' || kind === 'exit') && isStateMachine(container)) {
                this.setStatus(`Click on a composite state to add ${kind === 'entry' ? 'an entry point' : 'an exit node'}.`, 'warning');
                return;
            }
            this.applyEdit(editor => {
                const result = editor.addVertex(container, kind);
                this.pendingRename = kind === 'state' || kind === 'entry' || kind === 'exit';
                return result;
            });
            this.toolDone();
            return;
        }
        switch (tool) {
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
            rect: { left: event.clientX - 120, top: event.clientY - 15, width: 240, height: 30 },
            value: '',
            placeholder: 'trigger [guard] / effect',
            validate: value => this.checkEdit(editor => editor.addTransition(source, target, value)),
            completions: () => this.completions(),
            commit: value => finish(value),
            cancel: () => finish(undefined),
            discarded: (_value, error) => this.setStatus(`The label was not applied – ${error}`, 'error')
        });
    }

    doubleClick(target: SModelElementImpl): void {
        if (this.tool !== 'select' || this.simulationSession) {
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
                this.pendingRename = true;
                return editor.addVertex(state.parsed.model, 'state');
            });
        } else if (kind === 'definition') {
            this.editInText(id);
        } else if (kind !== 'initial' && kind !== 'final') {
            this.startRename(id);
        }
    }

    /**
     * A vertex was dragged. Automatic layout: dropping it onto another state (or region, or the canvas)
     * moves it there in the model, otherwise the computed layout is restored. Manual layout: the moved
     * vertices keep their new positions; with Shift held, the vertex is moved into the state below the mouse.
     */
    dragEnd(draggedId: string, dropTargetId: string | undefined, info: DragInfo): void {
        if (this.simulationSession) {
            this.render();
            return;
        }
        const manual = this.isManualLayout();
        if (manual && !info.shiftKey) {
            this.moveNodes(info);
            return;
        }
        const vertex = this.astOf(draggedId);
        const container = this.containerAt(dropTargetId);
        const dropNode = dropTargetId ? this.astOf(dropTargetId) : undefined;
        if (!isVertex(vertex) || !container) {
            this.render();
            return;
        }
        const targetContainer = isState(dropNode) && dropNode.regions.length === 0 ? dropNode : container;
        if (targetContainer === vertex.$container) {
            // no structural change: restore the computed layout (manual layout: keep the new position)
            if (manual) {
                this.moveNodes(info);
            } else {
                this.render();
            }
            return;
        }
        const moved = info.moved.find(m => m.id === draggedId);
        const layoutChange = (layout: ManualLayout): ManualLayout => {
            const id = movedId(vertex, targetContainer);
            const nodes = { ...layout.nodes };
            delete nodes[id];
            const parent = this.state?.layout.ids.get(isState(targetContainer) && targetContainer.regions.length > 0 ? targetContainer.regions[0] : targetContainer);
            if (manual && moved && parent) {
                // the position where it was dropped, relative to the new parent
                const origin = this.absolutePosition(parent);
                nodes[id] = this.clampToParent(parent, { x: moved.absoluteX - origin.x, y: moved.absoluteY - origin.y });
            }
            return { ...layout, nodes };
        };
        this.applyEdit(editor => editor.moveVertex(vertex, targetContainer), layoutChange).then(done => {
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
            this.host.highlightText(undefined);
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

    singleSelection(): string | undefined {
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

    /**
     * Selects the diagram element at the offset of the text cursor (if the diagram shows the current
     * text) and removes the highlight of the text.
     */
    selectElementAtOffset(offset: number): void {
        if (!this.state || this.state.parsed.text !== this.host.getText()) {
            return;
        }
        const id = this.elementAtOffset(offset, false);
        if (id !== this.singleSelection()) {
            if (id) {
                this.select(id);
            } else if (this.selection.size > 0) {
                this.actionDispatcher.dispatch(SelectAllAction.create({ select: false }));
            }
        }
        this.host.highlightText(undefined);
    }

    /** Moves the cursor of the text editor to the element and focuses the editor. */
    editInText(id: string): void {
        const range = this.rangeOf(id);
        if (range) {
            this.host.editTextAt(range.end);
        }
    }

    private revealInEditor(id: string): void {
        const range = this.rangeOf(id);
        if (range && !this.host.textHasFocus()) {
            this.host.highlightText(range);
        }
    }

    canEdit(): boolean {
        return !this.simulationSession;
    }

    deleteSelection(): void {
        if (this.simulationSession) {
            return;
        }
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
            if (kind === 'definition' || isStateMachine(node)) {
                return [];
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
        if (this.simulationSession) {
            return;
        }
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
                minWidth: 240,
                value: nodeTextOf(node.spec),
                placeholder: 'trigger [guard] / effect',
                validate: value => this.checkEdit(editor => editor.updateTransitionLabel(node, value)),
                completions: () => this.completions(),
                commit: value => this.applyEdit(editor => editor.updateTransitionLabel(node, value)),
                discarded: (_value, error) => this.setStatus(`The label was not applied – ${error}`, 'error')
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

    /**
     * Validates a new name for the vertex: it must be an identifier and must differ from the names of
     * its siblings (vertices in other states may have the same simple name).
     */
    validateName(value: string, vertex?: Vertex): string | undefined {
        const name = value.trim();
        if (!isValidIdentifier(name)) {
            return 'Use letters, digits and _ (no keywords), starting with a letter.';
        }
        if (vertex && siblingVertices(vertex.$container).some(v => v !== vertex && v.name === name)) {
            return `'${name}' already exists here.`;
        }
        return undefined;
    }

    transitionLabelText(transition: Transition): string {
        return transitionLabel(transition);
    }

    // -----------------------------------------------------------------------------------------
    // Manual layout (experimental): positions stored in a sidecar file, see docs/manual-layout.md

    /** The manual layout of the model (undefined: none, the automatic layout is shown). */
    get manualLayout(): ManualLayout | undefined {
        return this.layoutData;
    }

    isManualLayout(): boolean {
        return this.layoutData?.mode === 'manual' && !this.simulationSession;
    }

    /**
     * Sets the layout of the model loaded by the host (opening a model, an external change of the layout
     * file). Clears the layout history; {@link DiagramHost.layoutChanged} is not called. `show`: update
     * the diagram now (false if the host loads a new text and updates the diagram anyway).
     */
    loadLayout(layout: ManualLayout | undefined, show = true): void {
        this.layoutHistory.clear();
        this.layoutData = layout;
        this.updateLayoutControls();
        if (show) {
            this.applyLayoutChange();
        }
    }

    /** Replaces the manual layout as an undoable change (e.g. a layout file opened for the current model). */
    replaceLayout(layout: ManualLayout | undefined): void {
        this.setLayout(layout, { record: true });
    }

    /**
     * The text of the host changed (typing, undo / redo in the text editor, or a diagram edit):
     * `previousKey` is the text state key before the change. Layout changes belonging to an undone /
     * redone diagram edit are undone / redone with it. Call it before the diagram is updated.
     */
    textChanged(kind: TextChangeKind, previousKey: string): void {
        let entry;
        if (kind === 'undo') {
            entry = this.layoutHistory.textUndone(previousKey);
        } else if (kind === 'redo') {
            entry = this.layoutHistory.textRedone(this.currentTextKey());
        } else {
            this.layoutHistory.textEdited();
        }
        if (entry) {
            this.setLayout(kind === 'undo' ? entry.before : entry.after, { record: false, relayout: false });
        }
    }

    /** The key of the current text state (see {@link DiagramHost.textStateKey}). */
    currentTextKey(): string {
        return this.host.textStateKey?.() ?? textKey(this.host.getText());
    }

    /** The layout direction setting changed: new elements of a manual layout are placed in this direction. */
    directionChanged(): void {
        if (this.layoutData) {
            this.layoutData = { ...this.layoutData, direction: this.settings.direction };
            this.host.layoutChanged?.(this.layoutData);
        }
    }

    private bindLayoutControls(): void {
        const bind = (id: string, action: () => void) => document.getElementById(id)?.addEventListener('click', action);
        bind('btn-layout-auto', () => this.setLayoutMode('auto'));
        bind('btn-layout-manual', () => this.setLayoutMode('manual'));
        bind('btn-arrange', () => this.autoArrange());
        bind('btn-reset-layout', () => this.resetLayout());
        this.updateLayoutControls();
    }

    private updateLayoutControls(): void {
        const manual = this.layoutData?.mode === 'manual';
        document.getElementById('btn-layout-auto')?.classList.toggle('active', !manual);
        document.getElementById('btn-layout-manual')?.classList.toggle('active', manual);
        const arrange = document.getElementById('btn-arrange');
        if (arrange) {
            arrange.hidden = !manual;
        }
        const reset = document.getElementById('btn-reset-layout');
        if (reset) {
            reset.hidden = !this.layoutData;
        }
        byId('diagram-area').classList.toggle('manual-layout', manual);
    }

    /** Switches between the automatic and the manual layout; the manual layout starts with the current diagram. */
    setLayoutMode(mode: 'auto' | 'manual'): void {
        if (!this.state || this.simulationSession || (this.layoutData?.mode ?? 'auto') === mode) {
            return;
        }
        if (mode === 'auto') {
            this.setLayout({ ...this.layoutData!, mode: 'auto' }, { record: true });
            this.setStatus('Automatic layout. The manual layout is kept: switch back to Manual to use it again.');
            return;
        }
        const layout = this.layoutData && Object.keys(this.layoutData.nodes).length > 0
            ? { ...this.layoutData, mode: 'manual' as const }
            : captureLayout(this.state.auto.graph, this.settings.direction);
        this.setLayout(layout, { record: true });
        this.setStatus('Manual layout: drag states to move them (hold Shift while dropping to move a state into another state), '
            + 'drag the corner of a selected state to resize it, double-click a transition to add a bend point.');
    }

    /** Arranges everything automatically and keeps the result as the manual layout. */
    autoArrange(): void {
        if (!this.state || this.simulationSession) {
            return;
        }
        this.setLayout(captureLayout(this.state.auto.graph, this.settings.direction), { record: true });
        this.setStatus('Arranged automatically – the positions can be adjusted by hand (Ctrl+Z restores the previous layout).');
    }

    /** Discards the manual layout. */
    resetLayout(): void {
        if (!this.layoutData || this.simulationSession) {
            return;
        }
        this.setLayout(undefined, { record: true });
        this.setStatus('Automatic layout – the manual layout was discarded (Ctrl+Z restores it).');
    }

    /**
     * Replaces the manual layout. `record`: add the change to the undo history (`linked`: it belongs to
     * the text edit just made); `relayout`: show it now (not necessary if the text changes as well).
     */
    private setLayout(layout: ManualLayout | undefined, options: { record: boolean, linked?: boolean, relayout?: boolean }): void {
        if (options.record) {
            this.layoutHistory.push({
                before: this.layoutData,
                after: layout,
                textKey: this.currentTextKey(),
                linked: options.linked ?? false
            });
        }
        this.layoutData = layout;
        this.host.layoutChanged?.(layout);
        this.updateLayoutControls();
        if (options.relayout ?? true) {
            this.applyLayoutChange();
        }
    }

    /** Changes the current manual layout (all nodes pinned at their current positions). */
    private changeLayout(change: (layout: ManualLayout) => void): void {
        if (!this.state || !this.isManualLayout()) {
            return;
        }
        const layout = cloneManualLayout(this.state.effective ?? this.layoutData ?? createManualLayout());
        change(layout);
        this.setLayout(layout, { record: true });
    }

    private absolutePosition(id: string): Point {
        let x = 0;
        let y = 0;
        for (let current: string | undefined = id; current && current !== MACHINE_ID; current = this.state?.parents.get(current)) {
            const node = this.state?.nodes.get(current);
            x += node?.x ?? 0;
            y += node?.y ?? 0;
        }
        return { x, y };
    }

    /** Keeps a position inside the content area of the parent (below the name of a state). */
    private clampToParent(parentId: string | undefined, position: Point): Point {
        const origin = contentOrigin(parentId ? this.state?.nodes.get(parentId) : undefined);
        return { x: Math.max(origin.x, position.x), y: Math.max(origin.y, position.y) };
    }

    private moveNodes(info: DragInfo): void {
        const state = this.state;
        if (!state) {
            return;
        }
        const moves = info.moved.filter(m => state.nodes.has(m.id));
        if (moves.length === 0) {
            this.render();
            return;
        }
        this.changeLayout(layout => {
            for (const move of moves) {
                const position = this.clampToParent(state.parents.get(move.id), { x: move.x, y: move.y });
                layout.nodes[move.id] = { ...layout.nodes[move.id], ...position };
            }
        });
    }

    resizeEnd(id: string, width: number, height: number): void {
        this.changeLayout(layout => {
            const node = this.state?.nodes.get(id);
            layout.nodes[id] = { ...(layout.nodes[id] ?? { x: node?.x ?? 0, y: node?.y ?? 0 }), width, height };
        });
    }

    /** The bend points of a transition as shown (a spline has none that could be moved). */
    private shownBends(edgeId: string): { edge: DiagramEdge, bends: Point[] } | undefined {
        const edge = this.state?.layout.graph.edges.find(e => e.id === edgeId);
        return edge ? { edge, bends: edge.routing === 'spline' ? [] : edge.points.slice(1, -1).map(p => ({ ...p })) } : undefined;
    }

    private storeBends(edge: DiagramEdge, bends: Point[]): void {
        const graph = this.state?.layout.graph;
        if (!graph) {
            return;
        }
        this.changeLayout(layout => {
            const entry = { ...layout.edges[edge.id] };
            if (bends.length > 0) {
                entry.bends = bends.map(p => toFrameCoordinates(graph, edge, p));
            } else {
                delete entry.bends;
            }
            if (entry.bends || entry.label) {
                layout.edges[edge.id] = entry;
            } else {
                delete layout.edges[edge.id];
            }
        });
    }

    bendMoved(edgeId: string, index: number, point: Point): void {
        const shown = this.shownBends(edgeId);
        if (shown && index >= 0 && index < shown.bends.length) {
            shown.bends[index] = point;
            this.storeBends(shown.edge, shown.bends);
        }
    }

    bendAdded(edgeId: string, point: Point): void {
        const shown = this.shownBends(edgeId);
        if (!shown) {
            return;
        }
        // insert the point into the segment of the route which is nearest to it
        const points = [shown.edge.points[0], ...shown.bends, shown.edge.points[shown.edge.points.length - 1]];
        let best = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i + 1 < points.length; i++) {
            const d = segmentDistance(point, points[i], points[i + 1]);
            if (d < bestDistance) {
                best = i;
                bestDistance = d;
            }
        }
        shown.bends.splice(best, 0, point);
        this.storeBends(shown.edge, shown.bends);
    }

    bendRemoved(edgeId: string, index: number): void {
        const shown = this.shownBends(edgeId);
        if (shown && index >= 0 && index < shown.bends.length) {
            shown.bends.splice(index, 1);
            this.storeBends(shown.edge, shown.bends);
        }
    }

    labelMoved(edgeId: string, dx: number, dy: number): void {
        this.changeLayout(layout => {
            const entry = { ...layout.edges[edgeId] };
            entry.label = { x: (entry.label?.x ?? 0) + dx, y: (entry.label?.y ?? 0) + dy };
            layout.edges[edgeId] = entry;
        });
    }

    // -----------------------------------------------------------------------------------------
    // Simulation

    /** Starts the simulation mode: the model must not contain errors (warnings are fine). */
    async startSimulation(): Promise<void> {
        if (this.simulationSession) {
            return;
        }
        closeInlineEditor();
        await this.update();
        const state = this.state;
        if (!state || this.syntaxErrors || state.parsed.text !== this.host.getText()) {
            this.setStatus('The model contains syntax errors – fix them before starting the simulation.', 'error');
            return;
        }
        const errors = state.parsed.diagnostics.filter(d => d.severity === 1);
        if (errors.length > 0) {
            this.setStatus(`The model contains ${errors.length} error${errors.length === 1 ? '' : 's'} – fix ${errors.length === 1 ? 'it' : 'them'} before `
                + `starting the simulation (line ${errors[0].range.start.line + 1}: ${errors[0].message}).`, 'error');
            return;
        }
        this.setTool('select');
        this.pendingSource = undefined;
        document.body.classList.add('simulating');
        this.setPaletteEnabled(false);
        byId('properties').classList.add('simulation');
        const session = new SimulationSession(state.parsed.model, { changed: () => this.simulationChanged() });
        this.simulationSession = session;
        this.simulationPanel = new SimulationPanel(byId('properties'), session, this);
        this.host.simulationStateChanged?.(true);
        this.setStatus(`Simulation of ${state.parsed.model.name} started.`);
        this.simulationChanged();
        this.focusDiagram();
    }

    /** Leaves the simulation mode and returns to editing. */
    stopSimulation(): void {
        const session = this.simulationSession;
        if (!session) {
            return;
        }
        session.dispose();
        this.simulationSession = undefined;
        this.simulationPanel = undefined;
        clearTimeout(this.flagTimer);
        document.body.classList.remove('simulating');
        this.setPaletteEnabled(true);
        byId('properties').classList.remove('simulation');
        byId('properties').replaceChildren();
        this.host.simulationStateChanged?.(false);
        this.host.highlightText(undefined);
        this.render();
    }

    /** The palette (and the layout controls) are disabled while simulating. */
    private setPaletteEnabled(enabled: boolean): void {
        for (const control of byId('palette').querySelectorAll<HTMLButtonElement>('button')) {
            control.disabled = !enabled;
        }
        for (const id of LAYOUT_CONTROLS) {
            const control = document.getElementById(id);
            if (control instanceof HTMLButtonElement) {
                control.disabled = !enabled;
            }
        }
    }

    /** Called by the session after every change: updates the panel and (if necessary) the diagram. */
    private simulationChanged(): void {
        this.simulationPanel?.update();
        const flags = this.simulationFlags();
        if (flags && flags.key !== this.renderedFlags) {
            this.render();
        }
    }

    /**
     * The simulation state as diagram flags: active states (and final states), recently taken
     * transitions and breakpoints, mapped to diagram ids via `layout.ids`. The layout itself is not
     * recomputed. Schedules a re-render when the highlight of a taken transition expires.
     */
    private simulationFlags(): { active: Set<string>, recent: Set<string>, breakpoints: Set<string>, key: string } | undefined {
        const session = this.simulationSession;
        const state = this.state;
        if (!session || !state) {
            return undefined;
        }
        const ids = state.layout.ids;
        const active = new Set<string>();
        const sim = session.sim;
        if (sim?.isRunning) {
            for (const node of sim.activeStateNodes()) {
                const id = ids.get(node);
                if (id) {
                    active.add(id);
                }
            }
            // the final state of a container is active if the container is active but none of its states
            const containers: ScopeContainer[] = [state.parsed.model];
            for (const vertex of allVertices(state.parsed.model)) {
                if (isState(vertex)) {
                    containers.push(vertex, ...vertex.regions);
                }
            }
            for (const container of containers) {
                const containerId = ids.get(container);
                const finalId = containerId && finalNodeId(containerId);
                if (!finalId || !state.nodes.has(finalId)) {
                    continue;
                }
                const owner = isRegion(container) ? container.$container : container;
                const ownerActive = isStateMachine(owner) || sim.isActive(owner);
                if (ownerActive && !container.vertices.some(v => isState(v) && sim.isActive(v))) {
                    active.add(finalId);
                }
            }
        }
        const recent = new Set<string>();
        const now = performance.now();
        let nextExpiry = Number.POSITIVE_INFINITY;
        for (const [transition, time] of session.recentTransitions) {
            const age = now - time;
            if (age >= TAKEN_HIGHLIGHT_MS) {
                session.recentTransitions.delete(transition);
                continue;
            }
            const id = ids.get(transition);
            if (id) {
                recent.add(id);
            }
            nextExpiry = Math.min(nextExpiry, TAKEN_HIGHLIGHT_MS - age);
        }
        clearTimeout(this.flagTimer);
        if (Number.isFinite(nextExpiry)) {
            this.flagTimer = setTimeout(() => this.simulationChanged(), nextExpiry + 10);
        }
        const breakpoints = new Set<string>();
        for (const node of session.breakpoints) {
            const id = ids.get(node);
            if (id) {
                breakpoints.add(id);
            }
        }
        const key = [[...active].sort().join(','), [...recent].sort().join(','), [...breakpoints].sort().join(',')].join('|');
        return { active, recent, breakpoints, key };
    }

    toggleBreakpoint(node: AstNode): void {
        const session = this.simulationSession;
        if (!session) {
            return;
        }
        const set = session.toggleBreakpoint(node);
        const name = isTransition(node) ? `transition ${this.transitionLabelText(node) || nodeTextOf(node)}` : `state ${isState(node) ? qualifiedName(node) : ''}`;
        this.setStatus(`Breakpoint ${set ? 'set on' : 'removed from'} ${name}.`);
        this.simulationChanged();
    }

    toggleBreakpointOfSelection(): void {
        const id = this.singleSelection();
        const node = id ? this.astOf(id) : undefined;
        if (canHaveBreakpoint(node)) {
            this.toggleBreakpoint(node);
        } else {
            this.setStatus('Select a state or a transition in the diagram first (or right-click it).', 'warning');
        }
    }

    /** Selects the text of a model element (read-only while simulating) and the corresponding diagram element. */
    reveal(node: AstNode): void {
        const cst = node.$cstNode;
        if (cst) {
            this.host.selectText({ offset: cst.offset, end: cst.end });
        }
        let current: AstNode | undefined = node;
        while (current && !this.state?.layout.ids.has(current)) {
            current = current.$container;
        }
        const id = current ? this.state?.layout.ids.get(current) : undefined;
        if (id && id !== MACHINE_ID) {
            this.select(id, true);
        }
    }

    /** The id of the diagram element of a DOM element (walking up to the element with a sprotty id). */
    private elementIdAt(target: EventTarget | null): string | undefined {
        let element = target instanceof Element ? target : null;
        while (element) {
            if (element.id.startsWith('sprotty_')) {
                const id = element.id.substring('sprotty_'.length);
                if (this.state?.layout.elements.has(id)) {
                    return id;
                }
            }
            element = element.parentElement;
        }
        return undefined;
    }

    // -----------------------------------------------------------------------------------------
    // Properties panel

    private renderPropertiesPanel(): void {
        const panel = byId('properties');
        if (this.simulationSession || panel.contains(document.activeElement)) {
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

    /** The rendered diagram as a standalone SVG document (undefined if nothing has been rendered yet). */
    exportSvg(): string | undefined {
        if (!this.state) {
            return undefined;
        }
        const graph = this.state.layout.graph;
        return exportSvg(byId('sprotty'), graph.width, graph.height, `theme-${this.settings.theme}`);
    }
}

/** Distance of a point from the line segment a-b. */
function segmentDistance(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
