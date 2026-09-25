import type { AstNode } from 'langium';
import ElkModule from 'elkjs/lib/elk.bundled.js';
import type { ELK as ElkApi, ElkExtendedEdge, ElkNode, LayoutOptions } from 'elkjs/lib/elk-api.js';
import * as ast from '../generated/ast.js';
import { scopeOf, transitionLabel, type ScopeContainer } from '../model-utils.js';
import type {
    DiagramEdge, DiagramGraph, DiagramNode, DiagramNodeKind, LayoutDirection, LayoutOptionsInput, LayoutResult, Point, TextMeasure, TextStyle
} from './diagram-model.js';

/** Metrics shared by the layout and the rendering of the diagram. */
export const DiagramMetrics = {
    fontSize: { name: 14, body: 12, label: 12 } as Record<TextStyle, number>,
    lineHeight: { name: 17, body: 15, label: 15 } as Record<TextStyle, number>,
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
        deephistory: 26
    } as Record<string, number>
};

/** Rough text measurement used when no real font metrics are available (e.g. in Node.js). */
export const approximateTextMeasure: TextMeasure = (text, style) => ({
    width: Math.ceil(text.length * DiagramMetrics.fontSize[style] * 0.58),
    height: DiagramMetrics.lineHeight[style]
});

export const MACHINE_ID = '#machine';

export function initialNodeId(scopeId: string): string {
    return `${scopeId}#initial`;
}

export function finalNodeId(scopeId: string): string {
    return `${scopeId}#final`;
}

type ElkInstance = Pick<ElkApi, 'layout'>;
let defaultElk: ElkInstance | undefined;

function createDefaultElk(): ElkInstance {
    // elkjs is a CommonJS module: depending on the module loader the constructor is the default export or nested in it
    type ElkConstructor = new () => ElkInstance;
    const module = ElkModule as unknown as ElkConstructor | { default: ElkConstructor };
    const Constructor = typeof module === 'function' ? module : module.default;
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
        elkOptions: options.elkOptions
    });
    const elk = options.elk as ElkInstance | undefined ?? (defaultElk ??= createDefaultElk());
    return builder.build(elk);
}

interface BuildOptions {
    elkOptions?: Record<string, string>;
    direction: LayoutDirection;
    routing: 'SPLINES' | 'ORTHOGONAL' | 'POLYLINE';
    measure: TextMeasure;
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
    private readonly usedIds = new Set<string>([MACHINE_ID]);

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
        const id = this.uniqueId(vertex.name || '#unnamed');
        if (ast.isPseudoState(vertex)) {
            const node = this.pseudoNode(id, vertex.kind as DiagramNodeKind, DiagramMetrics.pseudoSize[vertex.kind] ?? 20);
            node.name = vertex.name;
            this.register(node, this.elkLeaf(id, node), parentId, parentElk, vertex);
            return node;
        }
        return this.createState(vertex, id, parentId, parentElk);
    }

    private createState(state: ast.State, id: string, parentId: string, parentElk: ElkNode): DiagramNode {
        const m = DiagramMetrics;
        const measure = this.options.measure;
        const body = stateBodyLines(state);
        const nameWidth = measure(state.name ?? '', 'name').width;
        const bodyWidth = Math.max(0, ...body.map(line => measure(line, 'body').width));
        const width = Math.max(nameWidth + 2 * m.stateHorizontalPadding, bodyWidth + 2 * m.bodyPadding + 4, m.stateMinWidth);
        const bodyHeight = body.length > 0 ? body.length * m.lineHeight.body + 2 * m.bodyPadding : m.emptyBodyHeight;
        const composite = state.vertices.length > 0 || state.regions.length > 0;
        const node: DiagramNode = {
            id,
            kind: 'state',
            name: state.name,
            body,
            composite,
            x: 0, y: 0, width, height: m.headerHeight + bodyHeight,
            headerHeight: m.headerHeight,
            children: []
        };
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

    private createTransition(transition: ast.Transition, scopeId: string): void {
        const source = transition.initial ? this.findId(initialNodeId(scopeId)) : this.ids.get(transition.source?.ref as AstNode);
        const target = transition.final ? this.findId(finalNodeId(scopeId)) : this.ids.get(transition.target?.ref as AstNode);
        if (!source || !target) {
            return;
        }
        // ids derived from the end points stay stable while other transitions are added or removed
        const id = this.uniqueId(`${source}->${target}`);
        const text = transitionLabel(transition);
        const edge: DiagramEdge = {
            id,
            source,
            target,
            routing: 'polyline',
            points: []
        };
        const elkEdge: ElkExtendedEdge = { id, sources: [source], targets: [target] };
        if (text) {
            const size = this.options.measure(text, 'label');
            edge.label = { text, x: 0, y: 0, width: size.width + 4, height: size.height };
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
    for (const behavior of state.behaviors) {
        if (ast.isStateAction(behavior)) {
            lines.push(`${behavior.kind} / ${behavior.action}`);
        } else {
            lines.push(transitionLabel(behavior));
        }
    }
    return lines;
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
