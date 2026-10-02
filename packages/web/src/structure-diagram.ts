import type { AstNode, LangiumDocument } from 'langium';
import type { SModelRoot } from 'sprotty-protocol';
import {
    IBD_OVERVIEW_ID, endpointLabel, findProviders, findRequirers, ibdChoices, ibdElementAt, ibdRouteElements, instanceType, isComponentInstance,
    isConnection, isDelegation, isPort, isStructure, isThread, layoutStructure, portEndpoint, portTypeLabel, threadInstances, threadSettings,
    type IbdLayoutResult, type ParsedDmfModel
} from 'hsm-language';
import type { DiagramHost, TextRange } from './diagram-controller.js';
import type { HsmModelService } from './model-service.js';
import { toIbdSchema } from './diagram/ibd-model.js';
import type { Issue } from './diagram/model.js';
import { canvasTextMeasure } from './diagram/text-measure.js';
import { byId, h } from './ui/dom.js';

/** What the structure diagram needs from the diagram controller (which owns the Sprotty diagram). */
export interface StructureDiagramContext {
    readonly host: DiagramHost;
    readonly language: HsmModelService;
    readonly elk: unknown;
    /** The ids of the selected diagram elements (shared with the controller, updated by the Sprotty selection). */
    readonly selection: Set<string>;
    /** Shows the diagram (first rendering or update). */
    show(schema: SModelRoot): Promise<void>;
    /** Selects a diagram element (and updates the Sprotty selection). */
    select(id: string | undefined): void;
    /** Fits the diagram to the screen after the next update. */
    fitOnNextUpdate(): void;
}

/** The parsed structure file and its diagram. */
export interface StructureState {
    parsed: ParsedDmfModel;
    layout: IbdLayoutResult;
    issues: Map<string, Issue>;
    /** The shown element (name of a structure / component type or the overview). */
    element: string;
}

/**
 * The diagram of a structure file (`.dmf`): an internal block diagram of a structure or system (see
 * ibd-layout.ts of the language package), shown by the {@link DiagramController} instead of the state
 * machine diagram when the edited file is a structure file. Read only (graphical editing is not
 * supported yet); selecting a port, connector or instance highlights the route of its signals and the
 * text of the element. If the file has several structures or component types, a selector at the top of
 * the diagram (and the text cursor) chooses the one shown.
 */
export class StructureDiagram {

    private state?: StructureState;
    private updateVersion = 0;
    /** The element chosen with the selector or the text cursor (by file). */
    private readonly chosen = new Map<string, string>();
    private route?: Set<string>;

    constructor(private readonly context: StructureDiagramContext) { }

    get model(): StructureState | undefined {
        return this.state;
    }

    /** Leaves the structure mode: hides the selector. */
    deactivate(): void {
        this.state = undefined;
        this.route = undefined;
        document.getElementById('ibd-element-select')?.parentElement?.setAttribute('hidden', '');
        byId('diagram-area').classList.remove('route-highlight', 'structure-diagram');
    }

    /** Parses the text and updates the diagram. Returns false if the text has syntax errors. */
    async update(force = false): Promise<void> {
        const version = ++this.updateVersion;
        const text = this.context.host.getText();
        const parsed = await this.context.language.parseStructure(text);
        if (version !== this.updateVersion) {
            return;
        }
        this.context.host.modelParsed?.(parsed);
        byId('diagram-area').classList.add('structure-diagram');
        const banner = byId('diagram-banner');
        if (parsed.hasSyntaxErrors) {
            banner.hidden = false;
            banner.textContent = 'The text contains syntax errors – the diagram shows the last valid state.';
            return;
        }
        banner.hidden = true;
        const uri = this.context.language.uri;
        const choices = ibdChoices(parsed.model);
        const wanted = this.chosen.get(uri);
        const element = wanted && choices.some(c => c.id === wanted) ? wanted : undefined;
        if (!force && this.state?.parsed === parsed && this.state.element === (element ?? this.state.element)) {
            return;
        }
        let layout: IbdLayoutResult | undefined;
        try {
            layout = await layoutStructure(parsed.model, { element, measure: canvasTextMeasure, elk: this.context.elk });
        } catch (error) {
            console.error(error);
            banner.hidden = false;
            banner.textContent = `The diagram layout failed: ${error instanceof Error ? error.message : error}`;
            return;
        }
        if (version !== this.updateVersion) {
            return;
        }
        this.updateSelector(choices.map(c => ({ id: c.id, label: c.label })), layout ? elementOf(layout) : undefined);
        if (!layout) {
            this.state = undefined;
            banner.hidden = false;
            banner.textContent = 'The file declares no components, structures or systems – there is nothing to show in the diagram.';
            await this.context.show({ type: 'graph:ibd', id: '#empty', children: [] } as SModelRoot);
            this.renderProperties();
            return;
        }
        this.state = { parsed, layout, issues: this.computeIssues(parsed, layout), element: elementOf(layout) };
        for (const id of [...this.context.selection]) {
            if (!layout.elements.has(id)) {
                this.context.selection.delete(id);
            }
        }
        this.updateRoute();
        await this.render();
    }

    private async render(): Promise<void> {
        if (!this.state) {
            return;
        }
        byId('diagram-area').classList.toggle('route-highlight', this.route !== undefined);
        await this.context.show(toIbdSchema(this.state.layout.graph, { selected: this.context.selection, issues: this.state.issues, route: this.route }));
        this.renderProperties();
    }

    /** The selector of the shown element (hidden if there is only one). */
    private updateSelector(choices: Array<{ id: string, label: string }>, current: string | undefined): void {
        let select = document.getElementById('ibd-element-select') as HTMLSelectElement | null;
        if (!select) {
            select = h('select', { id: 'ibd-element-select', title: 'The structure or component type shown in the diagram' });
            const box = h('div', { class: 'ibd-element-choice' }, h('span', {}, 'Show'), select);
            select.addEventListener('change', () => {
                this.chosen.set(this.context.language.uri, select!.value);
                this.context.selection.clear();
                this.context.fitOnNextUpdate();
                this.update(true);
            });
            byId('diagram-area').append(box);
        }
        const key = choices.map(c => `${c.id}\n${c.label}`).join('\n');
        if (select.dataset.choices !== key) {
            select.dataset.choices = key;
            select.replaceChildren(...choices.map(c => h('option', { value: c.id }, c.label)));
        }
        if (current) {
            select.value = current;
        }
        const box = select.parentElement!;
        if (choices.length > 1) {
            box.removeAttribute('hidden');
        } else {
            box.setAttribute('hidden', '');
        }
    }

    private computeIssues(parsed: ParsedDmfModel, layout: IbdLayoutResult): Map<string, Issue> {
        const issues = new Map<string, Issue>();
        const textDocument = parsed.document.textDocument;
        for (const diagnostic of parsed.diagnostics) {
            if (diagnostic.severity !== 1 && diagnostic.severity !== 2) {
                continue;
            }
            const id = this.elementAtOffset(textDocument.offsetAt(diagnostic.range.start), layout, parsed, true);
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

    /** The text range of a diagram element in the edited file (ports of instances: the instance). */
    rangeOf(id: string): TextRange | undefined {
        const layout = this.state?.layout;
        const node = layout?.instances.get(id) ?? layout?.elements.get(id);
        const cst = node && documentOf(node) === this.state?.parsed.document ? node.$cstNode : undefined;
        return cst ? { offset: cst.offset, end: cst.end } : undefined;
    }

    /** The innermost diagram element (of the edited file) whose text contains the offset. */
    private elementAtOffset(offset: number, layout: IbdLayoutResult, parsed: ParsedDmfModel, includeFrame: boolean): string | undefined {
        let best: { id: string, length: number } | undefined;
        for (const [id, node] of layout.elements) {
            if (layout.instances.has(id) || documentOf(node) !== parsed.document || (!includeFrame && id === layout.graph.id)) {
                continue;
            }
            const cst = node.$cstNode;
            if (!cst || offset < cst.offset || offset > cst.end) {
                continue;
            }
            const length = cst.end - cst.offset;
            if (!best || length < best.length) {
                best = { id, length };
            }
        }
        return best?.id;
    }

    /**
     * The text cursor moved: shows the structure or component type at the cursor (if the diagram shows
     * another one) and selects the element at the cursor.
     */
    selectAtOffset(offset: number): void {
        const state = this.state;
        if (!state || state.parsed.text !== this.context.host.getText()) {
            return;
        }
        const element = ibdElementAt(state.parsed.model, offset);
        const shown = element !== undefined && [...state.layout.elements.values()].some(n => (isStructure(n) || n.$type === 'Component') && (n as { name?: string }).name === element);
        if (element && !shown) {
            this.chosen.set(this.context.language.uri, element);
            this.context.selection.clear();
            this.context.fitOnNextUpdate();
            this.update(true).then(() => this.selectAtOffset(offset));
            return;
        }
        const id = this.elementAtOffset(offset, state.layout, state.parsed, false);
        const single = this.context.selection.size === 1 ? [...this.context.selection][0] : undefined;
        if (id !== single) {
            this.context.select(id);
        }
        this.context.host.highlightText(undefined);
    }

    /** The selection changed (in the diagram): highlights the route and the text of the element. */
    selectionChanged(): void {
        const single = this.context.selection.size === 1 ? [...this.context.selection][0] : undefined;
        const range = single ? this.rangeOf(single) : undefined;
        if (range && !this.context.host.textHasFocus()) {
            this.context.host.highlightText(range);
        } else if (!single) {
            this.context.host.highlightText(undefined);
        }
        const before = this.route ? [...this.route].join('\n') : undefined;
        this.updateRoute();
        const after = this.route ? [...this.route].join('\n') : undefined;
        if (before !== after) {
            // (not within the handling of the selection action)
            requestAnimationFrame(() => this.render());
        } else {
            this.renderProperties();
        }
    }

    private updateRoute(): void {
        const single = this.context.selection.size === 1 ? [...this.context.selection][0] : undefined;
        this.route = single && this.state ? ibdRouteElements(this.state.layout, single) : undefined;
    }

    /** Graph size for the export. */
    get size(): { width: number, height: number } | undefined {
        const graph = this.state?.layout.graph;
        return graph ? { width: graph.width, height: graph.height } : undefined;
    }

    // -----------------------------------------------------------------------------------------
    // Properties panel (read only)

    renderProperties(): void {
        const panel = byId('properties');
        const state = this.state;
        const single = this.context.selection.size === 1 ? [...this.context.selection][0] : undefined;
        const node = single ? state?.layout.elements.get(single) : undefined;
        const content: HTMLElement[] = [];
        if (!state) {
            content.push(h('p', { class: 'hint' }, 'Structure file without component types.'));
        } else if (!node || !single) {
            content.push(...this.overviewPanel(state));
        } else {
            content.push(...this.elementPanel(state, single, node));
        }
        panel.replaceChildren(...content);
    }

    private overviewPanel(state: StructureState): HTMLElement[] {
        const root = state.layout.elements.get(state.layout.graph.id);
        const rows: HTMLElement[] = [];
        if (isStructure(root)) {
            rows.push(h('dt', {}, 'Ports'), h('dd', {}, String(root.ports.length)),
                h('dt', {}, 'Threads'), h('dd', {}, String(root.threads.length)),
                h('dt', {}, 'Connections'), h('dd', {}, String(root.connections.length + root.delegations.length)));
        }
        return [
            h('h2', {}, state.layout.graph.kind === 'overview' ? 'Component types' : state.layout.graph.name),
            h('div', { class: 'kind' }, state.layout.graph.kind === 'overview' ? 'Structure file' : state.layout.graph.kind),
            ...(rows.length > 0 ? [h('dl', {}, ...rows)] : []),
            h('h2', { style: 'margin-top:18px' }, 'Notation'),
            h('ul', { class: 'hint', style: 'padding-left:18px;margin:6px 0' },
                h('li', {}, 'Ports: filled square = provided, hollow square = required.'),
                h('li', {}, 'Async ports (events) show a chevron in the direction of the events, sync ports (data) are plain squares.'),
                h('li', {}, 'Dashed connectors cross threads.'),
                h('li', {}, 'Select a port, connector or instance to highlight the route of its signals.'),
                h('li', {}, 'The diagram is read only: edit the text.'))
        ];
    }

    private elementPanel(state: StructureState, id: string, node: AstNode): HTMLElement[] {
        const issue = state.issues.get(id);
        const result: HTMLElement[] = [];
        const rows: HTMLElement[] = [];
        let title = id;
        let kind = '';
        if (isPort(node)) {
            const instance = state.layout.instances.get(id);
            title = isComponentInstance(instance) ? `${instance.name}.${node.name}` : node.name;
            kind = `${node.direction === 'provides' ? 'Provided' : 'Required'} ${node.kind} port`;
            rows.push(h('dt', {}, 'Type'), h('dd', {}, portTypeLabel(node)));
            const structure = state.layout.elements.get(state.layout.graph.id);
            if (isStructure(structure) && (!instance || isComponentInstance(instance))) {
                const endpoint = portEndpoint(structure, isComponentInstance(instance) ? instance : undefined, node);
                const ends = node.direction === 'requires' ? findProviders(endpoint) : findRequirers(endpoint);
                rows.push(h('dt', {}, node.direction === 'requires' ? 'Providers' : 'Requirers'),
                    h('dd', {}, ends.length > 0 ? ends.map(endpointLabel).join(', ') : '–'));
            }
        } else if (isComponentInstance(node)) {
            const type = instanceType(node);
            title = node.name;
            kind = `Instance of ${type?.name ?? node.type?.$refText ?? '?'}`;
            rows.push(h('dt', {}, 'Ports'), h('dd', {}, String(type?.ports.length ?? 0)));
        } else if (isThread(node)) {
            const settings = threadSettings(node);
            title = node.name;
            kind = 'Thread';
            rows.push(h('dt', {}, 'Instances'), h('dd', {}, threadInstances(node).map(i => i.name).join(', ') || '–'));
            if (settings.priority !== undefined) {
                rows.push(h('dt', {}, 'Priority'), h('dd', {}, String(settings.priority)));
            }
            if (settings.period !== undefined) {
                rows.push(h('dt', {}, 'Period'), h('dd', {}, settings.period));
            }
        } else if (isConnection(node) || isDelegation(node)) {
            const edge = state.layout.graph.edges.find(e => e.id === id);
            title = edge?.title ?? id;
            kind = isConnection(node) ? (edge?.crossThread ? 'Connection (crosses threads)' : 'Connection') : 'Delegation';
        } else {
            title = (node as { name?: string }).name ?? id;
            kind = node.$type;
        }
        result.push(h('h2', {}, title), h('div', { class: 'kind' }, kind));
        if (rows.length > 0) {
            result.push(h('dl', {}, ...rows));
        }
        if (this.route && this.route.size > 1) {
            result.push(h('p', { class: 'hint' }, 'The route of the signals is highlighted in the diagram.'));
        }
        if (issue) {
            result.push(h('ul', { class: 'problems' }, ...issue.messages.map(m => h('li', { class: issue.severity === 'error' ? 'error' : '' }, m))));
        }
        return result;
    }
}

/** The element shown by a layout (the choice of the selector). */
function elementOf(layout: IbdLayoutResult): string {
    return layout.graph.kind === 'overview' ? IBD_OVERVIEW_ID : layout.graph.name;
}

/** The document containing an AST node. */
function documentOf(node: AstNode): LangiumDocument | undefined {
    let root = node;
    while (root.$container) {
        root = root.$container;
    }
    return root.$document;
}
