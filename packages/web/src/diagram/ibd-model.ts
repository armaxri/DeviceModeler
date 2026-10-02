import { SChildElementImpl, SNodeImpl, SShapeElementImpl, boundsFeature, hoverFeedbackFeature, selectFeature } from 'sprotty';
import type { SModelElement, SModelRoot } from 'sprotty-protocol';
import type { DiagramLabel, IbdBehavior, IbdComposite, IbdEdge, IbdGraph, IbdNode, IbdNodeKind, IbdPort, Point } from 'hsm-language';
import type { Issue } from './model.js';

/*
 * The Sprotty model of the internal block diagram of a structure (`.dmf`, see ibd-model.ts of the
 * language package): frame, thread and instance nodes with ports, connectors.
 */

/** Types of the elements of the internal block diagram (used to select the views). */
export const IbdTypes = {
    graph: 'graph:ibd',
    frame: 'node:ibd-frame',
    thread: 'node:ibd-thread',
    instance: 'node:ibd-instance',
    block: 'node:ibd-block',
    port: 'port:ibd',
    /** An invisible node covering the whole diagram (the labels of boundary ports are outside of the frame): fit to screen shows them. */
    canvas: 'node:ibd-canvas',
    connector: 'edge:ibd-connector'
} as const satisfies Record<IbdNodeKind | 'graph' | 'port' | 'connector' | 'canvas', string>;

/** A frame, thread, instance or component block. */
export class IbdNodeElement extends SNodeImpl {
    static override readonly DEFAULT_FEATURES = [selectFeature, boundsFeature, hoverFeedbackFeature];

    kind: IbdNodeKind = 'instance';
    name = '';
    typeName?: string;
    stereotype?: string;
    details?: string;
    description?: string;
    headerHeight = 0;
    tabWidth?: number;
    behavior?: IbdBehavior;
    composite?: IbdComposite;
    issue?: Issue;
    /** The node owns a port of the highlighted route. */
    onRoute = false;
}

export class IbdPortElement extends SShapeElementImpl {
    static readonly DEFAULT_FEATURES = [selectFeature, boundsFeature, hoverFeedbackFeature];

    portName = '';
    direction: IbdPort['direction'] = 'provides';
    kind: IbdPort['kind'] = 'sync';
    side: IbdPort['side'] = 'WEST';
    title = '';
    /** The label, relative to the port. */
    label?: DiagramLabel;
    selected = false;
    hoverFeedback = false;
    issue?: Issue;
    onRoute = false;
}

export class IbdConnectorElement extends SChildElementImpl {
    static readonly DEFAULT_FEATURES = [selectFeature, hoverFeedbackFeature];

    kind: IbdEdge['kind'] = 'connect';
    crossThread = false;
    title = '';
    points: Point[] = [];
    selected = false;
    hoverFeedback = false;
    issue?: Issue;
    onRoute = false;
}

export interface IbdSchemaOptions {
    selected: ReadonlySet<string>;
    issues: ReadonlyMap<string, Issue>;
    /** Ids of the elements on the highlighted route. */
    route?: ReadonlySet<string>;
}

/** Converts the laid out internal block diagram into the Sprotty model schema. */
export function toIbdSchema(graph: IbdGraph, options: IbdSchemaOptions): SModelRoot {
    const convertPort = (port: IbdPort): SModelElement => ({
        type: IbdTypes.port,
        id: port.id,
        position: { x: port.x, y: port.y },
        size: { width: port.size, height: port.size },
        portName: port.name,
        direction: port.direction,
        kind: port.kind,
        side: port.side,
        title: port.title,
        label: { ...port.label, x: port.label.x - port.x, y: port.label.y - port.y },
        selected: options.selected.has(port.id),
        issue: options.issues.get(port.id),
        onRoute: options.route?.has(port.id) ?? false,
        children: []
    } as SModelElement);
    const convertNode = (node: IbdNode): SModelElement => ({
        type: IbdTypes[node.kind],
        id: node.id,
        position: { x: node.x, y: node.y },
        size: { width: node.width, height: node.height },
        kind: node.kind,
        name: node.name,
        typeName: node.typeName,
        stereotype: node.stereotype,
        details: node.details,
        description: node.description,
        headerHeight: node.headerHeight,
        tabWidth: node.tabWidth,
        behavior: node.behavior,
        composite: node.composite,
        selected: options.selected.has(node.id),
        issue: options.issues.get(node.id),
        onRoute: options.route?.has(node.id) ?? false,
        children: [...node.children.map(convertNode), ...node.ports.map(convertPort)]
    } as SModelElement);
    const convertEdge = (edge: IbdEdge): SModelElement => ({
        type: IbdTypes.connector,
        id: edge.id,
        kind: edge.kind,
        crossThread: edge.crossThread,
        title: edge.title,
        points: edge.points,
        selected: options.selected.has(edge.id),
        issue: options.issues.get(edge.id),
        onRoute: options.route?.has(edge.id) ?? false,
        children: []
    } as SModelElement);
    return {
        type: IbdTypes.graph,
        id: `${graph.id}#ibd`,
        name: graph.name,
        children: [
            { type: IbdTypes.canvas, id: `${graph.id}#canvas`, position: { x: 0, y: 0 }, size: { width: graph.width, height: graph.height }, children: [] } as SModelElement,
            ...graph.children.map(convertNode),
            ...graph.edges.map(convertEdge)
        ]
    } as SModelRoot;
}
