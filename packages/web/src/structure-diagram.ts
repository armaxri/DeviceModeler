import type { AstNode, LangiumDocument } from 'langium';
import type { SModelElementImpl } from 'sprotty';
import type { SModelRoot } from 'sprotty-protocol';
import {
    BUILTIN_TYPES, DmfEditor, EditError, IBD_OVERVIEW_ID, applyEdits, behaviorMachine, checkRename, docComment, mapOffset, endpointLabel, findProviders, findRequirers, ibdChoices, ibdElementAt,
    ibdNodes, ibdRouteElements, instanceType, isComponent, isComponentInstance, isComponentType, isConnection, isDelegation, isPort, isPortInterface,
    isStructDeclaration, isStructure, isThread, layoutStructure, normalizeUri, planConnection, portEndpoint, portTypeLabel, routeContinuations, routeIdsAt,
    threadInstances, threadOf, threadSettings, visibleElements,
    type Component, type ComponentInstance, type ComponentType, type DmfPortEnd, type DmfWorkspace, type EditResult, type IbdLayoutResult, type IbdNode,
    type ParsedDmfModel, type Port, type PortEndpoint, type Structure, type StructureContext, type StructureLocation, type TextEdit, type Thread
} from 'hsm-language';
import type { DiagramHost, StatusSeverity, TextRange } from './diagram-controller.js';
import type { HsmModelService } from './model-service.js';
import { IbdTypes, toIbdSchema, type ConnectStatus } from './diagram/ibd-model.js';
import type { Issue } from './diagram/model.js';
import { canvasTextMeasure } from './diagram/text-measure.js';
import { renderBreadcrumb } from './ui/breadcrumb.js';
import { byId, h } from './ui/dom.js';
import { closeInlineEditor, showChooser, showInlineEditor } from './ui/inline-editor.js';
import { checkedField, field, problems } from './ui/properties.js';
import { describeSyntaxProblem } from './model-service.js';

/**
 * A place to navigate to (from the diagram to another file or element): a file, and in a structure file
 * the shown element, the selected diagram element and the instance tree context of the shown structure
 * (see {@link StructureContext}); in a state machine an offset of its text.
 */
export interface DiagramLocation {
    uri: string;
    /** Structure files: the structure or component type to show. */
    element?: string;
    /** The diagram element to select (structure files: see the ids in ibd-model.ts of the language package). */
    id?: string;
    /** Structure files: the shown structure seen as a part of a root structure (routes across levels, "follow into"). */
    context?: StructureContext;
    /** An offset of the text to reveal (and the element there to select) if there is no `id`. */
    offset?: number;
}

/** The tools of the palette of the structure diagram. */
export type StructureTool = 'thread' | 'instance' | 'port-provides-sync' | 'port-provides-async' | 'port-requires-sync' | 'port-requires-async' | 'connector';

/** What the structure diagram needs from the diagram controller (which owns the Sprotty diagram and the palette). */
export interface StructureDiagramContext {
    readonly host: DiagramHost;
    readonly language: HsmModelService;
    readonly elk: unknown;
    /** The ids of the selected diagram elements (shared with the controller, updated by the Sprotty selection). */
    readonly selection: Set<string>;
    /** Shows the diagram (first rendering or update). */
    show(schema: SModelRoot): Promise<void>;
    /** Selects a diagram element (and updates the Sprotty selection), optionally centering it. */
    select(id: string | undefined, center?: boolean): void;
    /** Fits the diagram to the screen after the next update. */
    fitOnNextUpdate(): void;
    /** The active tool of the palette (`select` or a structure tool). */
    tool(): StructureTool | 'select';
    setTool(tool: StructureTool | 'select'): void;
    /** The tool was used: back to the selection tool unless it is kept (Shift). */
    toolDone(): void;
    /** Shows a hint at the bottom of the diagram (undefined: the hint of the tool). */
    setHint(hint: string | undefined): void;
    setStatus(message: string, severity?: StatusSeverity): void;
    /** Opens a location (another file: through the host, with history). */
    navigate(location: DiagramLocation): void;
}

/** The parsed structure file and its diagram. */
export interface StructureState {
    parsed: ParsedDmfModel;
    layout: IbdLayoutResult;
    issues: Map<string, Issue>;
    /** The shown element (name of a structure / component type or the overview). */
    element: string;
}

/** The route of the selected element computed in the instance tree of the root of the shown structure (all files). */
interface RouteInfo {
    /** The selected element the route belongs to. */
    id: string;
    context: StructureContext;
    /** Diagram ids of the route in the shown structure. */
    ids: Set<string>;
    /** The endpoints of the route (labels relative to the root). */
    labels: string[];
    /** Providers (required port) or requirers (provided port) of the selected port. */
    ends: StructureLocation[];
    endsKind?: 'Providers' | 'Requirers';
    /** Composite parts of the shown structure the route continues into. */
    continuations: Array<{ instance: string, location: StructureLocation }>;
    /** The route continues outside of the shown structure (in the parent at the context). */
    outward?: StructureLocation;
}

const PORT_TOOLS: Record<string, { direction: 'provides' | 'requires', kind: 'sync' | 'async' }> = {
    'port-provides-sync': { direction: 'provides', kind: 'sync' },
    'port-provides-async': { direction: 'provides', kind: 'async' },
    'port-requires-sync': { direction: 'requires', kind: 'sync' },
    'port-requires-async': { direction: 'requires', kind: 'async' }
};

/**
 * The diagram of a structure file (`.dmf`): an internal block diagram of a structure or system (see
 * ibd-layout.ts of the language package), shown by the {@link DiagramController} instead of the state
 * machine diagram when the edited file is a structure file. Graphical editing (palette, rename in
 * place, drag & drop of instances into threads, connectors, properties) becomes text edits
 * ({@link DmfEditor}); selecting a port, connector or instance highlights the route of its signals,
 * across the levels of the hierarchy and the files of the workspace ({@link DmfWorkspace}); instances
 * open the state machine of their behavior or the diagram of their structure. If the file has several
 * structures or component types, a selector at the top of the diagram (and the text cursor) chooses the
 * one shown.
 */
export class StructureDiagram {

    private state?: StructureState;
    private updateVersion = 0;
    /** The element chosen with the selector, the text cursor or a navigation (by file). */
    private readonly chosen = new Map<string, string>();
    /** The contexts of shown structures given by a navigation (by `uri#element`). */
    private readonly contexts = new Map<string, StructureContext>();
    /** The context of the shown structure (explicit or the first use in a system of the workspace). */
    private shownContext?: StructureContext;
    private route?: Set<string>;
    private routeInfo?: RouteInfo;
    private pendingSelectOffset?: number;
    private pendingRename = false;
    private pendingLocation?: DiagramLocation;
    /** The connector tool: the port the connector starts at, and the state of the other ports. */
    private pendingPort?: string;
    private connectStatus?: Map<string, { status: ConnectStatus, message: string }>;
    private preview?: { svg: SVGSVGElement, line: SVGLineElement, move: (event: MouseEvent) => void };
    /** An edit is being applied (further edits of the same model are ignored). */
    private editing = false;

    constructor(private readonly context: StructureDiagramContext) { }

    get model(): StructureState | undefined {
        return this.state;
    }

    private get uri(): string {
        return this.context.language.uri;
    }

    /** Leaves the structure mode: hides the selector. */
    deactivate(): void {
        this.state = undefined;
        this.route = undefined;
        this.routeInfo = undefined;
        this.cancelConnector();
        document.getElementById('ibd-element-select')?.parentElement?.setAttribute('hidden', '');
        this.renderTypes(undefined);
        byId('diagram-area').classList.remove('route-highlight', 'structure-diagram');
    }

    /** Shows a location after the next update (navigation; the host loads the file). */
    reveal(location: DiagramLocation): void {
        this.pendingLocation = location;
    }

    /** The shown element and selection, for the navigation history. */
    currentLocation(): DiagramLocation {
        const single = this.single();
        return {
            uri: this.uri,
            element: this.state?.element,
            id: single,
            context: this.state ? this.contexts.get(`${normalizeUri(this.uri)}#${this.state.element}`) : undefined
        };
    }

    /** Parses the text and updates the diagram. */
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
        const uri = this.uri;
        const pending = this.pendingLocation && normalizeUri(this.pendingLocation.uri) === normalizeUri(uri) ? this.pendingLocation : undefined;
        if (pending?.element) {
            this.chosen.set(uri, pending.element);
            const key = `${normalizeUri(uri)}#${pending.element}`;
            if (pending.context) {
                this.contexts.set(key, pending.context);
            } else {
                this.contexts.delete(key);
            }
            force = true;
        }
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
            // a file of data types and interfaces: an overview of them instead of a diagram
            const types = this.renderTypes(parsed);
            banner.hidden = types;
            banner.textContent = 'The file declares no components, structures or systems – there is nothing to show in the diagram. '
                + 'Add one with the buttons of the properties panel.';
            await this.context.show({ type: 'graph:ibd', id: '#empty', children: [] } as SModelRoot);
            this.renderProperties();
            renderBreadcrumb([]);
            return;
        }
        this.renderTypes(undefined);
        this.state = { parsed, layout, issues: this.computeIssues(parsed, layout), element: elementOf(layout) };
        for (const id of [...this.context.selection]) {
            if (!layout.elements.has(id)) {
                this.context.selection.delete(id);
            }
        }
        if (this.pendingPort && !layout.elements.has(this.pendingPort)) {
            this.cancelConnector();
        }
        let selectId: string | undefined;
        if (this.pendingSelectOffset !== undefined) {
            selectId = this.elementStartingAt(this.pendingSelectOffset);
            this.pendingSelectOffset = undefined;
        }
        if (pending) {
            this.pendingLocation = undefined;
            selectId = pending.id && layout.elements.has(pending.id) ? pending.id
                : pending.offset !== undefined ? this.elementAt(pending.offset, layout, parsed, true) : undefined;
        }
        if (selectId) {
            this.context.selection.clear();
            this.context.selection.add(selectId);
        }
        this.updateRoute();
        await this.render();
        if (selectId) {
            const id = selectId;
            this.context.select(id);
            const range = this.rangeOf(id);
            if (range && !this.context.host.textHasFocus()) {
                this.context.host.highlightText(range);
            }
            if (this.pendingRename) {
                requestAnimationFrame(() => requestAnimationFrame(() => this.startRename(id)));
            }
        }
        this.pendingRename = false;
        this.refreshContext();
    }

    private async render(): Promise<void> {
        if (!this.state) {
            return;
        }
        byId('diagram-area').classList.toggle('route-highlight', this.route !== undefined && !this.pendingPort);
        byId('diagram-area').classList.toggle('connecting', this.pendingPort !== undefined);
        await this.context.show(toIbdSchema(this.state.layout.graph, {
            selected: this.context.selection,
            issues: this.state.issues,
            route: this.pendingPort ? undefined : this.route,
            connect: this.connectStatus ? new Map([...this.connectStatus].map(([id, s]) => [id, s.status])) : undefined,
            pendingPort: this.pendingPort
        }));
        this.renderProperties();
    }

    /**
     * The overview of the structs and interfaces of a file without component types (cards with their
     * fields and events; a click selects the declaration in the text). Without `parsed` (or types) the
     * overview is removed. Returns whether it is shown.
     */
    private renderTypes(parsed: ParsedDmfModel | undefined): boolean {
        const types = parsed?.model.elements.filter(e => isStructDeclaration(e) || isPortInterface(e)) ?? [];
        document.getElementById('ibd-types')?.remove();
        if (types.length === 0) {
            return false;
        }
        const text = (node: AstNode | undefined) => node?.$cstNode?.text.replace(/\s+/g, ' ') ?? '';
        const cards = types.map(type => {
            const rows = isStructDeclaration(type)
                ? type.fields.map(f => h('li', {}, h('span', { class: 'member-name' }, f.name), ` : ${text(f.type)}`))
                : isPortInterface(type) ? type.events.map(e => h('li', {}, 'event ', h('span', { class: 'member-name' }, e.name), e.type ? ` : ${text(e.type)}` : '')) : [];
            const card = h('section', { class: 'ibd-type-card', title: 'Show the declaration in the text' },
                h('div', { class: 'ibd-type-kind' }, isStructDeclaration(type) ? '«struct»' : '«interface»'),
                h('div', { class: 'ibd-type-name' }, type.name),
                ...[type.description, docComment(type)].filter(d => d).map(d => h('div', { class: 'ibd-type-description' }, d!)),
                h('ul', {}, ...(rows.length > 0 ? rows : [h('li', { class: 'empty' }, isStructDeclaration(type) ? 'no fields' : 'no events')])));
            card.addEventListener('click', () => {
                if (type.$cstNode) {
                    this.context.host.selectText({ offset: type.$cstNode.offset, end: type.$cstNode.end });
                }
            });
            return card;
        });
        const overview = h('div', { id: 'ibd-types' },
            h('div', { class: 'ibd-types-title' }, `Data types and interfaces of ${fileName(this.uri)}`), h('div', { class: 'ibd-types-cards' }, ...cards));
        byId('diagram-area').append(overview);
        return true;
    }

    /** The selector of the shown element (hidden if there is only one). */
    private updateSelector(choices: Array<{ id: string, label: string }>, current: string | undefined): void {
        let select = document.getElementById('ibd-element-select') as HTMLSelectElement | null;
        if (!select) {
            select = h('select', { id: 'ibd-element-select', title: 'The structure or component type shown in the diagram' });
            const box = h('div', { class: 'ibd-element-choice' }, h('span', {}, 'Show'), select);
            select.addEventListener('change', () => {
                this.chosen.set(this.uri, select!.value);
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
            const id = this.elementAt(textDocument.offsetAt(diagnostic.range.start), layout, parsed, true);
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
        // problems of other files: an instance whose component type (in an imported file) or state machine has errors
        for (const [id, node] of layout.elements) {
            if (!isComponentInstance(node)) {
                continue;
            }
            const messages = importedProblems(node, parsed);
            if (messages.length > 0) {
                const issue = issues.get(id) ?? { severity: 'error', messages: [] };
                issue.severity = 'error';
                issue.messages.push(...messages);
                issues.set(id, issue);
            }
        }
        return issues;
    }

    /** The text range of a diagram element in the edited file (ports of instances: the instance). */
    rangeOf(id: string): TextRange | undefined {
        const layout = this.state?.layout;
        const node = layout?.instances.get(id) ?? layout?.elements.get(id);
        const cst = node && this.isOwn(node) ? node.$cstNode : undefined;
        return cst ? { offset: cst.offset, end: cst.end } : undefined;
    }

    /** Whether the node belongs to the edited file (not to an imported one). */
    private isOwn(node: AstNode): boolean {
        return documentOf(node) === this.state?.parsed.document;
    }

    /** The innermost diagram element (of the edited file) whose text contains the offset. */
    private elementAt(offset: number, layout: IbdLayoutResult, parsed: ParsedDmfModel, includeFrame: boolean): string | undefined {
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

    /** The diagram element (of the edited file) whose text starts at the offset (e.g. a created element). */
    private elementStartingAt(offset: number): string | undefined {
        const state = this.state;
        if (!state) {
            return undefined;
        }
        for (const [id, node] of state.layout.elements) {
            if (!state.layout.instances.has(id) && this.isOwn(node) && node.$cstNode?.offset === offset) {
                return id;
            }
        }
        return this.elementAt(offset, state.layout, state.parsed, false);
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
            this.chosen.set(this.uri, element);
            this.context.selection.clear();
            this.context.fitOnNextUpdate();
            this.update(true).then(() => this.selectAtOffset(offset));
            return;
        }
        const id = this.elementAt(offset, state.layout, state.parsed, false);
        if (id !== this.single()) {
            this.context.select(id);
        }
        this.context.host.highlightText(undefined);
    }

    /** The selection changed (in the diagram): highlights the route and the text of the element. */
    selectionChanged(): void {
        const single = this.single();
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

    private single(): string | undefined {
        return this.context.selection.size === 1 ? [...this.context.selection][0] : undefined;
    }

    /** The route of the selection: at once in the shown structure, then (asynchronously) across the levels of the hierarchy. */
    private updateRoute(): void {
        const single = this.single();
        this.route = single && this.state ? ibdRouteElements(this.state.layout, single) : undefined;
        if (this.routeInfo?.id === single && this.routeInfo && this.route) {
            this.route = new Set([...this.route, ...this.routeInfo.ids]);
        } else {
            this.routeInfo = undefined;
        }
        if (single && this.route) {
            this.computeRouteInfo(single);
        }
    }

    /** The context of the shown structure: given by a navigation, else its first use in a system of the workspace. */
    private async contextOf(ws: DmfWorkspace, state: StructureState): Promise<{ context: StructureContext, structure: Structure } | undefined> {
        const structure = ws.componentType(this.uri, state.element);
        if (!isStructure(structure)) {
            return undefined;
        }
        const explicit = this.contexts.get(`${normalizeUri(this.uri)}#${state.element}`);
        if (explicit) {
            const resolved = ws.resolveContext(explicit);
            if (resolved?.structure === structure) {
                return { context: explicit, structure };
            }
        }
        return { context: ws.contextsOf(structure)[0], structure };
    }

    /** Updates the breadcrumb (the shown structure as a part of a root structure). */
    private async refreshContext(): Promise<void> {
        const state = this.state;
        if (!state) {
            return;
        }
        const ws = await this.context.language.structureWorkspace(this.context.host.getText());
        if (state !== this.state) {
            return;
        }
        const found = await this.contextOf(ws, state);
        this.shownContext = found?.context;
        const context = found?.context;
        if (!context || context.path.length === 0) {
            renderBreadcrumb([]);
            return;
        }
        const items: Array<{ label: string, title?: string, onClick?: () => void }> = [];
        for (let i = 0; i < context.path.length; i++) {
            const level = ws.resolveContext({ ...context, path: context.path.slice(0, i) });
            if (!level) {
                break;
            }
            const location: DiagramLocation = {
                uri: documentOf(level.structure)?.uri.toString() ?? context.rootUri, element: level.structure.name,
                id: `${level.structure.name}/${context.path[i]}`, context: { ...context, path: context.path.slice(0, i) }
            };
            items.push({ label: i === 0 ? level.structure.name : context.path[i - 1], title: `Show ${level.structure.name}`, onClick: () => this.context.navigate(location) });
        }
        items.push({ label: `${context.path[context.path.length - 1]} : ${state.element}` });
        renderBreadcrumb(items, 'Part of');
    }

    private async computeRouteInfo(id: string): Promise<void> {
        const state = this.state;
        const node = state?.layout.elements.get(id);
        if (!state || !node) {
            return;
        }
        const ws = await this.context.language.structureWorkspace(this.context.host.getText());
        if (state !== this.state || this.single() !== id) {
            return;
        }
        const found = await this.contextOf(ws, state);
        if (!found) {
            return;
        }
        const ctx = found.context;
        const starts: PortEndpoint[] = [];
        const add = (instance: string | undefined, port: string | undefined) => {
            const endpoint = port !== undefined ? ws.endpoint(ctx, instance, port) : undefined;
            if (endpoint) {
                starts.push(endpoint);
            }
        };
        if (isPort(node)) {
            const instance = state.layout.instances.get(id);
            add(isComponentInstance(instance) ? instance.name : undefined, node.name);
        } else if (isComponentInstance(node)) {
            instanceType(node)?.ports.forEach(p => add(node.name, p.name));
        } else if (isConnection(node) || isDelegation(node)) {
            for (const reference of [node.source, node.target]) {
                add(reference?.instance?.$refText, reference?.port?.$refText);
            }
        }
        if (starts.length === 0) {
            return;
        }
        const route = ws.route(starts);
        const ids = routeIdsAt(route, ctx.path);
        ids.add(id);
        let ends: StructureLocation[] = [];
        let endsKind: RouteInfo['endsKind'];
        const portStart = isPort(node) ? starts[0] : isConnection(node) ? starts[0] : undefined;
        if (portStart) {
            ends = ws.routeEnds(portStart, { ...ctx, path: [] });
            endsKind = portStart.port.direction === 'requires' ? 'Providers' : 'Requirers';
        }
        const continuations = routeContinuations(route, ctx.path).map(instance => {
            const inner = route.endpoints.filter(e => e.path.length === ctx.path.length + 1 && e.path[ctx.path.length].name === instance);
            const entry = inner.find(e => !e.instance) ?? inner[0];
            const s = entry.structure.name;
            return {
                instance,
                location: {
                    uri: documentOf(entry.structure)?.uri.toString() ?? '', element: s,
                    id: entry.instance ? `${s}/${entry.instance.name}.${entry.port.name}` : `${s}.${entry.port.name}`,
                    context: { ...ctx, path: [...ctx.path, instance] }
                }
            };
        });
        let outward: StructureLocation | undefined;
        if (ctx.path.length > 0) {
            const parentPath = ctx.path.slice(0, -1);
            const last = ctx.path[ctx.path.length - 1];
            const exit = route.endpoints.find(e => e.path.length === parentPath.length && e.instance?.name === last
                && e.path.every((p, i) => p.name === parentPath[i]));
            if (exit) {
                const s = exit.structure.name;
                outward = {
                    uri: documentOf(exit.structure)?.uri.toString() ?? '', element: s, id: `${s}/${last}.${exit.port.name}`,
                    context: { ...ctx, path: parentPath }
                };
            }
        }
        this.routeInfo = {
            id, context: ctx, ids, labels: [...new Set(route.endpoints.map(endpointLabel))], ends, endsKind, continuations, outward
        };
        const local = ibdRouteElements(state.layout, id) ?? new Set<string>();
        this.route = new Set([...local, ...ids]);
        this.render();
    }

    /** Graph size for the export. */
    get size(): { width: number, height: number } | undefined {
        const graph = this.state?.layout.graph;
        return graph ? { width: graph.width, height: graph.height } : undefined;
    }

    // -----------------------------------------------------------------------------------------
    // Editing: every diagram operation becomes a text edit (DmfEditor)

    /**
     * Computes text edits on the current model, applies them to the text (undoable) and updates the
     * diagram. `rename`: start renaming the element at the `selectOffset` of the result (a new element).
     */
    async applyEdit(producer: (editor: DmfEditor, state: StructureState) => EditResult | undefined, rename = false): Promise<boolean> {
        if (this.editing) {
            // (the producer refers to the model before the running edit)
            return false;
        }
        const state = this.state;
        if (!state || state.parsed.text !== this.context.host.getText()) {
            // the text changed after the diagram was shown: the producer would refer to an outdated model
            await this.update();
            this.context.setStatus(this.state && this.state.parsed.text === this.context.host.getText()
                ? 'The model has changed – please repeat the action.' : 'Please fix the syntax errors in the text first.', 'warning');
            return false;
        }
        this.editing = true;
        try {
            return await this.applyEditOn(state, producer, rename);
        } finally {
            this.editing = false;
        }
    }

    private async applyEditOn(state: StructureState, producer: (editor: DmfEditor, state: StructureState) => EditResult | undefined, rename: boolean): Promise<boolean> {
        let result: EditResult | undefined;
        try {
            result = producer(new DmfEditor(state.parsed.text, state.parsed.model), state);
        } catch (error) {
            if (error instanceof EditError) {
                this.context.setStatus(error.message, 'error');
                this.render();
                return false;
            }
            throw error;
        }
        if (!result || result.edits.length === 0) {
            this.render();
            return false;
        }
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && byId('properties').contains(focused)) {
            focused.blur();
        }
        if (!await this.context.host.applyTextEdits(result.edits)) {
            return false;
        }
        this.pendingSelectOffset = result.selectOffset;
        this.pendingRename = rename && result.selectOffset !== undefined;
        await this.update();
        return true;
    }

    /** The message of the edit operation or the syntax error of the resulting text, undefined if the edit is fine. */
    checkEdit(producer: (editor: DmfEditor) => EditResult | undefined): string | undefined {
        const state = this.state;
        if (!state || state.parsed.text !== this.context.host.getText()) {
            return undefined;
        }
        let result: EditResult | undefined;
        try {
            result = producer(new DmfEditor(state.parsed.text, state.parsed.model));
        } catch (error) {
            if (error instanceof EditError) {
                return error.message;
            }
            throw error;
        }
        if (!result || result.edits.length === 0) {
            return undefined;
        }
        const changed = applyEdits(state.parsed.text, result.edits);
        const errors = this.context.language.syntaxErrors(changed);
        if (errors.length === 0) {
            return undefined;
        }
        const start = Math.min(...result.edits.map(e => e.offset));
        const end = start + Math.max(...result.edits.map(e => e.text.length));
        return `Syntax error: ${describeSyntaxProblem(errors[0], start, end)}`;
    }

    /** The structure shown in the diagram (undefined for component types and the overview). */
    private shownStructure(): Structure | undefined {
        const node = this.state?.layout.elements.get(this.state.layout.graph.id);
        return isStructure(node) ? node : undefined;
    }

    /** The id of the diagram element of a Sprotty element (or its nearest ancestor known to the layout). */
    private idOf(target: SModelElementImpl | undefined): string | undefined {
        for (let current = target; current; current = 'parent' in current ? (current as { parent?: SModelElementImpl }).parent : undefined) {
            if (this.state?.layout.elements.has(current.id)) {
                return current.id;
            }
            if (current.type === IbdTypes.graph) {
                return this.state?.layout.graph.id;
            }
        }
        return undefined;
    }

    /** The port end (a port of a part or a boundary port) of a port id. */
    private endOf(id: string): DmfPortEnd | undefined {
        const node = this.state?.layout.elements.get(id);
        if (!isPort(node)) {
            return undefined;
        }
        const instance = this.state!.layout.instances.get(id);
        if (instance && !isComponentInstance(instance)) {
            return undefined;
        }
        return { instance, port: node };
    }

    /** The diagram node (layout) of an id. */
    private ibdNode(id: string): IbdNode | undefined {
        return this.state ? ibdNodes(this.state.layout.graph).find(n => n.node.id === id)?.node : undefined;
    }

    /** A mouse button was pressed (tools of the palette, click on the icon of an instance). */
    mouseDown(target: SModelElementImpl, event: MouseEvent): void {
        if (event.button !== 0 || !this.state) {
            return;
        }
        const tool = this.context.tool();
        const id = this.idOf(target);
        if (tool === 'select') {
            const element = event.target instanceof Element ? event.target : undefined;
            const node = id ? this.state.layout.elements.get(id) : undefined;
            if (element?.closest('.ibd-icon') && isComponentInstance(node)) {
                const instanceId = id!;
                setTimeout(() => this.openInstance(instanceId, node), 0);
            }
            return;
        }
        if (tool === 'connector') {
            this.connectorDown(id, event);
            return;
        }
        const structure = this.shownStructure();
        const node = id ? this.state.layout.elements.get(id) : undefined;
        if (tool === 'thread') {
            if (!structure || !this.isOwn(structure)) {
                this.context.setStatus('Threads are added to a structure or system: show one in the diagram.', 'warning');
                return;
            }
            this.applyEdit(editor => editor.addThread(structure), true);
            this.context.toolDone();
        } else if (tool === 'instance') {
            if (!structure || !this.isOwn(structure)) {
                this.context.setStatus('Instances are added to a structure or system: show one in the diagram.', 'warning');
                return;
            }
            const thread = isThread(node) ? node : isComponentInstance(node) && !this.state.layout.instances.has(id!) ? threadOf(node) : undefined;
            this.chooseType(event, structure, thread);
        } else if (tool in PORT_TOOLS) {
            const owner = this.portOwnerAt(id, node);
            if (!owner) {
                return;
            }
            const { direction, kind } = PORT_TOOLS[tool];
            const type = kind === 'sync' ? 'integer' : this.defaultInterface();
            this.applyEdit(editor => editor.addPort(owner, { direction, kind, type }), true);
            this.context.toolDone();
        }
    }

    /** The component type a port tool adds a port to: the shown structure (its boundary), a component block, the type of an instance. */
    private portOwnerAt(id: string | undefined, node: AstNode | undefined): ComponentType | undefined {
        let owner: ComponentType | undefined;
        if (isComponentInstance(node) && id && !this.state!.layout.instances.has(id)) {
            owner = instanceType(node);
        } else if (isPort(node)) {
            const instance = this.state!.layout.instances.get(id!);
            owner = isComponentInstance(instance) ? instanceType(instance) : node.$container;
        } else if (isComponentType(node)) {
            owner = node;
        } else {
            owner = this.shownStructure();
        }
        if (!owner) {
            this.context.setStatus('Click on the frame, a component or an instance to add a port.', 'warning');
            return undefined;
        }
        if (!this.isOwn(owner)) {
            const file = documentOf(owner)?.uri.path.replace(/^.*\//, '') ?? 'another file';
            this.context.setStatus(`'${owner.name}' is declared in ${file} – open it to add ports (double-click the type name of the instance).`, 'warning');
            return undefined;
        }
        return owner;
    }

    /** The first interface visible in the file (the default type of a new async port). */
    private defaultInterface(): string | undefined {
        const model = this.state?.parsed.model;
        if (!model) {
            return undefined;
        }
        for (const [name, element] of visibleElements(model)) {
            if (isPortInterface(element) && !name.includes('.')) {
                return name;
            }
        }
        return undefined;
    }

    /** The component types an instance can be created of (visible in the file, not systems, not the structure itself). */
    private instantiableTypes(structure: Structure): Array<{ name: string, type: ComponentType }> {
        const result: Array<{ name: string, type: ComponentType }> = [];
        const seen = new Set<AstNode>();
        for (const [name, element] of visibleElements(structure.$container)) {
            if (!isComponentType(element) || seen.has(element) || element === structure || (isStructure(element) && element.kind === 'system')) {
                continue;
            }
            seen.add(element);
            result.push({ name, type: element });
        }
        return result;
    }

    /** The instance tool: choose the component type, then the instance is added and renamed. */
    private chooseType(event: MouseEvent, structure: Structure, thread: Thread | undefined): void {
        const types = this.instantiableTypes(structure);
        showChooser({
            x: event.clientX + 4,
            y: event.clientY + 4,
            title: `New instance in ${thread ? `thread ${thread.name}` : structure.name}`,
            placeholder: 'component type',
            items: types.map(t => ({
                value: t.name,
                label: t.name,
                detail: `${isStructure(t.type) ? 'structure' : 'component'}${this.isOwn(t.type) ? '' : ` · ${documentOf(t.type)?.uri.path.replace(/^.*\//, '') ?? ''}`}`
            })),
            commit: value => {
                this.applyEdit(editor => editor.addInstance(structure, value, { thread }), true);
                this.context.toolDone();
            },
            cancel: () => this.context.toolDone()
        });
    }

    // ---- connector tool

    private connectorDown(id: string | undefined, event: MouseEvent): void {
        const end = id ? this.endOf(id) : undefined;
        if (!this.pendingPort) {
            if (!end || !id) {
                this.context.setStatus('Press on a port and drag to the port to connect it with.', 'warning');
                return;
            }
            this.startConnector(id, event);
            return;
        }
        if (end && id && id !== this.pendingPort) {
            this.finishConnector(id);
        } else if (id !== this.pendingPort) {
            this.cancelConnector();
            this.context.setStatus('Connector cancelled.');
            this.render();
        }
    }

    /** The mouse button was released: a connector dragged from one port to another is finished. */
    mouseUp(target: SModelElementImpl, _event: MouseEvent): void {
        if (this.context.tool() !== 'connector' || !this.pendingPort) {
            return;
        }
        const id = this.idOf(target);
        if (id && id !== this.pendingPort && this.endOf(id)) {
            this.finishConnector(id);
        }
    }

    private startConnector(id: string, event: MouseEvent): void {
        const structure = this.shownStructure();
        const source = this.endOf(id);
        if (!structure || !source || !this.isOwn(structure)) {
            this.context.setStatus('Connectors are drawn in the diagram of a structure or system.', 'warning');
            return;
        }
        this.pendingPort = id;
        this.connectStatus = new Map();
        for (const [otherId, node] of this.state!.layout.elements) {
            const other = isPort(node) && otherId !== id ? this.endOf(otherId) : undefined;
            if (!other) {
                continue;
            }
            try {
                const plan = planConnection(structure, source, other);
                this.connectStatus.set(otherId, plan.problems.length > 0
                    ? { status: 'problem', message: `${plan.text} – incompatible: ${plan.problems.join('; ')}` }
                    : { status: 'ok', message: `${plan.text}${plan.swapped ? ' (from the required port)' : ''}` });
            } catch (error) {
                this.connectStatus.set(otherId, { status: 'invalid', message: error instanceof Error ? error.message : String(error) });
            }
        }
        this.showPreview(event);
        this.context.setHint('Drag to (or click) the port to connect – green: compatible, orange: incompatible types (Esc cancels)');
        this.render();
    }

    private finishConnector(targetId: string): void {
        const sourceId = this.pendingPort!;
        const structure = this.shownStructure();
        const source = this.endOf(sourceId);
        const target = this.endOf(targetId);
        const status = this.connectStatus?.get(targetId);
        this.cancelConnector();
        if (!structure || !source || !target) {
            return;
        }
        if (status?.status === 'invalid') {
            this.context.setStatus(status.message, 'error');
            this.render();
            this.context.toolDone();
            return;
        }
        let plan: ReturnType<DmfEditor['addConnection']>['plan'] | undefined;
        this.applyEdit(editor => {
            const result = editor.addConnection(structure, source, target);
            plan = result.plan;
            return result;
        }).then(done => {
            if (done && plan) {
                if (plan.problems.length > 0) {
                    this.context.setStatus(`Added '${plan.text}' – but the ports are incompatible: ${plan.problems.join('; ')}.`, 'warning');
                } else {
                    this.context.setStatus(`Added '${plan.text}'${plan.swapped ? ' (written from the required to the provided port)' : ''}.`);
                }
            }
        });
        this.context.toolDone();
    }

    /** Ends the connector tool's drawing (Esc, another tool, a click elsewhere). */
    cancelConnector(): void {
        this.pendingPort = undefined;
        this.connectStatus = undefined;
        if (this.preview) {
            byId('diagram-area').removeEventListener('mousemove', this.preview.move);
            this.preview.svg.remove();
            this.preview = undefined;
        }
        this.context.setHint(undefined);
        byId('diagram-area').classList.remove('connecting');
    }

    /** The line from the port to the mouse while drawing a connector; the hint tells whether the port below the mouse fits. */
    private showPreview(event: MouseEvent): void {
        const area = byId('diagram-area');
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.classList.add('connector-preview');
        const line = document.createElementNS(ns, 'line');
        svg.append(line);
        area.append(svg);
        const port = document.getElementById(`sprotty_${this.pendingPort}`)?.querySelector('.ibd-port-shape');
        const origin = () => {
            const rect = (port ?? document.getElementById(`sprotty_${this.pendingPort}`))?.getBoundingClientRect();
            const box = area.getBoundingClientRect();
            return rect ? { x: rect.left + rect.width / 2 - box.left, y: rect.top + rect.height / 2 - box.top } : { x: 0, y: 0 };
        };
        const move = (e: MouseEvent) => {
            const box = area.getBoundingClientRect();
            const start = origin();
            line.setAttribute('x1', String(start.x));
            line.setAttribute('y1', String(start.y));
            line.setAttribute('x2', String(e.clientX - box.left));
            line.setAttribute('y2', String(e.clientY - box.top));
            let element = e.target instanceof Element ? e.target : null;
            while (element && !(element.id.startsWith('sprotty_') && this.connectStatus?.has(element.id.substring(8)))) {
                element = element.parentElement;
            }
            const status = element ? this.connectStatus?.get(element.id.substring(8)) : undefined;
            line.setAttribute('class', status ? `status-${status.status}` : '');
            this.context.setHint(status ? status.message : 'Drag to (or click) the port to connect – green: compatible, orange: incompatible types (Esc cancels)');
        };
        area.addEventListener('mousemove', move);
        this.preview = { svg, line, move };
        move(event);
    }

    // ---- drag & drop, double-click, rename, delete

    /** An instance was dragged onto a thread (or the frame): it is moved into that thread (out of its thread). */
    dragEnd(draggedId: string, dropTargetId: string | undefined): void {
        const state = this.state;
        const instance = state?.layout.elements.get(draggedId);
        if (!state || !isComponentInstance(instance) || state.layout.instances.has(draggedId) || !this.isOwn(instance)) {
            this.render();
            return;
        }
        const target = dropTargetId === `${state.layout.graph.id}#ibd` ? this.shownStructure() : dropTargetId ? state.layout.elements.get(dropTargetId) : undefined;
        if (!isThread(target) && !isStructure(target)) {
            this.render();
            return;
        }
        this.applyEdit(editor => editor.moveInstance(instance, target)).then(done => {
            if (done) {
                this.context.setStatus(isThread(target) ? `Moved '${instance.name}' into the thread ${target.name}.`
                    : `'${instance.name}' runs in no thread of its own now (a passive part).`);
            }
        });
    }

    /**
     * Double-click: on an instance with a behavior or a structure: opens it (on the type name: the type
     * definition, on the name: rename); elsewhere: rename in place.
     */
    doubleClick(target: SModelElementImpl, event: MouseEvent): void {
        const id = this.idOf(target);
        const state = this.state;
        if (!id || !state) {
            return;
        }
        const node = state.layout.elements.get(id);
        const element = event.target instanceof Element ? event.target : undefined;
        if (isComponentInstance(node) && !state.layout.instances.has(id)) {
            if (element?.closest('.ibd-instance-type')) {
                this.goToType(node);
            } else if (element?.closest('.ibd-instance-label') || !this.openInstance(id, node)) {
                this.startRename(id);
            }
        } else if (isConnection(node) || isDelegation(node)) {
            const range = this.rangeOf(id);
            if (range) {
                this.context.host.editTextAt(range.end);
            }
        } else if (node) {
            this.startRename(id);
        }
    }

    /** The context of the parts of the shown structure (to open a composite part). */
    private partContext(instance: string): StructureContext {
        const base = this.shownContext ?? { rootUri: this.uri, root: this.state?.element ?? '', path: [] };
        return { ...base, path: [...base.path, instance] };
    }

    /** Opens the state machine (behavior) or the structure of an instance; false if it has neither. */
    openInstance(id: string, instance: ComponentInstance): boolean {
        const node = this.ibdNode(id);
        if (node?.composite?.uri) {
            this.context.navigate({ uri: node.composite.uri, element: node.composite.structure, context: this.partContext(instance.name) });
            return true;
        }
        if (node?.behavior) {
            if (!node.behavior.uri) {
                this.context.setStatus(`The state machine of '${instance.name}' is not available.`, 'warning');
                return true;
            }
            this.context.navigate({ uri: node.behavior.uri });
            return true;
        }
        return false;
    }

    /** Shows the definition of the type of an instance (its file, the type selected). */
    goToType(instance: ComponentInstance): void {
        const type = instanceType(instance);
        const document = type ? documentOf(type) : undefined;
        if (!type || !document) {
            this.context.setStatus(`The type '${instance.type?.$refText ?? '?'}' of '${instance.name}' is not resolved.`, 'warning');
            return;
        }
        this.context.navigate({ uri: document.uri.toString(), element: type.name, id: type.name, offset: type.$cstNode?.offset });
    }

    /** Opens an inline editor to rename the element (instance, port, thread, structure, component type). */
    startRename(id: string): void {
        closeInlineEditor();
        const node = this.state?.layout.elements.get(id);
        const element = document.getElementById(`sprotty_${id}`);
        if (!node || !element || !('name' in node) || typeof node.name !== 'string') {
            return;
        }
        const named = node as AstNode & { name: string };
        const label = element.querySelector(':scope > .ibd-instance-name, :scope > .ibd-thread-title, :scope > .ibd-frame-title, .ibd-port-label') ?? element;
        const bounds = label.getBoundingClientRect();
        showInlineEditor({
            rect: { left: bounds.left, top: bounds.top, width: Math.max(bounds.width, 120), height: Math.max(bounds.height, 20) },
            value: named.name,
            validate: value => {
                try {
                    checkRename(named, value.trim());
                    return undefined;
                } catch (error) {
                    return error instanceof Error ? error.message : String(error);
                }
            },
            commit: value => this.rename(named, value.trim()),
            discarded: (_value, error) => this.context.setStatus(`The name was not applied – ${error}`, 'error')
        });
    }

    /**
     * Renames an element: instances and threads in the file, component types and ports also in the
     * other files of the workspace that reference them (Langium references, {@link DmfWorkspace.renameEdits}).
     */
    async rename(node: AstNode & { name: string }, name: string): Promise<void> {
        if (name === node.name) {
            return;
        }
        if (isComponentInstance(node) || isThread(node)) {
            await this.applyEdit(editor => editor.rename(node, name));
            return;
        }
        const document = documentOf(node);
        if (!document || !node.$cstNode) {
            return;
        }
        const ws = await this.context.language.structureWorkspace(this.context.host.getText());
        let edits: Map<string, TextEdit[]> | undefined;
        try {
            edits = ws.renameEdits(document.uri.toString(), node.$cstNode.offset, name);
        } catch (error) {
            if (error instanceof EditError) {
                this.context.setStatus(error.message, 'error');
                return;
            }
            throw error;
        }
        if (!edits) {
            if (this.isOwn(node)) {
                await this.applyEdit(editor => editor.rename(node as Port, name));
            }
            return;
        }
        const current = normalizeUri(this.uri);
        const own = edits.get(current) ?? [];
        const others = new Map([...edits].filter(([uri]) => uri !== current));
        if (others.size > 0) {
            if (!this.context.host.applyWorkspaceEdits) {
                this.context.setStatus(`'${node.name}' is also used in other files – rename it in the text editor.`, 'warning');
                return;
            }
            // all files in one step (VS Code: one workspace edit, undone together)
            if (!await this.applyWorkspaceEdits(edits, own.length > 0 ? mapOffset(node.$cstNode.offset, [...own]) : undefined)) {
                this.context.setStatus(`The other files using '${node.name}' could not be changed.`, 'error');
                return;
            }
        } else if (own.length > 0) {
            await this.applyEdit(() => ({ edits: own }));
        } else {
            await this.update(true);
        }
        this.context.setStatus(`Renamed '${node.name}' to '${name}'${others.size > 0 ? ` (also in ${fileNames(others.keys())})` : ''}.`);
    }

    /**
     * Applies edits of several files (including the edited one, by normalized URI) through the host, then
     * updates the diagram and selects the element at `selectOffset` of the changed text.
     */
    private async applyWorkspaceEdits(edits: ReadonlyMap<string, readonly TextEdit[]>, selectOffset?: number): Promise<boolean> {
        if (this.editing || !this.context.host.applyWorkspaceEdits) {
            return false;
        }
        this.editing = true;
        try {
            if (!await this.context.host.applyWorkspaceEdits(edits)) {
                return false;
            }
        } finally {
            this.editing = false;
        }
        this.pendingSelectOffset = selectOffset;
        await this.update(true);
        return true;
    }

    /** Deletes the selected elements of the edited file (an instance with its connections, a thread keeping its instances, …). */
    deleteSelection(): void {
        const state = this.state;
        if (!state) {
            return;
        }
        const nodes: AstNode[] = [];
        let skipped = false;
        for (const id of this.context.selection) {
            const node = state.layout.elements.get(id);
            if (!node || id === state.layout.graph.id && isStructure(node)) {
                continue;
            }
            if (state.layout.instances.has(id) || !this.isOwn(node)) {
                skipped = true;
                continue;
            }
            nodes.push(node);
        }
        if (nodes.length === 0) {
            if (skipped) {
                this.context.setStatus('The ports of an instance belong to its component type – delete them there (double-click the type name).', 'warning');
            }
            return;
        }
        this.context.selection.clear();
        const ports = nodes.flatMap(node => isPort(node) ? [node] : isComponentType(node) ? node.ports : []);
        if (ports.length > 0 && this.context.host.applyWorkspaceEdits) {
            this.deleteWithUsages(state, nodes, ports);
        } else {
            this.applyEdit(editor => editor.deleteElements(nodes));
        }
    }

    /**
     * Deletes elements including ports: the connections and delegations using the ports in other files of
     * the workspace are deleted as well (one step with the edits of the edited file).
     */
    private async deleteWithUsages(state: StructureState, nodes: AstNode[], ports: Port[]): Promise<void> {
        const text = this.context.host.getText();
        const ws = await this.context.language.structureWorkspace(text);
        const others = text === state.parsed.text && this.state === state
            ? ws.portDeletionEdits(this.uri, ports.filter(p => p.$cstNode).map(p => p.$cstNode!.offset)) : new Map<string, TextEdit[]>();
        if (others.size === 0) {
            await this.applyEdit(editor => editor.deleteElements(nodes));
            return;
        }
        let own: TextEdit[];
        try {
            own = new DmfEditor(state.parsed.text, state.parsed.model).deleteElements(nodes).edits;
        } catch (error) {
            if (error instanceof EditError) {
                this.context.setStatus(error.message, 'error');
                return;
            }
            throw error;
        }
        if (await this.applyWorkspaceEdits(new Map([[normalizeUri(this.uri), own], ...others]))) {
            this.context.setStatus(`Deleted, with the connections in ${fileNames(others.keys())}.`);
        } else {
            this.context.setStatus(`The connections in ${fileNames(others.keys())} could not be deleted.`, 'error');
        }
    }

    // -----------------------------------------------------------------------------------------
    // Properties panel

    renderProperties(): void {
        const panel = byId('properties');
        if (panel.contains(document.activeElement) && document.activeElement !== panel) {
            return;
        }
        const state = this.state;
        const single = this.single();
        const node = single ? state?.layout.elements.get(single) : undefined;
        const content: Array<HTMLElement | undefined> = [];
        if (!state) {
            content.push(h('p', { class: 'hint' }, 'Structure file without component types.'), ...this.addTypeButtons());
        } else if (this.context.selection.size > 1) {
            content.push(h('h2', {}, `${this.context.selection.size} elements selected`),
                h('div', { class: 'actions' }, h('button', { class: 'danger', onClick: () => this.deleteSelection() }, 'Delete')));
        } else if (!node || !single || single === state.layout.graph.id) {
            content.push(...this.overviewPanel(state));
        } else {
            content.push(...this.elementPanel(state, single, node));
        }
        panel.replaceChildren(...content.filter((e): e is HTMLElement => !!e));
    }

    private addTypeButtons(): HTMLElement[] {
        const add = (kind: 'component' | 'structure' | 'system') => () => this.applyEditOnText(editor => editor.addComponentType(kind));
        return [h('div', { class: 'actions' },
            h('button', { onClick: add('component') }, 'Add component'),
            h('button', { onClick: add('structure') }, 'Add structure'),
            h('button', { onClick: add('system') }, 'Add system'))];
    }

    /** An edit of a file without a diagram (no component types yet). */
    private async applyEditOnText(producer: (editor: DmfEditor) => EditResult): Promise<void> {
        const text = this.context.host.getText();
        const parsed = await this.context.language.parseStructure(text);
        if (parsed.hasSyntaxErrors) {
            this.context.setStatus('Please fix the syntax errors in the text first.', 'error');
            return;
        }
        try {
            const result = producer(new DmfEditor(text, parsed.model));
            if (await this.context.host.applyTextEdits(result.edits)) {
                this.pendingSelectOffset = result.selectOffset;
                this.pendingRename = true;
                this.context.fitOnNextUpdate();
                await this.update(true);
            }
        } catch (error) {
            if (error instanceof EditError) {
                this.context.setStatus(error.message, 'error');
                return;
            }
            throw error;
        }
    }

    private overviewPanel(state: StructureState): HTMLElement[] {
        const root = state.layout.elements.get(state.layout.graph.id);
        const rows: HTMLElement[] = [];
        const result: HTMLElement[] = [];
        if (isStructure(root)) {
            rows.push(h('dt', {}, 'Ports'), h('dd', {}, String(root.ports.length)),
                h('dt', {}, 'Threads'), h('dd', {}, String(root.threads.length)),
                h('dt', {}, 'Connections'), h('dd', {}, String(root.connections.length + root.delegations.length)));
        }
        result.push(h('h2', {}, state.layout.graph.kind === 'overview' ? 'Component types' : state.layout.graph.name),
            h('div', { class: 'kind' }, state.layout.graph.kind === 'overview' ? 'Structure file' : state.layout.graph.kind));
        if (isStructure(root) && this.isOwn(root)) {
            result.push(this.nameField(root));
        } else if (isComponent(root)) {
            result.push(...this.componentFields(root));
        }
        if (rows.length > 0) {
            result.push(h('dl', {}, ...rows));
        }
        const context = this.shownContext;
        if (context && context.path.length > 0) {
            result.push(h('p', { class: 'hint' }, `Shown as the part ${context.path.join('.')} of ${context.root}: routes are followed through ${context.root}.`));
        }
        if (isStructure(root)) {
            result.push(h('div', { class: 'actions' },
                h('button', { onClick: () => this.applyEdit(editor => editor.addThread(root), true) }, 'Add thread'),
                h('button', { onClick: () => this.context.setTool('instance') }, 'Add instance…'),
                h('button', { onClick: () => this.context.setTool('connector') }, 'Connector')));
        }
        result.push(...this.addTypeButtons(),
            h('h2', { style: 'margin-top:18px' }, 'How to edit'),
            h('ul', { class: 'hint', style: 'padding-left:18px;margin:6px 0' },
                h('li', {}, 'Pick a tool in the palette (thread, instance, ports, connector), then click into the diagram. Hold ', h('kbd', {}, 'Shift'), ' to keep the tool.'),
                h('li', {}, 'Connector: press on a port and drag to the other port – compatible ports turn green. A connection is written from the required to the provided port, a boundary port is delegated.'),
                h('li', {}, 'Drag an instance into a thread (or out of it onto the frame) to change its thread.'),
                h('li', {}, 'Double-click an instance to open its state machine or structure, its type name to open the type, its name (or ', h('kbd', {}, 'F2'), ') to rename it.'),
                h('li', {}, 'Select a port, connector or instance to highlight the route of its signals (also through composites).'),
                h('li', {}, h('kbd', {}, 'Del'), ' deletes, ', h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Z'), ' undoes; ', h('kbd', {}, 'Alt'), '+', h('kbd', {}, '←'), ' goes back.')),
            h('h2', { style: 'margin-top:18px' }, 'Notation'),
            h('ul', { class: 'hint', style: 'padding-left:18px;margin:6px 0' },
                h('li', {}, 'Ports: filled square = provided, hollow square = required.'),
                h('li', {}, 'Async ports (events) show a chevron in the direction of the events, sync ports (data) are plain squares.'),
                h('li', {}, 'Dashed connectors cross threads.')));
        return result;
    }

    private nameField(node: AstNode & { name: string }, label = 'Name'): HTMLElement {
        const input = h('input', { value: node.name, spellcheck: 'false' });
        const check = (value: string) => {
            try {
                checkRename(node, value.trim());
                return undefined;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        };
        input.addEventListener('input', () => {
            const error = check(input.value);
            input.setCustomValidity(error ?? '');
            input.title = error ?? '';
        });
        input.addEventListener('change', () => {
            if (!check(input.value) && input.value.trim() !== node.name) {
                this.rename(node, input.value.trim());
            }
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                input.dispatchEvent(new Event('change'));
            }
        });
        return field(label, input);
    }

    /** The behavior of a component (state machine file) and the button to open it. */
    private componentFields(component: Component): HTMLElement[] {
        const own = this.isOwn(component);
        const result: HTMLElement[] = [];
        if (own) {
            result.push(this.nameField(component));
            const machines = h('datalist', { id: 'dmf-behavior-files' },
                ...this.context.language.workspaceFileNames().filter(n => /\.hsm$/i.test(n)).map(n => h('option', { value: n })));
            const value = component.behavior ? component.behavior.path ?? component.behavior.machine?.$refText ?? '' : '';
            result.push(...checkedField('Behavior (state machine)', h('input', { value, list: 'dmf-behavior-files', placeholder: 'e.g. door.hsm', spellcheck: 'false' }),
                v => this.checkEdit(editor => editor.setBehavior(component, v)),
                v => this.applyEdit(editor => editor.setBehavior(component, v))), machines);
        }
        const behavior = this.ibdNode(component.name)?.behavior;
        if (behavior?.uri) {
            const uri = behavior.uri;
            result.push(h('div', { class: 'actions' }, h('button', { onClick: () => this.context.navigate({ uri }) }, 'Open state machine')));
        }
        if (own) {
            result.push(h('div', { class: 'actions' },
                h('button', { onClick: () => this.applyEdit(e => e.addPort(component, { direction: 'provides', kind: 'async', type: this.defaultInterface() }), true) }, 'Add provided port'),
                h('button', { onClick: () => this.applyEdit(e => e.addPort(component, { direction: 'requires', kind: 'async', type: this.defaultInterface() }), true) }, 'Add required port')));
        }
        return result;
    }

    private elementPanel(state: StructureState, id: string, node: AstNode): HTMLElement[] {
        const issue = state.issues.get(id);
        const result: Array<HTMLElement | undefined> = [];
        const remove = h('button', { class: 'danger', onClick: () => this.deleteSelection() }, 'Delete');
        if (isPort(node)) {
            const instance = state.layout.instances.get(id);
            const part = isComponentInstance(instance) ? instance : undefined;
            const owner = node.$container;
            result.push(h('h2', {}, part ? `${part.name}.${node.name}` : node.name),
                h('div', { class: 'kind' }, `${node.direction === 'provides' ? 'Provided' : 'Required'} ${node.kind} port of ${owner.name}`),
                ...problems(issue));
            if (this.isOwn(owner) && !part) {
                result.push(...this.portFields(node));
            } else {
                result.push(h('dl', {}, h('dt', {}, 'Type'), h('dd', {}, portTypeLabel(node))));
                if (part) {
                    result.push(h('p', { class: 'hint' }, `The port belongs to the component type ${owner.name}${this.isOwn(owner) ? '' : ` (${documentOf(owner)?.uri.path.replace(/^.*\//, '')})`}.`),
                        this.isOwn(owner) ? h('div', {}, ...this.portFields(node)) : h('div', { class: 'actions' }, h('button', { onClick: () => this.goToType(part) }, `Edit in ${owner.name}`)));
                }
            }
            result.push(...this.routePanel(state, id, node, part));
            if (!part && this.isOwn(owner)) {
                result.push(h('div', { class: 'actions' }, remove));
            }
        } else if (isComponentInstance(node)) {
            result.push(...this.instancePanel(state, id, node, issue, remove));
        } else if (isThread(node)) {
            result.push(...this.threadPanel(node, issue, remove));
        } else if (isConnection(node) || isDelegation(node)) {
            const edge = state.layout.graph.edges.find(e => e.id === id);
            result.push(h('h2', {}, edge?.title ?? id),
                h('div', { class: 'kind' }, isConnection(node) ? (edge?.crossThread ? 'Connection (crosses threads)' : 'Connection') : 'Delegation'),
                ...problems(issue),
                h('dl', {},
                    h('dt', {}, isConnection(node) ? 'Required' : 'From'), h('dd', {}, h('code', {}, node.source ? referenceText(node.source) : '?')),
                    h('dt', {}, isConnection(node) ? 'Provided' : 'To'), h('dd', {}, h('code', {}, node.target ? referenceText(node.target) : '?'))),
                ...this.routePanel(state, id, node, undefined),
                h('div', { class: 'actions' }, h('button', { onClick: () => this.context.host.editTextAt(this.rangeOf(id)?.end ?? 0) }, 'Edit in text'), remove));
        } else if (isComponent(node)) {
            result.push(h('h2', {}, node.name), h('div', { class: 'kind' }, 'Component'), ...problems(issue), ...this.componentFields(node),
                this.isOwn(node) ? h('div', { class: 'actions' }, remove) : undefined);
        } else {
            result.push(h('h2', {}, (node as { name?: string }).name ?? id), h('div', { class: 'kind' }, node.$type), ...problems(issue));
        }
        return result.filter((e): e is HTMLElement => !!e);
    }

    /** Name, direction, kind and type of a port (of a type of the edited file). */
    private portFields(port: Port): HTMLElement[] {
        const direction = h('select', {}, h('option', { value: 'provides' }, 'provides'), h('option', { value: 'requires' }, 'requires'));
        direction.value = port.direction;
        direction.addEventListener('change', () => this.applyEdit(editor => editor.setPortDirection(port, direction.value as Port['direction'])));
        const kind = h('select', {}, h('option', { value: 'sync' }, 'sync (data)'), h('option', { value: 'async' }, 'async (events)'));
        kind.value = port.kind;
        kind.addEventListener('change', () => this.applyEdit(editor => editor.setPortKind(port, kind.value as Port['kind'])));
        const model = this.state?.parsed.model;
        const names = model ? [...visibleElements(model)].filter(([, e]) => isPortInterface(e) || isStructDeclaration(e)).map(([n]) => n) : [];
        const types = h('datalist', { id: 'dmf-port-types' }, ...[...BUILTIN_TYPES.filter(t => t !== 'void'), ...names].map(n => h('option', { value: n })));
        const typeText = port.$cstNode ? this.typeTextOf(port) : portTypeLabel(port);
        return [
            this.nameField(port),
            h('div', { class: 'row' }, field('Direction', direction), field('Kind', kind)),
            ...checkedField('Type', h('input', {
                value: typeText, list: 'dmf-port-types', spellcheck: 'false',
                placeholder: port.kind === 'async' ? 'interface or event a, event b : integer' : 'e.g. integer'
            }), value => this.checkEdit(editor => editor.setPortType(port, value)), value => this.applyEdit(editor => editor.setPortType(port, value))),
            types
        ];
    }

    /** The type of a port as written (after the colon). */
    private typeTextOf(port: Port): string {
        const text = this.state?.parsed.text ?? '';
        const cst = port.$cstNode!;
        const source = documentOf(port) === this.state?.parsed.document ? text.substring(cst.offset, cst.end) : '';
        const colon = source.indexOf(':');
        return colon >= 0 ? source.substring(colon + 1).trim() : portTypeLabel(port);
    }

    private instancePanel(state: StructureState, id: string, node: ComponentInstance, issue: Issue | undefined, remove: HTMLElement): HTMLElement[] {
        const type = instanceType(node);
        const thread = threadOf(node);
        const structure = this.shownStructure();
        const own = this.isOwn(node);
        const result: Array<HTMLElement | undefined> = [
            h('h2', {}, node.name),
            h('div', { class: 'kind' }, `Instance of ${type?.name ?? node.type?.$refText ?? '?'}${thread ? ` · thread ${thread.name}` : ' · passive (no thread)'}`),
            ...problems(issue)
        ];
        if (own && structure) {
            result.push(this.nameField(node));
            const typeSelect = h('select', {}, ...this.instantiableTypes(structure).map(t => h('option', { value: t.name }, t.name)));
            if (!type || ![...typeSelect.options].some(o => o.value === node.type?.$refText)) {
                typeSelect.prepend(h('option', { value: node.type?.$refText ?? '' }, node.type?.$refText ?? '?'));
            }
            typeSelect.value = node.type?.$refText ?? '';
            typeSelect.addEventListener('change', () => this.applyEdit(editor => editor.setInstanceType(node, typeSelect.value)));
            const threadSelect = h('select', {}, h('option', { value: '' }, '– none (passive)'), ...structure.threads.map(t => h('option', { value: t.name }, t.name)));
            threadSelect.value = thread?.name ?? '';
            threadSelect.addEventListener('change', () => {
                const target = structure.threads.find(t => t.name === threadSelect.value) ?? structure;
                this.applyEdit(editor => editor.moveInstance(node, target));
            });
            result.push(field('Type', typeSelect), field('Thread', threadSelect));
        }
        const ibd = this.ibdNode(id);
        result.push(h('div', { class: 'actions' },
            ibd?.behavior ? h('button', { class: 'primary', onClick: () => this.openInstance(id, node) }, 'Open state machine') : undefined,
            ibd?.composite ? h('button', { class: 'primary', onClick: () => this.openInstance(id, node) }, `Open ${ibd.composite.structure}`) : undefined,
            type ? h('button', { onClick: () => this.goToType(node) }, 'Go to type') : undefined,
            own ? remove : undefined));
        result.push(...this.routePanel(state, id, node, node));
        return result.filter((e): e is HTMLElement => !!e);
    }

    private threadPanel(thread: Thread, issue: Issue | undefined, remove: HTMLElement): HTMLElement[] {
        const settings = threadSettings(thread);
        const own = this.isOwn(thread);
        const annotation = (name: 'priority' | 'period' | 'stack', label: string, value: string | undefined, placeholder: string) => checkedField(label,
            h('input', { value: value ?? '', placeholder, spellcheck: 'false', disabled: !own }),
            v => this.checkEdit(editor => editor.setThreadAnnotations(thread, { [name]: v })),
            v => this.applyEdit(editor => editor.setThreadAnnotations(thread, { [name]: v })));
        const stackText = thread.annotations.find(a => a.name === 'stack')?.arguments[0]?.number;
        return [
            h('h2', {}, thread.name),
            h('div', { class: 'kind' }, 'Thread'),
            ...problems(issue),
            own ? this.nameField(thread) : undefined,
            ...annotation('priority', 'Priority', settings.priority !== undefined ? String(settings.priority) : undefined, 'e.g. 5'),
            ...annotation('period', 'Period', settings.period, 'e.g. 10 ms (cyclic thread)'),
            ...annotation('stack', 'Stack size (bytes)', stackText, 'e.g. 4096'),
            h('dl', {}, h('dt', {}, 'Instances'), h('dd', {}, threadInstances(thread).map(i => i.name).join(', ') || '–')),
            h('p', { class: 'hint' }, 'Drag instances into the thread (or out of it onto the frame). Deleting the thread keeps its instances (they become passive parts).'),
            own ? h('div', { class: 'actions' }, h('button', { onClick: () => this.context.setTool('instance') }, 'Add instance…'), remove) : undefined
        ].filter((e): e is HTMLElement => !!e);
    }

    /** The route of the selected element: providers / requirers (links, also in other files), "follow into" the composites. */
    private routePanel(state: StructureState, id: string, node: AstNode, part: ComponentInstance | undefined): HTMLElement[] {
        const info = this.routeInfo?.id === id ? this.routeInfo : undefined;
        const result: HTMLElement[] = [];
        if (!info) {
            // the route in the shown structure (until the route across the hierarchy is computed)
            const structure = this.shownStructure();
            if (isPort(node) && structure && (!part || isComponentInstance(part))) {
                const endpoint = portEndpoint(structure, part, node);
                const ends = node.direction === 'requires' ? findProviders(endpoint) : findRequirers(endpoint);
                result.push(h('dl', {}, h('dt', {}, node.direction === 'requires' ? 'Providers' : 'Requirers'),
                    h('dd', {}, ends.length > 0 ? ends.map(endpointLabel).join(', ') : '–')));
            }
            return result;
        }
        const link = (label: string, location: StructureLocation) => h('a', {
            href: '#', class: 'nav-link', title: `Show ${location.id ?? location.element}${location.uri !== normalizeUri(this.uri) ? ` in ${fileName(location.uri)}` : ''}`,
            onClick: (event: Event) => {
                event.preventDefault();
                this.context.navigate(location);
            }
        }, label);
        if (info.endsKind) {
            result.push(h('div', { class: 'route-section' },
                h('div', { class: 'route-title' }, info.endsKind),
                info.ends.length > 0
                    ? h('ul', { class: 'route-list' }, ...info.ends.map(end => h('li', {}, link(endLabel(end), end),
                        end.uri !== normalizeUri(this.uri) ? h('span', { class: 'route-file' }, ` · ${fileName(end.uri)}`) : undefined)))
                    : h('div', { class: 'hint' }, info.endsKind === 'Providers' ? 'not connected' : 'not used')));
            if (info.endsKind === 'Providers' && info.ends.length > 0) {
                const first = info.ends[0];
                result.push(h('div', { class: 'actions' }, h('button', { onClick: () => this.context.navigate(first), title: 'Show the port providing the data or accepting the events' }, 'Go to provider')));
            }
        }
        if (info.labels.length > 1) {
            result.push(h('div', { class: 'route-section' }, h('div', { class: 'route-title' }, `Route (in ${info.context.root})`),
                h('div', { class: 'route-path' }, info.labels.join(' · '))));
        }
        const buttons = [
            ...info.continuations.map(c => h('button', { onClick: () => this.context.navigate(c.location), title: 'Show the structure of the part, the route stays highlighted' }, `Follow into ${c.instance} ▸`)),
            info.outward ? h('button', { onClick: () => this.context.navigate(info.outward!), title: 'Show the structure using this one' }, `◂ Follow out to ${info.outward.element}`) : undefined
        ].filter((b): b is HTMLButtonElement => !!b);
        if (buttons.length > 0) {
            result.push(h('div', { class: 'actions' }, ...buttons));
        }
        void state;
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

function referenceText(reference: { instance?: { $refText: string }, port: { $refText: string } }): string {
    return reference.instance ? `${reference.instance.$refText}.${reference.port.$refText}` : reference.port.$refText;
}

function fileName(uri: string): string {
    return decodeURIComponent(uri.replace(/^.*\//, ''));
}

/** `drive.motor.ctrl` of a location (the instance path of its context and the port). */
function endLabel(location: StructureLocation): string {
    const id = location.id ?? location.element;
    const local = id.includes('/') ? id.substring(id.indexOf('/') + 1) : id.substring(id.indexOf('.') + 1);
    return [...(location.context?.path ?? []), local].join('.');
}

/** The file names of URIs, for messages. */
function fileNames(uris: Iterable<string>): string {
    return [...uris].map(fileName).join(', ');
}

/**
 * The errors of other files concerning an instance: errors in the declaration of its component type in an
 * imported structure file and errors of the state machine implementing it (`behavior`), as messages
 * naming the file.
 */
function importedProblems(instance: ComponentInstance, parsed: ParsedDmfModel): string[] {
    const type = instanceType(instance);
    const typeDocument = type ? documentOf(type) : undefined;
    const messages: string[] = [];
    const errorsOf = (document: LangiumDocument | undefined, range?: { start: number, end: number }) => {
        if (!document || document === parsed.document) {
            return [];
        }
        const errors = (document.diagnostics ?? []).filter(d => d.severity === 1);
        const syntax = document.parseResult.lexerErrors.length + document.parseResult.parserErrors.length;
        return [
            ...(syntax > 0 && !range ? ['syntax errors'] : []),
            ...errors.filter(d => !range || inRange(document.textDocument.offsetAt(d.range.start), range)).map(d => d.message)
        ];
    };
    if (type?.$cstNode && typeDocument) {
        for (const message of errorsOf(typeDocument, { start: type.$cstNode.offset, end: type.$cstNode.end })) {
            messages.push(`${type.name} (${fileName(typeDocument.uri.toString())}): ${message}`);
        }
    }
    const machine = isComponent(type) ? behaviorMachine(type) : undefined;
    const machineDocument = machine ? documentOf(machine) : undefined;
    const machineErrors = errorsOf(machineDocument);
    if (machine && machineDocument && machineErrors.length > 0) {
        messages.push(`State machine ${machine.name} (${fileName(machineDocument.uri.toString())}) has ${machineErrors.length === 1 ? 'an error' : `${machineErrors.length} errors`}: ${machineErrors[0]}`);
    }
    return messages;
}

function inRange(offset: number, range: { start: number, end: number }): boolean {
    return offset >= range.start && offset <= range.end;
}
