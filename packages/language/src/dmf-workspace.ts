import { AstUtils, URI, type AstNode, type LangiumDocument } from 'langium';
import * as ast from './generated/ast.js';
import { resolvedBehavior } from './dmf-imports.js';
import { instanceType, structureInstances } from './dmf-model.js';
import { findProviders, findRequirers, portEndpoint, portRoute, structureContexts, type PortEndpoint, type Route } from './dmf-routes.js';
import { dmfRenameEdits } from './edit/dmf-edits.js';
import type { TextEdit } from './edit/model-edits.js';
import { loadImports, replaceDocument } from './hsm-document.js';
import { createHsmServices } from './hsm-module.js';

/*
 * The structure files of a workspace, loaded together (with their imports) into Langium services of
 * their own: queries across files that the editor of a single file cannot answer from its own document
 * and its imports – which structures use a state machine or a component type, the route of a signal
 * from the root system down to the parts of a composite ("follow into"), the providers of a port in
 * another file, renames that update the files referencing an element. Model elements are identified
 * across the separately parsed documents by URI and names (see {@link StructureLocation}).
 */

/**
 * A place in the instance tree of a root structure: the structure `structure` of file `uri`, seen as
 * the part `path` (instance names from the root) of the root structure `root` of file `rootUri`. An empty
 * path: the root itself.
 */
export interface StructureContext {
    rootUri: string;
    root: string;
    path: readonly string[];
}

/** A diagram element in a structure file: what navigation opens and selects. */
export interface StructureLocation {
    /** URI of the structure file. */
    uri: string;
    /** The structure, system or component type shown (its name). */
    element: string;
    /** The diagram id of the element to select (see ibd-model.ts), e.g. `DriveUnit/motor.ctrl`. */
    id?: string;
    /** The instance tree context of the shown structure (for "follow into" and routes across levels). */
    context?: StructureContext;
}

/** An instance of a component type with a behavior state machine (the "used by" links of a state machine). */
export interface BehaviorUsage {
    /** The component type implemented by the state machine. */
    component: string;
    componentUri: string;
    /** The instances of the component type in the structures of the workspace. */
    instances: Array<{ structure: string, instance: string, location: StructureLocation }>;
}

/** The structure files of a workspace (see the comment of this module). */
export class DmfWorkspace {

    readonly services: ReturnType<typeof createHsmServices> = createHsmServices();
    private key?: string;
    private roots: Array<LangiumDocument<ast.DmfModel>> = [];

    /**
     * Loads all structure files (`.dmf`) of `files` (texts by URI; state machines and headers are loaded
     * as their imports). Nothing is done if the files did not change since the last call.
     */
    async update(files: Readonly<Record<string, string>>): Promise<void> {
        const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
        const key = entries.map(([uri, text]) => `${uri}\u0000${text}`).join('\u0001');
        if (key === this.key) {
            return;
        }
        const shared = this.services.shared;
        const documents = shared.workspace.LangiumDocuments;
        for (const document of documents.all.toArray()) {
            documents.deleteDocument(document.uri);
        }
        const roots = entries.filter(([uri]) => /\.dmf$/i.test(uri))
            .map(([uri, text]) => replaceDocument(shared, URI.parse(uri), text) as LangiumDocument<ast.DmfModel>);
        const imported = await loadImports(shared, roots, { ...files }, async () => undefined);
        await shared.workspace.DocumentBuilder.build([...roots, ...imported], { validation: false });
        this.roots = roots;
        this.key = key;
    }

    /** The structure models of the workspace. */
    get models(): ast.DmfModel[] {
        return this.roots.map(d => d.parseResult.value);
    }

    model(uri: string): ast.DmfModel | undefined {
        const key = normalizeUri(uri);
        return this.roots.find(d => d.uri.toString() === key)?.parseResult.value;
    }

    /** A component type (structure, system or component) of a file. */
    componentType(uri: string, name: string): ast.ComponentType | undefined {
        return this.model(uri)?.elements.find((e): e is ast.ComponentType => ast.isComponentType(e) && e.name === name);
    }

    /** All structures and systems of the workspace. */
    get structures(): ast.Structure[] {
        return this.models.flatMap(m => m.elements.filter(ast.isStructure));
    }

    /**
     * The contexts of a structure in the instance trees of the systems of the workspace (the systems
     * containing it, with the instance path); the structure itself as root if no system contains it.
     */
    contextsOf(structure: ast.Structure): StructureContext[] {
        const result: StructureContext[] = [];
        for (const root of this.structures.filter(s => s.kind === 'system')) {
            for (const { path, structure: s } of structureContexts(root)) {
                if (s === structure) {
                    result.push({ rootUri: uriOf(root), root: root.name, path: path.map(i => i.name) });
                }
            }
        }
        return result.length > 0 ? result : [{ rootUri: uriOf(structure), root: structure.name, path: [] }];
    }

    /** The root structure and the instances of a context (undefined if it does not exist (any more)). */
    resolveContext(context: StructureContext): { root: ast.Structure, path: ast.ComponentInstance[], structure: ast.Structure } | undefined {
        const root = this.componentType(context.rootUri, context.root);
        if (!ast.isStructure(root)) {
            return undefined;
        }
        let structure: ast.Structure = root;
        const path: ast.ComponentInstance[] = [];
        for (const name of context.path) {
            const instance = structureInstances(structure).find(i => i.name === name);
            const type = instanceType(instance);
            if (!instance || !ast.isStructure(type)) {
                return undefined;
            }
            path.push(instance);
            structure = type;
        }
        return { root, path, structure };
    }

    /**
     * The endpoint of a port seen in the structure of a context: a port of the part `instance` or (without
     * instance) a boundary port.
     */
    endpoint(context: StructureContext, instance: string | undefined, port: string): PortEndpoint | undefined {
        const resolved = this.resolveContext(context);
        if (!resolved) {
            return undefined;
        }
        const part = instance !== undefined ? structureInstances(resolved.structure).find(i => i.name === instance) : undefined;
        if (instance !== undefined && !part) {
            return undefined;
        }
        const owner = part ? instanceType(part) : resolved.structure;
        const astPort = owner?.ports.find(p => p.name === port);
        return astPort ? portEndpoint(resolved.structure, part, astPort, resolved.path) : undefined;
    }

    /** The route through the ports of a context (all levels of the instance tree of its root). */
    route(starts: readonly PortEndpoint[]): Route {
        return portRoute(starts);
    }

    /** The providers (for required ports) or requirers (provided ports) of an endpoint, as locations. */
    routeEnds(endpoint: PortEndpoint, context: StructureContext): StructureLocation[] {
        const ends = endpoint.port.direction === 'requires' ? findProviders(endpoint) : findRequirers(endpoint);
        return ends.map(end => endpointLocation(end, context));
    }

    /** The instances of the component types implemented by the state machine of a file (by URI). */
    behaviorUsages(machineUri: string): BehaviorUsage[] {
        const result: BehaviorUsage[] = [];
        for (const model of this.models) {
            for (const component of model.elements.filter(ast.isComponent)) {
                if (!component.behavior) {
                    continue;
                }
                const resolved = resolvedBehavior(component.behavior);
                const uri = resolved.uri?.toString() ?? component.behavior.machine?.ref?.$document?.uri.toString()
                    ?? (component.behavior.machine?.ref ? uriOf(component.behavior.machine.ref) : undefined);
                if (uri !== normalizeUri(machineUri)) {
                    continue;
                }
                const usage: BehaviorUsage = { component: component.name, componentUri: uriOf(component), instances: [] };
                for (const structure of this.structures) {
                    for (const instance of structureInstances(structure)) {
                        if (instanceType(instance) === component) {
                            usage.instances.push({
                                structure: structure.name, instance: instance.name,
                                location: { uri: uriOf(structure), element: structure.name, id: `${structure.name}/${instance.name}` }
                            });
                        }
                    }
                }
                result.push(usage);
            }
        }
        return result;
    }

    /** The node of a loaded file at an offset (the innermost named element), e.g. to rename it. */
    nodeAt(uri: string, offset: number, accept: (node: AstNode) => boolean): AstNode | undefined {
        const model = this.model(uri);
        let best: AstNode | undefined;
        for (const node of model ? AstUtils.streamAst(model) : []) {
            const cst = node.$cstNode;
            if (cst && cst.offset === offset && accept(node)) {
                best = node;
            }
        }
        return best;
    }

    /**
     * The edits renaming the element starting at `offset` of the file `uri` and all references to it in
     * the structure files of the workspace, by URI (see {@link dmfRenameEdits}).
     */
    renameEdits(uri: string, offset: number, newName: string): Map<string, TextEdit[]> | undefined {
        const node = this.nodeAt(uri, offset, n => 'name' in n && typeof (n as { name: unknown }).name === 'string'
            && (ast.isComponentType(n) || ast.isPort(n) || ast.isComponentInstance(n) || ast.isThread(n) || ast.isPortInterface(n) || ast.isStructDeclaration(n)));
        return node ? dmfRenameEdits(this.services.Dmf, node as AstNode & { name: string }, newName) : undefined;
    }
}

/** The URI in the form of the URIs of Langium documents (`memory:///a.dmf` -> `memory:/a.dmf`). */
export function normalizeUri(uri: string): string {
    return URI.parse(uri).toString();
}

/** The URI of the document of a node. */
function uriOf(node: AstNode): string {
    return AstUtils.getDocument(node).uri.toString();
}

/**
 * The location of an endpoint of a route: the structure it is seen in (with the context of the
 * instance path below the root of `root`) and the diagram id of the port.
 */
export function endpointLocation(endpoint: PortEndpoint, root: StructureContext): StructureLocation {
    const s = endpoint.structure.name;
    return {
        uri: uriOf(endpoint.structure),
        element: s,
        id: endpoint.instance ? `${s}/${endpoint.instance.name}.${endpoint.port.name}` : `${s}.${endpoint.port.name}`,
        context: { rootUri: normalizeUri(root.rootUri), root: root.root, path: endpoint.path.map(i => i.name) }
    };
}

/**
 * The diagram ids (see ibd-model.ts) of the elements of a route in the structure seen at the instance
 * path `path` (names from the root of the route): ports, instances, connections and delegations.
 */
export function routeIdsAt(route: Route, path: readonly string[]): Set<string> {
    const result = new Set<string>();
    const at = (endpoint: PortEndpoint) => endpoint.path.length === path.length && endpoint.path.every((p, i) => p.name === path[i]);
    for (const endpoint of route.endpoints) {
        if (!at(endpoint)) {
            continue;
        }
        const s = endpoint.structure.name;
        if (endpoint.instance) {
            result.add(`${s}/${endpoint.instance.name}.${endpoint.port.name}`);
            result.add(`${s}/${endpoint.instance.name}`);
        } else {
            result.add(`${s}.${endpoint.port.name}`);
        }
    }
    for (const hop of route.hops) {
        if (hop.node && at(hop.from)) {
            const s = hop.from.structure.name;
            const text = (reference: ast.PortReference) => `${reference.instance ? `${reference.instance.$refText}.` : ''}${reference.port.$refText}`;
            result.add(`${s}/${text(hop.node.source)}->${text(hop.node.target)}`);
        }
    }
    return result;
}

/**
 * The composite parts of the shown structure (at `path`) through which the route continues inside
 * ("follow into"): instance names.
 */
export function routeContinuations(route: Route, path: readonly string[]): string[] {
    const result: string[] = [];
    for (const endpoint of route.endpoints) {
        if (endpoint.path.length === path.length + 1 && endpoint.path.slice(0, path.length).every((p, i) => p.name === path[i])) {
            const name = endpoint.path[path.length].name;
            if (!result.includes(name)) {
                result.push(name);
            }
        }
    }
    return result;
}
