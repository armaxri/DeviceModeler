import type { AstNode } from 'langium';

export interface Point {
    x: number;
    y: number;
}

/** `code`: monospace text of the definition section. */
export type TextStyle = 'name' | 'body' | 'label' | 'code';

/** Measures the size of a single line of text rendered in the given style. */
export type TextMeasure = (text: string, style: TextStyle) => { width: number, height: number };

export type LayoutDirection = 'DOWN' | 'RIGHT';

export type EdgeRouting = 'SPLINES' | 'ORTHOGONAL' | 'POLYLINE';

export interface LayoutOptionsInput {
    direction?: LayoutDirection;
    routing?: EdgeRouting;
    measure?: TextMeasure;
    /** Additional ELK layout options for the root graph (override the defaults). */
    elkOptions?: Record<string, string>;
    /** An ELK instance to use (e.g. one backed by a web worker). */
    elk?: unknown;
    /**
     * Prefix the labels of transitions with their priority (`1: ev / a`) if their source vertex
     * has more than one outgoing transition. Default: true.
     */
    priorities?: boolean;
    /** Maximum number of characters of a text line in states and labels before it is wrapped / shortened. Default: 60. */
    maxLineLength?: number;
}

export type DiagramNodeKind = 'state' | 'region' | 'initial' | 'final' | 'choice' | 'junction' | 'history' | 'deephistory' | 'sync' | 'entry' | 'exit'
    | 'definition';

export interface DiagramNode {
    id: string;
    kind: DiagramNodeKind;
    /** Position relative to the parent node. */
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    /** Lines of the body compartment of a state (or of the definition section). */
    body?: string[];
    /** Full (not shortened) text of each body line, if it differs from the displayed line. */
    bodyTitles?: Array<string | undefined>;
    /** Name label next to the node (entry points, exit nodes), position relative to the node. */
    label?: DiagramLabel;
    /** Height of the name compartment of a state. */
    headerHeight?: number;
    /** A state with sub states or regions. */
    composite?: boolean;
    /** The children of this state are regions. */
    regions?: boolean;
    /** Index of a region within its state. */
    index?: number;
    /** Regions (manual layout): where the separator line to the previous region is drawn (default: by layout direction). */
    separator?: 'top' | 'left';
    children: DiagramNode[];
}

export interface DiagramLabel {
    text: string;
    /** Full text if `text` is shortened. */
    title?: string;
    /** Absolute position (edge labels), relative to the node (node labels) */
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DiagramEdge {
    id: string;
    source: string;
    target: string;
    /**
     * `spline`: points are start point, then triples of (control point, control point, end point)
     * of cubic bezier segments. Otherwise the points describe a polyline.
     */
    routing: 'spline' | 'polyline' | 'orthogonal';
    /** Absolute coordinates of the route. */
    points: Point[];
    label?: DiagramLabel;
    /** Priority of the transition among the outgoing transitions of its source (if it has several). */
    priority?: number;
}

export interface DiagramGraph {
    id: string;
    name: string;
    width: number;
    height: number;
    direction: LayoutDirection;
    children: DiagramNode[];
    edges: DiagramEdge[];
}

export interface LayoutResult {
    graph: DiagramGraph;
    /** Maps diagram element ids to AST nodes. */
    elements: Map<string, AstNode>;
    /** Maps AST nodes to diagram element ids. */
    ids: Map<AstNode, string>;
}
