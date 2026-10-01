import { AstUtils, GrammarUtils, type AstNode, type CstNode } from 'langium';
import { semanticAnnotations } from './model-annotations.js';
import {
    isClassScope, isInternalScope, isPseudoState, isRegion, isState, isStateMachine, isTransition, isVertex,
    type Region, type Scope, type State, type StateMachine, type Transition, type Vertex
} from './generated/ast.js';

/** AST nodes which own vertices and transitions. */
export type ScopeContainer = StateMachine | State | Region;

export function isScopeContainer(node: unknown): node is ScopeContainer {
    return isStateMachine(node) || isState(node) || isRegion(node);
}

/** Returns the nearest container (state machine, state or region) that owns the given node. */
export function scopeOf(node: AstNode): ScopeContainer {
    let current = node.$container;
    while (current) {
        if (isScopeContainer(current)) {
            return current;
        }
        current = current.$container;
    }
    throw new Error(`Node of type ${node.$type} is not contained in a state machine.`);
}

export function getStateMachine(node: AstNode): StateMachine {
    const root = AstUtils.findRootNode(node);
    if (!isStateMachine(root)) {
        throw new Error('Root node is not a state machine.');
    }
    return root;
}

export function allVertices(node: AstNode): Vertex[] {
    return AstUtils.streamAllContents(node).filter(isVertex).toArray();
}

export function allTransitions(node: AstNode): Transition[] {
    const result = AstUtils.streamAllContents(node).filter(isTransition).toArray();
    if (isTransition(node)) {
        result.unshift(node);
    }
    return result;
}

export function allContainers(machine: StateMachine): ScopeContainer[] {
    return [machine, ...AstUtils.streamAllContents(machine).filter(isScopeContainer)];
}

/** A state is composite if it contains sub vertices or regions. */
export function isComposite(state: State): boolean {
    return state.vertices.length > 0 || state.regions.length > 0;
}

/** Whether `ancestor` is equal to `node` or one of its (transitive) containers. */
export function isAncestorOrSelf(ancestor: AstNode, node: AstNode | undefined): boolean {
    let current = node;
    while (current) {
        if (current === ancestor) {
            return true;
        }
        current = current.$container;
    }
    return false;
}

/** Chain of scope containers from the root state machine down to (and including) the given container. */
export function containerPath(container: ScopeContainer): ScopeContainer[] {
    const path: ScopeContainer[] = [];
    let current: AstNode | undefined = container;
    while (current) {
        if (isScopeContainer(current)) {
            path.unshift(current);
        }
        current = current.$container;
    }
    return path;
}

/** The innermost scope container that (transitively) contains both given containers. */
export function commonContainer(a: ScopeContainer, b: ScopeContainer): ScopeContainer {
    const pathA = containerPath(a);
    const pathB = containerPath(b);
    let result = pathA[0];
    for (let i = 0; i < Math.min(pathA.length, pathB.length); i++) {
        if (pathA[i] !== pathB[i]) {
            break;
        }
        result = pathA[i];
    }
    return result;
}

/** Initial transitions (`[*] -> X`) declared directly in the given container. */
export function initialTransitions(container: ScopeContainer): Transition[] {
    return container.transitions.filter(t => t.initial);
}

/** Final transitions (`X -> [*]`) declared directly in the given container. */
export function finalTransitions(container: ScopeContainer): Transition[] {
    return container.transitions.filter(t => t.final);
}

/** The region of a state containing the given node, if any. */
export function enclosingRegion(node: AstNode): Region | undefined {
    return AstUtils.getContainerOfType(node.$container, isRegion);
}

/** Source text of an AST node with normalized white space (e.g. `ev [x > 3] / x += 1`). */
export function nodeText(node: AstNode | undefined): string {
    const cst = node?.$cstNode;
    if (!cst) {
        return '';
    }
    return cst.text.replace(/\s+/g, ' ').trim();
}

/** Label of a transition (`trigger, trigger [guard] / effect`), without source and target. */
export function transitionLabel(transition: Transition): string {
    const spec = nodeText(transition.spec);
    const points = entryExitSpec(transition);
    return points ? `${spec} ${points}`.trim() : spec;
}

/** The entry / exit specification of a transition (`# >E`, `# X1> X2>`), empty if there is none. */
export function entryExitSpec(transition: Transition): string {
    const parts = [...transition.entryPoints.map(e => `>${e}`), ...transition.exitPoints.map(x => `${x}>`)];
    return parts.length > 0 ? `# ${parts.join(' ')}` : '';
}

/**
 * The entry point selected by a transition (`# >E`). Like itemis CREATE, only the first of several
 * entry points is used (the validator warns about the others).
 */
export function entryPointOf(transition: Transition): string | undefined {
    return transition.entryPoints[0];
}

/** Whether the transition leaves its source state through exit nodes (`# X>`) instead of being triggered. */
export function isExitTransition(transition: Transition): boolean {
    return transition.exitPoints.length > 0;
}

/** Human readable name of the given container, used in messages. */
export function containerName(container: ScopeContainer): string {
    if (isStateMachine(container)) {
        return `state machine '${container.name}'`;
    } else if (isState(container)) {
        return `state '${container.name}'`;
    } else {
        const state = container.$container;
        const index = state.regions.indexOf(container) + 1;
        return container.name ? `region '${container.name}' of '${state.name}'` : `region #${index} of '${state.name}'`;
    }
}

/**
 * Outgoing transitions of a vertex in priority order, i.e. in document order of the text
 * (see docs/semantics.md §1).
 */
export function outgoingTransitions(vertex: Vertex): Transition[] {
    return allTransitions(getStateMachine(vertex))
        .filter(t => !t.initial && t.source?.ref === vertex)
        .sort((a, b) => (a.$cstNode?.offset ?? 0) - (b.$cstNode?.offset ?? 0));
}

/**
 * Priority (1-based) of a transition among the outgoing transitions of its source vertex, or
 * `undefined` if the source has only one outgoing transition (or for initial transitions and forks).
 */
export function transitionPriority(transition: Transition, outgoing?: Transition[]): number | undefined {
    const source = transition.source?.ref;
    // all outgoing transitions of a fork (sync) are taken together: they have no priority
    if (transition.initial || !source || (isPseudoState(source) && source.kind === 'sync')) {
        return undefined;
    }
    const transitions = outgoing ?? outgoingTransitions(source);
    return transitions.length > 1 ? transitions.indexOf(transition) + 1 : undefined;
}

/** Whether the state machine has a definition section (namespace, annotations, interfaces, internal scope). */
export function hasDefinitionSection(machine: StateMachine): boolean {
    return !!machine.namespace || machine.imports.length > 0 || semanticAnnotations(machine).length > 0 || machine.scopes.length > 0 || machine.reactions.length > 0;
}

/**
 * Text lines of the definition section with normalized white space, e.g.
 * `['import "motor_types.h"', '@CycleBased(100)', 'interface:', '  in event powerOn', ...]`. Declarations are indented
 * by two spaces.
 */
export function definitionLines(machine: StateMachine): string[] {
    const lines: string[] = [];
    if (machine.namespace) {
        lines.push(`namespace ${machine.namespace}`);
    }
    // imported state machines and C/C++ headers
    for (const node of machine.imports) {
        lines.push(nodeText(node));
    }
    for (const annotation of semanticAnnotations(machine)) {
        lines.push(nodeText(annotation));
    }
    for (const scope of machine.scopes) {
        lines.push(scopeLabel(scope));
        for (const declaration of scope.declarations) {
            lines.push(`  ${nodeText(declaration)}`);
        }
    }
    // local reactions of the state machine itself (e.g. `always / x++`)
    for (const reaction of machine.reactions) {
        lines.push(nodeText(reaction));
    }
    return lines;
}

/** The label of a scope of the definition section: `interface:`, `interface Name:`, `internal:`, `public:`, ... */
export function scopeLabel(scope: Scope): string {
    if (isInternalScope(scope)) {
        return 'internal:';
    }
    if (isClassScope(scope)) {
        return `${scope.access}:`;
    }
    return scope.name ? `interface ${scope.name}:` : 'interface:';
}

/** Text range (offsets) of the definition section, if the state machine has one. */
export function definitionRange(machine: StateMachine): { offset: number, end: number } | undefined {
    const cst = machine.$cstNode;
    if (!cst || !hasDefinitionSection(machine)) {
        return undefined;
    }
    const nodes = [
        machine.namespace ? GrammarUtils.findNodeForKeyword(cst, 'namespace') : undefined,
        machine.namespace ? GrammarUtils.findNodeForProperty(cst, 'namespace') : undefined,
        ...machine.imports.map(i => i.$cstNode),
        ...semanticAnnotations(machine).map(a => a.$cstNode),
        ...machine.scopes.map(s => s.$cstNode),
        ...machine.reactions.map(r => r.$cstNode)
    ].filter((n): n is CstNode => !!n);
    if (nodes.length === 0) {
        return undefined;
    }
    return { offset: Math.min(...nodes.map(n => n.offset)), end: Math.max(...nodes.map(n => n.end)) };
}
