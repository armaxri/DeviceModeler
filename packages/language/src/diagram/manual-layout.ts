/**
 * Manual ("hand-arranged") diagram layouts (experimental).
 *
 * A manual layout is stored next to the model in a sidecar file `<model>.devm.layout` (JSON), so the
 * `.devm` text stays free of layout noise. Elements are identified by their diagram ids, which are
 * derived from the model and stable while other elements are added or removed:
 *
 * - vertices: qualified name (`Closed.Active.Playing`)
 * - regions: `<state>#region<n>` (index within the state, starting at 1)
 * - initial / final pseudo states: `<container>#initial`, `<container>#final` (`#machine#initial` on top level)
 * - the definition section: `#definitions`
 * - transitions: `<source>-><target>`, `~<n>` is appended to the n-th duplicate of the same pair
 *
 * The layout is computed on top of the automatic layout: pinned nodes (stored in the layout) keep their
 * position (and their size if they were resized, composite states grow if their content does not fit),
 * nodes without a stored position are placed near their siblings without overlapping them. Transitions
 * keep the route of the automatic layout as long as their end points are arranged like in the automatic
 * layout and no moved vertex lies on the route. Otherwise they are routed around the other vertices in
 * the shape of the edge routing setting; stored bend points are waypoints the route passes through.
 */
import type * as ast from '../generated/ast.js';
import type {
    DiagramEdge, DiagramGraph, DiagramLabel, DiagramNode, DiagramNodeKind, EdgeRouting, LayoutDirection, LayoutOptionsInput, LayoutResult, Point, TextMeasure
} from './diagram-model.js';
import { DiagramMetrics, MACHINE_ID, approximateTextMeasure, layoutStateMachine } from './layout.js';
import { layoutFromModel } from './layout-annotations.js';
import {
    LayoutTree, MANUAL_LAYOUT_VERSION, TOLERANCE, center, cloneLayout, crossesRect, distributePorts, edgeFrameOrigin, insideRect, overlaps, placeChildren, routeThroughWaypoints,
    type BaseEdgeLayout, type BaseManualLayout, type BaseNodeLayout, type LayoutMode, type OrthogonalRoute, type Rect
} from './layout-core/index.js';

/** File name extension of layout sidecar files (`model.devm` -> `model.devm.layout`). */
export const LAYOUT_FILE_EXTENSION = '.layout';

export type RegionOrientation = 'vertical' | 'horizontal';

/** A stored node of a state machine diagram (see {@link BaseNodeLayout}). */
export interface NodeLayout extends BaseNodeLayout {
    /** States with regions: whether the regions are stacked vertically or placed side by side. */
    regions?: RegionOrientation;
}

/** A stored transition: waypoints in the coordinate system of its frame node, the offset of its label. */
export type EdgeLayout = BaseEdgeLayout;

/** The manual layout of a state machine diagram (the shared data model with {@link NodeLayout}s). */
export type ManualLayout = BaseManualLayout<NodeLayout, EdgeLayout>;

/** Vertices whose border is not straight: the routes end in the middle of the side. */
export const POINT_PORT_KINDS: ReadonlySet<DiagramNodeKind> = new Set<DiagramNodeKind>(['initial', 'final', 'choice', 'junction', 'history', 'deephistory', 'entry', 'exit']);

export interface ManualLayoutResult extends LayoutResult {
    /**
     * The effective layout: all nodes pinned at their computed positions (stored sizes, bend points and
     * label offsets kept). Changes made in the diagram are applied to this layout.
     */
    effective?: ManualLayout;
}

export function createManualLayout(mode: LayoutMode = 'manual', direction?: LayoutDirection): ManualLayout {
    return { version: MANUAL_LAYOUT_VERSION, mode, ...(direction ? { direction } : {}), nodes: {}, edges: {} };
}

export function isManualLayout(layout: ManualLayout | undefined): layout is ManualLayout {
    return layout?.mode === 'manual';
}

/** `model.devm` -> `model.devm.layout` */
export function layoutFileName(modelFile: string): string {
    return modelFile + LAYOUT_FILE_EXTENSION;
}

// ---------------------------------------------------------------------------------------------
// Persistence

export class ManualLayoutError extends Error { }

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function parsePoint(value: unknown, what: string): Point {
    const point = value as Partial<Point> | null;
    if (typeof point !== 'object' || point === null || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
        throw new ManualLayoutError(`${what}: {x, y} expected`);
    }
    return { x: point.x, y: point.y };
}

/** Parses and validates the content of a `.devm.layout` file. */
export function parseManualLayout(text: string): ManualLayout {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (error) {
        throw new ManualLayoutError(`Invalid layout file: ${error instanceof Error ? error.message : String(error)}`);
    }
    const data = json as Partial<Record<keyof ManualLayout, unknown>> | null;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new ManualLayoutError('Invalid layout file: object expected');
    }
    if (data.version !== MANUAL_LAYOUT_VERSION) {
        throw new ManualLayoutError(`Unsupported layout file version ${String(data.version)} (expected ${MANUAL_LAYOUT_VERSION})`);
    }
    const layout = createManualLayout(data.mode === 'auto' ? 'auto' : 'manual',
        data.direction === 'DOWN' || data.direction === 'RIGHT' ? data.direction : undefined);
    for (const [id, value] of Object.entries(asRecord(data.nodes))) {
        const node = value as Partial<Record<keyof NodeLayout, unknown>>;
        const { x, y } = parsePoint(node, `node '${id}'`);
        const entry: NodeLayout = { x, y };
        if (isFiniteNumber(node.width) && node.width > 0) {
            entry.width = node.width;
        }
        if (isFiniteNumber(node.height) && node.height > 0) {
            entry.height = node.height;
        }
        if (node.regions === 'vertical' || node.regions === 'horizontal') {
            entry.regions = node.regions;
        }
        layout.nodes[id] = entry;
    }
    for (const [id, value] of Object.entries(asRecord(data.edges))) {
        const edge = value as Partial<Record<keyof EdgeLayout, unknown>>;
        const entry: EdgeLayout = {};
        if (Array.isArray(edge?.bends) && edge.bends.length > 0) {
            entry.bends = edge.bends.map((p, i) => parsePoint(p, `bend point ${i} of '${id}'`));
        }
        if (edge?.label !== undefined) {
            entry.label = parsePoint(edge.label, `label offset of '${id}'`);
        }
        if (entry.bends || entry.label) {
            layout.edges[id] = entry;
        }
    }
    return layout;
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Serializes a layout as JSON with sorted keys and rounded coordinates (stable diffs). */
export function serializeManualLayout(layout: ManualLayout): string {
    const nodes: Record<string, NodeLayout> = {};
    for (const id of Object.keys(layout.nodes).sort()) {
        const node = layout.nodes[id];
        nodes[id] = {
            x: round(node.x), y: round(node.y),
            ...(node.width !== undefined ? { width: round(node.width) } : {}),
            ...(node.height !== undefined ? { height: round(node.height) } : {}),
            ...(node.regions ? { regions: node.regions } : {})
        };
    }
    const edges: Record<string, EdgeLayout> = {};
    for (const id of Object.keys(layout.edges).sort()) {
        const edge = layout.edges[id];
        const entry: EdgeLayout = {};
        if (edge.bends?.length) {
            entry.bends = edge.bends.map(p => ({ x: round(p.x), y: round(p.y) }));
        }
        if (edge.label) {
            entry.label = { x: round(edge.label.x), y: round(edge.label.y) };
        }
        if (entry.bends || entry.label) {
            edges[id] = entry;
        }
    }
    const result: ManualLayout = {
        version: MANUAL_LAYOUT_VERSION,
        mode: layout.mode,
        ...(layout.direction ? { direction: layout.direction } : {}),
        nodes,
        edges
    };
    return JSON.stringify(result, undefined, 2) + '\n';
}

export function cloneManualLayout(layout: ManualLayout): ManualLayout {
    return cloneLayout(layout);
}

// ---------------------------------------------------------------------------------------------
// Keys

/** Splits a transition id `source->target~n` into its end points. */
export function edgeEndpoints(edgeId: string): { source: string, target: string, suffix: string } | undefined {
    const arrow = edgeId.indexOf('->');
    if (arrow < 0) {
        return undefined;
    }
    const rest = edgeId.substring(arrow + 2);
    const match = /^(.*?)(~\d+)?$/.exec(rest)!;
    return { source: edgeId.substring(0, arrow), target: match[1], suffix: match[2] ?? '' };
}

/** Whether `id` denotes the element `base` or an element contained in it (sub states, regions, initial / final nodes). */
export function isWithinElement(id: string, base: string): boolean {
    return id === base || id.startsWith(base + '.') || id.startsWith(base + '#');
}

function renameId(id: string, oldId: string, newId: string): string {
    return isWithinElement(id, oldId) ? newId + id.substring(oldId.length) : id;
}

/**
 * Renames the element `oldId` and everything contained in it (keys of sub states, regions and
 * transitions) after a vertex was renamed or moved into another container. Returns a new layout.
 */
export function renameLayoutElement(layout: ManualLayout, oldId: string, newId: string): ManualLayout {
    if (oldId === newId) {
        return layout;
    }
    const result: ManualLayout = { ...layout, nodes: {}, edges: {} };
    for (const [id, node] of Object.entries(layout.nodes)) {
        if (!isWithinElement(id, newId) || isWithinElement(id, oldId)) {
            result.nodes[renameId(id, oldId, newId)] = node;
        }
    }
    for (const [id, edge] of Object.entries(layout.edges)) {
        const ends = edgeEndpoints(id);
        const renamed = ends ? `${renameId(ends.source, oldId, newId)}->${renameId(ends.target, oldId, newId)}${ends.suffix}` : id;
        result.edges[renamed] = edge;
    }
    return result;
}

/**
 * Removes the elements (and everything contained in them) and all transitions from or to them.
 * Regions of a state which follow a removed region are renumbered. Returns a new layout.
 */
export function removeLayoutElements(layout: ManualLayout, ids: Iterable<string>): ManualLayout {
    let result: ManualLayout = { ...layout, nodes: { ...layout.nodes }, edges: { ...layout.edges } };
    for (const removed of ids) {
        for (const id of Object.keys(result.nodes)) {
            if (isWithinElement(id, removed)) {
                delete result.nodes[id];
            }
        }
        for (const id of Object.keys(result.edges)) {
            const ends = edgeEndpoints(id);
            if (id === removed || (ends && (isWithinElement(ends.source, removed) || isWithinElement(ends.target, removed)))) {
                delete result.edges[id];
            }
        }
        const region = /^(.*)#region(\d+)$/.exec(removed);
        if (region) {
            // the following regions move up
            const state = region[1];
            const index = Number(region[2]);
            const count = Math.max(0, ...Object.keys(result.nodes).map(id => {
                const match = id.startsWith(state + '#region') ? /^#region(\d+)/.exec(id.substring(state.length)) : null;
                return match ? Number(match[1]) : 0;
            }));
            for (let i = index + 1; i <= count; i++) {
                result = renameLayoutElement(result, `${state}#region${i}`, `${state}#region${i - 1}`);
            }
        }
    }
    return result;
}

// ---------------------------------------------------------------------------------------------
// Capture

function forEachNode(nodes: DiagramNode[], visit: (node: DiagramNode, parent: DiagramNode | undefined) => void, parent?: DiagramNode): void {
    for (const node of nodes) {
        visit(node, parent);
        forEachNode(node.children, visit, node);
    }
}

/**
 * Pins all nodes of a computed diagram at their current positions ("auto-arrange": the automatic
 * layout becomes the manual layout). The sizes of regions are stored as well (regions are stacked in
 * their state, their size is the minimum size), all other sizes follow the content.
 */
export function captureLayout(graph: DiagramGraph, direction?: LayoutDirection): ManualLayout {
    const layout = createManualLayout('manual', direction ?? graph.direction);
    forEachNode(graph.children, node => {
        layout.nodes[node.id] = node.kind === 'region'
            ? { x: node.x, y: node.y, width: node.width, height: node.height }
            : { x: node.x, y: node.y };
    });
    return layout;
}

// ---------------------------------------------------------------------------------------------
// Layout computation

/** Top of the content area of a state: below the name and the body compartment. */
function stateContentTop(node: DiagramNode): number {
    const m = DiagramMetrics;
    const body = node.body?.length ?? 0;
    return (node.headerHeight ?? m.headerHeight) + (body > 0 ? body * m.lineHeight.body + 2 * m.bodyPadding : 0);
}

/**
 * The top left corner of the area in which the children of a node may be placed (relative to the
 * node): below the name and body of a composite state, below the name of a region, (0, 0) on the canvas.
 */
export function contentOrigin(node: DiagramNode | undefined): Point {
    const m = DiagramMetrics;
    if (!node) {
        return { x: 0, y: 0 };
    }
    if (node.kind === 'region') {
        return { x: m.regionPadding, y: m.regionPadding + (node.name ? m.lineHeight.body : 0) };
    }
    return { x: m.compositePadding, y: stateContentTop(node) + m.compositePadding };
}

export interface ManualLayoutOptions {
    direction?: LayoutDirection;
    measure?: TextMeasure;
    /** Shape of the rerouted transitions (default: splines, like the automatic layout). */
    routing?: EdgeRouting;
}

/**
 * Computes the diagram of a state machine: the automatic layout, adjusted by the manual layout. The manual
 * layout is the one described by the layout annotations of the model ({@link layoutFromModel}) unless
 * another one is given; `null` (or a layout whose mode is `auto`) means the automatic layout. Without a
 * manual layout the result is exactly the automatic layout.
 */
export async function layoutStateMachineWithLayout(machine: ast.StateMachine, options: LayoutOptionsInput = {}, layout?: ManualLayout | null): Promise<ManualLayoutResult> {
    const auto = await layoutStateMachine(machine, options);
    if (layout === undefined) {
        layout = layoutFromModel(machine);
    }
    if (!isManualLayout(layout ?? undefined)) {
        return auto;
    }
    return applyManualLayout(auto, layout!, { direction: options.direction, measure: options.measure, routing: options.routing });
}

/** Applies a manual layout to the result of the automatic layout (which is not modified). */
export function applyManualLayout(auto: LayoutResult, layout: ManualLayout, options: ManualLayoutOptions = {}): ManualLayoutResult {
    return new ManualLayoutEngine(auto.graph, layout, {
        direction: layout.direction ?? options.direction ?? auto.graph.direction,
        measure: options.measure ?? approximateTextMeasure,
        routing: options.routing ?? 'SPLINES'
    }).run(auto);
}

const ROOT_PADDING = 20;
const NODE_SPACING = 30;
const ROUND_KINDS: ReadonlySet<DiagramNodeKind> = new Set<DiagramNodeKind>(['initial', 'final', 'junction', 'history', 'deephistory', 'entry', 'exit']);

class ManualLayoutEngine {

    /** The cloned diagram nodes (modified in place) and their hierarchy. */
    private readonly tree: LayoutTree<DiagramNode>;
    private readonly nodes: Map<string, DiagramNode>;
    /** Absolute bounds of the nodes in the automatic layout. */
    private readonly autoBounds: Map<string, Rect>;
    /** Relative position of the nodes in the automatic layout. */
    private readonly autoPositions = new Map<string, Point>();
    private readonly root: DiagramNode;
    private readonly edges: DiagramEdge[];
    private readonly autoEdges = new Map<string, DiagramEdge>();
    /** frame node id -> edges routed in its coordinate system */
    private readonly framedEdges = new Map<string, DiagramEdge[]>();
    private readonly frames = new Map<string, string>();
    /** Uniform shift of the content of a container (keeps it below the header of the state). */
    private readonly shifts = new Map<string, Point>();
    /** Edge routes relative to their frame node. */
    private readonly localRoutes = new Map<string, { points: Point[], label?: DiagramLabel, waypoints?: Point[] }>();

    constructor(graph: DiagramGraph, private readonly layout: ManualLayout, private readonly options: Required<ManualLayoutOptions>) {
        const clone = (node: DiagramNode): DiagramNode => ({
            ...node,
            label: node.label ? { ...node.label } : undefined,
            children: node.children.map(clone)
        });
        this.root = { id: MACHINE_ID, kind: 'state', x: 0, y: 0, width: graph.width, height: graph.height, children: graph.children.map(clone) };
        this.tree = new LayoutTree<DiagramNode>(this.root, node => node.children);
        this.nodes = this.tree.nodes;
        this.autoBounds = this.tree.absoluteBounds();
        for (const [id, node] of this.nodes) {
            this.autoPositions.set(id, { x: node.x, y: node.y });
        }
        this.edges = graph.edges.map(edge => {
            this.autoEdges.set(edge.id, edge);
            return { ...edge, points: edge.points.map(p => ({ ...p })), label: edge.label ? { ...edge.label } : undefined };
        });
        for (const edge of this.edges) {
            const frame = this.edgeFrame(edge);
            this.frames.set(edge.id, frame);
            const list = this.framedEdges.get(frame) ?? [];
            list.push(edge);
            this.framedEdges.set(frame, list);
        }
    }

    run(auto: LayoutResult): ManualLayoutResult {
        const extent = this.layoutContent(this.root, this.root.children, 0, 0);
        // absolute routes
        for (const edge of this.edges) {
            const route = this.localRoutes.get(edge.id);
            if (!route) {
                continue;
            }
            const origin = this.absolutePosition(this.frames.get(edge.id)!);
            edge.points = route.points.map(p => ({ x: p.x + origin.x, y: p.y + origin.y }));
            if (route.waypoints) {
                edge.waypoints = route.waypoints.map(p => ({ x: p.x + origin.x, y: p.y + origin.y }));
            }
            if (edge.label && route.label) {
                edge.label = { ...route.label, x: route.label.x + origin.x, y: route.label.y + origin.y };
            }
        }
        const graph: DiagramGraph = {
            ...auto.graph,
            width: Math.max(extent.x, 0) + ROOT_PADDING,
            height: Math.max(extent.y, 0) + ROOT_PADDING,
            children: this.root.children,
            edges: this.edges
        };
        return { graph, elements: auto.elements, ids: auto.ids, effective: this.effectiveLayout() };
    }

    // -----------------------------------------------------------------------------------------
    // Structure helpers

    private path(id: string): string[] {
        return this.tree.path(id);
    }

    /**
     * The node in whose coordinate system an edge is routed: the innermost node containing both end
     * points (for a transition between a composite state and its content: the composite state; for a
     * self transition: the parent of the vertex).
     */
    private edgeFrame(edge: DiagramEdge): string {
        return this.tree.frameOf(edge.source, edge.target);
    }

    private absolutePosition(id: string): Point {
        return this.tree.absolutePosition(id);
    }

    /** Bounds of a node relative to the frame node (which must be an ancestor or the node itself). */
    private boundsIn(id: string, frame: string): Rect {
        return this.tree.boundsIn(id, frame);
    }

    private autoBoundsIn(id: string, frame: string): Rect {
        const bounds = this.autoBounds.get(id)!;
        const origin = this.autoBounds.get(frame)!;
        return id === frame ? { ...bounds, x: 0, y: 0 } : { ...bounds, x: bounds.x - origin.x, y: bounds.y - origin.y };
    }

    // -----------------------------------------------------------------------------------------
    // Nodes

    private stored(id: string) {
        return this.layout.nodes[id];
    }

    /** Minimum size of a composite state (text of the name and the body compartment). */
    private compositeMinimum(node: DiagramNode): { width: number, height: number } {
        const m = DiagramMetrics;
        const measure = this.options.measure;
        const body = node.body ?? [];
        const width = Math.max(measure(node.name ?? '', 'name').width + 2 * m.stateHorizontalPadding,
            ...body.map(line => measure(line, 'body').width + 2 * m.bodyPadding + 4), m.stateMinWidth);
        const bodyHeight = body.length > 0 ? body.length * m.lineHeight.body + 2 * m.bodyPadding : m.emptyBodyHeight;
        return { width, height: (node.headerHeight ?? m.headerHeight) + bodyHeight + 30 };
    }

    /** Computes the size of the node and the layout of its content. */
    private layoutNode(node: DiagramNode): void {
        const stored = this.stored(node.id);
        const m = DiagramMetrics;
        const explicit = node.kind === 'state' ? stored : undefined;
        if (node.kind === 'state' && node.regions) {
            this.layoutRegions(node, explicit);
        } else if (node.children.length > 0) {
            const origin = contentOrigin(node);
            const extent = this.layoutContent(node, node.children, origin.x, origin.y);
            const minimum = this.compositeMinimum(node);
            node.width = Math.max(minimum.width, extent.x + m.compositePadding, explicit?.width ?? 0);
            node.height = Math.max(minimum.height, extent.y + m.compositePadding, explicit?.height ?? 0);
        } else {
            // leaf: the size computed by the automatic layout is the size of its text
            node.width = Math.max(node.width, explicit?.width ?? 0);
            node.height = Math.max(node.height, explicit?.height ?? 0);
        }
    }

    private layoutRegions(state: DiagramNode, explicit: NodeLayout | undefined): void {
        const m = DiagramMetrics;
        const regions = state.children.filter(c => c.kind === 'region');
        const orientation = explicit?.regions ?? this.stored(state.id)?.regions ?? (this.options.direction === 'DOWN' ? 'vertical' : 'horizontal');
        for (const region of regions) {
            const origin = contentOrigin(region);
            const extent = this.layoutContent(region, region.children, origin.x, origin.y);
            const size = this.stored(region.id);
            region.width = Math.max(40, extent.x + m.regionPadding, size?.width ?? 0);
            region.height = Math.max(30, extent.y + m.regionPadding, size?.height ?? 0);
            region.separator = orientation === 'vertical' ? 'top' : 'left';
        }
        // the regions start below the header (or where the first region was stored)
        const top = Math.max(stateContentTop(state), regions[0] ? this.stored(regions[0].id)?.y ?? 0 : 0);
        const minimum = this.compositeMinimum(state);
        const vertical = orientation === 'vertical';
        let offset = vertical ? top : 0;
        for (const region of regions) {
            region.x = vertical ? 0 : offset;
            region.y = vertical ? offset : top;
            offset += vertical ? region.height : region.width;
        }
        const cross = Math.max(0, ...regions.map(r => vertical ? r.width : r.height));
        state.width = Math.max(minimum.width, explicit?.width ?? 0, vertical ? cross : offset);
        state.height = Math.max(minimum.height, explicit?.height ?? 0, vertical ? offset : top + cross);
        // regions fill the state, the last one takes the remaining space
        const last = regions[regions.length - 1];
        for (const region of regions) {
            if (vertical) {
                region.width = state.width;
            } else {
                region.height = state.height - top;
            }
        }
        if (last) {
            if (vertical) {
                last.height = state.height - last.y;
            } else {
                last.width = state.width - last.x;
            }
        }
        this.routeEdges(state.id);
    }

    /**
     * Lays out the children of a container (state machine, composite state or region) and routes the
     * edges in its coordinate system. Returns the extent (right / bottom) of the content.
     */
    private layoutContent(owner: DiagramNode, children: DiagramNode[], left: number, top: number): Point {
        for (const child of children) {
            this.layoutNode(child);
        }
        // pinned content must not overlap the header of the state: it is shifted as a whole
        const shift = placeChildren({
            children: children.filter(c => c.kind !== 'region'),
            stored: child => this.stored(child.id),
            auto: child => this.autoPositions.get(child.id)!,
            left, top
        });
        if (shift) {
            this.shifts.set(owner.id, shift);
        }
        if (owner.kind !== 'state' || !owner.regions) {
            this.routeEdges(owner.id);
        }
        let right = 0;
        let bottom = 0;
        for (const child of children) {
            if (child.kind === 'region') {
                continue;
            }
            right = Math.max(right, child.x + child.width + (child.label ? Math.max(0, child.label.x + child.label.width - child.width) : 0));
            bottom = Math.max(bottom, child.y + child.height);
        }
        if (owner.kind !== 'state' || !owner.regions) {
            for (const edge of this.framedEdges.get(owner.id) ?? []) {
                const route = this.localRoutes.get(edge.id);
                if (!route || (owner !== this.root && (edge.source === owner.id || edge.target === owner.id))) {
                    // transitions between a composite state and its content lie within the state anyway
                    continue;
                }
                for (const p of route.points) {
                    right = Math.max(right, p.x);
                    bottom = Math.max(bottom, p.y);
                }
                if (route.label) {
                    right = Math.max(right, route.label.x + route.label.width);
                    bottom = Math.max(bottom, route.label.y + route.label.height);
                }
            }
        }
        return { x: right, y: bottom };
    }

    // -----------------------------------------------------------------------------------------
    // Edges

    private routeEdges(frame: string): void {
        const edges = this.framedEdges.get(frame) ?? [];
        const straight: DiagramEdge[] = [];
        const pending: DiagramEdge[] = [];
        const placed: Point[][] = [];
        const waypoints = new Map<string, Point[]>();
        for (const edge of edges) {
            const stored = this.layout.edges[edge.id];
            const label = edge.label ? { ...edge.label } : undefined;
            let route: { points: Point[], label?: DiagramLabel, waypoints?: Point[] } | undefined;
            if (stored?.bends?.length) {
                const shift = this.shifts.get(frame) ?? { x: 0, y: 0 };
                const bends = stored.bends.map(p => ({ x: p.x + shift.x, y: p.y + shift.y }));
                if (edge.source !== frame && edge.target !== frame) {
                    // waypoints: the route is computed through them
                    waypoints.set(edge.id, bends);
                    pending.push(edge);
                    continue;
                }
                route = { points: this.polyline(edge, frame, bends), label, waypoints: bends };
                edge.routing = 'polyline';
                this.placeLabel(route);
            } else if (edge.source === edge.target || edge.source === frame || edge.target === frame) {
                route = this.autoRoute(edge, frame);
                if (!route) {
                    straight.push(edge);
                    continue;
                }
            } else {
                route = this.autoRoute(edge, frame);
                if (!route || this.crossesMovedVertex(edge, frame, route.points)) {
                    pending.push(edge);
                    continue;
                }
            }
            this.applyLabelOffset(route, stored);
            this.localRoutes.set(edge.id, route);
            placed.push(route.points);
        }
        // transitions whose end points were moved and transitions with waypoints: orthogonal routes around
        // the other vertices
        const routes: Array<{ edge: DiagramEdge, waypoints: Point[], cuts: number[] } & OrthogonalRoute> = [];
        for (const edge of pending) {
            const source = this.boundsIn(edge.source, frame);
            const target = this.boundsIn(edge.target, frame);
            const obstacles = this.obstacles(edge, frame).map(o => o.rect);
            // states between the frame and the end points
            const inner = (id: string) => { const path = this.path(id); return path.slice(path.indexOf(frame) + 1, -1); };
            const containers = [...new Set([...inner(edge.source), ...inner(edge.target)])]
                .filter(id => this.nodes.get(id)!.kind !== 'region')
                .map(id => this.boundsIn(id, frame));
            const through = waypoints.get(edge.id) ?? [];
            const legs = this.routeLegs(edge, source, target, through, obstacles, containers, placed, frame);
            if (!legs) {
                if (through.length > 0) {
                    // no route through the waypoints: straight lines through them
                    const route = { points: this.polyline(edge, frame, through), label: edge.label ? { ...edge.label } : undefined, waypoints: through };
                    edge.routing = 'polyline';
                    this.placeLabel(route);
                    this.applyLabelOffset(route, this.layout.edges[edge.id]);
                    this.localRoutes.set(edge.id, route);
                    placed.push(route.points);
                } else {
                    straight.push(edge);
                }
                continue;
            }
            const { points, cuts } = legs;
            placed.push(points);
            routes.push({
                edge, points, waypoints: through, cuts,
                source: { vertex: edge.source, rect: source, fixed: POINT_PORT_KINDS.has(this.nodes.get(edge.source)!.kind) },
                target: { vertex: edge.target, rect: target, fixed: POINT_PORT_KINDS.has(this.nodes.get(edge.target)!.kind) }
            });
        }
        // (the ends of routes through waypoints stay where they are: shifting them could move a waypoint)
        distributePorts(routes.filter(r => r.waypoints.length === 0));
        const taken = edges.map(e => this.localRoutes.get(e.id)?.label).filter((l): l is DiagramLabel => !!l);
        const vertices = this.labelObstacles(frame);
        const orthogonal = new Set(routes.map(r => r.points));
        const shapes = routes.map(({ edge, points, waypoints: through, cuts }) => this.shapeRoute(edge, frame, points, through, cuts));
        const lines = [...placed.filter(p => !orthogonal.has(p)), ...shapes.map(s => s.outline)];
        routes.forEach(({ edge, waypoints: through }, i) => {
            const shape = shapes[i];
            const route = { points: shape.points, label: edge.label ? { ...edge.label } : undefined, waypoints: through.length > 0 ? through : undefined };
            edge.routing = shape.routing;
            this.placeFreeLabel(route, shape.outline, vertices, taken, lines.filter(l => l !== shape.outline));
            this.applyLabelOffset(route, this.layout.edges[edge.id]);
            this.localRoutes.set(edge.id, route);
            if (route.label) {
                taken.push(route.label);
            }
        });
        // straight lines (self transitions, transitions into composite states and transitions without an
        // orthogonal route); parallel transitions between the same vertices get a bend to separate them
        const groups = new Map<string, DiagramEdge[]>();
        for (const edge of straight) {
            const key = [edge.source, edge.target].sort().join('\n');
            groups.set(key, [...(groups.get(key) ?? []), edge]);
        }
        for (const group of groups.values()) {
            group.forEach((edge, index) => {
                const route = { points: this.straightRoute(edge, frame, index, group.length), label: edge.label ? { ...edge.label } : undefined };
                edge.routing = 'polyline';
                // labels of parallel transitions are placed on the outer side of their bend
                const [a, bend, b] = route.points;
                const side = route.points.length === 3 && edge.source !== edge.target
                    ? { x: bend.x - (a.x + b.x) / 2, y: bend.y - (a.y + b.y) / 2 }
                    : undefined;
                this.placeLabel(route, edge.source === edge.target, side);
                this.applyLabelOffset(route, this.layout.edges[edge.id]);
                this.localRoutes.set(edge.id, route);
            });
        }
    }

    /**
     * The vertices a transition must not cross, relative to its frame: all vertices in the frame except
     * the end points and the states containing them (whose content is an obstacle instead).
     */
    private obstacles(edge: DiagramEdge, frame: string): Array<{ id: string, rect: Rect }> {
        const containing = new Set([...this.path(edge.source), ...this.path(edge.target)]);
        const result: Array<{ id: string, rect: Rect }> = [];
        const visit = (node: DiagramNode) => {
            for (const child of node.children) {
                if (child.id === edge.source || child.id === edge.target) {
                    continue;
                }
                if (containing.has(child.id) || child.kind === 'region') {
                    visit(child);
                } else {
                    result.push({ id: child.id, rect: this.boundsIn(child.id, frame) });
                }
            }
        };
        visit(this.nodes.get(frame)!);
        return result;
    }

    /** Whether the route crosses a vertex which was moved relative to the end points of the transition. */
    private crossesMovedVertex(edge: DiagramEdge, frame: string, points: Point[]): boolean {
        const now = this.boundsIn(edge.source, frame);
        const before = this.autoBoundsIn(edge.source, frame);
        const dx = now.x - before.x;
        const dy = now.y - before.y;
        return this.obstacles(edge, frame).some(({ id, rect }) => {
            const auto = this.autoBoundsIn(id, frame);
            const moved = Math.abs(rect.x - auto.x - dx) > TOLERANCE || Math.abs(rect.y - auto.y - dy) > TOLERANCE
                || Math.abs(rect.width - auto.width) > TOLERANCE || Math.abs(rect.height - auto.height) > TOLERANCE;
            return moved && crossesRect(points, rect);
        });
    }

    /**
     * An orthogonal route from the source through the waypoints to the target (each part routed on its
     * own; it does not turn back at a waypoint). `cuts` are the indices of the waypoints in the route.
     */
    private routeLegs(edge: DiagramEdge, source: Rect, target: Rect, waypoints: Point[], obstacles: Rect[], containers: Rect[],
        placed: Point[][], frame: string): { points: Point[], cuts: number[] } | undefined {
        const fixedKind = (id: string) => POINT_PORT_KINDS.has(this.nodes.get(id)!.kind);
        return routeThroughWaypoints({
            source, target, waypoints, obstacles, containers, placed,
            sourceFixed: fixedKind(edge.source),
            targetFixed: fixedKind(edge.target),
            bounds: this.routingBounds(frame, [source, ...waypoints.map(p => ({ x: p.x, y: p.y, width: 0, height: 0 })), target, ...obstacles])
        });
    }

    /**
     * The route in the shape of the edge routing setting: the orthogonal route as it is, a polyline taking
     * the shortcuts which do not cross a vertex, or a spline through the corners of that polyline.
     * `outline` is the polyline the route follows (for the label placement).
     */
    private shapeRoute(edge: DiagramEdge, frame: string, orthogonal: Point[], waypoints: Point[] = [], cuts: number[] = []): { points: Point[], routing: DiagramEdge['routing'], outline: Point[] } {
        const routing = this.options.routing;
        if (routing === 'ORTHOGONAL') {
            return { points: orthogonal, routing: 'orthogonal', outline: orthogonal };
        }
        // (vertices containing a waypoint are crossed anyway)
        const obstacles = this.obstacles(edge, frame).map(o => o.rect).filter(o => !waypoints.some(w => insideRect(w, o)));
        const ends = [this.boundsIn(edge.source, frame), this.boundsIn(edge.target, frame)];
        // shortcuts within the parts between the waypoints (the route keeps passing through them)
        const bounds = [0, ...cuts, orthogonal.length - 1];
        const polyline: Point[] = [];
        for (let i = 0; i + 1 < bounds.length; i++) {
            const part = shortcut(orthogonal.slice(bounds[i], bounds[i + 1] + 1), obstacles, ends);
            polyline.push(...(i === 0 ? part : part.slice(1)));
        }
        if (routing === 'SPLINES') {
            const bounds = this.routingBounds(frame, [...ends, ...obstacles]);
            return { ...this.splineRoute(orthogonal, [...polyline], obstacles, ends, bounds), routing: 'spline' };
        }
        // the ends point towards the next corner (like the routes of the automatic layout), unless the
        // ends of several routes were spread along the side
        const [source, target] = ends;
        const sourceKind = this.nodes.get(edge.source)!.kind;
        const targetKind = this.nodes.get(edge.target)!.kind;
        const start = borderPoint(source, sourceKind, polyline.length > 2 ? polyline[1] : center(target));
        const end = borderPoint(target, targetKind, polyline.length > 2 ? polyline[polyline.length - 2] : center(source));
        const free = (a: Point, b: Point) => !obstacles.some(o => crossesRect([a, b], o));
        if (polyline.length > 2 ? free(start, polyline[1]) && free(polyline[polyline.length - 2], end) : free(start, end)) {
            const spread = (p: Point, rect: Rect) => Math.abs(p.x - center(rect).x) > 0.5 && Math.abs(p.y - center(rect).y) > 0.5;
            if (!spread(polyline[0], source) || ROUND_KINDS.has(sourceKind)) {
                polyline[0] = start;
            }
            if (!spread(polyline[polyline.length - 1], target) || ROUND_KINDS.has(targetKind)) {
                polyline[polyline.length - 1] = end;
            }
        }
        return { points: polyline, routing: 'polyline', outline: polyline };
    }

    /**
     * A smooth curve through the corners of the shortened route which leaves the source and enters the
     * target perpendicular to their sides (like the splines of the automatic layout), as round as
     * possible without touching a vertex.
     */
    private splineRoute(orthogonal: Point[], polyline: Point[], obstacles: Rect[], ends: Rect[],
        bounds: { minX: number, minY: number, maxX: number, maxY: number }): { points: Point[], outline: Point[] } {
        const unit = (a: Point, b: Point) => {
            const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
            return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
        };
        const out = unit(orthogonal[0], orthogonal[1]);
        const into = unit(orthogonal[orthogonal.length - 2], orthogonal[orthogonal.length - 1]);
        const clear = (spline: Point[]) => {
            const samples = sampleSpline(spline);
            return samples.every(p => p.x >= bounds.minX - 1 && p.x <= bounds.maxX + 1 && p.y >= bounds.minY - 1 && p.y <= bounds.maxY + 1)
                && obstacles.every(o => !crossesRect(samples, o))
                && ends.every(e => !crossesRect(samples, { x: e.x + 1, y: e.y + 1, width: e.width - 2, height: e.height - 2 }));
        };
        // the label is placed along the curve itself
        const result = (points: Point[]) => ({ points, outline: sampleSpline(points) });
        for (const stiffness of [1, 0.6, 0.3]) {
            const spline = hermiteSpline(polyline, out, into, stiffness);
            if (clear(spline)) {
                return result(spline);
            }
        }
        // round the corners of the route as much as possible
        for (const radius of [60, 30, 15]) {
            const spline = toSpline(polyline, radius);
            if (clear(spline)) {
                return result(spline);
            }
        }
        return result(toSpline(orthogonal, 10));
    }

    /** All vertices within the frame (relative to it) and whether they contain other vertices. */
    private labelObstacles(frame: string): Array<{ rect: Rect, container: boolean }> {
        const result: Array<{ rect: Rect, container: boolean }> = [];
        const visit = (node: DiagramNode) => {
            for (const child of node.children) {
                if (child.kind !== 'region') {
                    result.push({ rect: this.boundsIn(child.id, frame), container: child.children.length > 0 });
                }
                visit(child);
            }
        };
        visit(this.nodes.get(frame)!);
        return result;
    }

    /**
     * Places the label next to a segment of the route (preferring long segments and their middle) where it
     * does not cover a vertex, the border of a state, another label or another route.
     */
    private placeFreeLabel(route: { points: Point[], label?: DiagramLabel }, outline: Point[], vertices: Array<{ rect: Rect, container: boolean }>, labels: Rect[], routes: Point[][]): void {
        const label = route.label;
        if (!label) {
            return;
        }
        const points = outline;
        // long segments first; on curves (many short segments) the ones nearest to the middle
        const curved = points.length > 8;
        const middle = (points.length - 2) / 2;
        const segments = points.slice(1).map((b, i) => ({ a: points[i], b, i })).sort((s, t) => curved
            ? Math.abs(s.i - middle) - Math.abs(t.i - middle)
            : Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y) - Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y));
        const candidates: Rect[] = [];
        for (const { a, b } of segments) {
            for (const t of [0.5, 0.25, 0.75]) {
                const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
                if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) {
                    candidates.push({ x: p.x - label.width / 2, y: p.y - label.height - 3, width: label.width, height: label.height });
                    candidates.push({ x: p.x - label.width / 2, y: p.y + 3, width: label.width, height: label.height });
                } else {
                    candidates.push({ x: p.x + 5, y: p.y - label.height / 2, width: label.width, height: label.height });
                    candidates.push({ x: p.x - label.width - 5, y: p.y - label.height / 2, width: label.width, height: label.height });
                }
            }
        }
        const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y
            && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
        const free = (r: Rect) => vertices.every(v => !overlaps(r, v.rect, 0) || (v.container && contains(v.rect, r)))
            && labels.every(l => !overlaps(r, l, 0))
            && routes.every(other => !crossesRect(other, r));
        const best = candidates.find(free) ?? candidates[0];
        if (best) {
            label.x = best.x;
            label.y = best.y;
        }
    }

    /** The area in which the transitions of a frame are routed: within the content area of the frame. */
    private routingBounds(frame: string, rects: Rect[]): { minX: number, minY: number, maxX: number, maxY: number } {
        const node = this.nodes.get(frame)!;
        let min: Point = { x: 0, y: 0 };
        if (node !== this.root) {
            if (node.kind === 'state' && node.regions) {
                min = { x: 0, y: stateContentTop(node) };
            } else {
                const origin = contentOrigin(node);
                min = { x: origin.x / 2, y: origin.y - origin.x / 2 };
            }
        }
        const space = 3 * NODE_SPACING;
        return {
            minX: min.x, minY: min.y,
            maxX: Math.max(min.x, ...rects.map(r => r.x + r.width)) + space,
            maxY: Math.max(min.y, ...rects.map(r => r.y + r.height)) + space
        };
    }

    /** The route of the automatic layout if both end points are arranged like in the automatic layout. */
    private autoRoute(edge: DiagramEdge, frame: string): { points: Point[], label?: DiagramLabel } | undefined {
        const autoEdge = this.autoEdges.get(edge.id);
        if (!autoEdge || autoEdge.points.length < 2) {
            return undefined;
        }
        const displacement = (id: string): Point | undefined => {
            const now = this.boundsIn(id, frame);
            const before = this.autoBoundsIn(id, frame);
            if (Math.abs(now.width - before.width) > TOLERANCE || Math.abs(now.height - before.height) > TOLERANCE) {
                return undefined;
            }
            return { x: now.x - before.x, y: now.y - before.y };
        };
        const ds = displacement(edge.source);
        const dt = displacement(edge.target);
        if (!ds || !dt || Math.abs(ds.x - dt.x) > TOLERANCE || Math.abs(ds.y - dt.y) > TOLERANCE) {
            return undefined;
        }
        const origin = this.autoBounds.get(frame)!;
        const shift = (p: Point) => ({ x: p.x - origin.x + ds.x, y: p.y - origin.y + ds.y });
        edge.routing = autoEdge.routing;
        return {
            points: autoEdge.points.map(shift),
            label: autoEdge.label ? { ...autoEdge.label, ...shift(autoEdge.label) } : undefined
        };
    }

    private straightRoute(edge: DiagramEdge, frame: string, index: number, count: number): Point[] {
        const source = this.boundsIn(edge.source, frame);
        const target = this.boundsIn(edge.target, frame);
        if (edge.source === edge.target) {
            // self transition: a loop at the right side
            const size = 22 + index * 12;
            const right = source.x + source.width;
            const cy = source.y + source.height / 2;
            const dy = Math.min(source.height / 2 - 2, 8 + index * 4);
            return [{ x: right, y: cy - dy }, { x: right + size, y: cy - dy - 8 }, { x: right + size, y: cy + dy + 8 }, { x: right, y: cy + dy }];
        }
        if (edge.source === frame || edge.target === frame) {
            return this.hierarchicalRoute(edge, frame, source, target);
        }
        const bends: Point[] = [];
        if (count > 1) {
            // parallel transitions: bend the lines symmetrically around the direct line
            const a = center(source);
            const b = center(target);
            const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
            const sign = edge.source < edge.target ? 1 : -1;
            const offset = (index - (count - 1) / 2) * 26 * sign;
            bends.push({ x: (a.x + b.x) / 2 - (b.y - a.y) / length * offset, y: (a.y + b.y) / 2 + (b.x - a.x) / length * offset });
            if (Math.abs(offset) < 0.1) {
                bends.pop();
            }
        }
        return this.polyline(edge, frame, bends);
    }

    /** A transition between a composite state and a vertex inside it: from the nearest border of the state. */
    private hierarchicalRoute(edge: DiagramEdge, frame: string, source: Rect, target: Rect): Point[] {
        const outerIsSource = edge.source === frame;
        const outer = outerIsSource ? source : target;
        const inner = outerIsSource ? target : source;
        const innerNode = this.nodes.get(outerIsSource ? edge.target : edge.source)!;
        const c = center(inner);
        const distances = [
            { d: inner.x, p: { x: 0, y: c.y } },
            { d: inner.y, p: { x: c.x, y: 0 } },
            { d: outer.width - inner.x - inner.width, p: { x: outer.width, y: c.y } },
            { d: outer.height - inner.y - inner.height, p: { x: c.x, y: outer.height } }
        ];
        const border = distances.reduce((a, b) => a.d <= b.d ? a : b).p;
        const end = borderPoint(inner, innerNode.kind, border);
        return outerIsSource ? [border, end] : [end, border];
    }

    /** Polyline from the border of the source through the bend points to the border of the target. */
    private polyline(edge: DiagramEdge, frame: string, bends: Point[]): Point[] {
        const source = this.boundsIn(edge.source, frame);
        const target = this.boundsIn(edge.target, frame);
        const sourceKind = this.nodes.get(edge.source)!.kind;
        const targetKind = this.nodes.get(edge.target)!.kind;
        const first = bends[0] ?? center(target);
        const last = bends[bends.length - 1] ?? center(source);
        const start = edge.source === frame ? nearestBorderPoint(source, first) : borderPoint(source, sourceKind, first);
        const end = edge.target === frame ? nearestBorderPoint(target, last) : borderPoint(target, targetKind, last);
        return [start, ...bends, end];
    }

    /**
     * Places the label at the middle of the route: above horizontal segments, right of vertical ones
     * (or on the given side).
     */
    private placeLabel(route: { points: Point[], label?: DiagramLabel }, loop = false, side?: Point): void {
        const label = route.label;
        if (!label) {
            return;
        }
        const points = route.points;
        if (loop) {
            const right = Math.max(...points.map(p => p.x));
            const cy = (points[0].y + points[points.length - 1].y) / 2;
            label.x = right + 4;
            label.y = cy - label.height / 2;
            return;
        }
        const { point, direction } = midpoint(points);
        if (Math.abs(direction.x) >= Math.abs(direction.y)) {
            label.x = point.x - label.width / 2;
            label.y = side && side.y > 0 ? point.y + 3 : point.y - label.height - 3;
        } else {
            label.x = side && side.x < 0 ? point.x - label.width - 5 : point.x + 5;
            label.y = point.y - label.height / 2;
        }
    }

    private applyLabelOffset(route: { label?: DiagramLabel }, stored: EdgeLayout | undefined): void {
        if (route.label && stored?.label) {
            route.label.x += stored.label.x;
            route.label.y += stored.label.y;
        }
    }

    // -----------------------------------------------------------------------------------------
    // Result

    private effectiveLayout(): ManualLayout {
        const result = createManualLayout('manual', this.layout.direction);
        for (const [id, node] of this.nodes) {
            if (id === MACHINE_ID) {
                continue;
            }
            const stored = this.stored(id);
            if (node.kind === 'region') {
                if (stored?.width !== undefined || stored?.height !== undefined) {
                    result.nodes[id] = { ...stored };
                }
                continue;
            }
            result.nodes[id] = {
                x: node.x, y: node.y,
                ...(stored?.width !== undefined ? { width: stored.width } : {}),
                ...(stored?.height !== undefined ? { height: stored.height } : {}),
                ...(stored?.regions ? { regions: stored.regions } : {})
            };
        }
        for (const edge of this.edges) {
            const stored = this.layout.edges[edge.id];
            if (!stored) {
                continue;
            }
            const shift = this.shifts.get(this.frames.get(edge.id)!) ?? { x: 0, y: 0 };
            result.edges[edge.id] = {
                ...(stored.bends?.length ? { bends: stored.bends.map(p => ({ x: p.x + shift.x, y: p.y + shift.y })) } : {}),
                ...(stored.label ? { label: { ...stored.label } } : {})
            };
        }
        return result;
    }
}

// ---------------------------------------------------------------------------------------------
// Geometry

/** The point where the line from the center of the shape towards `toward` leaves the shape. */
export function borderPoint(rect: Rect, kind: DiagramNodeKind, toward: Point): Point {
    const c = center(rect);
    const dx = toward.x - c.x;
    const dy = toward.y - c.y;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
        return c;
    }
    const hw = rect.width / 2;
    const hh = rect.height / 2;
    let t: number;
    if (ROUND_KINDS.has(kind)) {
        t = Math.min(hw, hh) / Math.hypot(dx, dy);
    } else if (kind === 'choice') {
        t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    } else {
        t = Math.min(Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Number.POSITIVE_INFINITY, Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Number.POSITIVE_INFINITY);
    }
    return { x: c.x + dx * t, y: c.y + dy * t };
}

/** The point on the border of a container (in its own coordinates) nearest to `point`. */
function nearestBorderPoint(rect: Rect, point: Point): Point {
    const x = Math.min(Math.max(point.x, rect.x), rect.x + rect.width);
    const y = Math.min(Math.max(point.y, rect.y), rect.y + rect.height);
    const options = [
        { d: x - rect.x, p: { x: rect.x, y } },
        { d: rect.x + rect.width - x, p: { x: rect.x + rect.width, y } },
        { d: y - rect.y, p: { x, y: rect.y } },
        { d: rect.y + rect.height - y, p: { x, y: rect.y + rect.height } }
    ];
    return options.reduce((a, b) => a.d <= b.d ? a : b).p;
}

/**
 * Removes the corners of a route where the direct line between the points before and after does not
 * come close to an obstacle (or run through the source / target).
 */
function shortcut(points: Point[], obstacles: Rect[], ends: Rect[]): Point[] {
    const clearance = 8;
    const inflated = obstacles.map(o => ({ x: o.x - clearance, y: o.y - clearance, width: o.width + 2 * clearance, height: o.height + 2 * clearance }));
    const free = (a: Point, b: Point) => !inflated.some(o => crossesRect([a, b], o)) && !ends.some(e => crossesRect([a, b], e));
    const result = [points[0]];
    let i = 0;
    while (i < points.length - 1) {
        let j = points.length - 1;
        while (j > i + 1 && !free(points[i], points[j])) {
            j--;
        }
        result.push(points[j]);
        i = j;
    }
    return result;
}

/**
 * The polyline with rounded corners (up to `radius` along each segment, at most half of it) as cubic
 * Bezier segments in the form of the spline routes of the automatic layout: start, (control, control, end)*.
 */
function toSpline(points: Point[], radius: number): Point[] {
    const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const result = [points[0]];
    const line = (to: Point) => {
        const from = result[result.length - 1];
        result.push(lerp(from, to, 1 / 3), lerp(from, to, 2 / 3), to);
    };
    for (let i = 1; i + 1 < points.length; i++) {
        const [prev, corner, next] = [points[i - 1], points[i], points[i + 1]];
        const inLength = Math.hypot(corner.x - prev.x, corner.y - prev.y);
        const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
        const before = lerp(corner, prev, inLength > 0 ? Math.min(radius, inLength / 2) / inLength : 0);
        const after = lerp(corner, next, outLength > 0 ? Math.min(radius, outLength / 2) / outLength : 0);
        line(before);
        // quadratic curve with the corner as control point
        result.push(lerp(before, corner, 2 / 3), lerp(after, corner, 2 / 3), after);
    }
    line(points[points.length - 1]);
    return result;
}

/**
 * Cubic Bezier segments through the points: the tangents at the ends are the given directions (scaled by
 * the length of the first / last segment and `stiffness`), inside Catmull-Rom tangents.
 */
function hermiteSpline(points: Point[], startDirection: Point, endDirection: Point, stiffness: number): Point[] {
    const last = points.length - 1;
    const length = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
    const tangent = (i: number): Point => {
        if (i === 0) {
            const l = Math.min(length(points[0], points[1]), 240) * stiffness;
            return { x: startDirection.x * l, y: startDirection.y * l };
        }
        if (i === last) {
            const l = Math.min(length(points[last - 1], points[last]), 240) * stiffness;
            return { x: endDirection.x * l, y: endDirection.y * l };
        }
        return { x: (points[i + 1].x - points[i - 1].x) / 2, y: (points[i + 1].y - points[i - 1].y) / 2 };
    };
    const result = [points[0]];
    for (let i = 0; i < last; i++) {
        const t0 = tangent(i);
        const t1 = tangent(i + 1);
        result.push(
            { x: points[i].x + t0.x / 3, y: points[i].y + t0.y / 3 },
            { x: points[i + 1].x - t1.x / 3, y: points[i + 1].y - t1.y / 3 },
            points[i + 1]
        );
    }
    return result;
}

/** Points on the spline (to check it against obstacles). */
function sampleSpline(points: Point[]): Point[] {
    const result = [points[0]];
    for (let i = 0; i + 3 < points.length; i += 3) {
        const [a, b, c, d] = [points[i], points[i + 1], points[i + 2], points[i + 3]];
        for (let k = 1; k <= 8; k++) {
            const t = k / 8;
            const u = 1 - t;
            result.push({
                x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
                y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y
            });
        }
    }
    return result;
}

/** The point in the middle (by length) of a polyline and the direction of the segment there. */
function midpoint(points: Point[]): { point: Point, direction: Point } {
    const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
    let remaining = lengths.reduce((a, b) => a + b, 0) / 2;
    for (let i = 0; i < lengths.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        if (remaining <= lengths[i] || i === lengths.length - 1) {
            const t = lengths[i] > 0 ? Math.min(1, remaining / lengths[i]) : 0;
            return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, direction: { x: b.x - a.x, y: b.y - a.y } };
        }
        remaining -= lengths[i];
    }
    return { point: points[0], direction: { x: 1, y: 0 } };
}

/**
 * Converts an absolute point into the coordinate system of the frame node of a transition (used to
 * store bend points which were placed in the diagram).
 */
export function toFrameCoordinates(graph: DiagramGraph, edge: DiagramEdge, point: Point): Point {
    const origin = frameOrigin(graph, edge);
    return { x: point.x - origin.x, y: point.y - origin.y };
}

/** Absolute position of the frame node of a transition (see `ManualLayoutEngine.edgeFrame`). */
export function frameOrigin(graph: DiagramGraph, edge: DiagramEdge): Point {
    return edgeFrameOrigin(graph.children, node => node.children, edge.source, edge.target);
}
