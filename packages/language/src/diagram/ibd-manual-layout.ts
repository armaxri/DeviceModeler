/**
 * Manual ("hand-arranged") layouts of structure diagrams (internal block diagrams of `.devm` files), the
 * counterpart of manual-layout.ts for state machines, with the same concept on the shared core
 * (layout-core): the layout is stored as layout annotations in the model text (see
 * ibd-layout-annotations.ts) and applied on top of the automatic (ELK) layout, which is always computed
 * first.
 *
 * - Nodes (the frame, threads, instances, component blocks, type boxes): pinned nodes keep their stored
 *   position (relative to their parent node) and their stored size if they were resized; containers
 *   (threads, the frame) grow to fit their content; nodes without a stored position are placed near their
 *   position in the automatic layout without overlapping the others ({@link placeChildren}).
 * - Ports: a stored port keeps its side and its offset along the side (from the top or left corner of
 *   its node); the other ports keep the side and offset of the automatic layout. Ports of a side keep a
 *   minimum distance (later ones are pushed along the side), the node grows if needed.
 * - Connectors: a connector keeps the route of the automatic layout while both its ports and their nodes
 *   are arranged like in the automatic layout (relative to the frame of the connector: the innermost node
 *   containing both ports' nodes) and no moved node lies on the route. Other connectors, and connectors
 *   with stored waypoints, are routed orthogonally around the instances ({@link routeThroughWaypoints}),
 *   leaving each port perpendicular to its side.
 */
import type { Point, TextMeasure } from './diagram-model.js';
import { IbdMetrics as M, ibdTextWidth, type IbdEdge, type IbdLayoutResult, type IbdNode, type IbdPort, type IbdPortSide } from './ibd-model.js';
import { approximateTextMeasure } from './layout.js';
import {
    LayoutTree, MANUAL_LAYOUT_VERSION, cloneLayout, crossesRect, placeChildren, routeThroughWaypoints, sameRect,
    type BaseManualLayout, type Rect
} from './layout-core/index.js';

/** A stored port: its side and the offset of its center along the side (from the top / left corner of its node). */
export interface IbdPortLayout {
    side: IbdPortSide;
    offset?: number;
}

/** The manual layout of a structure diagram: nodes, connectors (waypoints) and ports by diagram id. */
export interface IbdManualLayout extends BaseManualLayout {
    ports: Record<string, IbdPortLayout>;
}

export interface IbdManualLayoutResult extends IbdLayoutResult {
    /**
     * The effective layout (manual layouts only): all nodes pinned at their computed positions, stored
     * sizes, waypoints and ports kept. Changes made in the diagram are applied to this layout.
     */
    effective?: IbdManualLayout;
    /** The automatic layout the manual layout was applied to (set by `layoutStructure`). */
    auto?: IbdLayoutResult['graph'];
}

export function createIbdLayout(): IbdManualLayout {
    return { version: MANUAL_LAYOUT_VERSION, mode: 'manual', nodes: {}, edges: {}, ports: {} };
}

export function cloneIbdLayout(layout: IbdManualLayout): IbdManualLayout {
    return cloneLayout(layout);
}

/** Pins all nodes of a computed diagram at their current positions ("auto-arrange"). Ports and routes stay automatic. */
export function captureIbdLayout(graph: { children: IbdNode[] }): IbdManualLayout {
    const layout = createIbdLayout();
    const visit = (node: IbdNode) => {
        layout.nodes[node.id] = { x: node.x, y: node.y };
        node.children.forEach(visit);
    };
    graph.children.forEach(visit);
    return layout;
}

/** Applies a manual layout to the automatic layout of a structure diagram (which is not modified). */
export function applyIbdManualLayout(auto: IbdLayoutResult, layout: IbdManualLayout, options: { measure?: TextMeasure } = {}): IbdManualLayoutResult {
    return new IbdManualLayoutEngine(auto, layout, options.measure ?? approximateTextMeasure).run();
}

/** The direction from a port into its node (east, south, west, north as in the router). */
const SIDES: IbdPortSide[] = ['EAST', 'SOUTH', 'WEST', 'NORTH'];

/**
 * Positions a port (square centered on the border of its node at `offset` along its side) and its label:
 * inside instances and blocks on the left / right side, outside above / below the node (right of the
 * port) on the top / bottom side, outside of the frame for boundary ports.
 */
export function placeIbdPort(port: IbdPort, node: { width: number, height: number }, side: IbdPortSide, offset: number, boundary: boolean): void {
    const half = port.size / 2;
    const inset = half + 5;
    const label = port.label;
    port.side = side;
    switch (side) {
        case 'WEST':
        case 'EAST':
            port.x = side === 'WEST' ? -half : node.width - half;
            port.y = offset - half;
            if (boundary) {
                label.x = side === 'WEST' ? -half - 4 - label.width : node.width + half + 4;
                label.y = offset - label.height - 2;
            } else {
                label.x = side === 'WEST' ? inset : node.width - inset - label.width;
                label.y = offset - label.height / 2;
            }
            break;
        case 'NORTH':
        case 'SOUTH':
            // the label outside, right of the port (a connector runs straight out of the port, see `attachment`)
            port.x = offset - half;
            port.y = side === 'NORTH' ? -half : node.height - half;
            label.x = offset + half + 3;
            label.y = side === 'NORTH' ? -half - 2 - label.height : node.height + half + 2;
            break;
    }
}

/**
 * The top left corner of the area in which the children of a node are placed (relative to the node):
 * below the header of a thread, below the tab of the frame (and right of its boundary ports); on the
 * canvas (`undefined`) the padding of the diagram.
 */
export function ibdContentOrigin(node: Pick<IbdNode, 'kind' | 'headerHeight'> | undefined): Point {
    if (!node) {
        return { x: M.graphPadding, y: M.graphPadding };
    }
    if (node.kind === 'thread') {
        return { x: M.threadPadding, y: node.headerHeight + 6 };
    }
    return node.kind === 'frame' ? { x: M.portSize + 10, y: M.tabHeight + 10 } : { x: 0, y: 0 };
}

/** Offset of the center of a port along its side. */
export function portOffset(port: IbdPort): number {
    return port.side === 'WEST' || port.side === 'EAST' ? port.y + port.size / 2 : port.x + port.size / 2;
}

const ROOT_ID = '#ibd-root';
/** Distance kept between the routes and the border of their frame / thread header. */
const ROUTE_SPACE = 90;

interface PortInfo {
    port: IbdPort;
    node: IbdNode;
}

interface LocalRoute {
    points: Point[];
    waypoints?: Point[];
}

class IbdManualLayoutEngine {

    private readonly root: IbdNode;
    private readonly tree: LayoutTree<IbdNode>;
    /** Relative positions and absolute bounds of the nodes in the automatic layout. */
    private readonly autoPositions = new Map<string, Point>();
    private readonly autoBounds: Map<string, Rect>;
    /** Ports in the automatic layout (position relative to the node, side). */
    private readonly autoPorts = new Map<string, { x: number, y: number, side: IbdPortSide }>();
    private readonly ports = new Map<string, PortInfo>();
    private readonly edges: IbdEdge[];
    private readonly autoEdges = new Map<string, IbdEdge>();
    private readonly frames = new Map<string, string>();
    private readonly framedEdges = new Map<string, IbdEdge[]>();
    private readonly shifts = new Map<string, Point>();
    private readonly localRoutes = new Map<string, LocalRoute>();
    /** Ports placed by the stored layout: side and computed offset. */
    private readonly placedPorts = new Map<string, IbdPortLayout>();

    constructor(private readonly auto: IbdLayoutResult, private readonly layout: IbdManualLayout, private readonly measure: TextMeasure) {
        const clone = (node: IbdNode): IbdNode => ({
            ...node,
            ports: node.ports.map(p => ({ ...p, label: { ...p.label } })),
            children: node.children.map(clone)
        });
        const graph = auto.graph;
        this.root = {
            id: ROOT_ID, kind: 'frame', name: '', x: 0, y: 0, width: graph.width, height: graph.height, headerHeight: 0,
            ports: [], children: graph.children.map(clone)
        };
        this.tree = new LayoutTree<IbdNode>(this.root, node => node.children);
        this.autoBounds = this.tree.absoluteBounds();
        for (const [id, node] of this.tree.nodes) {
            this.autoPositions.set(id, { x: node.x, y: node.y });
            for (const port of node.ports) {
                this.ports.set(port.id, { port, node });
                this.autoPorts.set(port.id, { x: port.x, y: port.y, side: port.side });
            }
        }
        this.edges = graph.edges.map(edge => {
            this.autoEdges.set(edge.id, edge);
            return { ...edge, points: edge.points.map(p => ({ ...p })) };
        });
        for (const edge of this.edges) {
            const source = this.ports.get(edge.source);
            const target = this.ports.get(edge.target);
            if (!source || !target) {
                continue;
            }
            const frame = this.tree.frameOf(source.node.id, target.node.id);
            this.frames.set(edge.id, frame);
            this.framedEdges.set(frame, [...this.framedEdges.get(frame) ?? [], edge]);
        }
    }

    run(): IbdManualLayoutResult {
        const origin = ibdContentOrigin(undefined);
        this.layoutContent(this.root, origin.x, origin.y);
        // the labels of the boundary ports on the left must stay on the canvas
        const frame = this.root.children.find(c => c.kind === 'frame');
        if (frame) {
            const left = Math.min(frame.x, ...frame.ports.map(p => frame.x + p.label.x));
            if (left < M.graphPadding / 2) {
                const dx = M.graphPadding / 2 - left;
                this.root.children.forEach(child => child.x += dx);
            }
        }
        let right = 0;
        let bottom = 0;
        for (const child of this.root.children) {
            right = Math.max(right, child.x + child.width, ...child.ports.map(p => child.x + Math.max(p.x + p.size, p.label.x + p.label.width)));
            bottom = Math.max(bottom, child.y + child.height, ...child.ports.map(p => child.y + Math.max(p.y + p.size, p.label.y + p.label.height)));
        }
        for (const edge of this.edges) {
            const route = this.localRoutes.get(edge.id);
            if (!route) {
                continue;
            }
            const origin = this.tree.absolutePosition(this.frames.get(edge.id)!);
            edge.points = route.points.map(p => ({ x: p.x + origin.x, y: p.y + origin.y }));
            edge.waypoints = route.waypoints?.map(p => ({ x: p.x + origin.x, y: p.y + origin.y }));
        }
        // (arranged like the automatic layout: its size, which has room for the labels of the boundary ports on both sides)
        const auto = this.likeAuto(this.root) ? this.auto.graph : { width: 0, height: 0 };
        const graph = {
            ...this.auto.graph,
            width: Math.max(auto.width, right + M.graphPadding), height: Math.max(auto.height, bottom + M.graphPadding),
            children: this.root.children, edges: this.edges
        };
        return { ...this.auto, graph, effective: this.effectiveLayout() };
    }

    // -----------------------------------------------------------------------------------------
    // Nodes

    private stored(id: string) {
        return this.layout.nodes[id];
    }

    private autoSize(id: string): { width: number, height: number } {
        const bounds = this.autoBounds.get(id)!;
        return { width: bounds.width, height: bounds.height };
    }

    /** Lays out the children of a container, then its size, its ports and the connectors routed in it. Returns its content extent. */
    private layoutContent(owner: IbdNode, left: number, top: number): Point {
        for (const child of owner.children) {
            this.layoutNode(child);
        }
        const shift = placeChildren({
            children: owner.children,
            stored: child => this.stored(child.id),
            auto: child => this.autoPositions.get(child.id)!,
            left, top
        });
        if (shift) {
            this.shifts.set(owner.id, shift);
        }
        let right = 0;
        let bottom = 0;
        for (const child of owner.children) {
            // (with the ports and their labels outside of the node)
            right = Math.max(right, child.x + child.width, ...child.ports.map(p => child.x + Math.max(p.x + p.size, p.label.x + p.label.width)));
            bottom = Math.max(bottom, child.y + child.height, ...child.ports.map(p => child.y + Math.max(p.y + p.size, p.label.y + p.label.height)));
        }
        // stored waypoints of the connectors of the container belong to its content
        for (const edge of this.framedEdges.get(owner.id) ?? []) {
            for (const p of this.storedBends(edge, owner.id) ?? []) {
                right = Math.max(right, p.x);
                bottom = Math.max(bottom, p.y);
            }
        }
        return { x: right, y: bottom };
    }

    /** Whether the children of a container (and their ports) are arranged exactly like in the automatic layout. */
    private likeAuto(node: IbdNode): boolean {
        return node.children.every(child => {
            const auto = this.autoPositions.get(child.id)!;
            const size = this.autoSize(child.id);
            return sameRect({ x: child.x, y: child.y, width: child.width, height: child.height }, { ...auto, ...size })
                && child.ports.every(port => {
                    const autoPort = this.autoPorts.get(port.id)!;
                    return port.side === autoPort.side && Math.abs(port.x - autoPort.x) <= 0.5 && Math.abs(port.y - autoPort.y) <= 0.5;
                });
        });
    }

    private layoutNode(node: IbdNode): void {
        const stored = this.stored(node.id);
        const auto = this.autoSize(node.id);
        switch (node.kind) {
            case 'thread': {
                const origin = ibdContentOrigin(node);
                const extent = this.layoutContent(node, origin.x, origin.y);
                const title = ibdTextWidth(this.measure, `«thread» ${node.name}`, M.nameFont, true);
                const details = node.details ? ibdTextWidth(this.measure, node.details, M.detailsFont) : 0;
                const fits = this.likeAuto(node) && stored?.width === undefined && stored?.height === undefined;
                node.width = fits ? auto.width : Math.max(Math.max(title, details) + 2 * M.threadPadding, extent.x + M.threadPadding, stored?.width ?? 0);
                node.height = fits ? auto.height : Math.max(node.headerHeight + 40, extent.y + M.threadPadding, stored?.height ?? 0);
                this.routeEdges(node);
                break;
            }
            case 'frame': {
                const origin = ibdContentOrigin(node);
                const extent = this.layoutContent(node, origin.x, origin.y);
                const fits = this.likeAuto(node) && stored?.width === undefined && stored?.height === undefined;
                node.width = fits ? auto.width : Math.max((node.tabWidth ?? 0) + 60, extent.x + M.framePadding + M.portSize, stored?.width ?? 0);
                node.height = fits ? auto.height : Math.max(80, extent.y + M.framePadding, stored?.height ?? 0);
                this.placePorts(node, true, 16);
                this.routeEdges(node);
                break;
            }
            case 'instance':
            case 'block': {
                // the labels of the ports of both sides must fit
                const inset = M.portSize / 2 + 5;
                const sideOf = (port: IbdPort) => this.layout.ports[port.id]?.side ?? port.side;
                const labels = (side: IbdPortSide) => Math.max(0, ...node.ports.filter(p => sideOf(p) === side).map(p => p.label.width));
                node.width = Math.max(auto.width, stored?.width ?? 0, Math.ceil(labels('WEST') + labels('EAST') + 2 * inset + 2 * M.instancePadding));
                node.height = Math.max(auto.height, stored?.height ?? 0);
                this.placePorts(node, false, M.portRow);
                break;
            }
            default:
                node.width = Math.max(auto.width, stored?.width ?? 0);
                node.height = Math.max(auto.height, stored?.height ?? 0);
        }
    }

    /**
     * Places the ports of a node: stored ports at their side and offset, the others like in the automatic
     * layout; ports of a side keep a minimum distance (`gap` between their centers on the left / right
     * side, the label widths on the top / bottom side); the node grows if they do not fit.
     */
    private placePorts(node: IbdNode, boundary: boolean, gap: number): void {
        const entries = node.ports.map((port, index) => {
            const stored = this.layout.ports[port.id];
            const auto = this.autoPorts.get(port.id)!;
            const side = stored?.side ?? auto.side;
            const autoOffset = auto.side === 'WEST' || auto.side === 'EAST' ? auto.y + port.size / 2 : auto.x + port.size / 2;
            const offset = stored?.offset ?? (auto.side === side ? autoOffset : undefined);
            return { port, index, side, offset, stored: stored !== undefined };
        });
        const minimum = M.portSize;
        for (const side of SIDES) {
            const ports = entries.filter(e => e.side === side);
            if (ports.length === 0) {
                continue;
            }
            const vertical = side === 'WEST' || side === 'EAST';
            // ports without an offset (moved to another side without one) follow the others
            let next = Math.max(minimum, ...ports.filter(e => e.offset !== undefined).map(e => e.offset! + gap));
            for (const entry of ports.filter(e => e.offset === undefined)) {
                entry.offset = next;
                next += gap;
            }
            ports.sort((a, b) => a.offset! - b.offset! || Number(b.stored) - Number(a.stored) || a.index - b.index);
            let previous: { offset: number, port: IbdPort } | undefined;
            for (const entry of ports) {
                if (previous) {
                    const distance = vertical ? gap : Math.max(gap, (previous.port.label.width + entry.port.label.width) / 2 + 8);
                    entry.offset = Math.max(entry.offset!, previous.offset + distance);
                } else {
                    entry.offset = Math.max(entry.offset!, minimum);
                }
                previous = { offset: entry.offset!, port: entry.port };
            }
            const last = ports[ports.length - 1].offset! + (vertical ? gap / 2 + 4 : M.portSize);
            if (vertical) {
                node.height = Math.max(node.height, Math.ceil(last));
            } else {
                node.width = Math.max(node.width, Math.ceil(last));
            }
        }
        for (const entry of entries) {
            placeIbdPort(entry.port, node, entry.side, entry.offset!, boundary);
            if (entry.stored) {
                this.placedPorts.set(entry.port.id, { side: entry.side, offset: entry.offset! });
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Connectors

    private storedBends(edge: IbdEdge, frame: string): Point[] | undefined {
        const bends = this.layout.edges[edge.id]?.bends;
        if (!bends?.length) {
            return undefined;
        }
        const shift = this.shifts.get(frame) ?? { x: 0, y: 0 };
        return bends.map(p => ({ x: p.x + shift.x, y: p.y + shift.y }));
    }

    private autoBoundsIn(id: string, frame: string): Rect {
        const bounds = this.autoBounds.get(id)!;
        const origin = this.autoBounds.get(frame)!;
        return id === frame ? { ...bounds, x: 0, y: 0 } : { ...bounds, x: bounds.x - origin.x, y: bounds.y - origin.y };
    }

    /** The nodes in a frame a connector must not cross (instances and blocks, not threads), relative to the frame. */
    private obstacles(frame: IbdNode): Array<{ id: string, rect: Rect }> {
        const result: Array<{ id: string, rect: Rect }> = [];
        const visit = (node: IbdNode) => {
            for (const child of node.children) {
                if (child.kind === 'thread') {
                    visit(child);
                } else {
                    result.push({ id: child.id, rect: this.tree.boundsIn(child.id, frame.id) });
                }
            }
        };
        visit(frame);
        return result;
    }

    /** The threads within a frame (their borders are crossed by the connectors), relative to the frame. */
    private threads(frame: IbdNode): Rect[] {
        const result: Rect[] = [];
        const visit = (node: IbdNode) => {
            for (const child of node.children.filter(c => c.kind === 'thread')) {
                result.push(this.tree.boundsIn(child.id, frame.id));
                visit(child);
            }
        };
        visit(frame);
        return result;
    }

    /**
     * The point where a connector attaches to a port (relative to the frame), the square of the port and,
     * for ports on the top / bottom side of an instance, the point past the label of the port where the
     * route starts (the connector runs straight out of the port to it).
     */
    private attachment(portId: string, frame: string): { point: Point, square: Rect, lead?: Point } {
        const { port, node } = this.ports.get(portId)!;
        const origin = this.tree.boundsIn(node.id, frame);
        const square = { x: origin.x + port.x, y: origin.y + port.y, width: port.size, height: port.size };
        // the outer side of the ports of instances, the inner side of the boundary ports of the frame
        const inner = node.id === frame;
        const cx = square.x + square.width / 2;
        const cy = square.y + square.height / 2;
        let point: Point;
        switch (port.side) {
            case 'WEST': point = { x: inner ? square.x + square.width : square.x, y: cy }; break;
            case 'EAST': point = { x: inner ? square.x : square.x + square.width, y: cy }; break;
            case 'NORTH': point = { x: cx, y: inner ? square.y + square.height : square.y }; break;
            default: point = { x: cx, y: inner ? square.y : square.y + square.height };
        }
        if (!inner && (port.side === 'NORTH' || port.side === 'SOUTH')) {
            const distance = port.label.height + 6;
            return { point, square, lead: { x: point.x, y: point.y + (port.side === 'NORTH' ? -distance : distance) } };
        }
        return { point, square };
    }

    /** Whether a connector and its ports are arranged like in the automatic layout (relative to its frame). */
    private unchanged(edge: IbdEdge, frame: string): boolean {
        for (const portId of [edge.source, edge.target]) {
            const { port, node } = this.ports.get(portId)!;
            const auto = this.autoPorts.get(portId)!;
            if (port.side !== auto.side || Math.abs(port.x - auto.x) > 0.5 || Math.abs(port.y - auto.y) > 0.5) {
                return false;
            }
            // (a boundary port of the frame: its position relative to the frame is checked above)
            if (node.id !== frame && !sameRect(this.tree.boundsIn(node.id, frame), this.autoBoundsIn(node.id, frame))) {
                return false;
            }
        }
        return true;
    }

    private routeEdges(frame: IbdNode): void {
        const edges = this.framedEdges.get(frame.id) ?? [];
        if (edges.length === 0) {
            return;
        }
        const obstacles = this.obstacles(frame);
        const placed: Point[][] = [];
        const pending: Array<{ edge: IbdEdge, waypoints: Point[] }> = [];
        const origin = this.autoBounds.get(frame.id)!;
        for (const edge of edges) {
            const bends = this.storedBends(edge, frame.id);
            const autoEdge = this.autoEdges.get(edge.id)!;
            if (bends) {
                pending.push({ edge, waypoints: bends });
                continue;
            }
            if (autoEdge.points.length >= 2 && this.unchanged(edge, frame.id)) {
                const points = autoEdge.points.map(p => ({ x: p.x - origin.x, y: p.y - origin.y }));
                const ends = new Set([this.ports.get(edge.source)!.node.id, this.ports.get(edge.target)!.node.id]);
                const blocked = obstacles.some(({ id, rect }) => !ends.has(id) && !sameRect(rect, this.autoBoundsIn(id, frame.id)) && crossesRect(points, rect));
                if (!blocked) {
                    this.localRoutes.set(edge.id, { points });
                    placed.push(points);
                    continue;
                }
            }
            pending.push({ edge, waypoints: [] });
        }
        const half = M.portSize / 2;
        const inflated = obstacles.map(({ id, rect }) => ({ id, rect: { x: rect.x - half, y: rect.y - half, width: rect.width + 2 * half, height: rect.height + 2 * half } }));
        const containers = this.threads(frame);
        for (const { edge, waypoints } of pending) {
            const source = this.attachment(edge.source, frame.id);
            const target = this.attachment(edge.target, frame.id);
            const point = (p: Point): Rect => ({ x: p.x, y: p.y, width: 0, height: 0 });
            const start = source.lead ?? source.point;
            const end = target.lead ?? target.point;
            const rects = [...inflated.map(o => o.rect), point(start), point(end), ...waypoints.map(point)];
            const header = frame.kind === 'frame' ? M.tabHeight : frame.headerHeight;
            const bounds = {
                minX: Math.min(0, ...rects.map(r => r.x - 2 * M.portSize)),
                minY: Math.min(header, ...rects.map(r => r.y - 2 * M.portSize)),
                maxX: Math.max(frame.width, ...rects.map(r => r.x + r.width)) + ROUTE_SPACE,
                maxY: Math.max(frame.height, ...rects.map(r => r.y + r.height)) + ROUTE_SPACE
            };
            const route = routeThroughWaypoints({
                source: point(start), target: point(end), waypoints,
                obstacles: [...inflated.map(o => o.rect), source.square, target.square],
                containers, placed, bounds,
                sourceFixed: true, targetFixed: true
            });
            const points = route
                ? [...(source.lead ? [source.point] : []), ...route.points, ...(target.lead ? [target.point] : [])]
                : this.straightRoute(source.point, edge.source, target.point, edge.target, waypoints);
            this.localRoutes.set(edge.id, { points, waypoints: waypoints.length > 0 ? waypoints : undefined });
            placed.push(points);
        }
    }

    /** Fallback without an orthogonal route: from the ports straight out, then through the waypoints. */
    private straightRoute(from: Point, sourceId: string, to: Point, targetId: string, waypoints: Point[]): Point[] {
        const stub = (p: Point, portId: string): Point => {
            const { port, node } = this.ports.get(portId)!;
            const inward = node.kind === 'frame' ? -1 : 1;
            const d = 12 * inward;
            switch (port.side) {
                case 'WEST': return { x: p.x - d, y: p.y };
                case 'EAST': return { x: p.x + d, y: p.y };
                case 'NORTH': return { x: p.x, y: p.y - d };
                default: return { x: p.x, y: p.y + d };
            }
        };
        return [from, stub(from, sourceId), ...waypoints, stub(to, targetId), to];
    }

    // -----------------------------------------------------------------------------------------
    // Result

    private effectiveLayout(): IbdManualLayout {
        const result = createIbdLayout();
        for (const [id, node] of this.tree.nodes) {
            if (id === ROOT_ID) {
                continue;
            }
            const stored = this.stored(id);
            result.nodes[id] = {
                x: node.x, y: node.y,
                ...(stored?.width !== undefined ? { width: stored.width } : {}),
                ...(stored?.height !== undefined ? { height: stored.height } : {})
            };
        }
        for (const edge of this.edges) {
            const frame = this.frames.get(edge.id);
            const bends = frame ? this.storedBends(edge, frame) : undefined;
            if (bends) {
                result.edges[edge.id] = { bends };
            }
        }
        for (const [id, port] of this.placedPorts) {
            result.ports[id] = { ...port };
        }
        return result;
    }
}
