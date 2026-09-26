import {
    AstUtils, DefaultScopeProvider, DocumentCache, EMPTY_SCOPE, MapScope,
    type AstNode, type AstNodeDescription, type LangiumCoreServices, type ReferenceInfo, type Scope
} from 'langium';
import * as ast from './generated/ast.js';
import { isScopeContainer, type ScopeContainer } from './model-utils.js';

/** Scopes of one state machine, computed once per document version. */
interface MachineScopes {
    machine: ast.StateMachine;
    /** Vertex scope per scope container (including the scopes of all enclosing containers). */
    vertices: Map<ScopeContainer, Scope>;
    events?: Scope;
    elements?: Scope;
}

/**
 * Name resolution of the HSM language.
 *
 * - Vertices are referenced by (partially) qualified names built from the names of the enclosing
 *   states (regions are transparent): `Playing`, `Active.Playing`, `Closed.Active.Playing`.
 *   Names are looked up in the scope container of the reference first and then outwards, so the
 *   nearest vertex with a matching name wins.
 * - Declarations of the definition section are referenced by their simple name if they are declared
 *   in the unnamed interface or the internal scope, and by `Interface.name` for named interfaces.
 *
 * The scopes are cached per document (and state machine instance), so linking a big model is linear
 * in the number of references instead of quadratic.
 */
export class HsmScopeProvider extends DefaultScopeProvider {

    protected readonly scopeCache: DocumentCache<string, MachineScopes>;

    constructor(services: LangiumCoreServices) {
        super(services);
        this.scopeCache = new DocumentCache(services.shared);
    }

    override getScope(context: ReferenceInfo): Scope {
        const container = context.container;
        const property = context.property;
        if ((ast.isTransition(container) && (property === 'source' || property === 'target'))
            || (ast.isActiveExpression(container) && property === 'state')) {
            return this.vertexScope(container);
        }
        if (ast.isEventTrigger(container) || ast.isRaiseStatement(container) || ast.isValueOfExpression(container)) {
            const scopes = this.machineScopes(container);
            if (!scopes) {
                return EMPTY_SCOPE;
            }
            return scopes.events ??= this.declarationScope(scopes.machine, ast.isEventDeclaration);
        }
        if (ast.isElementReference(container)) {
            const scopes = this.machineScopes(container);
            if (!scopes) {
                return EMPTY_SCOPE;
            }
            return scopes.elements ??= this.declarationScope(scopes.machine, d => ast.isVariableDeclaration(d) || ast.isOperationDeclaration(d));
        }
        return super.getScope(context);
    }

    /** The cached scopes of the state machine containing `node` (recomputed if the document was parsed again). */
    protected machineScopes(node: AstNode): MachineScopes | undefined {
        const machine = AstUtils.getContainerOfType(node, ast.isStateMachine);
        if (!machine) {
            return undefined;
        }
        const document = machine.$document;
        if (!document) {
            return { machine, vertices: new Map() };
        }
        const cached = this.scopeCache.get(document.uri, 'machine');
        if (cached && cached.machine === machine) {
            return cached;
        }
        const scopes: MachineScopes = { machine, vertices: new Map() };
        this.scopeCache.set(document.uri, 'machine', scopes);
        return scopes;
    }

    protected vertexScope(node: AstNode): Scope {
        const scopes = this.machineScopes(node);
        let container: AstNode | undefined = node;
        while (container && !isScopeContainer(container)) {
            container = container.$container;
        }
        if (!scopes || !container) {
            return EMPTY_SCOPE;
        }
        return this.containerScope(container, scopes);
    }

    /** Vertices below `container` by their relative names, then the scope of the enclosing container. */
    protected containerScope(container: ScopeContainer, scopes: MachineScopes): Scope {
        const cached = scopes.vertices.get(container);
        if (cached) {
            return cached;
        }
        let parent: AstNode | undefined = container.$container;
        while (parent && !isScopeContainer(parent)) {
            parent = parent.$container;
        }
        const outer = parent
            ? this.containerScope(parent, scopes)
            // fallback: unique name suffixes anywhere in the state machine (e.g. `Playing` for `Closed.Active.Playing`)
            : new MapScope(globalSuffixes(scopes.machine).map(entry => this.descriptions.createDescription(entry.vertex, entry.name)));
        const names = new Set<string>();
        const descriptions: AstNodeDescription[] = [];
        collectVertices(container, [], entry => {
            // the first vertex with a name wins (duplicates are reported by the validator)
            if (!names.has(entry.name)) {
                names.add(entry.name);
                descriptions.push(this.descriptions.createDescription(entry.vertex, entry.name));
            }
        });
        const scope = new MapScope(descriptions, outer);
        scopes.vertices.set(container, scope);
        return scope;
    }

    protected declarationScope(machine: ast.StateMachine, filter: (declaration: ast.Declaration) => boolean): Scope {
        const descriptions: AstNodeDescription[] = [];
        for (const scope of machine.scopes) {
            for (const declaration of scope.declarations) {
                if (!filter(declaration)) {
                    continue;
                }
                const name = ast.isInterfaceScope(scope) && scope.name ? `${scope.name}.${declaration.name}` : declaration.name;
                descriptions.push(this.descriptions.createDescription(declaration, name));
            }
        }
        return new MapScope(descriptions);
    }
}

/** Calls `accept` for every vertex below the container with its name relative to the container. */
export function collectVertices(container: ScopeContainer, prefix: string[], accept: (entry: { vertex: ast.Vertex, name: string }) => void): void {
    for (const vertex of container.vertices) {
        if (!vertex.name) {
            continue;
        }
        const path = [...prefix, vertex.name];
        accept({ vertex, name: path.join('.') });
        if (ast.isState(vertex)) {
            collectVertices(vertex, path, accept);
            for (const region of vertex.regions) {
                collectVertices(region, path, accept);
            }
        }
    }
}

/** Fully qualified name of a vertex (names of the enclosing states, regions are skipped). */
export function qualifiedName(vertex: ast.Vertex): string {
    const names = [vertex.name];
    let current: AstNode | undefined = vertex.$container;
    while (current && !ast.isStateMachine(current)) {
        if (ast.isState(current)) {
            names.unshift(current.name);
        }
        current = current.$container;
    }
    return names.join('.');
}

/** Resolves a (partially) qualified vertex name like the scope provider does, starting at `context`. */
export function resolveVertex(name: string, context: AstNode): ast.Vertex | undefined {
    let current: AstNode | undefined = context;
    while (current) {
        if (isScopeContainer(current)) {
            let found: ast.Vertex | undefined;
            collectVertices(current, [], entry => {
                if (!found && entry.name === name) {
                    found = entry.vertex;
                }
            });
            if (found) {
                return found;
            }
        }
        current = current.$container;
    }
    const machine = AstUtils.getContainerOfType(context, ast.isStateMachine);
    return machine ? globalSuffixes(machine).find(entry => entry.name === name)?.vertex : undefined;
}

/**
 * Name suffixes of all vertices which identify exactly one vertex of the state machine,
 * e.g. `Playing` and `Active.Playing` for `Closed.Active.Playing`.
 */
export function globalSuffixes(machine: ast.StateMachine): Array<{ vertex: ast.Vertex, name: string }> {
    const candidates = new Map<string, ast.Vertex[]>();
    collectVertices(machine, [], ({ vertex, name }) => {
        const segments = name.split('.');
        for (let i = 1; i < segments.length; i++) {
            const suffix = segments.slice(i).join('.');
            const vertices = candidates.get(suffix);
            if (vertices) {
                vertices.push(vertex);
            } else {
                candidates.set(suffix, [vertex]);
            }
        }
    });
    return [...candidates.entries()]
        .filter(([, vertices]) => vertices.length === 1)
        .map(([name, vertices]) => ({ vertex: vertices[0], name }));
}

/**
 * The shortest name under which `vertex` can be referenced from `context`
 * (e.g. `Playing`, or `Active.Playing` if another `Playing` is closer).
 */
export function referenceName(vertex: ast.Vertex, context: AstNode): string {
    const segments = qualifiedName(vertex).split('.');
    for (let i = segments.length - 1; i >= 0; i--) {
        const candidate = segments.slice(i).join('.');
        if (resolveVertex(candidate, context) === vertex) {
            return candidate;
        }
    }
    return segments.join('.');
}

/**
 * All vertices of the state machine whose (fully) qualified name is `name` or ends with `.name`,
 * i.e. the candidates a (partially) qualified vertex name may denote.
 */
export function vertexCandidates(machine: ast.StateMachine, name: string): ast.Vertex[] {
    const result: ast.Vertex[] = [];
    collectVertices(machine, [], entry => {
        if (entry.name === name || entry.name.endsWith(`.${name}`)) {
            result.push(entry.vertex);
        }
    });
    return result;
}
