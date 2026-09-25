import type { ValidationAcceptor, ValidationChecks } from 'langium';
import * as ast from './generated/ast.js';
import type { HsmServices } from './hsm-module.js';
import {
    allTransitions, allVertices, containerName, enclosingRegion, finalTransitions, initialTransitions,
    isAncestorOrSelf, isComposite, scopeOf, type ScopeContainer
} from './model-utils.js';

export function registerValidationChecks(services: HsmServices): void {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.HsmValidator;
    const checks: ValidationChecks<ast.HsmAstType> = {
        StateMachine: [validator.checkUniqueNames, validator.checkReachability, validator.checkContainer],
        State: [validator.checkContainer, validator.checkStateStructure, validator.checkStateActions],
        Region: validator.checkContainer,
        PseudoState: validator.checkPseudoState,
        Transition: [validator.checkTransition, validator.checkDeterminism]
    };
    registry.register(checks, validator);
}

export class HsmValidator {

    checkUniqueNames(machine: ast.StateMachine, accept: ValidationAcceptor): void {
        const seen = new Map<string, ast.Vertex>();
        for (const vertex of allVertices(machine)) {
            const existing = seen.get(vertex.name);
            if (existing) {
                accept('error', `Duplicate name '${vertex.name}'. Names of states must be unique within a state machine.`,
                    { node: vertex, property: 'name' });
            } else {
                seen.set(vertex.name, vertex);
            }
        }
    }

    /** Checks that apply to every scope container: initial and final transitions. */
    checkContainer(container: ScopeContainer, accept: ValidationAcceptor): void {
        const initials = initialTransitions(container);
        if (ast.isState(container) && container.regions.length > 0) {
            for (const t of [...initials, ...finalTransitions(container)]) {
                accept('error', `'[*]' is ambiguous in ${containerName(container)} because it has regions. Declare it inside a region.`,
                    { node: t, property: t.initial ? 'initial' : 'final' });
            }
            return;
        }
        if (initials.length > 1) {
            for (const t of initials.slice(1)) {
                accept('error', `Only one initial transition is allowed in ${containerName(container)}.`, { node: t, property: 'initial' });
            }
        }
        if (container.vertices.length > 0 && initials.length === 0) {
            const message = `${capitalize(containerName(container))} has no initial transition ('[*] -> ...').`;
            if (ast.isRegion(container)) {
                accept('warning', message, { node: container, keyword: 'region' });
            } else {
                accept('warning', message, { node: container, property: 'name' });
            }
        }
    }

    checkStateStructure(state: ast.State, accept: ValidationAcceptor): void {
        if (state.regions.length > 0) {
            for (const vertex of state.vertices) {
                accept('error', `State '${state.name}' has regions: sub states must be declared inside a region.`,
                    { node: vertex, property: 'name' });
            }
        }
    }

    checkStateActions(state: ast.State, accept: ValidationAcceptor): void {
        const seen = new Set<string>();
        for (const behavior of state.behaviors) {
            if (ast.isStateAction(behavior)) {
                if (seen.has(behavior.kind)) {
                    accept('warning', `State '${state.name}' has more than one '${behavior.kind}' action.`, { node: behavior, property: 'kind' });
                }
                seen.add(behavior.kind);
            }
        }
    }

    checkPseudoState(pseudo: ast.PseudoState, accept: ValidationAcceptor): void {
        const machine = scopeOf(pseudo);
        const outgoing = allTransitions(rootOf(pseudo)).filter(t => t.source?.ref === pseudo);
        switch (pseudo.kind) {
            case 'history':
            case 'deephistory':
                if (ast.isStateMachine(machine)) {
                    accept('error', 'History pseudo states must be placed inside a composite state.', { node: pseudo, property: 'kind' });
                }
                if (outgoing.length > 1) {
                    accept('error', 'A history pseudo state may have at most one outgoing (default) transition.', { node: pseudo, property: 'name' });
                }
                for (const t of outgoing) {
                    if (t.event || t.guard !== undefined) {
                        accept('warning', 'The default transition of a history pseudo state should not have a trigger or guard.', { node: t, property: 'event' });
                    }
                }
                break;
            case 'choice':
            case 'junction':
                if (outgoing.length === 0) {
                    accept('error', `${capitalize(pseudo.kind)} '${pseudo.name}' needs at least one outgoing transition.`, { node: pseudo, property: 'name' });
                }
                for (const t of outgoing) {
                    if (t.event) {
                        accept('warning', `Transitions leaving ${pseudo.kind} '${pseudo.name}' must not have a trigger.`, { node: t, property: 'event' });
                    }
                }
                if (outgoing.length > 1 && outgoing.every(t => t.guard !== undefined)) {
                    accept('info', `Consider adding an 'else' branch (a transition without guard) to ${pseudo.kind} '${pseudo.name}'.`, { node: pseudo, property: 'name' });
                }
                break;
        }
    }

    checkTransition(transition: ast.Transition, accept: ValidationAcceptor): void {
        const container = scopeOf(transition);
        if (transition.initial && transition.final) {
            accept('error', 'A transition cannot lead from the initial pseudo state directly to the final state.', { node: transition, property: 'final' });
            return;
        }
        const target = transition.target?.ref;
        const source = transition.source?.ref;
        if (transition.initial) {
            if (transition.event || transition.guard !== undefined) {
                accept('warning', 'Initial transitions must not have a trigger or guard.', { node: transition, property: transition.event ? 'event' : 'guard' });
            }
            if (target && target.$container !== container) {
                accept('warning', `The initial transition should target a direct sub state of ${containerName(container)}.`, { node: transition, property: 'target' });
            }
        }
        if (transition.final && source && !isAncestorOrSelf(container, source)) {
            accept('warning', `'${source.name}' is not part of ${containerName(container)}; its final state is not reachable from it.`, { node: transition, property: 'source' });
        }
        if (source && ast.isPseudoState(source) && (source.kind === 'history' || source.kind === 'deephistory') && target && !isAncestorOrSelf(source.$container, target)) {
            accept('warning', 'The default transition of a history pseudo state should stay within its composite state.', { node: transition, property: 'target' });
        }
        if (source && target) {
            const sourceRegion = enclosingRegion(source);
            const targetRegion = enclosingRegion(target);
            if (sourceRegion && targetRegion && sourceRegion !== targetRegion
                && sourceRegion.$container === targetRegion.$container) {
                accept('error', `Transitions between orthogonal regions are not allowed ('${source.name}' -> '${target.name}').`, { node: transition, property: 'target' });
            }
        }
    }

    checkDeterminism(transition: ast.Transition, accept: ValidationAcceptor): void {
        const source = transition.source?.ref;
        if (!source || !transition.event || transition.guard !== undefined) {
            return;
        }
        const conflicts = allTransitions(rootOf(transition)).filter(t => t !== transition
            && t.source?.ref === source && t.event === transition.event && t.guard === undefined);
        if (conflicts.length > 0) {
            accept('warning', `Non-deterministic: '${source.name}' has several unguarded transitions for event '${transition.event}'.`, { node: transition, property: 'event' });
        }
    }

    checkReachability(machine: ast.StateMachine, accept: ValidationAcceptor): void {
        const transitions = allTransitions(machine);
        const entered = new Set<ast.Vertex>();
        for (const t of transitions) {
            const target = t.target?.ref;
            if (target) {
                entered.add(target);
            }
        }
        for (const vertex of allVertices(machine)) {
            if (entered.has(vertex) || !ast.isState(vertex)) {
                continue;
            }
            // states entered through a history pseudo state or via an entered descendant are reachable
            const container = scopeOf(vertex);
            const siblingHistory = container.vertices.some(v => ast.isPseudoState(v) && v.kind.endsWith('history'));
            const enteredDescendant = isComposite(vertex) && [...entered].some(e => e !== vertex && isAncestorOrSelf(vertex, e));
            if (!siblingHistory && !enteredDescendant) {
                accept('warning', `State '${vertex.name}' is never entered: it has no incoming transition.`, { node: vertex, property: 'name' });
            }
        }
    }
}

function rootOf(node: ast.Vertex | ast.Transition): ast.StateMachine {
    let current: { $container?: unknown } = node;
    while (current.$container) {
        current = current.$container as { $container?: unknown };
    }
    return current as ast.StateMachine;
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
