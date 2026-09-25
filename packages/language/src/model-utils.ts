import { AstUtils, type AstNode } from 'langium';
import {
    isRegion, isState, isStateMachine, isTransition, isVertex,
    type Region, type State, type StateMachine, type Transition, type Vertex
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

/** Label of a transition in the notation `event [guard] / effect`. */
export function transitionLabel(t: { event?: string, guard?: string, effect?: string }): string {
    const parts: string[] = [];
    if (t.event) {
        parts.push(t.event);
    }
    if (t.guard !== undefined) {
        parts.push(`[${t.guard}]`);
    }
    if (t.effect !== undefined) {
        parts.push(`/ ${t.effect}`);
    }
    return parts.join(' ');
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
