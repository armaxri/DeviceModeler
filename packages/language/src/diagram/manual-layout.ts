/**
 * Manual ("hand-arranged") diagram layouts (experimental).
 *
 * A manual layout is stored next to the model in a sidecar file `<model>.hsm.layout` (JSON), so the
 * `.hsm` text stays free of layout noise. Elements are identified by their diagram ids, which are
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
import { anchorDirection, anchorNormal, anchorPoint, isAnchorSide, supportsAnchors, type AnchorSide, type EdgeAnchor } from './edge-anchors.js';
import { applyEdgeCurves, elkEdgeRouting, roundedCorners, sampleSpline } from './edge-routes.js';
import { layoutFromModel } from './layout-annotations.js';
import { POINT_PORT_KINDS, crossesRect, distributePorts, routeOrthogonal, type FixedPort, type OrthogonalRoute } from './orthogonal-router.js';

export const MANUAL_LAYOUT_VERSION = 1;

/** File name extension of layout sidecar files (`model.hsm` -> `model.hsm.layout`). */
export const LAYOUT_FILE_EXTENSION = '.layout';

export type LayoutMode = 'auto' | 'manual';

export type RegionOrientation = 'vertical' | 'horizontal';

export interface NodeLayout {
    /** Position relative to the parent node (for regions: ignored, regions are stacked). */
    x: number;
    y: number;
    /** Explicit size (resized by the user or imported); the node is never smaller than its content. */
    width?: number;
    height?: number;
    /** States with regions: whether the regions are stacked vertically or placed side by side. */
    regions?: RegionOrientation;
}

export interface EdgeLayout {
    /** Bend points in the coordinate system of the edge's frame node (see `edgeFrame`). */
    bends?: Point[];
    /** Offset of the label from its computed position. */
    label?: Point;
    /** Anchor of the start of the transition on the border of its source state (`@from`). */
    source?: EdgeAnchor;
    /** Anchor of the end of the transition on the border of its target state (`@to`). */
    target?: EdgeAnchor;
}

/** Whether an edge layout contains anything (waypoints, label offset or anchors). */
export function hasEdgeLayout(edge: EdgeLayout | undefined): boolean {
    return !!edge && (!!edge.bends?.length || !!edge.label || !!edge.source || !!edge.target);
}

export interface ManualLayout {
    version: number;
    mode: LayoutMode;
    /** Layout direction used to place new elements (default: the direction of the layout options). */
    direction?: LayoutDirection;
    nodes: Record<string, NodeLayout>;
    edges: Record<string, EdgeLayout>;
}

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

/** `model.hsm` -> `model.hsm.layout` */
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

/** Parses and validates the content of a `.hsm.layout` file. */
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
        for (const end of ['source', 'target'] as const) {
            const anchor = edge?.[end] as Partial<EdgeAnchor> | undefined;
            if (anchor && isAnchorSide(anchor.side) && isFiniteNumber(anchor.position)) {
                entry[end] = { side: anchor.side, position: anchor.position };
            }
        }
        if (hasEdgeLayout(entry)) {
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
        for (const end of ['source', 'target'] as const) {
            const anchor = edge[end];
            if (anchor) {
                entry[end] = { side: anchor.side, position: round(anchor.position) };
            }
        }
        if (hasEdgeLayout(entry)) {
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
    return JSON.parse(JSON.stringify(layout)) as ManualLayout;
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

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

const ROOT_PADDING = 20;
const NODE_SPACING = 30;
const TOLERANCE = 0.5;
const ROUND_KINDS: ReadonlySet<DiagramNodeKind> = new Set<DiagramNodeKind>(['initial', 'final', 'junction', 'history', 'deephistory', 'entry', 'exit']);

class ManualLayoutEngine {

    /** Cloned diagram nodes (modified in place). */
    private readonly nodes = new Map<string, DiagramNode>();
    private readonly parents = new Map<string, string>();
    /** Absolute bounds of the nodes in the automatic layout. */
    private readonly autoBounds = new Map<string, Rect>();
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
        const collect = (node: DiagramNode, parent: DiagramNode, ax: number, ay: number) => {
            this.nodes.set(node.id, node);
            this.parents.set(node.id, parent.id);
            this.autoPositions.set(node.id, { x: node.x, y: node.y });
            this.autoBounds.set(node.id, { x: ax + node.x, y: ay + node.y, width: node.width, height: node.height });
            node.children.forEach(child => collect(child, node, ax + node.x, ay + node.y));
        };
        this.root.children.forEach(child => collect(child, this.root, 0, 0));
        this.nodes.set(MACHINE_ID, this.root);
        this.autoBounds.set(MACHINE_ID, { x: 0, y: 0, width: graph.width, height: graph.height });
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
            const source = this.anchor(edge, 'source');
            const target = this.anchor(edge, 'target');
            if (source || target) {
                edge.anchors = { ...(source ? { source: { ...source } } : {}), ...(target ? { target: { ...target } } : {}) };
            }
        }
        const graph: DiagramGraph = {
            ...auto.graph,
            width: Math.max(extent.x, 0) + ROOT_PADDING,
            height: Math.max(extent.y, 0) + ROOT_PADDING,
            children: this.root.children,
            edges: this.edges
        };
        applyEdgeCurves(graph, this.options.routing);
        return { graph, elements: auto.elements, ids: auto.ids, effective: this.effectiveLayout() };
    }

    // -----------------------------------------------------------------------------------------
    // Structure helpers

    private path(id: string): string[] {
        const result = [id];
        let current = this.parents.get(id);
        while (current) {
            result.unshift(current);
            current = this.parents.get(current);
        }
        if (result[0] !== MACHINE_ID) {
            result.unshift(MACHINE_ID);
        }
        return result;
    }

    /**
     * The node in whose coordinate system an edge is routed: the innermost node containing both end
     * points (for a transition between a composite state and its content: the composite state; for a
     * self transition: the parent of the vertex).
     */
    private edgeFrame(edge: DiagramEdge): string {
        const source = this.path(edge.source);
        const target = this.path(edge.target);
        let frame = MACHINE_ID;
        for (let i = 0; i < Math.min(source.length, target.length) && source[i] === target[i]; i++) {
            frame = source[i];
        }
        if (edge.source === edge.target) {
            frame = this.parents.get(edge.source) ?? MACHINE_ID;
        }
        return frame;
    }

    private absolutePosition(id: string): Point {
        let x = 0;
        let y = 0;
        for (let current: string | undefined = id; current && current !== MACHINE_ID; current = this.parents.get(current)) {
            const node = this.nodes.get(current)!;
            x += node.x;
            y += node.y;
        }
        return { x, y };
    }

    /** Bounds of a node relative to the frame node (which must be an ancestor or the node itself). */
    private boundsIn(id: string, frame: string): Rect {
        const node = this.nodes.get(id)!;
        if (id === frame) {
            return { x: 0, y: 0, width: node.width, height: node.height };
        }
        let x = 0;
        let y = 0;
        for (let current: string | undefined = id; current && current !== frame; current = this.parents.get(current)) {
            const n = this.nodes.get(current)!;
            x += n.x;
            y += n.y;
        }
        return { x, y, width: node.width, height: node.height };
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
            // the transitions between the state and its content end on its border
            this.routeEdges(node.id, 'container');
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
        const pinned = children.filter(c => this.stored(c.id) && c.kind !== 'region');
        const unpinned = children.filter(c => !this.stored(c.id) && c.kind !== 'region');
        for (const child of pinned) {
            const stored = this.stored(child.id)!;
            child.x = stored.x;
            child.y = stored.y;
        }
        // pinned content must not overlap the header of the state: shift it as a whole
        if (pinned.length > 0) {
            const dx = Math.max(0, left - Math.min(...pinned.map(c => c.x)));
            const dy = Math.max(0, top - Math.min(...pinned.map(c => c.y)));
            if (dx > 0 || dy > 0) {
                this.shifts.set(owner.id, { x: dx, y: dy });
                for (const child of pinned) {
                    child.x += dx;
                    child.y += dy;
                }
            }
        }
        separate(pinned);
        const placed: DiagramNode[] = [...pinned];
        for (const child of unpinned) {
            this.placeNew(child, pinned, placed, left, top);
            placed.push(child);
        }
        if (owner === this.root) {
            this.routeEdges(owner.id);
        } else if (owner.kind !== 'state' || !owner.regions) {
            // (the transitions between the state and its content: once the size of the state is known)
            this.routeEdges(owner.id, owner.kind === 'state' ? 'inner' : undefined);
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

    /** Places a node without stored position near its position in the automatic layout, without overlaps. */
    private placeNew(node: DiagramNode, pinned: DiagramNode[], placed: DiagramNode[], left: number, top: number): void {
        const auto = this.autoPositions.get(node.id)!;
        let target = { ...auto };
        if (pinned.length > 0) {
            // keep the offset of the nearest pinned sibling (in the automatic layout)
            const distance = (n: DiagramNode) => {
                const p = this.autoPositions.get(n.id)!;
                return Math.hypot(p.x - auto.x, p.y - auto.y);
            };
            const nearest = pinned.reduce((a, b) => distance(a) <= distance(b) ? a : b);
            const nearestAuto = this.autoPositions.get(nearest.id)!;
            target = { x: auto.x + nearest.x - nearestAuto.x, y: auto.y + nearest.y - nearestAuto.y };
        }
        target = { x: Math.max(left, target.x), y: Math.max(top, target.y) };
        const free = (x: number, y: number) => x >= left - TOLERANCE && y >= top - TOLERANCE
            && placed.every(other => !overlaps({ x, y, width: node.width, height: node.height }, other, NODE_SPACING / 2));
        if (free(target.x, target.y)) {
            node.x = target.x;
            node.y = target.y;
            return;
        }
        const gap = NODE_SPACING;
        const candidates: Point[] = [];
        for (const other of placed) {
            candidates.push(
                { x: other.x + other.width + gap, y: other.y },
                { x: other.x, y: other.y + other.height + gap },
                { x: other.x - node.width - gap, y: other.y },
                { x: other.x, y: other.y - node.height - gap },
                { x: other.x + other.width + gap, y: target.y },
                { x: target.x, y: other.y + other.height + gap }
            );
        }
        let best: Point | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const candidate of candidates) {
            const d = Math.hypot(candidate.x - target.x, candidate.y - target.y);
            if (d < bestDistance && free(candidate.x, candidate.y)) {
                best = candidate;
                bestDistance = d;
            }
        }
        node.x = best?.x ?? left;
        node.y = best?.y ?? Math.max(top, ...placed.map(p => p.y + p.height + gap));
    }

    // -----------------------------------------------------------------------------------------
    // Edges

    /**
     * Routes the transitions of a frame node. `part`: only the transitions between the frame and its content
     * (`container`, routed once the size of the frame is known) or only the others (`inner`).
     */
    private routeEdges(frame: string, part?: 'inner' | 'container'): void {
        const all = this.framedEdges.get(frame) ?? [];
        const isContainerEdge = (edge: DiagramEdge) => edge.source === frame || edge.target === frame;
        const edges = part ? all.filter(edge => isContainerEdge(edge) === (part === 'container')) : all;
        const straight: DiagramEdge[] = [];
        const pending: DiagramEdge[] = [];
        // (the routes of the frame computed before)
        const placed: Point[][] = all.filter(e => !edges.includes(e)).map(e => this.localRoutes.get(e.id)?.points).filter((p): p is Point[] => !!p);
        const waypoints = new Map<string, Point[]>();
        /** Routes of anchored self transitions and transitions between a composite state and its content. */
        const fixed: Array<{ edge: DiagramEdge, points: Point[] }> = [];
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
            } else if (this.anchor(edge, 'source') || this.anchor(edge, 'target')) {
                // anchored ends: routed from / to the anchors
                if (edge.source === edge.target) {
                    fixed.push({ edge, points: this.selfLoop(edge, frame, 0) });
                    continue;
                }
                if (edge.source === frame || edge.target === frame) {
                    const points = this.anchoredHierarchicalRoute(edge, frame, placed);
                    if (!points) {
                        straight.push(edge);
                        continue;
                    }
                    placed.push(points);
                    fixed.push({ edge, points });
                    continue;
                }
                pending.push(edge);
                continue;
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
                source: { vertex: edge.source, rect: source, kind: this.nodes.get(edge.source)!.kind, fixed: !!this.anchor(edge, 'source') },
                target: { vertex: edge.target, rect: target, kind: this.nodes.get(edge.target)!.kind, fixed: !!this.anchor(edge, 'target') }
            });
        }
        // (the ends of routes through waypoints stay where they are: shifting them could move a waypoint)
        distributePorts(routes.filter(r => r.waypoints.length === 0));
        for (const { edge, points } of fixed) {
            const end = (id: string) => ({ vertex: id, rect: this.boundsIn(id, frame), kind: this.nodes.get(id)!.kind, fixed: true });
            routes.push({ edge, points, waypoints: [], cuts: [], source: end(edge.source), target: end(edge.target) });
        }
        const taken = all.map(e => this.localRoutes.get(e.id)?.label).filter((l): l is DiagramLabel => !!l);
        const vertices = this.labelObstacles(frame);
        const orthogonal = new Set(routes.map(r => r.points));
        const shapes = routes.map(({ edge, points, waypoints: through, cuts }) => this.shapeRoute(edge, frame, points, through, cuts));
        const lines = [...placed.filter(p => !orthogonal.has(p)), ...shapes.map(s => s.outline)];
        routes.forEach(({ edge, waypoints: through }, i) => {
            const shape = shapes[i];
            const route = { points: shape.points, label: edge.label ? { ...edge.label } : undefined, waypoints: through.length > 0 ? through : undefined };
            edge.routing = shape.routing;
            this.placeFreeLabel(route, shape.outline, vertices, taken, lines.filter(l => l !== shape.outline), frame === MACHINE_ID);
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
        const stops: Rect[] = [source, ...waypoints.map(p => ({ x: p.x, y: p.y, width: 0, height: 0 })), target];
        const fixedKind = (id: string) => POINT_PORT_KINDS.has(this.nodes.get(id)!.kind);
        const points: Point[] = [];
        const cuts: number[] = [];
        let exclude: number | undefined;
        for (let i = 0; i + 1 < stops.length; i++) {
            const from = stops[i];
            const to = stops[i + 1];
            // a waypoint inside a vertex: that vertex is crossed
            const legObstacles = obstacles.filter(o => ![from, to].some(r => r.width === 0 && insideRect(r, o)));
            const leg = routeOrthogonal({
                source: from, target: to, obstacles: legObstacles, containers, placed,
                sourceFixed: i > 0 || fixedKind(edge.source),
                targetFixed: i + 2 < stops.length || fixedKind(edge.target),
                sourceExclude: exclude,
                sourcePort: i === 0 ? this.fixedPort(edge, 'source', frame) : undefined,
                targetPort: i + 2 === stops.length ? this.fixedPort(edge, 'target', frame) : undefined,
                bounds: this.routingBounds(frame, [...stops, ...obstacles])
            });
            if (!leg) {
                return undefined;
            }
            if (i > 0) {
                cuts.push(points.length - 1);
            }
            points.push(...(i === 0 ? leg : leg.slice(1)));
            const a = leg[leg.length - 2];
            const b = leg[leg.length - 1];
            // the direction back to where the route arrived
            exclude = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? (b.x > a.x ? 2 : 0) : (b.y > a.y ? 3 : 1);
        }
        return { points, cuts };
    }

    /**
     * The route in the shape of the edge routing setting: the orthogonal route as it is, a polyline taking
     * the shortcuts which do not cross a vertex, or a spline through the corners of that polyline.
     * `outline` is the polyline the route follows (for the label placement).
     */
    private shapeRoute(edge: DiagramEdge, frame: string, orthogonal: Point[], waypoints: Point[] = [], cuts: number[] = []): { points: Point[], routing: DiagramEdge['routing'], outline: Point[] } {
        // (rounded / smooth routes are orthogonal / polyline routes drawn differently)
        const routing = elkEdgeRouting(this.options.routing);
        if (routing === 'ORTHOGONAL') {
            return { points: orthogonal, routing: 'orthogonal', outline: orthogonal };
        }
        // (vertices containing a waypoint are crossed anyway)
        const obstacles = this.obstacles(edge, frame).map(o => o.rect).filter(o => !waypoints.some(w => insideRect(w, o)));
        // (a composite state is not an obstacle for the transitions to / from its content)
        const ends = [edge.source, edge.target].filter(id => id !== frame).map(id => this.boundsIn(id, frame));
        // shortcuts within the parts between the waypoints (the route keeps passing through them); the
        // loop of a self transition is kept
        const bounds = [0, ...cuts, orthogonal.length - 1];
        const polyline: Point[] = [];
        for (let i = 0; i + 1 < bounds.length; i++) {
            const segment = orthogonal.slice(bounds[i], bounds[i + 1] + 1);
            // (an anchored end is left / entered away from its side)
            const startNormal = i === 0 ? this.anchorOutward(edge, 'source', frame) : undefined;
            const endNormal = i + 2 === bounds.length ? this.anchorOutward(edge, 'target', frame) : undefined;
            const part = edge.source === edge.target ? segment : shortcut(segment, obstacles, ends, startNormal, endNormal);
            polyline.push(...(i === 0 ? part : part.slice(1)));
        }
        if (routing === 'SPLINES') {
            const bounds = this.routingBounds(frame, [...ends, ...obstacles]);
            return { ...this.splineRoute(orthogonal, [...polyline], obstacles, ends, bounds), routing: 'spline' };
        }
        // the ends point towards the next corner (like the routes of the automatic layout), unless the
        // ends of several routes were spread along the side
        if (edge.source === frame || edge.target === frame || edge.source === edge.target) {
            return { points: polyline, routing: 'polyline', outline: polyline };
        }
        const [source, target] = ends;
        const sourceKind = this.nodes.get(edge.source)!.kind;
        const targetKind = this.nodes.get(edge.target)!.kind;
        const start = borderPoint(source, sourceKind, polyline.length > 2 ? polyline[1] : center(target));
        const end = borderPoint(target, targetKind, polyline.length > 2 ? polyline[polyline.length - 2] : center(source));
        const free = (a: Point, b: Point) => !obstacles.some(o => crossesRect([a, b], o));
        if (polyline.length > 2 ? free(start, polyline[1]) && free(polyline[polyline.length - 2], end) : free(start, end)) {
            const spread = (p: Point, rect: Rect) => Math.abs(p.x - center(rect).x) > 0.5 && Math.abs(p.y - center(rect).y) > 0.5;
            if ((!spread(polyline[0], source) || ROUND_KINDS.has(sourceKind)) && !this.anchor(edge, 'source')) {
                polyline[0] = start;
            }
            if ((!spread(polyline[polyline.length - 1], target) || ROUND_KINDS.has(targetKind)) && !this.anchor(edge, 'target')) {
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
            const spline = roundedCorners(polyline, radius, false);
            if (clear(spline)) {
                return result(spline);
            }
        }
        return result(roundedCorners(orthogonal, 10, false));
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
    private placeFreeLabel(route: { points: Point[], label?: DiagramLabel }, outline: Point[], vertices: Array<{ rect: Rect, container: boolean }>, labels: Rect[], routes: Point[][],
        onCanvas = false): void {
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
        // (on the canvas: not left of or above it, where it would be cut off)
        const free = (r: Rect) => (!onCanvas || (r.x >= 0 && r.y >= 0))
            && vertices.every(v => !overlaps(r, v.rect, 0) || (v.container && contains(v.rect, r)))
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
        if (edge.source === edge.target && (this.anchor(edge, 'source') || this.anchor(edge, 'target'))) {
            return this.selfLoop(edge, frame, index);
        }
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
        const innerAnchor = this.anchor(edge, outerIsSource ? 'target' : 'source');
        const outerAnchor = this.anchor(edge, outerIsSource ? 'source' : 'target');
        const border = outerAnchor ? anchorPoint(outer, outerAnchor) : this.nearestContainerSide(outer, inner, innerAnchor).point;
        const end = innerAnchor ? anchorPoint(inner, innerAnchor) : borderPoint(inner, innerNode.kind, border);
        return outerIsSource ? [border, end] : [end, border];
    }

    /**
     * The side of a composite state (`outer`, in its own coordinates) nearest to a vertex inside it and the
     * point on it in front of the vertex (in front of the anchor of the vertex: on the side of the anchor).
     */
    private nearestContainerSide(outer: Rect, inner: Rect, innerAnchor?: EdgeAnchor): { point: Point, side: AnchorSide } {
        const c = innerAnchor ? anchorPoint(inner, innerAnchor) : center(inner);
        const distances: Array<{ d: number, p: Point, side: AnchorSide }> = [
            { d: inner.x, p: { x: 0, y: c.y }, side: 'left' },
            { d: inner.y, p: { x: c.x, y: 0 }, side: 'top' },
            { d: outer.width - inner.x - inner.width, p: { x: outer.width, y: c.y }, side: 'right' },
            { d: outer.height - inner.y - inner.height, p: { x: c.x, y: outer.height }, side: 'bottom' }
        ];
        const best = innerAnchor
            ? distances.find(d => d.side === innerAnchor.side) ?? distances[0]
            : distances.reduce((a, b) => a.d <= b.d ? a : b);
        return { point: best.p, side: best.side };
    }

    /** The anchor of an end of a transition (only at states; undefined if none is stored). */
    private anchor(edge: DiagramEdge, end: 'source' | 'target'): EdgeAnchor | undefined {
        const anchor = this.layout.edges[edge.id]?.[end];
        return anchor && supportsAnchors(this.nodes.get(edge[end])?.kind) ? anchor : undefined;
    }

    /** The direction away from the side of an anchored end into the frame (undefined: not anchored). */
    private anchorOutward(edge: DiagramEdge, end: 'source' | 'target', frame: string): Point | undefined {
        const anchor = this.anchor(edge, end);
        if (!anchor) {
            return undefined;
        }
        const normal = anchorNormal(anchor.side);
        return edge[end] === frame ? { x: -normal.x, y: -normal.y } : normal;
    }

    /** The anchored end of a transition as fixed port of the orthogonal router (relative to the frame). */
    private fixedPort(edge: DiagramEdge, end: 'source' | 'target', frame: string): FixedPort | undefined {
        const anchor = this.anchor(edge, end);
        if (!anchor) {
            return undefined;
        }
        const rect = this.boundsIn(edge[end], frame);
        const dir = anchorDirection(anchor.side);
        // (the anchor of a composite state on a transition to / from its content: into the state)
        return { point: anchorPoint(rect, anchor), dir: edge[end] === frame ? (dir + 2) % 4 : dir };
    }

    /**
     * The orthogonal route of a transition between a composite state and a vertex inside it with an
     * anchored end: from the anchor on the border of the composite state (or the side nearest to the
     * vertex) around the other vertices inside the state (undefined if there is no such route).
     */
    private anchoredHierarchicalRoute(edge: DiagramEdge, frame: string, placed: Point[][]): Point[] | undefined {
        const outerIsSource = edge.source === frame;
        const innerId = outerIsSource ? edge.target : edge.source;
        const node = this.nodes.get(frame)!;
        const outer: Rect = { x: 0, y: 0, width: node.width, height: node.height };
        const inner = this.boundsIn(innerId, frame);
        const innerEnd = outerIsSource ? 'target' : 'source';
        const outerAnchor = this.anchor(edge, outerIsSource ? 'source' : 'target');
        const nearest = this.nearestContainerSide(outer, inner, this.anchor(edge, innerEnd));
        const side = outerAnchor?.side ?? nearest.side;
        const point = outerAnchor ? anchorPoint(outer, outerAnchor) : nearest.point;
        const outerPort: FixedPort = { point, dir: (anchorDirection(side) + 2) % 4 };
        const innerPort = this.fixedPort(edge, innerEnd, frame);
        const fixedKind = POINT_PORT_KINDS.has(this.nodes.get(innerId)!.kind);
        const zero: Rect = { x: point.x, y: point.y, width: 0, height: 0 };
        return routeOrthogonal({
            source: outerIsSource ? zero : inner,
            target: outerIsSource ? inner : zero,
            sourcePort: outerIsSource ? outerPort : innerPort,
            targetPort: outerIsSource ? innerPort : outerPort,
            sourceFixed: fixedKind, targetFixed: fixedKind,
            obstacles: this.obstacles(edge, frame).map(o => o.rect), placed,
            bounds: { minX: 0, minY: 0, maxX: outer.width, maxY: outer.height },
            // (the content of a state is close to its border)
            compact: true
        });
    }

    /**
     * The loop of a self transition with anchored ends (a missing anchor: on the right side, like the loop
     * of a transition without anchors).
     */
    private selfLoop(edge: DiagramEdge, frame: string, index: number): Point[] {
        const rect = this.boundsIn(edge.source, frame);
        const a = this.anchor(edge, 'source') ?? { side: 'right', position: 35 };
        const b = this.anchor(edge, 'target') ?? { side: 'right', position: 65 };
        return selfLoopRoute(rect, a, b, 22 + index * 12);
    }

    /** Polyline from the border of the source through the bend points to the border of the target. */
    private polyline(edge: DiagramEdge, frame: string, bends: Point[]): Point[] {
        const source = this.boundsIn(edge.source, frame);
        const target = this.boundsIn(edge.target, frame);
        const sourceKind = this.nodes.get(edge.source)!.kind;
        const targetKind = this.nodes.get(edge.target)!.kind;
        const sourceAnchor = this.anchor(edge, 'source');
        const targetAnchor = this.anchor(edge, 'target');
        const first = bends[0] ?? (targetAnchor ? anchorPoint(target, targetAnchor) : center(target));
        const last = bends[bends.length - 1] ?? (sourceAnchor ? anchorPoint(source, sourceAnchor) : center(source));
        const start = sourceAnchor ? anchorPoint(source, sourceAnchor)
            : edge.source === frame ? nearestBorderPoint(source, first) : borderPoint(source, sourceKind, first);
        const end = targetAnchor ? anchorPoint(target, targetAnchor)
            : edge.target === frame ? nearestBorderPoint(target, last) : borderPoint(target, targetKind, last);
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
                ...(stored.label ? { label: { ...stored.label } } : {}),
                ...(stored.source ? { source: { ...stored.source } } : {}),
                ...(stored.target ? { target: { ...stored.target } } : {})
            };
        }
        return result;
    }
}

// ---------------------------------------------------------------------------------------------
// Geometry

/**
 * Pinned nodes must not overlap (they may have grown since the layout was stored, e.g. because of a
 * longer text, or the layout was imported from a tool with other fonts): overlapping nodes are pushed
 * to the right or down, whichever is shorter.
 */
function separate(nodes: DiagramNode[]): void {
    const gap = 20;
    for (let iteration = 0; iteration < 100; iteration++) {
        let changed = false;
        const sorted = [...nodes].sort((a, b) => a.x - b.x || a.y - b.y);
        for (let i = 0; i < sorted.length; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
                const a = sorted[i];
                const b = sorted[j];
                if (!overlaps(a, b, 0)) {
                    continue;
                }
                const dx = a.x + a.width + gap - b.x;
                const dy = a.y + a.height + gap - b.y;
                if (dx <= dy || b.y < a.y) {
                    b.x += dx;
                } else {
                    b.y += dy;
                }
                changed = true;
            }
        }
        if (!changed) {
            return;
        }
    }
}

function insideRect(p: Point, rect: Rect): boolean {
    return p.x > rect.x && p.x < rect.x + rect.width && p.y > rect.y && p.y < rect.y + rect.height;
}

function center(rect: Rect): Point {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
    return a.x < b.x + b.width + margin && b.x < a.x + a.width + margin
        && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
}

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

/**
 * The loop of a self transition from anchor `a` to anchor `b` on the border of `rect`: perpendicular out of
 * the side of `a` by `size`, around the corners of the rectangle (the shorter way) and perpendicular back
 * into the side of `b`.
 */
export function selfLoopRoute(rect: Rect, a: EdgeAnchor, b: EdgeAnchor, size: number): Point[] {
    const start = anchorPoint(rect, a);
    const end = anchorPoint(rect, b);
    const na = anchorNormal(a.side);
    const nb = anchorNormal(b.side);
    const out = { x: start.x + na.x * size, y: start.y + na.y * size };
    const back = { x: end.x + nb.x * size, y: end.y + nb.y * size };
    // the corners of the rectangle enlarged by `size`, clockwise from top left; the corner after side i
    // (clockwise: top, right, bottom, left) is corners[(i + 1) % 4]
    const left = rect.x - size;
    const top = rect.y - size;
    const right = rect.x + rect.width + size;
    const bottom = rect.y + rect.height + size;
    const corners: Point[] = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
    const order: AnchorSide[] = ['top', 'right', 'bottom', 'left'];
    const ia = order.indexOf(a.side);
    const ib = order.indexOf(b.side);
    let path: Point[] = [out, back];
    if (ia !== ib) {
        const clockwise: Point[] = [];
        for (let i = ia; i !== ib; i = (i + 1) % 4) {
            clockwise.push(corners[(i + 1) % 4]);
        }
        const counter: Point[] = [];
        for (let i = ia; i !== ib; i = (i + 3) % 4) {
            counter.push(corners[i]);
        }
        const length = (points: Point[]) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
        const cw = [out, ...clockwise, back];
        const ccw = [out, ...counter, back];
        path = clockwise.length < counter.length || (clockwise.length === counter.length && length(cw) <= length(ccw)) ? cw : ccw;
    }
    // without duplicates and points in the middle of straight lines
    const result: Point[] = [];
    for (const p of [start, ...path, end]) {
        const last = result[result.length - 1];
        const before = result[result.length - 2];
        if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) {
            continue;
        }
        if (before && last && ((Math.abs(before.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01)
            || (Math.abs(before.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01))) {
            result[result.length - 1] = p;
            continue;
        }
        result.push(p);
    }
    return result;
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
function shortcut(points: Point[], obstacles: Rect[], ends: Rect[], startNormal?: Point, endNormal?: Point): Point[] {
    const clearance = 8;
    const inflated = obstacles.map(o => ({ x: o.x - clearance, y: o.y - clearance, width: o.width + 2 * clearance, height: o.height + 2 * clearance }));
    // a segment from / to an anchored end must leave / enter its side at an angle of at least 30 degrees
    const outward = (from: Point, to: Point, normal: Point | undefined) => {
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        return !normal || ((to.x - from.x) * normal.x + (to.y - from.y) * normal.y) >= 0.5 * length;
    };
    const last = points.length - 1;
    const free = (a: Point, b: Point) => !inflated.some(o => crossesRect([a, b], o)) && !ends.some(e => crossesRect([a, b], e))
        && (a !== points[0] || outward(a, b, startNormal)) && (b !== points[last] || outward(b, a, endNormal));
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
    const paths = new Map<string, Array<{ id: string, x: number, y: number }>>();
    const visit = (nodes: DiagramNode[], path: Array<{ id: string, x: number, y: number }>, ax: number, ay: number) => {
        for (const node of nodes) {
            const entry = { id: node.id, x: ax + node.x, y: ay + node.y };
            paths.set(node.id, [...path, entry]);
            visit(node.children, [...path, entry], entry.x, entry.y);
        }
    };
    visit(graph.children, [], 0, 0);
    const source = paths.get(edge.source) ?? [];
    const target = paths.get(edge.target) ?? [];
    let origin: Point = { x: 0, y: 0 };
    for (let i = 0; i < Math.min(source.length, target.length) && source[i].id === target[i].id; i++) {
        origin = { x: source[i].x, y: source[i].y };
    }
    if (edge.source === edge.target) {
        const parent = source[source.length - 2];
        origin = parent ? { x: parent.x, y: parent.y } : { x: 0, y: 0 };
    }
    return origin;
}
