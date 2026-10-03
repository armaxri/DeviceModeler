import type { AstNode } from 'langium';
import type { ELK as ElkApi, ElkExtendedEdge, ElkNode, LayoutOptions } from 'elkjs/lib/elk-api.js';
import * as ast from '../generated/ast.js';
import { referableName, submachineOf } from '../imports.js';
import {
    allTransitions, definitionLines, entryPointOf, hasDefinitionSection, nodeText, outgoingTransitions, scopeOf, transitionLabel, transitionPriority, type ScopeContainer
} from '../model-utils.js';
import { qualifiedName } from '../statemachine-scope.js';
import type {
    DiagramEdge, DiagramGraph, DiagramNode, DiagramNodeKind, LayoutDirection, LayoutOptionsInput, LayoutResult, Point, TextMeasure, TextStyle
} from './diagram-model.js';
import { helveticaTextWidth, monospaceTextWidth } from './text-metrics.js';

/** Metrics shared by the layout and the rendering of the diagram. */
export const DiagramMetrics = {
    fontSize: { name: 14, body: 12, label: 12, code: 11.5 } as Record<TextStyle, number>,
    lineHeight: { name: 17, body: 15, label: 15, code: 15 } as Record<TextStyle, number>,
    headerHeight: 26,
    bodyPadding: 6,
    emptyBodyHeight: 12,
    stateMinWidth: 60,
    stateHorizontalPadding: 14,
    compositePadding: 14,
    regionPadding: 12,
    pseudoSize: {
        initial: 20,
        final: 22,
        choice: 26,
        junction: 12,
        history: 26,
        deephistory: 26,
        sync: 44,
        entry: 16,
        exit: 16
    } as Record<string, number>,
    /** Thickness of the bar of a synchronization. */
    syncThickness: 7,
    /** Space reserved in the name compartment of a submachine state for the submachine icon. */
    submachineIconWidth: 22,
    /** Radius of the entry points / exit nodes of a submachine instance drawn on the border of its state. */
    submachinePointRadius: 5,
    /** Default maximum length of text lines (longer lines are wrapped or shortened). */
    maxLineLength: 60
};

/**
 * Text measurement used when no real font metrics are available (e.g. in Node.js): uses the
 * character widths of Helvetica (metric compatible with Arial / Liberation Sans) and of a
 * monospace font for the definition section, so the layout is close to the one in the browser.
 */
export const approximateTextMeasure: TextMeasure = (text, style) => ({
    width: Math.ceil(style === 'code'
        ? monospaceTextWidth(text, DiagramMetrics.fontSize[style])
        : helveticaTextWidth(text, DiagramMetrics.fontSize[style])),
    height: DiagramMetrics.lineHeight[style]
});

export const MACHINE_ID = '#machine';

/** Id of the node showing the definition section (mapped to the state machine in `LayoutResult.elements`). */
export const DEFINITION_ID = '#definitions';

export function initialNodeId(scopeId: string): string {
    return `${scopeId}#initial`;
}

export function finalNodeId(scopeId: string): string {
    return `${scopeId}#final`;
}

type ElkInstance = Pick<ElkApi, 'layout'>;
let defaultElk: ElkInstance | undefined;

/** Creates an ELK instance running on the current thread (loaded on demand). */
async function createDefaultElk(): Promise<ElkInstance> {
    // elkjs is a CommonJS module: depending on the module loader the constructor is the default export or nested in it
    type ElkConstructor = new () => ElkInstance;
    const module = await import('elkjs/lib/elk.bundled.js') as unknown as { default: ElkConstructor | { default: ElkConstructor } };
    const Constructor = typeof module.default === 'function' ? module.default : module.default.default;
    return new Constructor();
}

/**
 * Computes a PlantUML like diagram of the given state machine including the layout of all
 * states and the routes of all transitions.
 */
export async function layoutStateMachine(machine: ast.StateMachine, options: LayoutOptionsInput = {}): Promise<LayoutResult> {
    const builder = new DiagramBuilder(machine, {
        direction: options.direction ?? 'DOWN',
        routing: options.routing ?? 'SPLINES',
        measure: options.measure ?? approximateTextMeasure,
        elkOptions: options.elkOptions,
        priorities: options.priorities ?? true,
        maxLineLength: options.maxLineLength ?? DiagramMetrics.maxLineLength
    });
    const elk = options.elk as ElkInstance | undefined ?? (defaultElk ??= await createDefaultElk());
    return builder.build(elk);
}

interface BuildOptions {
    elkOptions?: Record<string, string>;
    direction: LayoutDirection;
    routing: 'SPLINES' | 'ORTHOGONAL' | 'POLYLINE';
    measure: TextMeasure;
    priorities: boolean;
    maxLineLength: number;
}

class DiagramBuilder {

    /** diagram element id -> AST node */
    private readonly elements = new Map<string, AstNode>();
    /** AST node -> diagram element id */
    private readonly ids = new Map<AstNode, string>();
    /** diagram id -> partially filled diagram node */
    private readonly nodes = new Map<string, DiagramNode>();
    /** diagram id -> ELK node */
    private readonly elkNodes = new Map<string, ElkNode>();
    /** diagram id -> id of parent diagram node (undefined for top level nodes) */
    private readonly parents = new Map<string, string>();
    private readonly edges: Array<{ edge: DiagramEdge, elk: ElkExtendedEdge }> = [];
    private readonly usedIds = new Set<string>([MACHINE_ID, DEFINITION_ID]);

    constructor(private readonly machine: ast.StateMachine, private readonly options: BuildOptions) { }

    async build(elk: ElkInstance): Promise<LayoutResult> {
        const root: ElkNode = {
            id: MACHINE_ID,
            layoutOptions: this.rootLayoutOptions(),
            children: [],
            edges: []
        };
        this.elkNodes.set(MACHINE_ID, root);
        this.elements.set(MACHINE_ID, this.machine);
        this.ids.set(this.machine, MACHINE_ID);

        const topLevel = this.createScopeContent(this.machine, MACHINE_ID, root);
        this.createTransitions();

        const result = await elk.layout(root);
        const graph: DiagramGraph = {
            id: MACHINE_ID,
            name: this.machine.name,
            width: result.width ?? 0,
            height: result.height ?? 0,
            direction: this.options.direction,
            children: topLevel,
            edges: this.edges.map(e => e.edge)
        };
        this.applyNodeLayout(result);
        for (const node of this.nodes.values()) {
            if (node.kind === 'state' && node.regions) {
                this.arrangeRegions(node);
            }
        }
        this.applyEdgeLayout(result);
        const definition = this.createDefinitionNode();
        if (definition) {
            this.placeDefinition(graph, definition);
        }
        return { graph, elements: this.elements, ids: this.ids };
    }

    private rootLayoutOptions(): LayoutOptions {
        return {
            ...this.defaultRootOptions(),
            ...this.options.elkOptions
        };
    }

    /**
     * Nested graphs are laid out with the options of their compound node,
     * so the algorithm settings have to be repeated on every composite state and region.
     */
    private compoundLayoutOptions(): LayoutOptions {
        const options = this.rootLayoutOptions();
        delete options['elk.padding'];
        delete options['elk.json.edgeCoords'];
        delete options['elk.hierarchyHandling'];
        // model order constraints crash ELK in nested graphs with hierarchy crossing edges
        delete options['elk.layered.considerModelOrder.strategy'];
        delete options['elk.layered.crossingMinimization.forceNodeModelOrder'];
        return options;
    }

    private defaultRootOptions(): LayoutOptions {
        return {
            'elk.algorithm': 'layered',
            'elk.direction': this.options.direction,
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.edgeRouting': this.options.routing,
            'elk.json.edgeCoords': 'ROOT',
            'elk.padding': '[top=20,left=20,bottom=20,right=20]',
            'elk.spacing.nodeNode': '30',
            'elk.spacing.edgeNode': '16',
            'elk.spacing.edgeEdge': '12',
            'elk.spacing.edgeLabel': '4',
            'elk.spacing.labelNode': '6',
            'elk.layered.spacing.nodeNodeBetweenLayers': '36',
            'elk.layered.spacing.edgeNodeBetweenLayers': '16',
            'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
            'elk.edgeLabels.placement': 'CENTER',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            // DFS from the sources in model order: the text order determines the direction of cycles
            'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.crossingMinimization.forceNodeModelOrder': 'false'
        };
    }

    private uniqueId(base: string): string {
        let id = base;
        let counter = 1;
        while (this.usedIds.has(id)) {
            id = `${base}~${counter++}`;
        }
        this.usedIds.add(id);
        return id;
    }

    private register(node: DiagramNode, elkNode: ElkNode, parentId: string, parentElk: ElkNode, astNode?: AstNode): void {
        this.nodes.set(node.id, node);
        this.elkNodes.set(node.id, elkNode);
        if (parentId !== MACHINE_ID) {
            this.parents.set(node.id, parentId);
        }
        parentElk.children!.push(elkNode);
        if (astNode) {
            this.elements.set(node.id, astNode);
            this.ids.set(astNode, node.id);
        }
    }

    /** A box with the lines of the definition section (namespace, annotations, interfaces, internal scope). */
    private createDefinitionNode(): DiagramNode | undefined {
        if (!hasDefinitionSection(this.machine)) {
            return undefined;
        }
        const m = DiagramMetrics;
        const measure = this.options.measure;
        const { lines, titles } = this.wrapLines(definitionLines(this.machine));
        const nameWidth = measure(this.machine.name ?? '', 'name').width + measure(' definitions', 'body').width;
        const bodyWidth = Math.max(0, ...lines.map(line => measure(line, 'code').width));
        const width = Math.max(nameWidth + 2 * m.stateHorizontalPadding, bodyWidth + 2 * m.bodyPadding + 4, m.stateMinWidth);
        const height = m.headerHeight + lines.length * m.lineHeight.code + 2 * m.bodyPadding;
        const node: DiagramNode = {
            id: DEFINITION_ID,
            kind: 'definition',
            name: this.machine.name,
            body: lines,
            bodyTitles: titles,
            headerHeight: m.headerHeight,
            x: 0, y: 0, width, height,
            children: []
        };
        this.nodes.set(DEFINITION_ID, node);
        this.elements.set(DEFINITION_ID, this.machine);
        return node;
    }

    /**
     * The definition section has no edges, so it is not laid out by ELK: it is placed at the top left
     * corner (like in itemis CREATE). The laid out states are moved to the right of it (top-down layout)
     * or below it (left-right layout, which tends to produce wide diagrams).
     */
    private placeDefinition(graph: DiagramGraph, definition: DiagramNode): void {
        const padding = 20;
        const spacing = 40;
        definition.x = padding;
        definition.y = padding;
        const beside = this.options.direction === 'DOWN';
        const dx = beside ? definition.width + spacing : 0;
        const dy = beside ? 0 : definition.height + spacing;
        for (const node of graph.children) {
            node.x += dx;
            node.y += dy;
        }
        for (const edge of graph.edges) {
            edge.points = edge.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
            if (edge.label) {
                edge.label.x += dx;
                edge.label.y += dy;
            }
        }
        graph.children.unshift(definition);
        graph.width = Math.max(graph.width + dx, definition.width + 2 * padding);
        graph.height = Math.max(graph.height + dy, definition.height + 2 * padding);
    }

    /**
     * Wraps lines longer than the maximum line length at statement boundaries (`; `),
     * segments which are still too long are shortened with an ellipsis.
     */
    private wrapLines(input: string[]): { lines: string[], titles: Array<string | undefined> } {
        const lines: string[] = [];
        const titles: Array<string | undefined> = [];
        for (const line of input) {
            const wrapped = wrapLine(line, this.options.maxLineLength);
            for (const part of wrapped) {
                lines.push(part);
                titles.push(wrapped.length > 1 || part !== line ? line : undefined);
            }
        }
        return { lines, titles };
    }

    /** Creates the nodes of all vertices of the container including initial and final pseudo states. */
    private createScopeContent(container: ScopeContainer, scopeId: string, parentElk: ElkNode): DiagramNode[] {
        const result: DiagramNode[] = [];
        const size = DiagramMetrics.pseudoSize;
        if (container.transitions.some(t => t.initial)) {
            const id = this.uniqueId(initialNodeId(scopeId));
            const node = this.pseudoNode(id, 'initial', size.initial);
            this.register(node, this.elkLeaf(id, node), scopeId, parentElk);
            this.elements.set(id, container);
            result.push(node);
        }
        for (const vertex of container.vertices) {
            result.push(this.createVertex(vertex, scopeId, parentElk));
        }
        if (container.transitions.some(t => t.final)) {
            const id = this.uniqueId(finalNodeId(scopeId));
            const node = this.pseudoNode(id, 'final', size.final);
            this.register(node, this.elkLeaf(id, node), scopeId, parentElk);
            this.elements.set(id, container);
            result.push(node);
        }
        return result;
    }

    private createVertex(vertex: ast.Vertex, parentId: string, parentElk: ElkNode): DiagramNode {
        const id = this.uniqueId(vertex.name ? vertexBaseId(vertex) : '#unnamed');
        if (ast.isPseudoState(vertex)) {
            const node = this.pseudoNode(id, vertex.kind as DiagramNodeKind, DiagramMetrics.pseudoSize[vertex.kind] ?? 20);
            node.name = vertex.name;
            if (vertex.kind === 'sync') {
                // synchronization bar perpendicular to the layout direction (the flow of the transitions)
                if (this.options.direction === 'DOWN') {
                    node.height = DiagramMetrics.syncThickness;
                } else {
                    node.width = DiagramMetrics.syncThickness;
                }
            }
            const elkNode = this.elkLeaf(id, node);
            if ((vertex.kind === 'entry' || vertex.kind === 'exit') && vertex.name) {
                // the name is shown next to the node, ELK reserves space for it
                const size = this.options.measure(vertex.name, 'label');
                node.label = { text: vertex.name, x: node.width + 3, y: (node.height - size.height) / 2, width: size.width + 2, height: size.height };
                elkNode.labels = [{ id: `${id}#name`, text: vertex.name, width: size.width + 2, height: size.height }];
                elkNode.layoutOptions = { 'elk.nodeLabels.placement': 'OUTSIDE V_CENTER H_RIGHT' };
            }
            this.register(node, elkNode, parentId, parentElk, vertex);
            return node;
        }
        return this.createState(vertex, id, parentId, parentElk);
    }

    private createState(state: ast.State, id: string, parentId: string, parentElk: ElkNode): DiagramNode {
        const m = DiagramMetrics;
        const measure = this.options.measure;
        const submachine = submachineOf(state);
        const instanceLine = submachine ? `instance ${referableName(submachine.instance)}` : undefined;
        const { lines: body, titles } = this.wrapLines(instanceLine ? [...stateBodyLines(state), instanceLine] : stateBodyLines(state));
        // a submachine state shows the state machine of its instance: `Moving : Motor`
        const nameWidth = measure(submachine ? `${state.name ?? ''} : ${submachine.machine.name}` : state.name ?? '', 'name').width
            + (submachine ? DiagramMetrics.submachineIconWidth : 0);
        const bodyWidth = Math.max(0, ...body.map(line => measure(line, 'body').width));
        const width = Math.max(nameWidth + 2 * m.stateHorizontalPadding, bodyWidth + 2 * m.bodyPadding + 4, m.stateMinWidth);
        const bodyHeight = body.length > 0 ? body.length * m.lineHeight.body + 2 * m.bodyPadding : m.emptyBodyHeight;
        const composite = state.vertices.length > 0 || state.regions.length > 0;
        const node: DiagramNode = {
            id,
            kind: 'state',
            name: state.name,
            body,
            bodyTitles: titles,
            composite,
            x: 0, y: 0, width, height: m.headerHeight + bodyHeight,
            headerHeight: m.headerHeight,
            children: []
        };
        if (submachine) {
            node.submachine = {
                instance: referableName(submachine.instance),
                machine: submachine.machine.name,
                uri: submachine.machine.$document?.uri.toString(),
                line: body.length - 1,
                points: this.submachinePoints(state)
            };
        }
        const elkNode: ElkNode = { id, width: node.width, height: node.height };
        this.register(node, elkNode, parentId, parentElk, state);
        if (composite) {
            const top = m.headerHeight + (body.length > 0 ? bodyHeight : 0);
            const pad = m.compositePadding;
            elkNode.children = [];
            elkNode.edges = [];
            elkNode.layoutOptions = {
                ...this.compoundLayoutOptions(),
                'elk.padding': state.regions.length > 0
                    ? `[top=${top},left=0,bottom=0,right=0]`
                    : `[top=${top + pad},left=${pad},bottom=${pad},right=${pad}]`,
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.nodeSize.minimum': `(${width}, ${node.height + 30})`
            };
            if (state.regions.length > 0) {
                node.regions = true;
                node.children = state.regions.map((region, index) => this.createRegion(region, id, index, elkNode));
                // invisible edges force the regions into consecutive layers
                for (let i = 1; i < node.children.length; i++) {
                    elkNode.edges.push({
                        id: `${id}#regionorder${i}`,
                        sources: [node.children[i - 1].id],
                        targets: [node.children[i].id]
                    });
                }
            }
            node.children.push(...this.createScopeContent(state, id, elkNode));
        }
        return node;
    }

    /** The entry points (`# >E`) and exit nodes (`# X>`) of a submachine state used by transitions, in text order. */
    private submachinePoints(state: ast.State): Array<{ kind: 'entry' | 'exit', name: string }> {
        const points: Array<{ kind: 'entry' | 'exit', name: string }> = [];
        const add = (kind: 'entry' | 'exit', name: string) => {
            if (!points.some(p => p.kind === kind && p.name === name)) {
                points.push({ kind, name });
            }
        };
        for (const transition of allTransitions(this.machine)) {
            const entry = entryPointOf(transition);
            if (entry && transition.target?.ref === state) {
                add('entry', entry);
            }
            if (transition.source?.ref === state) {
                transition.exitPoints.forEach(name => add('exit', name));
            }
        }
        return points;
    }

    private createRegion(region: ast.Region, stateId: string, index: number, parentElk: ElkNode): DiagramNode {
        const id = this.uniqueId(`${stateId}#region${index + 1}`);
        const pad = DiagramMetrics.regionPadding;
        const node: DiagramNode = {
            id,
            kind: 'region',
            name: region.name,
            index,
            x: 0, y: 0, width: 40, height: 30,
            children: []
        };
        const top = region.name ? pad + DiagramMetrics.lineHeight.body : pad;
        const elkNode: ElkNode = {
            id,
            children: [],
            edges: [],
            layoutOptions: {
                ...this.compoundLayoutOptions(),
                'elk.padding': `[top=${top},left=${pad},bottom=${pad},right=${pad}]`,
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.nodeSize.minimum': '(40, 30)'
            }
        };
        this.register(node, elkNode, stateId, parentElk, region);
        node.children = this.createScopeContent(region, id, elkNode);
        return node;
    }

    private pseudoNode(id: string, kind: DiagramNodeKind, size: number): DiagramNode {
        return { id, kind, x: 0, y: 0, width: size, height: size, children: [] };
    }

    private elkLeaf(id: string, node: DiagramNode): ElkNode {
        return { id, width: node.width, height: node.height };
    }

    private createTransitions(): void {
        const outgoing = new Map<ast.Vertex, ast.Transition[]>();
        this.outgoing = vertex => {
            let result = outgoing.get(vertex);
            if (!result) {
                result = outgoingTransitions(vertex);
                outgoing.set(vertex, result);
            }
            return result;
        };
        const visit = (container: ScopeContainer) => {
            const scopeId = this.ids.get(container)!;
            for (const transition of container.transitions) {
                this.createTransition(transition, scopeId);
            }
            for (const vertex of container.vertices) {
                if (ast.isState(vertex)) {
                    visit(vertex);
                    vertex.regions.forEach(visit);
                }
            }
        };
        visit(this.machine);
    }

    private outgoing: (vertex: ast.Vertex) => ast.Transition[] = outgoingTransitions;

    private createTransition(transition: ast.Transition, scopeId: string): void {
        const source = transition.initial ? this.findId(initialNodeId(scopeId)) : this.ids.get(transition.source?.ref as AstNode);
        const target = transition.final ? this.findId(finalNodeId(scopeId)) : this.ids.get(transition.target?.ref as AstNode);
        if (!source || !target) {
            return;
        }
        // ids derived from the end points stay stable while other transitions are added or removed
        const id = this.uniqueId(`${source}->${target}`);
        const sourceVertex = transition.source?.ref;
        const priority = sourceVertex && !transition.initial ? transitionPriority(transition, this.outgoing(sourceVertex)) : undefined;
        const spec = transitionLabel(transition);
        const fullText = priority !== undefined && this.options.priorities ? (spec ? `${priority}: ${spec}` : String(priority)) : spec;
        const text = shorten(fullText, this.options.maxLineLength);
        const edge: DiagramEdge = {
            id,
            source,
            target,
            routing: 'polyline',
            points: [],
            priority
        };
        const elkEdge: ElkExtendedEdge = { id, sources: [source], targets: [target] };
        if (text) {
            const size = this.options.measure(text, 'label');
            edge.label = { text, x: 0, y: 0, width: size.width + 4, height: size.height };
            if (text !== fullText) {
                edge.label.title = fullText;
            }
            elkEdge.labels = [{ id: `${id}#label`, text, width: size.width + 4, height: size.height }];
        }
        const container = this.edgeContainer(source, target);
        this.elkNodes.get(container)!.edges!.push(elkEdge);
        this.edges.push({ edge, elk: elkEdge });
        this.elements.set(id, transition);
        this.ids.set(transition, id);
    }

    private findId(id: string): string | undefined {
        return this.nodes.has(id) ? id : undefined;
    }

    private ancestors(id: string): string[] {
        const result: string[] = [];
        let current = this.parents.get(id);
        while (current) {
            result.unshift(current);
            current = this.parents.get(current);
        }
        return [MACHINE_ID, ...result];
    }

    /** ELK expects each edge to be contained in the lowest common ancestor of its end points. */
    private edgeContainer(source: string, target: string): string {
        const sourcePath = [...this.ancestors(source), source];
        const targetPath = [...this.ancestors(target), target];
        if (sourcePath.includes(target)) {
            return this.elkNodes.get(target)?.children ? target : this.parentOf(target);
        }
        if (targetPath.includes(source)) {
            return this.elkNodes.get(source)?.children ? source : this.parentOf(source);
        }
        let result = MACHINE_ID;
        for (let i = 0; i < Math.min(sourcePath.length, targetPath.length) - 1; i++) {
            if (sourcePath[i] !== targetPath[i]) {
                break;
            }
            result = sourcePath[i];
        }
        return result;
    }

    private parentOf(id: string): string {
        return this.parents.get(id) ?? MACHINE_ID;
    }

    private applyNodeLayout(elkRoot: ElkNode): void {
        const visit = (elkNode: ElkNode) => {
            for (const child of elkNode.children ?? []) {
                const node = this.nodes.get(child.id);
                if (node) {
                    node.x = child.x ?? 0;
                    node.y = child.y ?? 0;
                    node.width = child.width ?? node.width;
                    node.height = child.height ?? node.height;
                    const label = child.labels?.[0];
                    if (node.label && label && label.x !== undefined && label.y !== undefined) {
                        node.label.x = label.x;
                        node.label.y = label.y;
                    }
                }
                visit(child);
            }
        };
        visit(elkRoot);
    }

    /**
     * Stretches the regions of a state so that they fill the state completely and separator
     * lines can be drawn between them. The content of the regions keeps its absolute position.
     */
    private arrangeRegions(state: DiagramNode): void {
        const regions = state.children.filter(c => c.kind === 'region');
        if (regions.length === 0) {
            return;
        }
        const vertical = this.options.direction === 'DOWN';
        const headerBottom = Math.min(...regions.map(r => r.y));
        const sorted = [...regions].sort((a, b) => vertical ? a.y - b.y : a.x - b.x);
        sorted.forEach((region, i) => {
            const next = sorted[i + 1];
            let x: number, y: number, width: number, height: number;
            if (vertical) {
                x = 0;
                width = state.width;
                y = i === 0 ? headerBottom : (sorted[i - 1].y + sorted[i - 1].height);
                const bottom = next ? (region.y + region.height + next.y) / 2 : state.height;
                height = bottom - y;
            } else {
                y = headerBottom;
                height = state.height - headerBottom;
                x = i === 0 ? 0 : (sorted[i - 1].x + sorted[i - 1].width);
                const right = next ? (region.x + region.width + next.x) / 2 : state.width;
                width = right - x;
            }
            const dx = region.x - x;
            const dy = region.y - y;
            for (const child of region.children) {
                child.x += dx;
                child.y += dy;
            }
            region.x = x;
            region.y = y;
            region.width = width;
            region.height = height;
        });
    }

    private applyEdgeLayout(elkRoot: ElkNode): void {
        const elkEdges = new Map<string, ElkExtendedEdge>();
        const collect = (elkNode: ElkNode) => {
            for (const e of elkNode.edges ?? []) {
                elkEdges.set(e.id, e);
            }
            (elkNode.children ?? []).forEach(collect);
        };
        collect(elkRoot);
        for (const { edge } of this.edges) {
            const elkEdge = elkEdges.get(edge.id);
            const section = elkEdge?.sections?.[0];
            if (!elkEdge || !section) {
                continue;
            }
            const bends = section.bendPoints ?? [];
            const points: Point[] = [section.startPoint, ...bends, section.endPoint].map(p => ({ x: p.x, y: p.y }));
            edge.points = points;
            edge.routing = this.options.routing === 'SPLINES' && bends.length > 0 && (bends.length + 1) % 3 === 0
                ? 'spline'
                : this.options.routing === 'ORTHOGONAL' ? 'orthogonal' : 'polyline';
            const label = elkEdge.labels?.[0];
            if (edge.label && label) {
                edge.label.x = label.x ?? 0;
                edge.label.y = label.y ?? 0;
            }
        }
    }
}

/** Text lines shown in the body compartment of a state (description, actions, internal transitions). */
export function stateBodyLines(state: ast.State): string[] {
    const lines: string[] = [];
    if (state.description) {
        lines.push(...state.description.split(/\r?\n/));
    }
    for (const reaction of state.reactions) {
        lines.push(nodeText(reaction));
    }
    return lines;
}

/** Shortens a text to at most `max` characters (with an ellipsis). */
export function shorten(text: string, max: number): string {
    return text.length > max ? text.substring(0, Math.max(1, max - 1)).trimEnd() + '…' : text;
}

/**
 * Splits a line which is longer than `max` characters at statement boundaries (`; `) into
 * several lines (continuation lines are indented), parts which are still too long are shortened.
 */
export function wrapLine(line: string, max: number): string[] {
    if (line.length <= max) {
        return [line];
    }
    const indent = '    ';
    const segments = line.split(/(?<=;) /);
    const result: string[] = [];
    let current = '';
    for (const segment of segments) {
        if (!current) {
            current = (result.length === 0 ? '' : indent) + segment;
        } else if (current.length + 1 + segment.length <= max) {
            current += ' ' + segment;
        } else {
            result.push(current);
            current = indent + segment;
        }
    }
    if (current) {
        result.push(current);
    }
    return result.map(part => shorten(part, max));
}

/** Returns the scope container in which new children of the given diagram element are created. */
export function containerForElement(element: AstNode | undefined): ScopeContainer | undefined {
    if (!element) {
        return undefined;
    }
    if (ast.isStateMachine(element) || ast.isRegion(element)) {
        return element;
    }
    if (ast.isState(element)) {
        return element.regions.length > 0 ? element.regions[0] : element;
    }
    if (ast.isPseudoState(element) || ast.isTransition(element)) {
        return scopeOf(element);
    }
    return undefined;
}

/**
 * Base of the diagram id of a vertex: its qualified name. Entry points and exit nodes with the same name
 * in several orthogonal regions of a state (`Outer.failure`) include the region to stay distinguishable
 * (`Outer.r1.failure`, `Outer.region2.failure` for unnamed regions).
 */
export function vertexBaseId(vertex: ast.Vertex): string {
    const name = qualifiedName(vertex);
    const region = vertex.$container;
    if (!ast.isPseudoState(vertex) || (vertex.kind !== 'entry' && vertex.kind !== 'exit') || !ast.isRegion(region)) {
        return name;
    }
    const owner = region.$container;
    const shared = owner.regions.some(r => r !== region
        && r.vertices.some(v => ast.isPseudoState(v) && v.kind === vertex.kind && v.name === vertex.name));
    if (!shared) {
        return name;
    }
    const regionName = region.name ?? `region${owner.regions.indexOf(region) + 1}`;
    return `${qualifiedName(owner)}.${regionName}.${vertex.name}`;
}

/**
 * Positions (relative to the state) of the entry points and exit nodes of a submachine state drawn on
 * its border: entry points on the top (layout direction down) or left border, exit nodes on the
 * bottom or right border, evenly spaced.
 */
export function submachinePointPositions(node: DiagramNode, direction: LayoutDirection): Array<{ kind: 'entry' | 'exit', name: string, x: number, y: number }> {
    const points = node.submachine?.points ?? [];
    const result: Array<{ kind: 'entry' | 'exit', name: string, x: number, y: number }> = [];
    for (const kind of ['entry', 'exit'] as const) {
        const ofKind = points.filter(p => p.kind === kind);
        ofKind.forEach((point, i) => {
            const fraction = (i + 1) / (ofKind.length + 1);
            if (direction === 'DOWN') {
                result.push({ ...point, x: node.width * fraction, y: kind === 'entry' ? 0 : node.height });
            } else {
                result.push({ ...point, x: kind === 'entry' ? 0 : node.width, y: (node.headerHeight ?? DiagramMetrics.headerHeight) + (node.height - (node.headerHeight ?? DiagramMetrics.headerHeight)) * fraction });
            }
        });
    }
    return result;
}
