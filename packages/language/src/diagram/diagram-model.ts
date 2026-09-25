import type { AstNode } from 'langium';

export interface Point {
    x: number;
    y: number;
}

export type TextStyle = 'name' | 'body' | 'label';

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
}

export type DiagramNodeKind = 'state' | 'region' | 'initial' | 'final' | 'choice' | 'junction' | 'history' | 'deephistory';

export interface DiagramNode {
    id: string;
    kind: DiagramNodeKind;
    /** Position relative to the parent node. */
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    /** Lines of the body compartment of a state. */
    body?: string[];
    /** Height of the name compartment of a state. */
    headerHeight?: number;
    /** A state with sub states or regions. */
    composite?: boolean;
    /** The children of this state are regions. */
    regions?: boolean;
    /** Index of a region within its state. */
    index?: number;
    children: DiagramNode[];
}

export interface DiagramLabel {
    text: string;
    /** Absolute position */
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
