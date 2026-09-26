import {
    AstUtils, DefaultScopeProvider, EMPTY_SCOPE, MapScope,
    type AstNode, type AstNodeDescription, type LangiumCoreServices, type ReferenceInfo, type Scope
} from 'langium';
import * as ast from './generated/ast.js';
import { isScopeContainer, type ScopeContainer } from './model-utils.js';

/**
 * Name resolution of the HSM language.
 *
 * - Vertices are referenced by (partially) qualified names built from the names of the enclosing
 *   states (regions are transparent): `Playing`, `Active.Playing`, `Closed.Active.Playing`.
 *   Names are looked up in the scope container of the reference first and then outwards, so the
 *   nearest vertex with a matching name wins.
 * - Declarations of the definition section are referenced by their simple name if they are declared
 *   in the unnamed interface or the internal scope, and by `Interface.name` for named interfaces.
 */
export class HsmScopeProvider extends DefaultScopeProvider {

    constructor(services: LangiumCoreServices) {
        super(services);
    }

    override getScope(context: ReferenceInfo): Scope {
        const container = context.container;
        const property = context.property;
        if ((ast.isTransition(container) && (property === 'source' || property === 'target'))
            || (ast.isActiveExpression(container) && property === 'state')) {
            return this.vertexScope(container);
        }
        if (ast.isEventTrigger(container) || ast.isRaiseStatement(container) || ast.isValueOfExpression(container)) {
            return this.declarationScope(container, ast.isEventDeclaration);
        }
        if (ast.isElementReference(container)) {
            return this.declarationScope(container, d => ast.isVariableDeclaration(d) || ast.isOperationDeclaration(d));
        }
        return super.getScope(context);
    }

    protected vertexScope(node: AstNode): Scope {
        const descriptions: AstNodeDescription[] = [];
        let current: AstNode | undefined = node;
        while (current) {
            if (isScopeContainer(current)) {
                collectVertices(current, [], vertex => descriptions.push(this.descriptions.createDescription(vertex.vertex, vertex.name)));
            }
            current = current.$container;
        }
        // fallback: unique name suffixes anywhere in the state machine (e.g. `Playing` for `Closed.Active.Playing`)
        const machine = AstUtils.getContainerOfType(node, ast.isStateMachine);
        if (machine) {
            for (const entry of globalSuffixes(machine)) {
                descriptions.push(this.descriptions.createDescription(entry.vertex, entry.name));
            }
        }
        return this.createScope(descriptions);
    }

    protected declarationScope(node: AstNode, filter: (declaration: ast.Declaration) => boolean): Scope {
        const machine = AstUtils.getContainerOfType(node, ast.isStateMachine);
        if (!machine) {
            return EMPTY_SCOPE;
        }
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
            candidates.set(suffix, [...(candidates.get(suffix) ?? []), vertex]);
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
