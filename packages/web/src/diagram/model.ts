import {
    SChildElementImpl, SGraphImpl, SNodeImpl, hoverFeedbackFeature, moveFeature, selectFeature,
    type SModelElementImpl
} from 'sprotty';
import type { SModelElement, SModelRoot } from 'sprotty-protocol';
import type { DiagramEdge, DiagramGraph, DiagramLabel, DiagramNode, DiagramNodeKind, Point } from 'hsm-language';

export type IssueSeverity = 'error' | 'warning';

export interface Issue {
    severity: IssueSeverity;
    messages: string[];
}

/** Types of the diagram elements (used to select the views). */
export const DiagramTypes = {
    graph: 'graph',
    state: 'node:state',
    region: 'node:region',
    initial: 'node:initial',
    final: 'node:final',
    choice: 'node:choice',
    junction: 'node:junction',
    history: 'node:history',
    deephistory: 'node:deephistory',
    sync: 'node:sync',
    entry: 'node:entry',
    exit: 'node:exit',
    definition: 'node:definition',
    transition: 'edge:transition'
} as const satisfies Record<DiagramNodeKind | 'graph' | 'transition', string>;

export function nodeType(kind: DiagramNodeKind): string {
    return DiagramTypes[kind];
}

export class StateMachineGraph extends SGraphImpl {
    name = '';
}

/** Any vertex of the state machine: states, regions and pseudo states. */
export class VertexNode extends SNodeImpl {
    static override readonly DEFAULT_FEATURES = [selectFeature, moveFeature, hoverFeedbackFeature];

    kind: DiagramNodeKind = 'state';
    name?: string;
    body: string[] = [];
    /** Full text of shortened / wrapped body lines (tooltips). */
    bodyTitles: Array<string | undefined> = [];
    /** Name label next to the node (entry points, exit nodes), relative to the node. */
    label?: DiagramLabel;
    headerHeight = 26;
    composite = false;
    regionIndex = 0;
    /** Where the separator line of a region is drawn. */
    separator: 'top' | 'left' = 'top';
    issue?: Issue;
    /** Whether the node is the pending source of a transition being created. */
    pendingSource = false;
    /** Simulation: the state (or final state) is active. */
    active = false;
    /** Simulation: a breakpoint is set on the state. */
    breakpoint = false;
    /** Manual layout: the state shows a resize handle when it is selected. */
    resizable = false;
}

export class TransitionEdge extends SChildElementImpl {
    static readonly DEFAULT_FEATURES = [selectFeature, hoverFeedbackFeature];

    sourceId = '';
    targetId = '';
    routing: DiagramEdge['routing'] = 'polyline';
    points: Point[] = [];
    label?: DiagramEdge['label'];
    issue?: Issue;
    selected = false;
    hoverFeedback = false;
    /** Simulation: the transition was taken recently. */
    taken = false;
    /** Simulation: a breakpoint is set on the transition. */
    breakpoint = false;
    /** Manual layout: the bend points can be moved when the transition is selected. */
    editable = false;
}

export function isVertexNode(element: SModelElementImpl | undefined): element is VertexNode {
    return element instanceof VertexNode;
}

export function isTransitionEdge(element: SModelElementImpl | undefined): element is TransitionEdge {
    return element instanceof TransitionEdge;
}

export interface SchemaOptions {
    selected: Set<string>;
    issues: Map<string, Issue>;
    pendingSource?: string;
    /** Simulation: ids of the active states and final states. */
    activeStates?: ReadonlySet<string>;
    /** Simulation: ids of the transitions taken recently. */
    recentTransitions?: ReadonlySet<string>;
    /** Simulation: ids of the elements with a breakpoint. */
    breakpoints?: ReadonlySet<string>;
    /** Manual layout mode: states can be resized, bend points of transitions moved. */
    manualLayout?: boolean;
}

/** Converts the layouted diagram into the sprotty model schema. */
export function toSchema(graph: DiagramGraph, options: SchemaOptions): SModelRoot {
    const separator = graph.direction === 'DOWN' ? 'top' : 'left';
    const convertNode = (node: DiagramNode): SModelElement => ({
        type: nodeType(node.kind),
        id: node.id,
        position: { x: node.x, y: node.y },
        size: { width: node.width, height: node.height },
        kind: node.kind,
        name: node.name,
        body: node.body ?? [],
        bodyTitles: node.bodyTitles ?? [],
        label: node.label,
        headerHeight: node.headerHeight ?? 0,
        composite: node.composite ?? false,
        regionIndex: node.index ?? 0,
        separator: node.separator ?? separator,
        resizable: (options.manualLayout ?? false) && node.kind === 'state',
        selected: options.selected.has(node.id),
        issue: options.issues.get(node.id),
        pendingSource: options.pendingSource === node.id,
        active: options.activeStates?.has(node.id) ?? false,
        breakpoint: options.breakpoints?.has(node.id) ?? false,
        children: node.children.map(convertNode)
    } as SModelElement);
    const convertEdge = (edge: DiagramEdge): SModelElement => ({
        type: DiagramTypes.transition,
        id: edge.id,
        sourceId: edge.source,
        targetId: edge.target,
        routing: edge.routing,
        points: edge.points,
        label: edge.label,
        selected: options.selected.has(edge.id),
        issue: options.issues.get(edge.id),
        taken: options.recentTransitions?.has(edge.id) ?? false,
        breakpoint: options.breakpoints?.has(edge.id) ?? false,
        editable: options.manualLayout ?? false,
        children: []
    } as SModelElement);
    return {
        type: DiagramTypes.graph,
        id: graph.id,
        name: graph.name,
        children: [
            ...graph.children.map(convertNode),
            ...graph.edges.map(convertEdge)
        ]
    } as SModelRoot;
}
