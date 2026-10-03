import { AstUtils, type AstNode } from 'langium';
import * as ast from './generated/ast.js';
import { enclosingStructure, instanceType, isCompositeType, structureInstances, threadOf } from './dmf-model.js';

/**
 * Route analysis of structure models: the signal paths across connections (`connect`), delegations
 * (`delegate`) and the boundaries of composite instances through all levels of the hierarchy.
 * Pure functions over the (linked) AST, used by the validator, the language server ("go to
 * provider") and the diagram (highlighting the route of a selected port or instance).
 *
 * Endpoints are ports in the *instance tree* of a root structure: a structure that is instantiated
 * several times has several sets of endpoints, distinguished by the instance path from the root
 * ({@link PortEndpoint.path}). The root is the structure the analysis starts at (by default the
 * structure containing the node a query starts from, see {@link RouteOptions}); boundary ports of the
 * root are the ends of a route towards the outside.
 *
 * All hops are directed in *request direction*: from the side that requires a service (calls an
 * operation, reads data, sends an event) to the side that provides it:
 * - `connect a.r -> b.p`: from the required port `a.r` to the provided port `b.p`,
 * - `delegate p -> inst.q` (provided): from the boundary port `p` to the inner port `inst.q`,
 * - `delegate inst.r -> r` (required): from the inner port `inst.r` to the boundary port `r`,
 * - `boundary` hops connect the port of a composite instance (`sub.p` in the parent) with the same
 *   port seen as boundary port inside the composite: inwards for provided ports, outwards for
 *   required ports.
 * Following the hops forward from a required port leads to its providers ({@link findProviders}),
 * backward from a provided port to its requirers ({@link findRequirers}); {@link portRoute} follows
 * both directions (the whole net the port belongs to).
 */

/** A port in the instance tree of a root structure: a port of an instance or a boundary port of a structure. */
export interface PortEndpoint {
    /**
     * The composite instances leading from the root to {@link structure} (empty for the root): the
     * last one is an instance of `structure`.
     */
    readonly path: readonly ast.ComponentInstance[];
    /** The structure in whose body the port is seen. */
    readonly structure: ast.Structure;
    /** The instance whose port it is, `undefined` for a boundary port of {@link structure}. */
    readonly instance?: ast.ComponentInstance;
    readonly port: ast.Port;
}

/** A hop of a route, directed in request direction (see the comment of this module). */
export interface RouteHop {
    readonly kind: 'connect' | 'delegate' | 'boundary';
    /** The connection or delegation (`undefined` for boundary hops). */
    readonly node?: ast.Connection | ast.Delegation;
    readonly from: PortEndpoint;
    readonly to: PortEndpoint;
}

/** The ports and hops reached from the start endpoints. */
export interface Route {
    readonly start: readonly PortEndpoint[];
    /** All endpoints of the route (including the start endpoints), in the order they were reached. */
    readonly endpoints: readonly PortEndpoint[];
    /** All hops between the endpoints (each once). */
    readonly hops: readonly RouteHop[];
}

export interface RouteOptions {
    /**
     * The root of the instance tree. Default: the structure containing the node (for a port of a
     * component type: the structure declaring the port; component ports have no endpoints without a root).
     */
    readonly root?: ast.Structure;
}

// ---------------------------------------------------------------------------------------------
// Endpoints

/** An endpoint (path defaults to the root's own body). */
export function portEndpoint(structure: ast.Structure, instance: ast.ComponentInstance | undefined, port: ast.Port,
    path: readonly ast.ComponentInstance[] = []): PortEndpoint {
    return { path, structure, instance, port };
}

const ids = new WeakMap<object, number>();
let nextId = 0;

function idOf(node: object): number {
    let id = ids.get(node);
    if (id === undefined) {
        id = nextId++;
        ids.set(node, id);
    }
    return id;
}

/** A key identifying an endpoint (equal for equal endpoints). */
export function endpointKey(endpoint: PortEndpoint): string {
    return [...endpoint.path.map(idOf), 's' + idOf(endpoint.structure), endpoint.instance ? idOf(endpoint.instance) : '-', idOf(endpoint.port)].join('/');
}

export function sameEndpoint(a: PortEndpoint, b: PortEndpoint): boolean {
    return endpointKey(a) === endpointKey(b);
}

/** The name of an endpoint relative to the root: `door.cmd`, `sub.door.cmd`, `diag` (a boundary port of the root). */
export function endpointLabel(endpoint: PortEndpoint): string {
    return [...endpoint.path.map(i => i.name), ...(endpoint.instance ? [endpoint.instance.name] : []), endpoint.port.name].join('.');
}

/** The structures of the instance tree of a root (the root and every composite instance below it), with their instance paths. */
export function structureContexts(root: ast.Structure): Array<{ path: readonly ast.ComponentInstance[], structure: ast.Structure }> {
    const result: Array<{ path: readonly ast.ComponentInstance[], structure: ast.Structure }> = [];
    const visit = (structure: ast.Structure, path: readonly ast.ComponentInstance[], active: ast.Structure[]) => {
        result.push({ path, structure });
        for (const instance of structureInstances(structure)) {
            const type = instanceType(instance);
            // recursive instantiation is an error (reported by the validator), it is not followed
            if (isCompositeType(type) && !active.includes(type)) {
                visit(type, [...path, instance], [...active, type]);
            }
        }
    };
    visit(root, [], [root]);
    return result;
}

/**
 * The endpoints of a port in the instance tree of a root: the port of every instance of the port's
 * component type and, for a port of a structure, the boundary port in every use of that structure
 * (including the root itself).
 */
export function endpointsOfPort(root: ast.Structure, port: ast.Port): PortEndpoint[] {
    const owner = port.$container;
    const result: PortEndpoint[] = [];
    for (const { path, structure } of structureContexts(root)) {
        if (structure === owner) {
            result.push(portEndpoint(structure, undefined, port, path));
        }
        for (const instance of structureInstances(structure)) {
            if (instanceType(instance) === owner) {
                result.push(portEndpoint(structure, instance, port, path));
            }
        }
    }
    return result;
}

/** The contexts (instance paths) in which a structure appears in the instance tree of a root. */
function contextsOf(root: ast.Structure, structure: ast.Structure): Array<readonly ast.ComponentInstance[]> {
    return structureContexts(root).filter(c => c.structure === structure).map(c => c.path);
}

/** The endpoint denoted by a port reference of a connection or delegation in the given context. */
export function referenceEndpoint(reference: ast.PortReference, path: readonly ast.ComponentInstance[] = []): PortEndpoint | undefined {
    const structure = enclosingStructure(reference);
    const port = reference.port?.ref;
    if (!structure || !port) {
        return undefined;
    }
    if (reference.instance) {
        const instance = reference.instance.ref;
        return instance ? portEndpoint(structure, instance, port, path) : undefined;
    }
    return portEndpoint(structure, undefined, port, path);
}

/**
 * The endpoints a query on a model element starts from:
 * - a port reference (`door.cmd` in a connection): the referenced port,
 * - a connection or delegation: both of its ends,
 * - an instance: all ports of the instance,
 * - a port: its endpoints in the instance tree of the root (see {@link endpointsOfPort}),
 * - a structure: all of its boundary ports.
 * For elements inside a structure, the endpoints are created in every context of that structure in
 * the instance tree of the root (by default the structure itself).
 */
export function routeEndpointsOf(node: AstNode, options: RouteOptions = {}): PortEndpoint[] {
    if (ast.isPort(node)) {
        const root = options.root ?? (ast.isStructure(node.$container) ? node.$container : undefined);
        return root ? endpointsOfPort(root, node) : [];
    }
    if (ast.isStructure(node)) {
        const root = options.root ?? node;
        return node.ports.flatMap(port => endpointsOfPort(root, port).filter(e => e.structure === node && !e.instance));
    }
    const structure = enclosingStructure(node);
    if (!structure) {
        return [];
    }
    const paths = options.root ? contextsOf(options.root, structure) : [[]];
    const result: PortEndpoint[] = [];
    for (const path of paths) {
        if (ast.isPortReference(node)) {
            const endpoint = referenceEndpoint(node, path);
            if (endpoint) {
                result.push(endpoint);
            }
        } else if (ast.isConnection(node) || ast.isDelegation(node)) {
            for (const reference of [node.source, node.target]) {
                const endpoint = reference ? referenceEndpoint(reference, path) : undefined;
                if (endpoint) {
                    result.push(endpoint);
                }
            }
        } else {
            const instance = AstUtils.getContainerOfType(node, ast.isComponentInstance)
                ?? (ast.isThreadMember(node) ? node.instance?.ref : undefined);
            for (const port of instanceType(instance)?.ports ?? []) {
                result.push(portEndpoint(structure, instance, port, path));
            }
        }
    }
    return result;
}

// ---------------------------------------------------------------------------------------------
// Hops

function refersTo(reference: ast.PortReference | undefined, endpoint: PortEndpoint): boolean {
    return !!reference && reference.port?.ref === endpoint.port && reference.instance?.ref === endpoint.instance
        && (reference.instance !== undefined) === (endpoint.instance !== undefined);
}

/** The structures on the path of an endpoint (the root and the types of the path instances). */
function activeStructures(endpoint: PortEndpoint): ast.Structure[] {
    const root = endpoint.path.length > 0 ? enclosingStructure(endpoint.path[0]) : endpoint.structure;
    return [...(root ? [root] : []), ...endpoint.path.map(i => instanceType(i)).filter(isCompositeType)];
}

/** The boundary hop between a port of a composite instance and the boundary port inside the composite, if any. */
function innerBoundary(endpoint: PortEndpoint): PortEndpoint | undefined {
    const type = instanceType(endpoint.instance);
    if (!endpoint.instance || !isCompositeType(type) || activeStructures(endpoint).includes(type)) {
        return undefined;
    }
    return portEndpoint(type, undefined, endpoint.port, [...endpoint.path, endpoint.instance]);
}

/** The port of the composite instance outside of a boundary port (`undefined` at the root). */
function outerBoundary(endpoint: PortEndpoint): PortEndpoint | undefined {
    if (endpoint.instance || endpoint.path.length === 0) {
        return undefined;
    }
    const instance = endpoint.path[endpoint.path.length - 1];
    const parent = enclosingStructure(instance);
    return parent ? portEndpoint(parent, instance, endpoint.port, endpoint.path.slice(0, -1)) : undefined;
}

/** The hops leaving an endpoint in request direction. */
export function outgoingHops(endpoint: PortEndpoint): RouteHop[] {
    const hops: RouteHop[] = [];
    const structure = endpoint.structure;
    for (const connection of structure.connections) {
        const to = refersTo(connection.source, endpoint) && connection.target ? referenceEndpoint(connection.target, endpoint.path) : undefined;
        if (to) {
            hops.push({ kind: 'connect', node: connection, from: endpoint, to });
        }
    }
    for (const delegation of structure.delegations) {
        const to = refersTo(delegation.source, endpoint) && delegation.target ? referenceEndpoint(delegation.target, endpoint.path) : undefined;
        if (to) {
            hops.push({ kind: 'delegate', node: delegation, from: endpoint, to });
        }
    }
    if (endpoint.port.direction === 'provides') {
        const inner = innerBoundary(endpoint);
        if (inner) {
            hops.push({ kind: 'boundary', from: endpoint, to: inner });
        }
    } else {
        const outer = outerBoundary(endpoint);
        if (outer) {
            hops.push({ kind: 'boundary', from: endpoint, to: outer });
        }
    }
    return hops;
}

/** The hops arriving at an endpoint in request direction. */
export function incomingHops(endpoint: PortEndpoint): RouteHop[] {
    const hops: RouteHop[] = [];
    const structure = endpoint.structure;
    for (const connection of structure.connections) {
        const from = refersTo(connection.target, endpoint) && connection.source ? referenceEndpoint(connection.source, endpoint.path) : undefined;
        if (from) {
            hops.push({ kind: 'connect', node: connection, from, to: endpoint });
        }
    }
    for (const delegation of structure.delegations) {
        const from = refersTo(delegation.target, endpoint) && delegation.source ? referenceEndpoint(delegation.source, endpoint.path) : undefined;
        if (from) {
            hops.push({ kind: 'delegate', node: delegation, from, to: endpoint });
        }
    }
    if (endpoint.port.direction === 'requires') {
        const inner = innerBoundary(endpoint);
        if (inner) {
            hops.push({ kind: 'boundary', from: inner, to: endpoint });
        }
    } else {
        const outer = outerBoundary(endpoint);
        if (outer) {
            hops.push({ kind: 'boundary', from: outer, to: endpoint });
        }
    }
    return hops;
}

// ---------------------------------------------------------------------------------------------
// Queries

/**
 * The route through the given endpoints: all endpoints and hops reachable in the given direction
 * (`both`: the whole net, `forward`: towards the providers, `backward`: towards the requirers).
 */
export function portRoute(start: PortEndpoint | readonly PortEndpoint[], direction: 'both' | 'forward' | 'backward' = 'both'): Route {
    const starts = Array.isArray(start) ? start as readonly PortEndpoint[] : [start as PortEndpoint];
    const endpoints: PortEndpoint[] = [];
    const hops: RouteHop[] = [];
    const seen = new Set<string>();
    const seenHops = new Set<string>();
    const queue: PortEndpoint[] = [];
    const visit = (endpoint: PortEndpoint) => {
        const key = endpointKey(endpoint);
        if (!seen.has(key)) {
            seen.add(key);
            endpoints.push(endpoint);
            queue.push(endpoint);
        }
    };
    starts.forEach(visit);
    while (queue.length > 0) {
        const current = queue.shift()!;
        const next = [
            ...(direction !== 'backward' ? outgoingHops(current) : []),
            ...(direction !== 'forward' ? incomingHops(current) : [])
        ];
        for (const hop of next) {
            const key = `${endpointKey(hop.from)}>${endpointKey(hop.to)}>${hop.node ? idOf(hop.node) : '-'}`;
            if (!seenHops.has(key)) {
                seenHops.add(key);
                hops.push(hop);
            }
            visit(sameEndpoint(hop.from, current) ? hop.to : hop.from);
        }
    }
    return { start: starts, endpoints, hops };
}

/** The route of a model element (see {@link routeEndpointsOf}): the whole net of each of its ports. */
export function routeOf(node: AstNode, options: RouteOptions = {}): Route {
    return portRoute(routeEndpointsOf(node, options));
}

/**
 * The providers of a required port: the ends of the route in request direction, i.e. provided ports of
 * component instances (and of composites without a delegation inside) and required boundary ports of
 * the root (provided by the environment of the root). Empty if the port is not connected.
 */
export function findProviders(start: PortEndpoint): PortEndpoint[] {
    return routeEnds(start, 'forward');
}

/** The requirers (clients) of a provided port: the ends of the route against request direction. */
export function findRequirers(start: PortEndpoint): PortEndpoint[] {
    return routeEnds(start, 'backward');
}

function routeEnds(start: PortEndpoint, direction: 'forward' | 'backward'): PortEndpoint[] {
    const route = portRoute(start, direction);
    const next = direction === 'forward' ? outgoingHops : incomingHops;
    return route.endpoints.filter(e => !sameEndpoint(e, start) && next(e).length === 0);
}

/**
 * The providers of the ports at a model element (a port reference, an instance, a port, see
 * {@link routeEndpointsOf}), for "go to provider": for each required port its providers, for a
 * provided port the port itself.
 */
export function providersOf(node: AstNode, options: RouteOptions = {}): PortEndpoint[] {
    const result: PortEndpoint[] = [];
    const seen = new Set<string>();
    for (const start of routeEndpointsOf(node, options)) {
        const providers = start.port.direction === 'provides' && isComponentEndpoint(start) ? [start] : findProviders(start);
        for (const provider of providers) {
            const key = endpointKey(provider);
            if (!seen.has(key)) {
                seen.add(key);
                result.push(provider);
            }
        }
    }
    return result;
}

/** Whether the endpoint is a port of an instance of an (atomic) component, not of a composite or a boundary port. */
export function isComponentEndpoint(endpoint: PortEndpoint): boolean {
    return !!endpoint.instance && ast.isComponent(instanceType(endpoint.instance));
}

/**
 * The thread an endpoint's instance runs in: the thread of a component instance; `undefined` for
 * instances of subsystems (their parts run in threads of their own), boundary ports and component
 * instances outside of any thread (an error reported by the validator).
 */
export function effectiveThread(endpoint: PortEndpoint): ast.Thread | undefined {
    const instance = endpoint.instance;
    return instance && !isCompositeType(instanceType(instance)) ? threadOf(instance) : undefined;
}

/**
 * The threads on both sides of a connection: the thread of a component instance, and for an instance of
 * a subsystem the thread of the component ports the connection leads to inside the subsystem (its
 * requirers for the source side, its providers for the target side) if they all run in the same thread
 * (`undefined` otherwise). A connection crosses threads if both sides have a thread and they differ
 * (reported by the validator, drawn dashed in the diagram).
 */
export function connectionThreads(connection: ast.Connection): { source?: ast.Thread, target?: ast.Thread } {
    const side = (reference: ast.PortReference | undefined, direction: 'forward' | 'backward'): ast.Thread | undefined => {
        const instance = reference?.instance?.ref;
        if (!reference || !instance) {
            return undefined;
        }
        if (!isCompositeType(instanceType(instance))) {
            return threadOf(instance);
        }
        const start = referenceEndpoint(reference);
        if (!start) {
            return undefined;
        }
        // the component ports inside the subsystem: follow the boundary hop (and further) away from the connection
        const ends = (direction === 'forward' ? findProviders(start) : findRequirers(start))
            .filter(e => e.path.length > 0 && isComponentEndpoint(e));
        const threads = new Set(ends.map(effectiveThread));
        return threads.size === 1 ? [...threads][0] : undefined;
    };
    return { source: side(connection.source, 'backward'), target: side(connection.target, 'forward') };
}

/** Whether the connection crosses threads (see {@link connectionThreads}). */
export function crossesThreads(connection: ast.Connection): boolean {
    const { source, target } = connectionThreads(connection);
    return !!source && !!target && source !== target;
}
