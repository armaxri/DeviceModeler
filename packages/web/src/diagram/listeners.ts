import { inject, injectable } from 'inversify';
import {
    MouseListener, MoveMouseListener, ScrollMouseListener, SelectMouseListener, TYPES,
    type IActionHandler, type SModelElementImpl, type SModelRootImpl, type ViewerOptions
} from 'sprotty';
import { BringToFrontAction, MoveAction, SelectAction, SelectAllAction, type Action } from 'sprotty-protocol';
import { borderPlacement, borderPoint, ibdRoutePath, type NodeSide, type Point } from 'devm-language';
import { isTransitionEdge, isVertexNode, type TransitionEdge, type VertexNode } from './model.js';
import { IbdConnectorElement, IbdNodeElement, IbdPortElement } from './ibd-model.js';
import { arrowHead, routePath } from './views.js';

/*
 * The mouse interaction of the diagrams, shared by the state machine diagram and the structure diagram
 * (manual layout: drag nodes, resize them, move waypoints of edges; structure diagrams: move ports along
 * the border of their node). The changes are reported to the application through the
 * {@link DiagramCallbacks}, which writes them as layout annotations into the text.
 */

/** A node which can be moved and resized: a vertex of a state machine or a node of a structure diagram. */
type LayoutNode = VertexNode | IbdNodeElement;
/** An edge with waypoints: a transition or a connector. */
type LayoutEdge = TransitionEdge | IbdConnectorElement;

function isLayoutNode(element: SModelElementImpl | undefined): element is LayoutNode {
    return isVertexNode(element) || element instanceof IbdNodeElement;
}

function isLayoutEdge(element: SModelElementImpl | undefined): element is LayoutEdge {
    return isTransitionEdge(element) || element instanceof IbdConnectorElement;
}

/** The paths of an edge (line and hit area) in the DOM. */
const EDGE_PATHS = '.transition-line, .transition-hit, .ibd-connector-line, .ibd-connector-hit';
/** The outline of a node in the DOM (resized while dragging the resize handle). */
const NODE_SHAPE = ':scope > .state-shape, :scope > .ibd-node-shape';

/** The SVG path of an edge as rendered by its view. */
function edgePath(edge: LayoutEdge, points: Point[] = edge.points, spline = isTransitionEdge(edge) && edge.routing === 'spline'): string {
    return isTransitionEdge(edge) ? routePath(points, spline) : ibdRoutePath(points);
}

/** Position of a vertex after it was dragged (relative to its parent and absolute). */
export interface MovedVertex {
    id: string;
    x: number;
    y: number;
    absoluteX: number;
    absoluteY: number;
}

export interface DragInfo {
    /** Shift was held when the vertex was dropped (move it into the state below the mouse). */
    shiftKey: boolean;
    /** All vertices moved by the drag (the selection). */
    moved: MovedVertex[];
}

/** Callbacks from the diagram into the application. */
export interface DiagramCallbacks {
    /** A mouse button was pressed on a diagram element (or the canvas, i.e. the root). */
    mouseDown(target: SModelElementImpl, event: MouseEvent): void;
    /** The mouse button was released over a diagram element (e.g. the end of a connector dragged from a port). */
    mouseUp?(target: SModelElementImpl, event: MouseEvent): void;
    /** Whether the element may be dragged (e.g. not while a tool of the palette is active in a structure diagram). */
    canMove?(target: SModelElementImpl): boolean;
    doubleClick(target: SModelElementImpl, event: MouseEvent): void;
    /** A vertex was dragged and dropped onto the given container element (undefined: no valid drop target). */
    dragEnd(draggedId: string, dropTargetId: string | undefined, info: DragInfo): void;
    selectionChanged(selected: string[], deselected: string[]): void;
    allSelected(select: boolean): void;
    /** Whether the diagram can be edited (not while simulating). */
    canEdit(): boolean;
    /** Manual layout: a state was resized. */
    resizeEnd(id: string, width: number, height: number): void;
    /** Manual layout: bend point `index` (0 = first bend point) of a transition was moved to `point` (absolute). */
    bendMoved(edgeId: string, index: number, point: Point): void;
    /** Manual layout: a bend point was added at `point` (double-click on the transition). */
    bendAdded(edgeId: string, point: Point): void;
    /** Manual layout: a bend point was removed (double-click on it). */
    bendRemoved(edgeId: string, index: number): void;
    /** Manual layout: the label of a transition was moved. */
    labelMoved(edgeId: string, dx: number, dy: number): void;
    /** Manual layout (structure diagrams): a port was dragged to a side of its node and an offset along it. */
    portMoved?(portId: string, side: NodeSide, offset: number): void;
}

export const DiagramCallbacks = Symbol('DiagramCallbacks');

function parentOf(element: SModelElementImpl): SModelElementImpl | undefined {
    return 'parent' in element ? (element as { parent?: SModelElementImpl }).parent : undefined;
}

/** The node (a vertex but not a region, or a node of a structure diagram) which is dragged when the drag starts on `target`. */
function movableNode(target: SModelElementImpl): LayoutNode | undefined {
    let current: SModelElementImpl | undefined = target;
    while (current && !isLayoutNode(current)) {
        current = parentOf(current);
    }
    if (current && isLayoutNode(current) && !(isVertexNode(current) && current.kind === 'region')) {
        return current;
    }
    return undefined;
}

/** A port of a structure diagram which can be dragged along the border of its node. */
function movablePort(target: SModelElementImpl): IbdPortElement | undefined {
    return target instanceof IbdPortElement && target.movable && target.parent instanceof IbdNodeElement ? target : undefined;
}

/** Straight lines from the border of the source through the waypoints to the border of the target. */
function previewLine(edge: TransitionEdge, s: Rect, sourceKind: VertexNode['kind'], t: Rect, targetKind: VertexNode['kind']): Point[] {
    const sc = { x: s.x + s.width / 2, y: s.y + s.height / 2 };
    const tc = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
    const waypoints = edge.waypoints;
    return [borderPoint(s, sourceKind, waypoints[0] ?? tc), ...waypoints, borderPoint(t, targetKind, waypoints[waypoints.length - 1] ?? sc)];
}

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The DOM element of a handle (resize handle, bend point) the event started on. */
function handleElement(event: MouseEvent): Element | undefined {
    const target = event.target;
    return target instanceof Element ? target.closest('.resize-handle, .bend-handle') ?? undefined : undefined;
}

/** Whether the mouse down starts dragging a handle, a port or the label of a selected transition (manual layout). */
function startsHandleDrag(target: SModelElementImpl, event: MouseEvent): boolean {
    return handleElement(event) !== undefined || movablePort(target) !== undefined
        || (isTransitionEdge(target) && target.selected && event.target instanceof Element && event.target.closest('.transition-label') !== null);
}

function zoomOf(root: SModelRootImpl): number {
    return (root as SModelRootImpl & { zoom?: number }).zoom ?? 1;
}

/** Converts the mouse position into diagram coordinates. */
function toModel(root: SModelRootImpl, event: MouseEvent): Point {
    const viewport = root as SModelRootImpl & { zoom?: number, scroll?: Point };
    const zoom = viewport.zoom ?? 1;
    const scroll = viewport.scroll ?? { x: 0, y: 0 };
    return { x: scroll.x + (event.clientX - root.canvasBounds.x) / zoom, y: scroll.y + (event.clientY - root.canvasBounds.y) / zoom };
}

/** Absolute position of a node or port (the sum of the positions of it and its parent nodes). */
function absolutePosition(element: SModelElementImpl): Point {
    let x = 0;
    let y = 0;
    let current: SModelElementImpl | undefined = element;
    while (current && (isLayoutNode(current) || current instanceof IbdPortElement)) {
        x += current.position.x;
        y += current.position.y;
        current = current.parent;
    }
    return { x, y };
}

/**
 * The point where a connector attaches to a port (absolute): the outer side of the ports of instances,
 * the inner side of the boundary ports of the frame; `side` / `position` replace those of the port.
 */
function portAttachment(port: IbdPortElement, side: NodeSide = port.side, position?: Point): Point {
    const p = position ?? absolutePosition(port);
    const size = port.size.width;
    const inner = port.parent instanceof IbdNodeElement && port.parent.kind === 'frame';
    switch (side) {
        case 'WEST': return { x: inner ? p.x + size : p.x, y: p.y + size / 2 };
        case 'EAST': return { x: inner ? p.x : p.x + size, y: p.y + size / 2 };
        case 'NORTH': return { x: p.x + size / 2, y: inner ? p.y + size : p.y };
        default: return { x: p.x + size / 2, y: inner ? p.y : p.y + size };
    }
}

/** Orthogonal lines through the points (an elbow between points which are not aligned): the preview of a connector. */
function orthogonalPreview(points: Point[]): Point[] {
    const result: Point[] = [];
    for (const p of points) {
        const last = result[result.length - 1];
        if (last && Math.abs(last.x - p.x) > 0.5 && Math.abs(last.y - p.y) > 0.5) {
            const middle = (last.x + p.x) / 2;
            result.push({ x: middle, y: last.y }, { x: middle, y: p.y });
        }
        result.push(p);
    }
    return result;
}

/** The point 12 px in front of a port (where its connector leaves it). */
function portStub(port: IbdPortElement, point: Point, side: NodeSide = port.side): Point {
    const inner = port.parent instanceof IbdNodeElement && port.parent.kind === 'frame';
    const d = inner ? -12 : 12;
    switch (side) {
        case 'WEST': return { x: point.x - d, y: point.y };
        case 'EAST': return { x: point.x + d, y: point.y };
        case 'NORTH': return { x: point.x, y: point.y - d };
        default: return { x: point.x, y: point.y + d };
    }
}

interface HandleDrag {
    kind: 'resize' | 'bend' | 'label' | 'port';
    id: string;
    startX: number;
    startY: number;
    zoom: number;
    index: number;
    moved: boolean;
    element: LayoutNode | LayoutEdge | IbdPortElement;
    /** Port drags: the placement of the port at the mouse position. */
    placement?: { side: NodeSide, offset: number };
}

@injectable()
export class HsmMouseListener extends MouseListener {

    @inject(DiagramCallbacks) protected callbacks!: DiagramCallbacks;
    @inject(TYPES.ViewerOptions) protected viewerOptions!: ViewerOptions;

    private drag?: { id: string, x: number, y: number, moved: boolean };
    private handle?: HandleDrag;
    /** Absolute positions of all nodes and ports when the current drag started (live update of the edges). */
    private startPositions?: Map<string, Point>;
    private edgeFrame?: number;
    /** Edges whose DOM was changed while dragging (restored on drop, before the diagram is updated). */
    private readonly changedEdges = new Set<LayoutEdge>();

    override mouseDown(target: SModelElementImpl, event: MouseEvent): Action[] {
        this.callbacks.mouseDown(target, event);
        this.drag = undefined;
        this.handle = undefined;
        if (event.button !== 0 || !this.callbacks.canEdit()) {
            return [];
        }
        if (this.startHandleDrag(target, event)) {
            return [];
        }
        if (this.callbacks.canMove && !this.callbacks.canMove(target)) {
            return [];
        }
        // (structure diagrams: an instance may also be dropped into another thread)
        const node = movableNode(target);
        this.drag = node ? { id: node.id, x: event.clientX, y: event.clientY, moved: false } : undefined;
        this.startPositions = node ? this.positions(target.root) : undefined;
        return [];
    }

    /** The absolute positions of all nodes and ports. */
    private positions(root: SModelRootImpl): Map<string, Point> {
        const result = new Map<string, Point>();
        for (const element of root.index.all()) {
            if (isLayoutNode(element) || element instanceof IbdPortElement) {
                result.set(element.id, absolutePosition(element));
            }
        }
        return result;
    }

    /** Resize handles of nodes, bend points of selected edges, labels of selected transitions, ports (manual layout). */
    private startHandleDrag(target: SModelElementImpl, event: MouseEvent): boolean {
        const handle = handleElement(event);
        const base = { startX: event.clientX, startY: event.clientY, zoom: zoomOf(target.root), moved: false };
        if (handle?.classList.contains('resize-handle')) {
            const node = movableNode(target);
            if (node) {
                this.handle = { ...base, kind: 'resize', id: node.id, index: 0, element: node };
                return true;
            }
        }
        const edge = isLayoutEdge(target) ? target : undefined;
        if (edge && handle?.classList.contains('bend-handle')) {
            const index = Array.from(handle.parentElement?.children ?? []).indexOf(handle);
            this.handle = { ...base, kind: 'bend', id: edge.id, index, element: edge };
            return true;
        }
        if (isTransitionEdge(edge) && startsHandleDrag(target, event)) {
            this.handle = { ...base, kind: 'label', id: edge.id, index: 0, element: edge };
            return true;
        }
        const port = movablePort(target);
        if (port && this.callbacks.canMove?.(target) !== false) {
            this.handle = { ...base, kind: 'port', id: port.id, index: 0, element: port };
            this.startPositions = this.positions(target.root);
            return true;
        }
        return false;
    }

    override mouseMove(_target: SModelElementImpl, event: MouseEvent): Action[] {
        if (this.handle && (event.buttons & 1)) {
            this.moveHandle(this.handle, event);
            return [];
        }
        if (this.drag && (event.buttons & 1) && Math.hypot(event.clientX - this.drag.x, event.clientY - this.drag.y) > 4) {
            this.drag.moved = true;
            if (this.startPositions && this.edgeFrame === undefined) {
                const root = _target.root;
                this.edgeFrame = requestAnimationFrame(() => {
                    this.edgeFrame = undefined;
                    this.updateAttachedEdges(root);
                });
            }
        }
        return [];
    }

    /**
     * Manual layout: while nodes are dragged, the edges attached to them follow – transitions as straight
     * lines, connectors as orthogonal lines (edges inside a dragged node are moved with it). The DOM is
     * changed directly; the routes are computed properly when the nodes are dropped.
     */
    private updateAttachedEdges(root: SModelRootImpl): void {
        const start = this.startPositions;
        if (!start || !this.drag) {
            return;
        }
        const rect = (vertex: VertexNode) => ({ ...absolutePosition(vertex), width: vertex.size.width, height: vertex.size.height });
        for (const element of root.index.all()) {
            if (element instanceof IbdConnectorElement) {
                this.updateConnector(element, start);
                continue;
            }
            if (!isTransitionEdge(element) || element.points.length < 2) {
                continue;
            }
            const source = root.index.getById(element.sourceId);
            const target = root.index.getById(element.targetId);
            if (!isVertexNode(source) || !isVertexNode(target)) {
                continue;
            }
            const s = rect(source);
            const t = rect(target);
            const s0 = start.get(source.id);
            const t0 = start.get(target.id);
            if (!s0 || !t0) {
                continue;
            }
            const ds = { x: s.x - s0.x, y: s.y - s0.y };
            const dt = { x: t.x - t0.x, y: t.y - t0.y };
            if (Math.hypot(ds.x, ds.y) < 0.5 && Math.hypot(dt.x, dt.y) < 0.5) {
                continue;
            }
            if (Math.hypot(ds.x - dt.x, ds.y - dt.y) < 0.5) {
                this.showPreview(element, element.points.map(p => ({ x: p.x + ds.x, y: p.y + ds.y })), element.routing === 'spline');
            } else {
                this.showPreview(element, previewLine(element, s, source.kind, t, target.kind), false);
            }
        }
    }

    /**
     * The preview of a connector while nodes or a port are dragged: moved with its ports if both moved
     * alike, otherwise orthogonal lines from the ports through the waypoints. `moved` replaces the
     * placement of a dragged port.
     */
    private updateConnector(edge: IbdConnectorElement, start: Map<string, Point>, moved?: { port: IbdPortElement, side: NodeSide, position: Point }): void {
        const root = edge.root;
        const source = root.index.getById(edge.sourceId);
        const target = root.index.getById(edge.targetId);
        if (!(source instanceof IbdPortElement) || !(target instanceof IbdPortElement) || edge.points.length < 2) {
            return;
        }
        const end = (port: IbdPortElement) => moved?.port === port
            ? { now: portAttachment(port, moved.side, moved.position), side: moved.side }
            : { now: portAttachment(port), side: port.side };
        const s = end(source);
        const t = end(target);
        const s0 = start.get(source.id);
        const t0 = start.get(target.id);
        if (!s0 || !t0) {
            return;
        }
        const ds = { x: s.now.x - portAttachment(source, source.side, s0).x, y: s.now.y - portAttachment(source, source.side, s0).y };
        const dt = { x: t.now.x - portAttachment(target, target.side, t0).x, y: t.now.y - portAttachment(target, target.side, t0).y };
        const sideChanged = moved !== undefined && moved.side !== moved.port.side;
        if (!sideChanged && Math.hypot(ds.x, ds.y) < 0.5 && Math.hypot(dt.x, dt.y) < 0.5) {
            return;
        }
        if (!sideChanged && Math.hypot(ds.x - dt.x, ds.y - dt.y) < 0.5) {
            this.showPreview(edge, edge.points.map(p => ({ x: p.x + ds.x, y: p.y + ds.y })), false);
        } else {
            this.showPreview(edge, orthogonalPreview([s.now, portStub(source, s.now, s.side), ...edge.waypoints, portStub(target, t.now, t.side), t.now]), false);
        }
    }

    /** Live feedback while resizing a vertex: its transitions as straight lines (through their waypoints). */
    private updateResizedEdges(vertex: VertexNode, width: number, height: number): void {
        const root = vertex.root;
        const rect = (v: VertexNode) => v === vertex
            ? { ...absolutePosition(v), width, height }
            : { ...absolutePosition(v), width: v.size.width, height: v.size.height };
        const contains = (outer: { x: number, y: number, width: number, height: number }, inner: { x: number, y: number }) =>
            inner.x >= outer.x && inner.y >= outer.y && inner.x <= outer.x + outer.width && inner.y <= outer.y + outer.height;
        for (const element of root.index.all()) {
            if (!isTransitionEdge(element) || element.points.length < 2 || (element.sourceId !== vertex.id && element.targetId !== vertex.id)) {
                continue;
            }
            const source = root.index.getById(element.sourceId);
            const target = root.index.getById(element.targetId);
            if (!isVertexNode(source) || !isVertexNode(target) || source === target) {
                continue;
            }
            const s = rect(source);
            const t = rect(target);
            if (contains(s, t) || contains(t, s)) {
                // a transition between a composite state and its content: the route stays inside
                continue;
            }
            this.showPreview(element, previewLine(element, s, source.kind, t, target.kind), false);
        }
    }

    /** Shows the route in the DOM (restored by {@link restoreEdges}; the label is hidden meanwhile). */
    private showPreview(element: LayoutEdge, points: Point[], spline: boolean): void {
        const dom = document.getElementById(`${this.viewerOptions.baseDiv}_${element.id}`);
        if (!dom) {
            return;
        }
        const d = edgePath(element, points, spline);
        dom.querySelectorAll(EDGE_PATHS).forEach(path => path.setAttribute('d', d));
        dom.querySelector('.transition-arrow')?.setAttribute('d', arrowHead(points[points.length - 2], points[points.length - 1]));
        dom.querySelector('.transition-label')?.setAttribute('visibility', 'hidden');
        this.changedEdges.add(element);
    }

    /** Restores the DOM of the transitions changed while dragging (the diagram update only patches changed attributes). */
    private restoreEdges(): void {
        if (this.edgeFrame !== undefined) {
            cancelAnimationFrame(this.edgeFrame);
            this.edgeFrame = undefined;
        }
        for (const edge of this.changedEdges) {
            const dom = document.getElementById(`${this.viewerOptions.baseDiv}_${edge.id}`);
            const d = edgePath(edge);
            dom?.querySelectorAll(EDGE_PATHS).forEach(path => path.setAttribute('d', d));
            if (isTransitionEdge(edge)) {
                dom?.querySelector('.transition-arrow')?.setAttribute('d', arrowHead(edge.points[edge.points.length - 2], edge.points[edge.points.length - 1]));
                dom?.querySelector('.transition-label')?.removeAttribute('visibility');
            }
        }
        this.changedEdges.clear();
    }

    /** Live feedback while dragging a handle: the DOM is changed directly, the diagram is updated on drop. */
    private moveHandle(handle: HandleDrag, event: MouseEvent): void {
        const dx = (event.clientX - handle.startX) / handle.zoom;
        const dy = (event.clientY - handle.startY) / handle.zoom;
        handle.moved ||= Math.hypot(event.clientX - handle.startX, event.clientY - handle.startY) > 2;
        const dom = document.getElementById(`${this.viewerOptions.baseDiv}_${handle.id}`);
        if (!dom) {
            return;
        }
        if (handle.kind === 'resize' && isLayoutNode(handle.element)) {
            const { width, height } = handle.element.size;
            const w = Math.max(20, width + dx);
            const h = Math.max(20, height + dy);
            dom.querySelectorAll(NODE_SHAPE).forEach(shape => {
                shape.setAttribute('width', String(w));
                shape.setAttribute('height', String(h));
            });
            dom.querySelector(':scope > .state-separator')?.setAttribute('x2', String(w));
            if (isVertexNode(handle.element)) {
                this.updateResizedEdges(handle.element, w, h);
            }
            const grip = dom.querySelector(':scope > .resize-handle');
            grip?.setAttribute('x', String(w - 9));
            grip?.setAttribute('y', String(h - 9));
        } else if (handle.kind === 'bend' && isLayoutEdge(handle.element)) {
            // straight lines through the waypoints while dragging (the route is computed on drop)
            const edge = handle.element;
            const waypoints = edge.waypoints.map(p => ({ ...p }));
            const point = waypoints[handle.index];
            if (!point) {
                return;
            }
            point.x += dx;
            point.y += dy;
            const d = edgePath(edge, [edge.points[0], ...waypoints, edge.points[edge.points.length - 1]], false);
            dom.querySelectorAll(EDGE_PATHS).forEach(path => path.setAttribute('d', d));
            const circle = dom.querySelectorAll('.bend-handle')[handle.index];
            circle?.setAttribute('cx', String(point.x));
            circle?.setAttribute('cy', String(point.y));
        } else if (handle.kind === 'label') {
            dom.querySelector('.transition-label')?.setAttribute('transform', `translate(${dx}, ${dy})`);
        } else if (handle.kind === 'port' && handle.element instanceof IbdPortElement) {
            this.movePort(handle, handle.element, dom, event);
        }
    }

    /**
     * Live feedback while dragging a port: it snaps to the nearest side of its node at the mouse position
     * (its label is hidden meanwhile), its connectors follow.
     */
    private movePort(handle: HandleDrag, port: IbdPortElement, dom: HTMLElement, event: MouseEvent): void {
        const node = port.parent as IbdNodeElement;
        const origin = absolutePosition(node);
        const mouse = toModel(port.root, event);
        const size = port.size.width;
        const placement = borderPlacement({ ...origin, width: node.size.width, height: node.size.height }, mouse, size);
        handle.placement = placement;
        const relative = placement.side === 'WEST' ? { x: -size / 2, y: placement.offset - size / 2 }
            : placement.side === 'EAST' ? { x: node.size.width - size / 2, y: placement.offset - size / 2 }
                : placement.side === 'NORTH' ? { x: placement.offset - size / 2, y: -size / 2 }
                    : { x: placement.offset - size / 2, y: node.size.height - size / 2 };
        dom.setAttribute('transform', `translate(${relative.x}, ${relative.y})`);
        dom.querySelector('.ibd-port-label')?.setAttribute('visibility', 'hidden');
        const start = this.startPositions;
        if (start) {
            const position = { x: origin.x + relative.x, y: origin.y + relative.y };
            for (const element of port.root.index.all()) {
                if (element instanceof IbdConnectorElement && (element.sourceId === port.id || element.targetId === port.id)) {
                    this.updateConnector(element, start, { port, side: placement.side, position });
                }
            }
        }
    }

    override mouseUp(target: SModelElementImpl, event: MouseEvent): Action[] {
        this.callbacks.mouseUp?.(target, event);
        const handle = this.handle;
        this.handle = undefined;
        if (handle) {
            this.endHandleDrag(handle, event);
            return [];
        }
        const drag = this.drag;
        this.drag = undefined;
        this.startPositions = undefined;
        this.restoreEdges();
        if (drag?.moved) {
            this.callbacks.dragEnd(drag.id, this.findDropTarget(event, drag.id, target.root), {
                shiftKey: event.shiftKey,
                moved: this.movedVertices(target.root, drag.id)
            });
        }
        return [];
    }

    private endHandleDrag(handle: HandleDrag, event: MouseEvent): void {
        const dx = (event.clientX - handle.startX) / handle.zoom;
        const dy = (event.clientY - handle.startY) / handle.zoom;
        if (!handle.moved) {
            return;
        }
        // undo the live feedback: the diagram update only patches attributes which changed in the model
        const start = { ...handle, startX: event.clientX, startY: event.clientY };
        this.moveHandle(start, event);
        this.restoreEdges();
        if (handle.kind === 'bend' && isLayoutEdge(handle.element)) {
            const d = edgePath(handle.element);
            document.getElementById(`${this.viewerOptions.baseDiv}_${handle.id}`)?.querySelectorAll(EDGE_PATHS)
                .forEach(path => path.setAttribute('d', d));
        }
        if (handle.kind === 'port' && handle.element instanceof IbdPortElement) {
            const dom = document.getElementById(`${this.viewerOptions.baseDiv}_${handle.id}`);
            dom?.setAttribute('transform', `translate(${handle.element.position.x}, ${handle.element.position.y})`);
            dom?.querySelector('.ibd-port-label')?.removeAttribute('visibility');
            this.startPositions = undefined;
        }
        if (handle.kind === 'label') {
            document.getElementById(`${this.viewerOptions.baseDiv}_${handle.id}`)?.querySelector('.transition-label')?.removeAttribute('transform');
        }
        if (handle.kind === 'resize' && isLayoutNode(handle.element)) {
            this.callbacks.resizeEnd(handle.id, Math.max(20, handle.element.size.width + dx), Math.max(20, handle.element.size.height + dy));
        } else if (handle.kind === 'port' && handle.placement) {
            this.callbacks.portMoved?.(handle.id, handle.placement.side, handle.placement.offset);
        } else if (handle.kind === 'bend' && isLayoutEdge(handle.element)) {
            const point = handle.element.waypoints[handle.index];
            if (point) {
                this.callbacks.bendMoved(handle.id, handle.index, { x: point.x + dx, y: point.y + dy });
            }
        } else if (handle.kind === 'label') {
            this.callbacks.labelMoved(handle.id, dx, dy);
        }
    }

    /** The selected nodes (without the ones inside other selected nodes) and the dragged node. */
    private movedVertices(root: SModelRootImpl, draggedId: string): MovedVertex[] {
        const selected = new Set<LayoutNode>();
        for (const element of root.index.all()) {
            if (isLayoutNode(element) && (element.selected || element.id === draggedId) && !(isVertexNode(element) && element.kind === 'region')) {
                selected.add(element);
            }
        }
        const result: MovedVertex[] = [];
        for (const vertex of selected) {
            let parent: SModelElementImpl | undefined = vertex.parent;
            let nested = false;
            while (parent && isLayoutNode(parent)) {
                nested ||= selected.has(parent);
                parent = parent.parent;
            }
            if (!nested) {
                const absolute = absolutePosition(vertex);
                result.push({ id: vertex.id, x: vertex.position.x, y: vertex.position.y, absoluteX: absolute.x, absoluteY: absolute.y });
            }
        }
        return result;
    }

    override doubleClick(target: SModelElementImpl, event: MouseEvent): Action[] {
        if (this.callbacks.canEdit() && isLayoutEdge(target) && target.editable && event.target instanceof Element) {
            // manual layout: double-click on the line adds a waypoint, on a waypoint removes it
            const handle = event.target.closest('.bend-handle');
            if (handle) {
                this.callbacks.bendRemoved(target.id, Array.from(handle.parentElement?.children ?? []).indexOf(handle));
                return [];
            }
            if (event.target.closest(EDGE_PATHS)) {
                this.callbacks.bendAdded(target.id, toModel(target.root, event));
                return [];
            }
        }
        this.callbacks.doubleClick(target, event);
        return [];
    }

    /** Finds the innermost state, region or the canvas below the mouse, ignoring the dragged element. */
    protected findDropTarget(event: MouseEvent, draggedId: string, root: SModelRootImpl): string | undefined {
        const prefix = this.viewerOptions.baseDiv + '_';
        const dragged = root.index.getById(draggedId);
        for (const domElement of document.elementsFromPoint(event.clientX, event.clientY)) {
            let current: Element | null = domElement;
            while (current && !(current.id && current.id.startsWith(prefix))) {
                current = current.parentElement;
            }
            if (!current) {
                continue;
            }
            const id = current.id.substring(prefix.length);
            const element = root.index.getById(id);
            if (!element || isWithin(element, dragged)) {
                continue;
            }
            if (element === root) {
                return root.id;
            }
            if (isVertexNode(element) && (element.kind === 'state' || element.kind === 'region')) {
                return element.id;
            }
            if (element instanceof IbdNodeElement && (element.kind === 'thread' || element.kind === 'frame')) {
                return element.id;
            }
        }
        return undefined;
    }
}

function isWithin(element: SModelElementImpl, ancestor: SModelElementImpl | undefined): boolean {
    let current: SModelElementImpl | undefined = element;
    while (current) {
        if (current === ancestor) {
            return true;
        }
        current = 'parent' in current ? (current as { parent?: SModelElementImpl }).parent : undefined;
    }
    return false;
}

/**
 * Moving elements is disabled while the diagram cannot be edited (simulation); handles (resize, waypoints)
 * are dragged by the `HsmMouseListener`.
 */
@injectable()
export class HsmMoveMouseListener extends MoveMouseListener {

    @inject(DiagramCallbacks) protected callbacks!: DiagramCallbacks;

    override mouseDown(target: SModelElementImpl, event: MouseEvent): (Action | Promise<Action>)[] {
        if (!this.callbacks.canEdit() || startsHandleDrag(target, event) || (this.callbacks.canMove && !this.callbacks.canMove(target))) {
            this.startDragPosition = undefined;
            this.hasDragged = false;
            return [];
        }
        return super.mouseDown(target, event);
    }

    /**
     * Without Sprotty's final move to the drop position: the application updates the diagram on drop
     * (the position may differ from the drop position, e.g. it is kept inside the canvas); the final move
     * could be applied after that update and leave the vertex where it was dropped.
     */
    override mouseUp(target: SModelElementImpl, event: MouseEvent): (Action | Promise<Action>)[] {
        return super.mouseUp(target, event).filter(action => action instanceof Promise || action.kind !== MoveAction.KIND);
    }
}

/** Dragging a handle must not scroll the diagram. */
@injectable()
export class HsmScrollMouseListener extends ScrollMouseListener {

    @inject(DiagramCallbacks) protected callbacks!: DiagramCallbacks;

    override mouseDown(target: SModelElementImpl, event: MouseEvent): (Action | Promise<Action>)[] {
        if (this.callbacks.canEdit() && startsHandleDrag(target, event)) {
            this.lastScrollPosition = undefined;
            this.scrollbar = undefined;
            return [];
        }
        return super.mouseDown(target, event);
    }
}

/** Selection without re-ordering the selected element (transitions have to stay on top). */
@injectable()
export class HsmSelectMouseListener extends SelectMouseListener {
    protected override handleSelectTarget(selectableTarget: SModelElementImpl & { selected: boolean }, deselectedElements: SModelElementImpl[], event: MouseEvent): (Action | Promise<Action>)[] {
        return super.handleSelectTarget(selectableTarget as never, deselectedElements, event)
            .filter(action => !('kind' in action) || action.kind !== BringToFrontAction.KIND);
    }
}

/** Informs the application about selection changes. */
@injectable()
export class SelectionTracker implements IActionHandler {

    @inject(DiagramCallbacks) protected callbacks!: DiagramCallbacks;

    handle(action: Action): void {
        if (action.kind === SelectAction.KIND) {
            const select = action as SelectAction;
            this.callbacks.selectionChanged(select.selectedElementsIDs, select.deselectedElementsIDs);
        } else if (action.kind === SelectAllAction.KIND) {
            this.callbacks.allSelected((action as SelectAllAction).select);
        }
    }
}
