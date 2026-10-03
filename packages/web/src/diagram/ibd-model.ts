import { SChildElementImpl, SNodeImpl, SShapeElementImpl, boundsFeature, hoverFeedbackFeature, selectFeature } from 'sprotty';

/** Ports while drawing a connector: can be connected (`ok`), incompatible kinds / types / payloads (`problem`, refused with an explanation), not at all (`invalid`). */
export type ConnectStatus = 'ok' | 'problem' | 'invalid';
import type { SModelElement, SModelRoot } from 'sprotty-protocol';
import type { DiagramLabel, IbdBehavior, IbdComposite, IbdEdge, IbdGraph, IbdMember, IbdNode, IbdNodeKind, IbdPort, Point } from 'devm-language';
import type { Issue } from './model.js';

/*
 * The Sprotty model of the internal block diagram of a structure (see ibd-model.ts of the
 * language package): frame, thread and instance nodes with ports, connectors, type boxes (the structs
 * of the file).
 */

/** Types of the elements of the internal block diagram (used to select the views). */
export const IbdTypes = {
    graph: 'graph:ibd',
    frame: 'node:ibd-frame',
    thread: 'node:ibd-thread',
    instance: 'node:ibd-instance',
    block: 'node:ibd-block',
    /** A struct of the file (not connected). */
    type: 'node:ibd-type',
    port: 'port:ibd',
    /** An invisible node covering the whole diagram (the labels of boundary ports are outside of the frame): fit to screen shows them. */
    canvas: 'node:ibd-canvas',
    connector: 'edge:ibd-connector'
} as const satisfies Record<IbdNodeKind | 'graph' | 'port' | 'connector' | 'canvas', string>;

/** A frame, thread, instance, component block or type box. */
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
    /** Type boxes: fields. */
    members?: IbdMember[];
    issue?: Issue;
    /** The node owns a port of the highlighted route. */
    onRoute = false;
    /** Manual layout: the node shows a resize handle when it is selected. */
    resizable = false;
}

export class IbdPortElement extends SShapeElementImpl {
    static readonly DEFAULT_FEATURES = [selectFeature, boundsFeature, hoverFeedbackFeature];

    portName = '';
    direction: IbdPort['direction'] = 'in';
    kind: IbdPort['kind'] = 'sync';
    side: IbdPort['side'] = 'WEST';
    title = '';
    /** The type shown in the label (`up : integer`). */
    typeName?: string;
    /** The label, relative to the port. */
    label?: DiagramLabel;
    selected = false;
    hoverFeedback = false;
    issue?: Issue;
    onRoute = false;
    /** Drawing a connector: whether the port can be connected with the start port. */
    connect?: ConnectStatus;
    /** The start port of the connector being drawn. */
    connectSource = false;
    /** Manual layout: the port can be dragged along the border of its node (to another side). */
    movable = false;
}

export class IbdConnectorElement extends SChildElementImpl {
    static readonly DEFAULT_FEATURES = [selectFeature, hoverFeedbackFeature];

    kind: IbdEdge['kind'] = 'connect';
    /** The ports at the ends (the data flows from the source to the target). */
    sourceId = '';
    targetId = '';
    /** Between inout ports: the data flows both ways (arrowheads at both ends). */
    bidirectional = false;
    crossThread = false;
    title = '';
    points: Point[] = [];
    selected = false;
    hoverFeedback = false;
    issue?: Issue;
    onRoute = false;
    /** Manual layout: the points the route passes through (absolute). */
    waypoints: Point[] = [];
    /** Manual layout: the waypoints can be moved when the connector is selected. */
    editable = false;
}

export interface IbdSchemaOptions {
    selected: ReadonlySet<string>;
    issues: ReadonlyMap<string, Issue>;
    /** Ids of the elements on the highlighted route. */
    route?: ReadonlySet<string>;
    /** Drawing a connector: the status of the ports (see {@link ConnectStatus}). */
    connect?: ReadonlyMap<string, ConnectStatus>;
    /** Drawing a connector: its start port. */
    pendingPort?: string;
    /** The layout can be edited: nodes can be resized, ports moved along their border, waypoints of connectors moved. */
    layoutEditable?: boolean;
}

/** Converts the laid out internal block diagram into the Sprotty model schema. */
export function toIbdSchema(graph: IbdGraph, options: IbdSchemaOptions): SModelRoot {
    // ports of instances and boundary ports can be placed by hand (not the ports of component blocks)
    const movablePorts = new Set<string>();
    if (options.layoutEditable) {
        const visit = (node: IbdNode) => {
            if (node.kind === 'instance' || node.kind === 'frame') {
                node.ports.forEach(p => movablePorts.add(p.id));
            }
            node.children.forEach(visit);
        };
        graph.children.forEach(visit);
    }
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
        typeName: port.typeName,
        label: { ...port.label, x: port.label.x - port.x, y: port.label.y - port.y },
        selected: options.selected.has(port.id),
        issue: options.issues.get(port.id),
        onRoute: options.route?.has(port.id) ?? false,
        connect: options.connect?.get(port.id),
        connectSource: options.pendingPort === port.id,
        movable: movablePorts.has(port.id),
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
        members: node.members,
        selected: options.selected.has(node.id),
        issue: options.issues.get(node.id),
        onRoute: options.route?.has(node.id) ?? false,
        resizable: options.layoutEditable ?? false,
        children: [...node.children.map(convertNode), ...node.ports.map(convertPort)]
    } as SModelElement);
    const convertEdge = (edge: IbdEdge): SModelElement => ({
        type: IbdTypes.connector,
        id: edge.id,
        kind: edge.kind,
        sourceId: edge.source,
        targetId: edge.target,
        bidirectional: edge.bidirectional ?? false,
        crossThread: edge.crossThread,
        title: edge.title,
        points: edge.points,
        waypoints: edge.waypoints ?? [],
        editable: options.layoutEditable ?? false,
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
