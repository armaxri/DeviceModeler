import { inject, injectable } from 'inversify';
import {
    MouseListener, MoveMouseListener, ScrollMouseListener, SelectMouseListener, TYPES, findParentByFeature, isMoveable,
    type IActionHandler, type SModelElementImpl, type SModelRootImpl, type ViewerOptions
} from 'sprotty';
import { BringToFrontAction, SelectAction, SelectAllAction, type Action } from 'sprotty-protocol';
import { borderPoint, type Point } from 'hsm-language';
import { isTransitionEdge, isVertexNode, type TransitionEdge, type VertexNode } from './model.js';
import { arrowHead, routePath } from './views.js';

/** Position of a vertex after it was dragged (relative to its parent and absolute). */
export interface MovedVertex {
    id: string;
    x: number;
    y: number;
    absoluteX: number;
    absoluteY: number;
}

export interface DragInfo {
    /** Shift was held when the vertex was dropped (manual layout: move it into the state below the mouse). */
    shiftKey: boolean;
    /** All vertices moved by the drag (the selection). */
    moved: MovedVertex[];
}

/** Callbacks from the diagram into the application. */
export interface DiagramCallbacks {
    /** A mouse button was pressed on a diagram element (or the canvas, i.e. the root). */
    mouseDown(target: SModelElementImpl, event: MouseEvent): void;
    doubleClick(target: SModelElementImpl, event: MouseEvent): void;
    /** A vertex was dragged and dropped onto the given container element (undefined: no valid drop target). */
    dragEnd(draggedId: string, dropTargetId: string | undefined, info: DragInfo): void;
    selectionChanged(selected: string[], deselected: string[]): void;
    allSelected(select: boolean): void;
    /** Whether the diagram can be edited (not while simulating). */
    canEdit(): boolean;
    /** Whether the manual layout mode is active (nodes keep the position they are dragged to). */
    isManualLayout(): boolean;
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
}

export const DiagramCallbacks = Symbol('DiagramCallbacks');

/** Kinds of vertices which can only be moved in the manual layout mode (they cannot be nested elsewhere). */
const LAYOUT_ONLY_KINDS = ['initial', 'final', 'definition'];

/** Vertices which can be dragged into other states (or moved in the manual layout mode). */
function movableVertex(target: SModelElementImpl, manual: boolean): VertexNode | undefined {
    let current: SModelElementImpl | undefined = target;
    while (current && !isVertexNode(current)) {
        current = 'parent' in current ? (current as { parent?: SModelElementImpl }).parent : undefined;
    }
    if (current && isVertexNode(current) && current.kind !== 'region' && (manual || !LAYOUT_ONLY_KINDS.includes(current.kind))) {
        return current;
    }
    return undefined;
}

/** The DOM element of a handle (resize handle, bend point) the event started on. */
function handleElement(event: MouseEvent): Element | undefined {
    const target = event.target;
    return target instanceof Element ? target.closest('.resize-handle, .bend-handle') ?? undefined : undefined;
}

/** Whether the mouse down starts dragging a handle or the label of a selected transition (manual layout). */
function startsHandleDrag(target: SModelElementImpl, event: MouseEvent): boolean {
    return handleElement(event) !== undefined
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

function absolutePosition(element: VertexNode): Point {
    let x = 0;
    let y = 0;
    let current: SModelElementImpl | undefined = element;
    while (current && isVertexNode(current)) {
        x += current.position.x;
        y += current.position.y;
        current = current.parent;
    }
    return { x, y };
}

interface HandleDrag {
    kind: 'resize' | 'bend' | 'label';
    id: string;
    startX: number;
    startY: number;
    zoom: number;
    index: number;
    moved: boolean;
    element: VertexNode | TransitionEdge;
}

@injectable()
export class HsmMouseListener extends MouseListener {

    @inject(DiagramCallbacks) protected callbacks!: DiagramCallbacks;
    @inject(TYPES.ViewerOptions) protected viewerOptions!: ViewerOptions;

    private drag?: { id: string, x: number, y: number, moved: boolean };
    private handle?: HandleDrag;
    /** Absolute positions of all vertices when the current drag started (live update of the transitions). */
    private startPositions?: Map<string, Point>;
    private edgeFrame?: number;
    /** Transitions whose DOM was changed while dragging (restored on drop, before the diagram is updated). */
    private readonly changedEdges = new Set<TransitionEdge>();

    override mouseDown(target: SModelElementImpl, event: MouseEvent): Action[] {
        this.callbacks.mouseDown(target, event);
        this.drag = undefined;
        this.handle = undefined;
        const editable = this.callbacks.canEdit();
        const manual = editable && this.callbacks.isManualLayout();
        if (event.button !== 0 || !editable) {
            return [];
        }
        if (manual && this.startHandleDrag(target, event)) {
            return [];
        }
        const vertex = movableVertex(target, manual);
        this.drag = vertex ? { id: vertex.id, x: event.clientX, y: event.clientY, moved: false } : undefined;
        this.startPositions = undefined;
        if (vertex && manual) {
            this.startPositions = new Map();
            for (const element of target.root.index.all()) {
                if (isVertexNode(element)) {
                    this.startPositions.set(element.id, absolutePosition(element));
                }
            }
        }
        return [];
    }

    /** Resize handles of states, bend points and labels of selected transitions (manual layout). */
    private startHandleDrag(target: SModelElementImpl, event: MouseEvent): boolean {
        const handle = handleElement(event);
        const base = { startX: event.clientX, startY: event.clientY, zoom: zoomOf(target.root), moved: false };
        if (handle?.classList.contains('resize-handle')) {
            const vertex = movableVertex(target, true);
            if (vertex) {
                this.handle = { ...base, kind: 'resize', id: vertex.id, index: 0, element: vertex };
                return true;
            }
        }
        const edge = isTransitionEdge(target) ? target : undefined;
        if (edge && handle?.classList.contains('bend-handle')) {
            const index = Array.from(handle.parentElement?.children ?? []).indexOf(handle);
            this.handle = { ...base, kind: 'bend', id: edge.id, index, element: edge };
            return true;
        }
        if (edge && startsHandleDrag(target, event)) {
            this.handle = { ...base, kind: 'label', id: edge.id, index: 0, element: edge };
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
     * Manual layout: while vertices are dragged, the transitions attached to them follow as straight
     * lines (transitions inside a dragged vertex are moved with it). The DOM is changed directly; the
     * routes are computed properly when the vertices are dropped.
     */
    private updateAttachedEdges(root: SModelRootImpl): void {
        const start = this.startPositions;
        if (!start || !this.drag) {
            return;
        }
        const rect = (vertex: VertexNode) => ({ ...absolutePosition(vertex), width: vertex.size.width, height: vertex.size.height });
        for (const element of root.index.all()) {
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
            let points: Point[];
            if (Math.hypot(ds.x - dt.x, ds.y - dt.y) < 0.5) {
                points = element.points.map(p => ({ x: p.x + ds.x, y: p.y + ds.y }));
            } else {
                const sc = { x: s.x + s.width / 2, y: s.y + s.height / 2 };
                const tc = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
                points = [borderPoint(s, source.kind, tc), borderPoint(t, target.kind, sc)];
            }
            const dom = document.getElementById(`${this.viewerOptions.baseDiv}_${element.id}`);
            if (!dom) {
                continue;
            }
            const d = routePath(points, element.routing === 'spline' && points.length === element.points.length);
            dom.querySelectorAll('.transition-line, .transition-hit').forEach(path => path.setAttribute('d', d));
            dom.querySelector('.transition-arrow')?.setAttribute('d', arrowHead(points[points.length - 2], points[points.length - 1]));
            dom.querySelector('.transition-label')?.setAttribute('visibility', 'hidden');
            this.changedEdges.add(element);
        }
    }

    /** Restores the DOM of the transitions changed while dragging (the diagram update only patches changed attributes). */
    private restoreEdges(): void {
        if (this.edgeFrame !== undefined) {
            cancelAnimationFrame(this.edgeFrame);
            this.edgeFrame = undefined;
        }
        for (const edge of this.changedEdges) {
            const dom = document.getElementById(`${this.viewerOptions.baseDiv}_${edge.id}`);
            const d = routePath(edge.points, edge.routing === 'spline');
            dom?.querySelectorAll('.transition-line, .transition-hit').forEach(path => path.setAttribute('d', d));
            dom?.querySelector('.transition-arrow')?.setAttribute('d', arrowHead(edge.points[edge.points.length - 2], edge.points[edge.points.length - 1]));
            dom?.querySelector('.transition-label')?.removeAttribute('visibility');
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
        if (handle.kind === 'resize' && isVertexNode(handle.element)) {
            const { width, height } = handle.element.size;
            const w = Math.max(20, width + dx);
            const h = Math.max(20, height + dy);
            dom.querySelector(':scope > .state-shape')?.setAttribute('width', String(w));
            dom.querySelector(':scope > .state-shape')?.setAttribute('height', String(h));
            dom.querySelector(':scope > .state-separator')?.setAttribute('x2', String(w));
            const grip = dom.querySelector(':scope > .resize-handle');
            grip?.setAttribute('x', String(w - 9));
            grip?.setAttribute('y', String(h - 9));
        } else if (handle.kind === 'bend' && isTransitionEdge(handle.element)) {
            const points = handle.element.points.map(p => ({ ...p }));
            const point = points[handle.index + 1];
            if (!point) {
                return;
            }
            point.x += dx;
            point.y += dy;
            const d = routePath(points, false);
            dom.querySelectorAll('.transition-line, .transition-hit').forEach(path => path.setAttribute('d', d));
            const circle = dom.querySelectorAll('.bend-handle')[handle.index];
            circle?.setAttribute('cx', String(point.x));
            circle?.setAttribute('cy', String(point.y));
        } else if (handle.kind === 'label') {
            dom.querySelector('.transition-label')?.setAttribute('transform', `translate(${dx}, ${dy})`);
        }
    }

    override mouseUp(target: SModelElementImpl, event: MouseEvent): Action[] {
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
        if (handle.kind === 'label') {
            document.getElementById(`${this.viewerOptions.baseDiv}_${handle.id}`)?.querySelector('.transition-label')?.removeAttribute('transform');
        }
        if (handle.kind === 'resize' && isVertexNode(handle.element)) {
            this.callbacks.resizeEnd(handle.id, Math.max(20, handle.element.size.width + dx), Math.max(20, handle.element.size.height + dy));
        } else if (handle.kind === 'bend' && isTransitionEdge(handle.element)) {
            const point = handle.element.points[handle.index + 1];
            if (point) {
                this.callbacks.bendMoved(handle.id, handle.index, { x: point.x + dx, y: point.y + dy });
            }
        } else if (handle.kind === 'label') {
            this.callbacks.labelMoved(handle.id, dx, dy);
        }
    }

    /** The selected vertices (without the ones inside other selected vertices) and the dragged vertex. */
    private movedVertices(root: SModelRootImpl, draggedId: string): MovedVertex[] {
        const selected = new Set<VertexNode>();
        for (const element of root.index.all()) {
            if (isVertexNode(element) && (element.selected || element.id === draggedId) && element.kind !== 'region') {
                selected.add(element);
            }
        }
        const result: MovedVertex[] = [];
        for (const vertex of selected) {
            let parent: SModelElementImpl | undefined = vertex.parent;
            let nested = false;
            while (parent && isVertexNode(parent)) {
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
        if (this.callbacks.canEdit() && this.callbacks.isManualLayout() && isTransitionEdge(target) && event.target instanceof Element) {
            // manual layout: double-click on the line adds a bend point, on a bend point removes it
            const handle = event.target.closest('.bend-handle');
            if (handle) {
                this.callbacks.bendRemoved(target.id, Array.from(handle.parentElement?.children ?? []).indexOf(handle));
                return [];
            }
            if (event.target.closest('.transition-hit, .transition-line')) {
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
 * Moving elements is disabled while the diagram cannot be edited (simulation). Initial and final states
 * and the definition section can only be moved in the manual layout mode; handles (resize, bend points)
 * are dragged by the `HsmMouseListener`.
 */
@injectable()
export class HsmMoveMouseListener extends MoveMouseListener {

    @inject(DiagramCallbacks) protected callbacks!: DiagramCallbacks;

    override mouseDown(target: SModelElementImpl, event: MouseEvent): (Action | Promise<Action>)[] {
        const moveable = findParentByFeature(target, isMoveable);
        const layoutOnly = isVertexNode(moveable) && LAYOUT_ONLY_KINDS.includes(moveable.kind);
        if (!this.callbacks.canEdit() || handleElement(event) || (layoutOnly && !this.callbacks.isManualLayout())) {
            this.startDragPosition = undefined;
            this.hasDragged = false;
            return [];
        }
        return super.mouseDown(target, event);
    }
}

/** Dragging a handle must not scroll the diagram. */
@injectable()
export class HsmScrollMouseListener extends ScrollMouseListener {

    @inject(DiagramCallbacks) protected callbacks!: DiagramCallbacks;

    override mouseDown(target: SModelElementImpl, event: MouseEvent): (Action | Promise<Action>)[] {
        if (this.callbacks.isManualLayout() && startsHandleDrag(target, event)) {
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
