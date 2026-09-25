import {
    SChildElementImpl, SGraphImpl, SNodeImpl, hoverFeedbackFeature, moveFeature, selectFeature,
    type SModelElementImpl
} from 'sprotty';
import type { SModelElement, SModelRoot } from 'sprotty-protocol';
import type { DiagramEdge, DiagramGraph, DiagramNode, DiagramNodeKind, Point } from 'hsm-language';

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
    transition: 'edge:transition'
} as const;

export function nodeType(kind: DiagramNodeKind): string {
    return `node:${kind}`;
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
    headerHeight = 26;
    composite = false;
    regionIndex = 0;
    /** Where the separator line of a region is drawn. */
    separator: 'top' | 'left' = 'top';
    issue?: Issue;
    /** Whether the node is the pending source of a transition being created. */
    pendingSource = false;
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
        headerHeight: node.headerHeight ?? 0,
        composite: node.composite ?? false,
        regionIndex: node.index ?? 0,
        separator,
        selected: options.selected.has(node.id),
        issue: options.issues.get(node.id),
        pendingSource: options.pendingSource === node.id,
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
