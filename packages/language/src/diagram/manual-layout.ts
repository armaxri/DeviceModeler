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
 * layout, otherwise they are drawn as straight lines between the borders of their end points (through the
 * stored bend points, if any).
 */
import type * as ast from '../generated/ast.js';
import type {
    DiagramEdge, DiagramGraph, DiagramLabel, DiagramNode, DiagramNodeKind, LayoutDirection, LayoutOptionsInput, LayoutResult, Point, TextMeasure
} from './diagram-model.js';
import { DiagramMetrics, MACHINE_ID, approximateTextMeasure, layoutStateMachine } from './layout.js';

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
}

/**
 * Computes the diagram of a state machine: the automatic layout, adjusted by the manual layout if one is
 * given and its mode is `manual`. Without a manual layout the result is exactly the automatic layout.
 */
export async function layoutStateMachineWithLayout(machine: ast.StateMachine, options: LayoutOptionsInput = {}, layout?: ManualLayout): Promise<ManualLayoutResult> {
    const auto = await layoutStateMachine(machine, options);
    if (!isManualLayout(layout)) {
        return auto;
    }
    return applyManualLayout(auto, layout, { direction: options.direction, measure: options.measure });
}

/** Applies a manual layout to the result of the automatic layout (which is not modified). */
export function applyManualLayout(auto: LayoutResult, layout: ManualLayout, options: ManualLayoutOptions = {}): ManualLayoutResult {
    return new ManualLayoutEngine(auto.graph, layout, {
        direction: layout.direction ?? options.direction ?? auto.graph.direction,
        measure: options.measure ?? approximateTextMeasure
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
    private readonly localRoutes = new Map<string, { points: Point[], label?: DiagramLabel }>();

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

    private routeEdges(frame: string): void {
        const edges = this.framedEdges.get(frame) ?? [];
        const straight: DiagramEdge[] = [];
        for (const edge of edges) {
            const stored = this.layout.edges[edge.id];
            const label = edge.label ? { ...edge.label } : undefined;
            let route: { points: Point[], label?: DiagramLabel } | undefined;
            if (stored?.bends?.length) {
                const shift = this.shifts.get(frame) ?? { x: 0, y: 0 };
                const bends = stored.bends.map(p => ({ x: p.x + shift.x, y: p.y + shift.y }));
                route = { points: this.polyline(edge, frame, bends), label };
                edge.routing = 'polyline';
                this.placeLabel(route);
            } else {
                route = this.autoRoute(edge, frame);
                if (!route) {
                    straight.push(edge);
                    continue;
                }
            }
            this.applyLabelOffset(route, stored);
            this.localRoutes.set(edge.id, route);
        }
        // straight lines; parallel transitions between the same vertices get a bend to separate them
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
