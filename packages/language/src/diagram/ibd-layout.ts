import { AstUtils, type AstNode } from 'langium';
import type { ELK as ElkApi, ElkExtendedEdge, ElkNode, ElkPort, LayoutOptions } from 'elkjs/lib/elk-api.js';
import * as ast from '../generated/ast.js';
import { docComment } from '../doc/doc-comments.js';
import { resolvedBehavior } from '../structure-imports.js';
import { instanceType, compositeInstances, threadInstances, threadOf, threadSettings } from '../structure-model.js';
import { crossesThreads, portEndpoint, portRoute, routeEndpointsOf, type PortEndpoint } from '../structure-routes.js';
import { portDeclarationText } from '../structure-types.js';
import type { Point, TextMeasure } from './diagram-model.js';
import {
    IBD_OVERVIEW_ID, IBD_TYPES_ID, IbdMetrics, ibdTextWidth, type IbdEdge, type IbdGraph, type IbdLayoutResult, type IbdMember, type IbdNode, type IbdPort, type IbdPortSide
} from './ibd-model.js';
import { approximateTextMeasure } from './layout.js';
import { applyIbdManualLayout, type IbdManualLayout, type IbdManualLayoutResult } from './ibd-manual-layout.js';
import { ibdLayoutFromModel } from './ibd-layout-annotations.js';

/*
 * Layout of the internal block diagram of a structure (see ibd-model.ts) with ELK: layered from left
 * to right with orthogonal routing; the frame of the structure and the threads are compound nodes
 * (hierarchy handling INCLUDE_CHILDREN), ports are fixed on the borders of their nodes.
 *
 * The layout runs twice: the first run (ports on fixed sides: in ports left, out and inout ports
 * right) gives the arrangement of the nodes; the second one puts every port on the side facing the
 * ports it is connected to (a connection running backwards, e.g. a reply, then needs no detour), orders
 * the ports of each side by the position of their partners and routes the connectors.
 */

const M = IbdMetrics;

export interface StructureLayoutOptions {
    /** Text measurement (default: Helvetica metrics). */
    measure?: TextMeasure;
    /** An ELK instance (e.g. one running in a web worker). */
    elk?: unknown;
    /**
     * What to show: the name of a subsystem, system or component type of the file,
     * {@link IBD_OVERVIEW_ID} for all component types or {@link IBD_TYPES_ID} for the data types of a
     * file without component types. Default: see {@link defaultIbdElement}.
     */
    element?: string;
    /**
     * The manual layout applied to the automatic layout: undefined (default) the one described by the
     * layout annotations of the elements of the diagram ({@link ibdLayoutFromModel}), `null` none (the
     * automatic layout).
     */
    layout?: IbdManualLayout | null;
    /**
     * The automatic layout of a previous call for the same text apart from layout annotations (e.g. after
     * a drag in the diagram): it is reused instead of running ELK again if the diagram has the same
     * elements.
     */
    reuse?: IbdGraph;
}

/** An element of a structure file that can be shown as a diagram. */
export interface IbdChoice {
    /** Name of the element, or {@link IBD_OVERVIEW_ID}. */
    id: string;
    label: string;
    kind: IbdGraph['kind'];
}

/**
 * The elements of a file that can be shown: its systems, subsystems and components, the overview of all
 * components, and for a file without component types its data types (structs).
 */
export function ibdChoices(model: ast.StructureModel): IbdChoice[] {
    const result: IbdChoice[] = [];
    const types = model.elements.filter(ast.isComponentType).filter(t => t.name);
    for (const type of types) {
        const kind = ast.isCompositeType(type) ? type.kind : 'component';
        result.push({ id: type.name, label: `${kind} ${type.name}`, kind });
    }
    if (types.filter(ast.isComponent).length > 1) {
        result.push({ id: IBD_OVERVIEW_ID, label: 'all component types', kind: 'overview' });
    }
    if (types.length === 0 && dataTypesOf(model).length > 0) {
        result.push({ id: IBD_TYPES_ID, label: 'data types', kind: 'types' });
    }
    return result;
}

/**
 * The element shown by default: the first system, else the first subsystem, else the overview of the
 * component types (if there are several), else the single component type, else the data types.
 */
export function defaultIbdElement(model: ast.StructureModel): string | undefined {
    const choices = ibdChoices(model);
    return (choices.find(c => c.kind === 'system') ?? choices.find(c => c.kind === 'subsystem') ?? choices.find(c => c.kind === 'overview') ?? choices[0])?.id;
}

/** The structs declared in a file (shown as type boxes next to its diagram). */
export function dataTypesOf(model: ast.StructureModel): ast.StructDeclaration[] {
    return model.elements.filter((e): e is ast.StructDeclaration => ast.isStructDeclaration(e) && !!e.name);
}

/** The element of a structure file containing the offset (a component type), for selecting the diagram by the cursor. */
export function ibdElementAt(model: ast.StructureModel, offset: number): string | undefined {
    for (const element of model.elements) {
        const cst = element.$cstNode;
        if (ast.isComponentType(element) && element.name && cst && cst.offset <= offset && offset <= cst.end) {
            return element.name;
        }
    }
    return undefined;
}

type ElkInstance = Pick<ElkApi, 'layout'>;
let defaultElk: ElkInstance | undefined;

async function createDefaultElk(): Promise<ElkInstance> {
    type ElkConstructor = new () => ElkInstance;
    const module = await import('elkjs/lib/elk.bundled.js') as unknown as { default: ElkConstructor | { default: ElkConstructor } };
    const Constructor = typeof module.default === 'function' ? module.default : module.default.default;
    return new Constructor();
}

/**
 * Computes the diagram of a structure file: the internal block diagram of a subsystem or system, a
 * component type as a block with its ports, all component types of the file or (a file without
 * component types) its data types (see {@link StructureLayoutOptions.element}). The structs declared
 * in the file are added as unconnected type boxes below the diagram (see
 * {@link addTypeBoxes}). `undefined` if the file declares neither component types nor data types.
 */
export async function layoutStructure(model: ast.StructureModel, options: StructureLayoutOptions = {}): Promise<IbdManualLayoutResult | undefined> {
    const id = options.element && ibdChoices(model).some(c => c.id === options.element) ? options.element : defaultIbdElement(model);
    if (!id) {
        return undefined;
    }
    const measure = options.measure ?? approximateTextMeasure;
    let auto: IbdLayoutResult | undefined;
    if (options.reuse) {
        // the elements and ids of the diagram without running ELK, then the positions of the previous layout
        const elements = await automaticLayout(model, id, measure, undefined);
        if (sameDiagramIds(elements.graph, options.reuse)) {
            auto = { ...elements, graph: options.reuse };
        }
    }
    auto ??= await automaticLayout(model, id, measure, options.elk as ElkInstance | undefined ?? (defaultElk ??= await createDefaultElk()));
    const manual = options.layout === undefined ? ibdLayoutFromModel(model, auto) : options.layout ?? undefined;
    if (!manual) {
        return { ...auto, auto: auto.graph };
    }
    return { ...applyIbdManualLayout(auto, manual, { measure }), auto: auto.graph };
}

/**
 * The elements of the diagram of a structure file (see {@link StructureLayoutOptions.element}) with their
 * ids and hierarchy, without laying them out (cheap; e.g. to compute layout annotations of a changed
 * model). `undefined` if there is nothing to show.
 */
export async function structureDiagramElements(model: ast.StructureModel, options: Pick<StructureLayoutOptions, 'element' | 'measure'> = {}): Promise<IbdLayoutResult | undefined> {
    const id = options.element && ibdChoices(model).some(c => c.id === options.element) ? options.element : defaultIbdElement(model);
    return id ? automaticLayout(model, id, options.measure ?? approximateTextMeasure, undefined) : undefined;
}

/** The automatic layout of the diagram `id`; without `elk` only the elements and ids (not laid out). */
async function automaticLayout(model: ast.StructureModel, id: string, measure: TextMeasure, elk: ElkInstance | undefined): Promise<IbdLayoutResult> {
    let result: IbdLayoutResult;
    if (id === IBD_TYPES_ID) {
        result = {
            graph: { id: IBD_TYPES_ID, name: 'Data types', kind: 'types', width: 0, height: 0, children: [], edges: [] },
            elements: new Map(), ids: new Map(), instances: new Map()
        };
    } else if (id === IBD_OVERVIEW_ID) {
        result = new BlockBuilder(measure).overview(model.elements.filter(ast.isComponent));
    } else {
        const type = model.elements.find((e): e is ast.ComponentType => ast.isComponentType(e) && e.name === id)!;
        if (ast.isComponent(type)) {
            result = new BlockBuilder(measure).single(type);
        } else {
            result = await new IbdBuilder(type, measure).build(elk);
        }
    }
    addTypeBoxes(result, dataTypesOf(model), measure);
    return result;
}

/** Whether two diagrams have the same nodes, ports and edges (by id; the layout may reorder the ports of a node). */
function sameDiagramIds(a: IbdGraph, b: IbdGraph): boolean {
    const key = (graph: IbdGraph) => [
        ...ibdNodes(graph).map(({ node, parent }) => `${parent?.id ?? ''}/${node.id}:${node.ports.map(p => p.id).sort().join(',')}`),
        ...graph.edges.map(e => `${e.id}:${e.source}->${e.target}`)
    ].join('\n');
    return a.id === b.id && key(a) === key(b);
}

// ---------------------------------------------------------------------------------------------
// Shared helpers

const textWidth = ibdTextWidth;

function behaviorOf(type: ast.ComponentType | undefined): IbdNode['behavior'] {
    if (!ast.isComponent(type) || !type.behavior) {
        return undefined;
    }
    const resolved = resolvedBehavior(type.behavior);
    return { machine: resolved.machine?.name ?? type.behavior.machine?.$refText, uri: resolved.uri?.toString() ?? resolved.machine?.$document?.uri.toString() };
}

function descriptionOf(node: AstNode & { description?: string }): string | undefined {
    return node.description ?? docComment(node);
}

function stereotypeOf(type: ast.ComponentType | undefined): string | undefined {
    return !type ? undefined : ast.isCompositeType(type) ? type.kind : 'component';
}

/**
 * An instance or component block: header (stereotype, name), the in ports on the left and the out and
 * inout ports on the right (the layout may move them to the other side), port labels inside.
 */
function blockNode(id: string, kind: 'instance' | 'block', name: string, type: ast.ComponentType | undefined, typeName: string | undefined,
    measure: TextMeasure, description: string | undefined): IbdNode {
    const title = typeName !== undefined ? `${name} : ${typeName}` : name;
    const stereotype = stereotypeOf(type);
    const node: IbdNode = {
        id, kind, name, typeName, stereotype, description,
        x: 0, y: 0, width: 0, height: 0,
        headerHeight: M.instanceHeader,
        behavior: behaviorOf(type),
        composite: ast.isCompositeType(type) ? { structure: type.name, uri: AstUtils.findRootNode(type).$document?.uri.toString() } : undefined,
        ports: [],
        children: []
    };
    const icon = node.behavior || node.composite ? M.iconWidth : 0;
    const headerWidth = Math.max(textWidth(measure, title, M.nameFont, true), textWidth(measure, `«${stereotype ?? ''}»`, M.stereotypeFont)) + icon;
    for (const port of type?.ports ?? []) {
        if (!port.name) {
            continue;
        }
        node.ports.push(ibdPort(`${id}.${port.name}`, port, defaultPortSide(port), measure));
    }
    const left = Math.max(0, ...node.ports.filter(p => p.side === 'WEST').map(p => p.label.width));
    const right = Math.max(0, ...node.ports.filter(p => p.side === 'EAST').map(p => p.label.width));
    const inset = M.portSize / 2 + 5;
    node.width = Math.ceil(Math.max(headerWidth + 2 * M.instancePadding, left + right + 2 * inset + M.instancePadding * 2, M.instanceMinWidth));
    arrangeBlockPorts(node);
    return node;
}

/** The side of a port before the layout puts it on the side of its partners: in ports left, out and inout ports right. */
function defaultPortSide(port: ast.Port): IbdPortSide {
    return port.direction === 'in' ? 'WEST' : 'EAST';
}

function ibdPort(id: string, port: ast.Port, side: IbdPortSide, measure: TextMeasure): IbdPort {
    const typeName = port.type?.name || undefined;
    const text = typeName ? `${port.name} : ${typeName}` : port.name;
    const width = textWidth(measure, text, M.portFont);
    return {
        id, name: port.name, direction: port.direction, kind: port.kind, typeName,
        title: portDeclarationText(port),
        side, x: 0, y: 0, size: M.portSize,
        label: { text, x: 0, y: 0, width, height: M.portFont + 3 }
    };
}

/**
 * Positions the ports of an instance or block in rows below the header (in their order per side) and
 * their labels inside the node; sets the height of the node.
 */
function arrangeBlockPorts(node: IbdNode): void {
    const half = M.portSize / 2;
    const inset = half + 5;
    const top = node.headerHeight + 4;
    let rows = 0;
    for (const side of ['WEST', 'EAST'] as const) {
        const ports = node.ports.filter(p => p.side === side);
        ports.forEach((port, i) => {
            const center = top + M.portRow * (i + 0.5);
            port.x = side === 'WEST' ? -half : node.width - half;
            port.y = center - half;
            port.label.x = side === 'WEST' ? inset : node.width - inset - port.label.width;
            port.label.y = center - port.label.height / 2;
        });
        rows = Math.max(rows, ports.length);
    }
    node.height = Math.max(top + rows * M.portRow + 8, 56);
}

// ---------------------------------------------------------------------------------------------
// Component types as blocks

class BlockBuilder {

    private readonly elements = new Map<string, AstNode>();
    private readonly ids = new Map<AstNode, string>();
    private readonly used = new Set<string>();

    constructor(private readonly measure: TextMeasure) { }

    private block(type: ast.Component): IbdNode {
        let id = type.name;
        for (let i = 1; this.used.has(id); i++) {
            id = `${type.name}~${i}`;
        }
        this.used.add(id);
        const node = blockNode(id, 'block', type.name, type, undefined, this.measure, descriptionOf(type));
        this.elements.set(id, type);
        this.ids.set(type, id);
        for (const port of node.ports) {
            const astPort = type.ports.find(p => p.name === port.name);
            if (astPort) {
                this.elements.set(port.id, astPort);
            }
        }
        return node;
    }

    single(type: ast.Component): IbdLayoutResult {
        const node = this.block(type);
        // room for the ports outside of the block
        node.x = M.graphPadding + M.portSize;
        node.y = M.graphPadding;
        const graph: IbdGraph = {
            id: `${node.id}#block`, name: type.name, kind: 'component',
            width: node.width + 2 * (M.graphPadding + M.portSize), height: node.height + 2 * M.graphPadding,
            children: [node], edges: []
        };
        return { graph, elements: this.elements, ids: this.ids, instances: new Map() };
    }

    /** All component types in rows (in text order), wrapped at a width of about 1000 px. */
    overview(types: ast.Component[]): IbdLayoutResult {
        const nodes = types.filter(t => t.name).map(t => this.block(t));
        const spacing = 36;
        const maxWidth = Math.max(1000, ...nodes.map(n => n.width));
        let x = M.graphPadding + M.portSize;
        let y = M.graphPadding;
        let rowHeight = 0;
        let width = 0;
        for (const node of nodes) {
            if (x + node.width > maxWidth && rowHeight > 0) {
                x = M.graphPadding + M.portSize;
                y += rowHeight + spacing;
                rowHeight = 0;
            }
            node.x = x;
            node.y = y;
            x += node.width + spacing;
            rowHeight = Math.max(rowHeight, node.height);
            width = Math.max(width, node.x + node.width);
        }
        const graph: IbdGraph = {
            id: IBD_OVERVIEW_ID, name: 'Component types', kind: 'overview',
            width: width + M.portSize + M.graphPadding, height: y + rowHeight + M.graphPadding,
            children: nodes, edges: []
        };
        return { graph, elements: this.elements, ids: this.ids, instances: new Map() };
    }
}

// ---------------------------------------------------------------------------------------------
// Data types (structs) as type boxes

/** The text of a member row of a type box: `x : real`. */
export function memberText(member: IbdMember): string {
    return `${member.prefix ?? ''}${member.name}${member.type ? ` : ${member.type}` : ''}`;
}

/** A type box: «struct», the name, the fields in a compartment below. */
function typeNode(id: string, type: ast.StructDeclaration, measure: TextMeasure): IbdNode {
    const members: IbdMember[] = type.fields.filter(f => f.name).map(f => ({ name: f.name, type: f.type?.name }));
    const stereotype = 'struct';
    const widths = [
        textWidth(measure, type.name, M.nameFont, true),
        textWidth(measure, `«${stereotype}»`, M.stereotypeFont),
        ...members.map(m => textWidth(measure, memberText(m), M.memberFont))
    ];
    return {
        id, kind: 'type', name: type.name, stereotype, description: descriptionOf(type),
        x: 0, y: 0,
        width: Math.ceil(Math.max(100, ...widths) + 2 * M.instancePadding),
        height: M.instanceHeader + Math.max(1, members.length) * M.memberRow + 10,
        headerHeight: M.instanceHeader,
        members,
        ports: [],
        children: []
    };
}

/**
 * Adds the structs of the file to a diagram as type boxes (in text order, in rows below
 * the diagram, left aligned with it, wrapped at its width – at least about 700 px). They are not
 * connected to anything: ports show their type in their label.
 */
export function addTypeBoxes(result: IbdLayoutResult, types: readonly ast.StructDeclaration[], measure: TextMeasure = approximateTextMeasure): void {
    const graph = result.graph;
    if (types.length === 0) {
        return;
    }
    const used = new Set(ibdNodes(graph).map(n => n.node.id));
    const nodes = types.map(type => {
        let id = `type:${type.name}`;
        for (let i = 1; used.has(id); i++) {
            id = `type:${type.name}~${i}`;
        }
        used.add(id);
        const node = typeNode(id, type, measure);
        result.elements.set(id, type);
        result.ids.set(type, id);
        return node;
    });
    const empty = graph.children.length === 0;
    const left = empty ? M.graphPadding : Math.min(...graph.children.map(c => c.x));
    const top = empty ? M.graphPadding : graph.height + (graph.kind === 'subsystem' || graph.kind === 'system' ? 0 : M.typeSpacing - M.graphPadding);
    const right = Math.max(left + 700, empty ? 0 : Math.max(...graph.children.map(c => c.x + c.width)));
    let x = left;
    let y = top;
    let rowHeight = 0;
    let width = graph.width;
    for (const node of nodes) {
        if (x > left && x + node.width > right) {
            x = left;
            y += rowHeight + M.typeSpacing;
            rowHeight = 0;
        }
        node.x = x;
        node.y = y;
        x += node.width + M.typeSpacing;
        rowHeight = Math.max(rowHeight, node.height);
        width = Math.max(width, node.x + node.width + M.graphPadding);
    }
    graph.children.push(...nodes);
    graph.width = width;
    graph.height = y + rowHeight + M.graphPadding;
}

// ---------------------------------------------------------------------------------------------
// Internal block diagram of a structure

interface EdgeInfo {
    edge: IbdEdge;
    /** Reversed for the layout (the edge runs backwards: its source is right of its target). */
    reversed: boolean;
}

class IbdBuilder {

    private readonly elements = new Map<string, AstNode>();
    private readonly ids = new Map<AstNode, string>();
    private readonly instances = new Map<string, AstNode>();
    private readonly used = new Set<string>();
    /** diagram id -> node */
    private readonly nodes = new Map<string, IbdNode>();
    /** port id -> port and its node */
    private readonly ports = new Map<string, { port: IbdPort, node: IbdNode }>();
    /** node id -> id of the parent node (undefined for the frame) */
    private readonly parents = new Map<string, string>();
    private readonly edges: EdgeInfo[] = [];
    private frame!: IbdNode;

    constructor(private readonly structure: ast.CompositeType, private readonly measure: TextMeasure) { }

    private unique(base: string): string {
        let id = base;
        for (let i = 1; this.used.has(id); i++) {
            id = `${base}~${i}`;
        }
        this.used.add(id);
        return id;
    }

    /** The diagram laid out with ELK; without `elk` only its elements (not laid out). */
    async build(elk: ElkInstance | undefined): Promise<IbdLayoutResult> {
        this.createNodes();
        this.createEdges();
        if (!elk) {
            const graph: IbdGraph = {
                id: this.frame.id, name: this.structure.name, kind: this.structure.kind, width: 0, height: 0,
                children: [this.frame], edges: this.edges.map(e => e.edge)
            };
            return { graph, elements: this.elements, ids: this.ids, instances: this.instances };
        }
        // first run: arrangement of the nodes; then the sides and the order of the ports are adjusted
        // to the arrangement (twice: the order depends on the sides of the partners)
        const first = await elk.layout(this.elkGraph());
        this.assignPortSides(this.absoluteCenters(first));
        const intermediate = await elk.layout(this.elkGraph());
        this.assignPortSides(this.absoluteCenters(intermediate));
        // last run: final positions and routes
        const second = await elk.layout(this.elkGraph());
        this.applyLayout(second);
        const graph: IbdGraph = {
            id: this.frame.id, name: this.structure.name, kind: this.structure.kind,
            width: second.width ?? 0,
            height: second.height ?? 0,
            children: [this.frame],
            edges: this.edges.map(e => e.edge)
        };
        return { graph, elements: this.elements, ids: this.ids, instances: this.instances };
    }

    // -----------------------------------------------------------------------------------------
    // Nodes

    private createNodes(): void {
        const structure = this.structure;
        const s = structure.name;
        const id = this.unique(s);
        const kindLabel = `ibd [${structure.kind}] ${s}`;
        this.frame = {
            id, kind: 'frame', name: s, stereotype: structure.kind, description: descriptionOf(structure),
            x: 0, y: 0, width: 0, height: 0,
            headerHeight: M.tabHeight,
            ports: [],
            children: []
        };
        this.frame.details = kindLabel;
        this.frame.tabWidth = textWidth(this.measure, kindLabel, M.tabFont, true) + 26;
        this.register(this.frame, structure);
        for (const port of structure.ports) {
            if (!port.name) {
                continue;
            }
            const ibd = ibdPort(this.unique(`${s}.${port.name}`), port, defaultPortSide(port), this.measure);
            this.frame.ports.push(ibd);
            this.ports.set(ibd.id, { port: ibd, node: this.frame });
            this.elements.set(ibd.id, port);
            this.ids.set(port, ibd.id);
        }
        // threads (with their instances), then the instances outside of threads, in text order
        for (const thread of structure.threads) {
            if (!thread.name) {
                continue;
            }
            const threadNode = this.threadNode(thread);
            this.frame.children.push(threadNode);
            this.parents.set(threadNode.id, this.frame.id);
            for (const instance of threadInstances(thread)) {
                if (threadOf(instance) === thread && !this.ids.has(instance)) {
                    threadNode.children.push(this.instanceNode(instance, threadNode.id));
                }
            }
        }
        for (const instance of compositeInstances(structure)) {
            if (!this.ids.has(instance) && instance.name) {
                this.frame.children.push(this.instanceNode(instance, this.frame.id));
            }
        }
    }

    private register(node: IbdNode, astNode: AstNode): void {
        this.nodes.set(node.id, node);
        this.elements.set(node.id, astNode);
        this.ids.set(astNode, node.id);
    }

    private threadNode(thread: ast.Thread): IbdNode {
        const settings = threadSettings(thread);
        const details = [
            settings.priority !== undefined ? `priority ${settings.priority}` : undefined,
            settings.period !== undefined ? `period ${settings.period}` : undefined,
            settings.stack !== undefined ? `stack ${settings.stack}` : undefined
        ].filter(d => d !== undefined).join(' · ');
        const node: IbdNode = {
            id: this.unique(`${this.structure.name}/thread:${thread.name}`),
            kind: 'thread', name: thread.name, stereotype: 'thread', details: details || undefined, description: descriptionOf(thread),
            x: 0, y: 0,
            width: Math.max(textWidth(this.measure, `«thread» ${thread.name}`, M.nameFont, true), textWidth(this.measure, details, M.detailsFont)) + 2 * M.threadPadding,
            height: 0,
            headerHeight: M.threadHeaderLine * (details ? 2 : 1) + 8,
            ports: [],
            children: []
        };
        node.height = node.headerHeight + 40;
        this.register(node, thread);
        return node;
    }

    private instanceNode(instance: ast.ComponentInstance, parentId: string): IbdNode {
        const type = instanceType(instance);
        const typeName = type?.name ?? instance.type?.$refText ?? '?';
        const id = this.unique(`${this.structure.name}/${instance.name}`);
        const node = blockNode(id, 'instance', instance.name, type, typeName, this.measure, descriptionOf(instance) ?? (type ? descriptionOf(type) : undefined));
        this.register(node, instance);
        this.parents.set(id, parentId);
        for (const port of node.ports) {
            this.used.add(port.id);
            this.ports.set(port.id, { port, node });
            const astPort = type?.ports.find(p => p.name === port.name);
            if (astPort) {
                this.elements.set(port.id, astPort);
                this.instances.set(port.id, instance);
            }
        }
        return node;
    }

    /** The id of the port of an instance (or of a boundary port) denoted by a port reference. */
    private portIdOf(reference: ast.PortReference | undefined): string | undefined {
        const port = reference?.port?.ref;
        if (!reference || !port) {
            return undefined;
        }
        if (reference.instance) {
            const instance = reference.instance.ref;
            const nodeId = instance && this.ids.get(instance);
            const id = nodeId ? `${nodeId}.${port.name}` : undefined;
            return id && this.ports.has(id) ? id : undefined;
        }
        return this.ids.get(port);
    }

    private createEdges(): void {
        const s = this.structure.name;
        const statements: Array<ast.Connection | ast.Delegation> = [...this.structure.connections, ...this.structure.delegations];
        for (const statement of statements) {
            const source = this.portIdOf(statement.source);
            const target = this.portIdOf(statement.target);
            if (!source || !target || source === target) {
                continue;
            }
            const text = `${statement.source.instance ? `${statement.source.instance.$refText}.` : ''}${statement.source.port.$refText}`
                + `->${statement.target.instance ? `${statement.target.instance.$refText}.` : ''}${statement.target.port.$refText}`;
            const kind = ast.isConnection(statement) ? 'connect' : 'delegate';
            const edge: IbdEdge = {
                id: this.unique(`${s}/${text}`),
                kind, source, target,
                ...(statement.source.port.ref?.direction === 'inout' && statement.target.port.ref?.direction === 'inout' ? { bidirectional: true } : {}),
                crossThread: ast.isConnection(statement) && crossesThreads(statement),
                title: `${kind} ${text.replace('->', ' -> ')}`,
                points: []
            };
            this.edges.push({ edge, reversed: false });
            this.elements.set(edge.id, statement);
            this.ids.set(statement, edge.id);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Port sides and order

    /** Absolute centers of the nodes after a layout run. */
    private absoluteCenters(root: ElkNode): Map<string, Point> {
        const result = new Map<string, Point>();
        const visit = (node: ElkNode, dx: number, dy: number) => {
            for (const child of node.children ?? []) {
                const x = dx + (child.x ?? 0);
                const y = dy + (child.y ?? 0);
                result.set(child.id, { x: x + (child.width ?? 0) / 2, y: y + (child.height ?? 0) / 2 });
                // absolute positions of the ports (centers)
                for (const port of child.ports ?? []) {
                    result.set(port.id, { x: x + (port.x ?? 0) + (port.width ?? 0) / 2, y: y + (port.y ?? 0) + (port.height ?? 0) / 2 });
                }
                visit(child, x, y);
            }
        };
        visit(root, 0, 0);
        return result;
    }

    /**
     * Puts each port of an instance on the side facing its partners (by default in ports left, out and
     * inout ports right), orders the ports of each side by the vertical position of their partners and
     * reverses edges running backwards (from right to left) for the second layout run.
     */
    private assignPortSides(centers: Map<string, Point>): void {
        const partners = new Map<string, string[]>();
        const add = (port: string, partner: string) => partners.set(port, [...partners.get(port) ?? [], partner]);
        for (const { edge } of this.edges) {
            add(edge.source, edge.target);
            add(edge.target, edge.source);
        }
        for (const node of this.nodes.values()) {
            if (node.kind !== 'instance') {
                continue;
            }
            const center = centers.get(node.id);
            if (!center) {
                continue;
            }
            for (const port of node.ports) {
                // the partners: ports of other instances (boundary ports are seen from inside the frame)
                const xs = (partners.get(port.id) ?? []).map(p => this.partnerX(p, centers)).filter((x): x is number => x !== undefined);
                if (xs.length > 0) {
                    const average = xs.reduce((a, b) => a + b, 0) / xs.length;
                    if (Math.abs(average - center.x) > 1) {
                        port.side = average < center.x ? 'WEST' : 'EAST';
                    }
                }
            }
        }
        // the order of the ports of each side: by the vertical position of their partners, node by node
        // from left to right (with the order already chosen for the nodes to the left)
        const tops = new Map<string, Point>();
        for (const node of this.nodes.values()) {
            const center = centers.get(node.id);
            if (center) {
                tops.set(node.id, { x: center.x - node.width / 2, y: center.y - node.height / 2 });
            }
        }
        const portY = (portId: string): number | undefined => {
            const entry = this.ports.get(portId);
            const top = entry && tops.get(entry.node.id);
            if (!entry || !top || entry.node === this.frame) {
                return centers.get(portId)?.y;
            }
            return top.y + entry.port.y + entry.port.size / 2;
        };
        const instances = [...this.nodes.values()].filter(n => n.kind === 'instance' && tops.has(n.id))
            .sort((a, b) => tops.get(a.id)!.x - tops.get(b.id)!.x);
        for (const node of instances) {
            const key = (port: IbdPort) => {
                const ys = (partners.get(port.id) ?? []).map(portY).filter((y): y is number => y !== undefined);
                return ys.length > 0 ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY;
            };
            const keys = new Map(node.ports.map(p => [p.id, key(p)]));
            const order = new Map(node.ports.map((p, i) => [p.id, i]));
            // unconnected ports keep their place after the connected ones
            node.ports.sort((a, b) => (keys.get(a.id)! - keys.get(b.id)!) || (order.get(a.id)! - order.get(b.id)!));
            // the labels of both sides must fit
            const inset = M.portSize / 2 + 5;
            const left = Math.max(0, ...node.ports.filter(p => p.side === 'WEST').map(p => p.label.width));
            const right = Math.max(0, ...node.ports.filter(p => p.side === 'EAST').map(p => p.label.width));
            node.width = Math.max(node.width, Math.ceil(left + right + 2 * inset + 2 * M.instancePadding));
            arrangeBlockPorts(node);
        }
        // edges whose source port is right of the target port run backwards
        for (const info of this.edges) {
            const source = this.ports.get(info.edge.source);
            const target = this.ports.get(info.edge.target);
            if (!source || !target || source.node === this.frame || target.node === this.frame) {
                continue;
            }
            info.reversed = source.port.side === 'WEST' && target.port.side === 'EAST';
        }
    }

    /** x of a partner port: for boundary ports, the inside of the frame border. */
    private partnerX(portId: string, centers: Map<string, Point>): number | undefined {
        const entry = this.ports.get(portId);
        if (entry?.node === this.frame) {
            const frame = centers.get(this.frame.id);
            return entry.port.side === 'WEST' ? (frame ? frame.x - 1e6 : undefined) : (frame ? frame.x + 1e6 : undefined);
        }
        return centers.get(portId)?.x;
    }

    // -----------------------------------------------------------------------------------------
    // ELK graph

    private algorithmOptions(): LayoutOptions {
        return {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.edgeRouting': 'ORTHOGONAL',
            'elk.spacing.nodeNode': '28',
            'elk.spacing.edgeNode': '18',
            'elk.spacing.edgeEdge': '10',
            'elk.spacing.portPort': '10',
            'elk.layered.spacing.nodeNodeBetweenLayers': '56',
            'elk.layered.spacing.edgeNodeBetweenLayers': '20',
            'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
            'elk.layered.unnecessaryBendpoints': 'true'
        };
    }

    private elkGraph(): ElkNode {
        const outside = this.outsideLabelWidth();
        const frame = this.elkCompound(this.frame, {
            'elk.padding': `[top=${M.tabHeight + M.framePadding},left=${M.framePadding + M.portSize},bottom=${M.framePadding},right=${M.framePadding + M.portSize}]`,
            'elk.portConstraints': 'FIXED_SIDE',
            'elk.port.borderOffset': String(-M.portSize / 2),
            'elk.spacing.portPort': '16',
            'elk.nodeSize.constraints': 'MINIMUM_SIZE PORTS',
            'elk.nodeSize.minimum': `(${this.tabWidth() + 60}, 80)`
        });
        frame.edges = [];
        const root: ElkNode = {
            id: '#root',
            layoutOptions: {
                ...this.algorithmOptions(),
                'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
                'elk.json.edgeCoords': 'ROOT',
                'elk.padding': `[top=${M.graphPadding},left=${M.graphPadding + outside},bottom=${M.graphPadding},right=${M.graphPadding + outside}]`
            },
            children: [frame],
            edges: []
        };
        for (const { edge, reversed } of this.edges) {
            const elkEdge: ElkExtendedEdge = reversed
                ? { id: edge.id, sources: [edge.target], targets: [edge.source] }
                : { id: edge.id, sources: [edge.source], targets: [edge.target] };
            frame.edges.push(elkEdge);
        }
        return root;
    }

    private elkCompound(node: IbdNode, options: LayoutOptions): ElkNode {
        const elkNode: ElkNode = {
            id: node.id,
            layoutOptions: { ...this.algorithmOptions(), ...options },
            ports: node.ports.map(port => this.elkPort(port, node)),
            children: node.children.map(child => child.kind === 'thread'
                ? this.elkCompound(child, {
                    'elk.padding': `[top=${child.headerHeight + 12},left=${M.threadPadding},bottom=${M.threadPadding},right=${M.threadPadding}]`,
                    'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                    'elk.nodeSize.minimum': `(${child.width}, ${child.height})`
                })
                : this.elkLeaf(child))
        };
        return elkNode;
    }

    private elkLeaf(node: IbdNode): ElkNode {
        return {
            id: node.id,
            width: node.width,
            height: node.height,
            layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
            ports: node.ports.map(port => this.elkPort(port, node))
        };
    }

    private elkPort(port: IbdPort, node: IbdNode): ElkPort {
        const elkPort: ElkPort = {
            id: port.id,
            width: port.size,
            height: port.size,
            layoutOptions: { 'elk.port.side': port.side }
        };
        if (node.kind !== 'frame') {
            elkPort.x = port.x;
            elkPort.y = port.y;
        }
        return elkPort;
    }

    private tabWidth(): number {
        return this.frame.tabWidth ?? 0;
    }

    /** Width of the labels of the boundary ports (outside of the frame). */
    private outsideLabelWidth(): number {
        return Math.max(0, ...this.frame.ports.map(p => p.label.width + 6));
    }

    // -----------------------------------------------------------------------------------------
    // Results

    private applyLayout(root: ElkNode): void {
        const visit = (elkNode: ElkNode) => {
            for (const child of elkNode.children ?? []) {
                const node = this.nodes.get(child.id);
                if (node) {
                    node.x = child.x ?? 0;
                    node.y = child.y ?? 0;
                    node.width = child.width ?? node.width;
                    node.height = child.height ?? node.height;
                    if (node.kind === 'frame') {
                        for (const elkPort of child.ports ?? []) {
                            const port = node.ports.find(p => p.id === elkPort.id);
                            if (port) {
                                port.x = elkPort.x ?? 0;
                                port.y = elkPort.y ?? 0;
                            }
                        }
                    }
                }
                visit(child);
            }
        };
        visit(root);
        // boundary ports: centered on the border, the label outside of the frame
        for (const port of this.frame.ports) {
            const half = M.portSize / 2;
            port.side = port.x + half <= this.frame.width / 2 ? 'WEST' : 'EAST';
            port.x = port.side === 'WEST' ? -half : this.frame.width - half;
            const center = { x: port.x + half, y: port.y + half };
            port.label.x = port.side === 'WEST' ? center.x - half - 4 - port.label.width : center.x + half + 4;
            port.label.y = center.y - port.label.height - 2;
        }
        const elkEdges = new Map<string, ElkExtendedEdge>();
        const collect = (node: ElkNode) => {
            (node.edges ?? []).forEach(e => elkEdges.set(e.id, e));
            (node.children ?? []).forEach(collect);
        };
        collect(root);
        for (const { edge, reversed } of this.edges) {
            const section = elkEdges.get(edge.id)?.sections?.[0];
            if (!section) {
                continue;
            }
            const points = [section.startPoint, ...section.bendPoints ?? [], section.endPoint].map(p => ({ x: p.x, y: p.y }));
            edge.points = reversed ? points.reverse() : points;
        }
        this.attachEdges();
    }

    /**
     * Moves the ends of the connectors exactly onto the port squares: the outer side of the ports of
     * instances, the inner side of the boundary ports (ELK keeps a distance to the ports).
     */
    private attachEdges(): void {
        const squares = new Map<string, { x: number, y: number, port: IbdPort, boundary: boolean }>();
        for (const { node, x, y } of ibdNodes({ children: [this.frame] } as IbdGraph)) {
            for (const port of node.ports) {
                squares.set(port.id, { x: x + port.x, y: y + port.y, port, boundary: node === this.frame });
            }
        }
        const attach = (points: Point[], index: number, neighbor: number, portId: string) => {
            const square = squares.get(portId);
            const point = points[index];
            const next = points[neighbor];
            if (!square || !point) {
                return;
            }
            const size = square.port.size;
            const left = square.port.side === 'WEST' ? !square.boundary : square.boundary;
            const x = left ? square.x : square.x + size;
            const y = square.y + size / 2;
            if (next && Math.abs(next.y - point.y) < 0.5) {
                next.y = y;
            }
            point.x = x;
            point.y = y;
        };
        for (const { edge } of this.edges) {
            if (edge.points.length >= 2) {
                attach(edge.points, 0, 1, edge.source);
                attach(edge.points, edge.points.length - 1, edge.points.length - 2, edge.target);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Routes

/**
 * The diagram elements on the route of the selected element (see structure-routes.ts): the ports, connectors
 * and delegations of the route in the shown structure and the instances owning the ports. Starts: a port
 * of an instance or a boundary port (the whole net of the port), an instance (the nets of all its ports),
 * a connection or delegation. `undefined` if the element has no route (threads, the frame, blocks).
 */
export function ibdRouteElements(layout: IbdLayoutResult, id: string): Set<string> | undefined {
    const structure = layout.elements.get(layout.graph.id);
    const node = layout.elements.get(id);
    if (!ast.isCompositeType(structure) || !node || node === structure || ast.isThread(node)) {
        return undefined;
    }
    let starts: PortEndpoint[];
    if (ast.isPort(node)) {
        const instance = layout.instances.get(id);
        if (instance && !ast.isComponentInstance(instance)) {
            return undefined;
        }
        starts = [portEndpoint(structure, instance, node)];
    } else if (ast.isComponentInstance(node) || ast.isConnection(node) || ast.isDelegation(node)) {
        starts = routeEndpointsOf(node);
    } else {
        return undefined;
    }
    const route = portRoute(starts);
    const portIds = new Map<AstNode, Map<ast.Port, string>>();
    for (const [elementId, element] of layout.elements) {
        if (ast.isPort(element)) {
            const owner = layout.instances.get(elementId) ?? structure;
            const ports = portIds.get(owner) ?? new Map<ast.Port, string>();
            ports.set(element, elementId);
            portIds.set(owner, ports);
        }
    }
    const result = new Set<string>([id]);
    for (const endpoint of route.endpoints) {
        if (endpoint.path.length > 0 || endpoint.structure !== structure) {
            continue;
        }
        const portId = portIds.get(endpoint.instance ?? structure)?.get(endpoint.port);
        if (portId) {
            result.add(portId);
        }
        const instanceId = endpoint.instance && layout.ids.get(endpoint.instance);
        if (instanceId) {
            result.add(instanceId);
        }
    }
    for (const hop of route.hops) {
        const edgeId = hop.node && hop.from.path.length === 0 ? layout.ids.get(hop.node) : undefined;
        if (edgeId) {
            result.add(edgeId);
        }
    }
    return result;
}

/** All nodes of the diagram (depth first) with their absolute positions. */
export function ibdNodes(graph: IbdGraph): Array<{ node: IbdNode, x: number, y: number, parent?: IbdNode }> {
    const result: Array<{ node: IbdNode, x: number, y: number, parent?: IbdNode }> = [];
    const visit = (node: IbdNode, dx: number, dy: number, parent?: IbdNode) => {
        const x = dx + node.x;
        const y = dy + node.y;
        result.push({ node, x, y, parent });
        node.children.forEach(child => visit(child, x, y, node));
    };
    graph.children.forEach(child => visit(child, 0, 0));
    return result;
}
