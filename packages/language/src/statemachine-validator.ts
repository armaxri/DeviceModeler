import type { AstNode, ValidationAcceptor, ValidationChecks } from 'langium';
import * as ast from './generated/ast.js';
import { regionPointAmbiguityMessage } from './statemachine-linker.js';
import type { DevmServices } from './devm-module.js';
import { isUnresolvedInstance, submachineOf } from './imports.js';
import { isKnownType } from './expression-validator.js';
import {
    allTransitions, allVertices, containerName, enclosingRegion, finalTransitions, initialTransitions,
    isAncestorOrSelf, isComposite, scopeOf, type ScopeContainer
} from './model-utils.js';

export function registerValidationChecks(services: DevmServices): void {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.StateMachineValidator;
    const checks: ValidationChecks<ast.DevmAstType> = {
        StateMachine: [validator.checkUniqueNames, validator.checkReachability, validator.checkContainer, validator.checkStateActions],
        State: [validator.checkContainer, validator.checkStateStructure, validator.checkStateActions],
        Region: validator.checkContainer,
        PseudoState: validator.checkPseudoState,
        Transition: [validator.checkTransition, validator.checkDeterminism]
    };
    registry.register(checks, validator);

    const expressions = services.validation.ExpressionValidator;
    const expressionChecks: ValidationChecks<ast.DevmAstType> = {
        StateMachine: [expressions.checkAnnotationCombinations, expressions.checkUnusedDeclarations],
        Annotation: expressions.checkAnnotation,
        InterfaceScope: expressions.checkInterfaceScope,
        InternalScope: expressions.checkInternalScope,
        ClassScope: expressions.checkClassScope,
        TypeReference: expressions.checkTypeReference,
        TypeAliasDeclaration: expressions.checkTypeAlias,
        VariableDeclaration: expressions.checkVariable,
        OperationDeclaration: expressions.checkOperation,
        ReactionSpec: expressions.checkGuard,
        LocalReaction: expressions.checkGuard,
        EventTrigger: expressions.checkEventTrigger,
        TimeTrigger: expressions.checkTimeTrigger,
        ExpressionStatement: expressions.checkExpressionStatement,
        RaiseStatement: expressions.checkRaise,
        ValueOfExpression: expressions.checkValueOf,
        AssignmentExpression: expressions.checkAssignment,
        PostfixExpression: expressions.checkPostfix,
        BinaryExpression: expressions.checkBinary,
        UnaryExpression: expressions.checkUnary,
        ConditionalExpression: expressions.checkConditional,
        CastExpression: expressions.checkCast,
        ElementReference: expressions.checkElementReference,
        CppReference: expressions.checkCppReference,
        MemberAccessExpression: expressions.checkMemberAccess,
        IndexExpression: expressions.checkIndex
    };
    registry.register(expressionChecks, expressions);
}

export class StateMachineValidator {

    /**
     * Names of vertices must be unique within their container (siblings), regions are transparent.
     * Exception (as in itemis CREATE): entry points and exit nodes with the same name may be placed in
     * different orthogonal regions of a state; `# >E` then enters every region through its entry point `E`.
     */
    checkUniqueNames(machine: ast.StateMachine, accept: ValidationAcceptor): void {
        const byParent = new Map<AstNode, Map<string, ast.Vertex[]>>();
        for (const vertex of allVertices(machine)) {
            const parent = ast.isRegion(vertex.$container) ? vertex.$container.$container : vertex.$container;
            const seen = byParent.get(parent) ?? new Map<string, ast.Vertex[]>();
            byParent.set(parent, seen);
            const others = seen.get(vertex.name) ?? [];
            const allowed = others.every(other => isRegionPoint(vertex) && isRegionPoint(other)
                && other.kind === vertex.kind && other.$container !== vertex.$container);
            if (!allowed) {
                accept('error', `Duplicate name '${vertex.name}'. Sibling states must have different names.`,
                    { node: vertex, property: 'name' });
            } else {
                seen.set(vertex.name, [...others, vertex]);
            }
        }
        const declarations = new Map<string, ast.Declaration>();
        for (const scope of machine.scopes) {
            for (const declaration of scope.declarations) {
                const name = ast.isInterfaceScope(scope) && scope.name ? `${scope.name}.${declaration.name}` : declaration.name;
                if (declarations.has(name)) {
                    accept('error', `Duplicate declaration '${name}'.`, { node: declaration, property: 'name' });
                } else {
                    declarations.set(name, declaration);
                }
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
        const hasEntryPoints = container.vertices.some(v => ast.isPseudoState(v) && v.kind === 'entry');
        if (container.vertices.length > 0 && initials.length === 0 && !hasEntryPoints) {
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

    checkStateActions(state: ast.State | ast.StateMachine, accept: ValidationAcceptor): void {
        for (const reaction of state.reactions) {
            if (reaction.triggers.length === 0 && !reaction.guard) {
                accept('warning', `Missing trigger: this reaction is never executed. Use 'always' or 'oncycle' to execute it in every step.`, { node: reaction });
            }
            for (const trigger of reaction.triggers) {
                if (ast.isBuiltinTrigger(trigger) && (trigger.kind === 'else' || trigger.kind === 'default')) {
                    accept('error', `'${trigger.kind}' can only be used on transitions leaving a choice.`, { node: trigger, property: 'kind' });
                }
            }
        }
    }

    checkPseudoState(pseudo: ast.PseudoState, accept: ValidationAcceptor): void {
        const container = scopeOf(pseudo);
        const transitions = allTransitions(rootOf(pseudo));
        const outgoing = transitions.filter(t => t.source?.ref === pseudo);
        const incoming = transitions.filter(t => t.target?.ref === pseudo);
        switch (pseudo.kind) {
            case 'history':
            case 'deephistory':
                if (ast.isStateMachine(container)) {
                    accept('error', 'History pseudo states must be placed inside a composite state.', { node: pseudo, property: 'kind' });
                }
                if (outgoing.length > 1) {
                    accept('error', 'A history pseudo state may have at most one outgoing (default) transition.', { node: pseudo, property: 'name' });
                }
                for (const t of outgoing) {
                    if (hasTrigger(t) || hasGuard(t)) {
                        accept('warning', 'The default transition of a history pseudo state should not have a trigger or guard.', { node: t, property: 'spec' });
                    }
                }
                break;
            case 'choice':
            case 'junction': {
                if (outgoing.length === 0) {
                    accept('error', `${capitalize(pseudo.kind)} '${pseudo.name}' needs at least one outgoing transition.`, { node: pseudo, property: 'name' });
                }
                for (const t of outgoing) {
                    if (t.spec?.triggers.some(trigger => !isDefaultTrigger(trigger))) {
                        accept('warning', `Transitions leaving ${pseudo.kind} '${pseudo.name}' must not have a trigger (except 'else' / 'default').`, { node: t, property: 'spec' });
                    }
                }
                const defaults = outgoing.filter(t => !hasGuard(t));
                if (defaults.length > 1) {
                    for (const t of defaults.slice(1)) {
                        accept('warning', `${capitalize(pseudo.kind)} '${pseudo.name}' has more than one default ('else') branch.`, { node: t, property: 'spec' });
                    }
                }
                if (outgoing.length > 0 && defaults.length === 0) {
                    accept('info', `Consider adding an 'else' branch to ${pseudo.kind} '${pseudo.name}'.`, { node: pseudo, property: 'name' });
                }
                break;
            }
            case 'entry':
                // entry points of the state machine itself are used when it is a submachine (`# >E`)
                if (outgoing.length !== 1) {
                    accept('error', `Entry point '${pseudo.name}' needs exactly one outgoing transition.`, { node: pseudo, property: 'name' });
                }
                for (const t of [...outgoing, ...incoming]) {
                    if (t.source?.ref === pseudo && (hasTrigger(t) || hasGuard(t))) {
                        accept('warning', 'The transition leaving an entry point must not have a trigger or guard.', { node: t, property: 'spec' });
                    }
                }
                if (incoming.length > 0) {
                    accept('error', `Entry point '${pseudo.name}' cannot be the target of a transition. Use '# >${pseudo.name}' on a transition to the composite state.`, { node: incoming[0], property: 'target' });
                }
                break;
            case 'exit':
                // exit nodes of the state machine itself are used when it is a submachine (`# X>`);
                // a state machine running on its own becomes final when it reaches one
                if (outgoing.length > 0) {
                    accept('error', `Exit node '${pseudo.name}' cannot have outgoing transitions. Use '# ${pseudo.name}>' on a transition leaving the composite state.`, { node: outgoing[0], property: 'source' });
                }
                break;
            case 'sync':
                if (incoming.length === 0 || outgoing.length === 0) {
                    accept('error', `Synchronization '${pseudo.name}' needs incoming and outgoing transitions.`, { node: pseudo, property: 'name' });
                } else if (incoming.length === 1 && outgoing.length === 1) {
                    accept('warning', `Synchronization '${pseudo.name}' should fork (several outgoing) or join (several incoming) transitions.`, { node: pseudo, property: 'name' });
                }
                for (const t of outgoing) {
                    if (hasTrigger(t)) {
                        accept('warning', 'Transitions leaving a synchronization must not have a trigger.', { node: t, property: 'spec' });
                    }
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
            if (hasTrigger(transition) || hasGuard(transition)) {
                accept('warning', 'Initial transitions must not have a trigger or guard.', { node: transition, property: 'spec' });
            }
            if (target && scopeOf(target) !== container) {
                accept('warning', `The initial transition should target a direct sub state of ${containerName(container)}.`, { node: transition, property: 'target' });
            }
        }
        if (transition.final && source && !isAncestorOrSelf(container, source)) {
            accept('warning', `'${source.name}' is not part of ${containerName(container)}; its final state is not reachable from it.`, { node: transition, property: 'source' });
        }
        if (source && ast.isPseudoState(source) && (source.kind === 'history' || source.kind === 'deephistory') && target && !isAncestorOrSelf(source.$container, target)) {
            accept('warning', 'The default transition of a history pseudo state should stay within its composite state.', { node: transition, property: 'target' });
        }
        if (source && ast.isState(source) && !hasTrigger(transition) && !hasGuard(transition) && transition.exitPoints.length === 0) {
            accept('warning', `Missing trigger: this transition is never taken. Use 'always' or 'oncycle' to take it in every step.`,
                { node: transition, property: transition.spec ? 'spec' : 'target' });
        }
        const sourceIsChoice = source && ast.isPseudoState(source) && (source.kind === 'choice' || source.kind === 'junction');
        for (const trigger of transition.spec?.triggers ?? []) {
            if (isDefaultTrigger(trigger) && !sourceIsChoice) {
                accept('error', `'${trigger.kind}' can only be used on transitions leaving a choice.`, { node: trigger, property: 'kind' });
            } else if (ast.isBuiltinTrigger(trigger) && (trigger.kind === 'entry' || trigger.kind === 'exit')) {
                accept('error', `'${trigger.kind}' can only be used in local reactions of a state.`, { node: trigger, property: 'kind' });
            }
        }
        if (source && target) {
            const sourceRegion = enclosingRegion(source);
            const targetRegion = enclosingRegion(target);
            const sync = (v: ast.Vertex) => ast.isPseudoState(v) && v.kind === 'sync';
            if (sourceRegion && targetRegion && sourceRegion !== targetRegion
                && sourceRegion.$container === targetRegion.$container && !sync(source) && !sync(target)) {
                accept('error', `Transitions between orthogonal regions are not allowed ('${source.name}' -> '${target.name}').`, { node: transition, property: 'target' });
            }
        }
        // (a state bound to an instance of a state machine whose import could not be resolved: the import is reported)
        const unresolved = (vertex: ast.Vertex | undefined) => ast.isState(vertex) && isUnresolvedInstance(vertex.submachine?.ref, isKnownType);
        transition.entryPoints.forEach((name, index) => {
            const entry = target && ast.isState(target) ? findPseudo(target, 'entry', name) : undefined;
            if (!entry && unresolved(target)) {
                return;
            }
            if (!entry) {
                accept('error', `'${target?.name ?? 'target'}' has no entry point '${name}'.`, { node: transition, property: 'entryPoints', index });
            } else if (index > 0) {
                accept('warning', `Only the first entry point ('${transition.entryPoints[0]}') is used; remove the others (like itemis CREATE).`,
                    { node: transition, property: 'entryPoints', index });
            }
        });
        const exits = new Set<string>();
        transition.exitPoints.forEach((name, index) => {
            const exit = source && ast.isState(source) ? findPseudo(source, 'exit', name) : undefined;
            if (!exit && unresolved(source)) {
                return;
            }
            if (!exit) {
                accept('error', `'${source?.name ?? 'source'}' has no exit node '${name}'.`, { node: transition, property: 'exitPoints', index });
            } else if (exits.has(name)) {
                accept('warning', `Duplicate exit node '${name}'.`, { node: transition, property: 'exitPoints', index });
            }
            exits.add(name);
        });
        if (source && isRegionPoint(source) && ast.isRegion(source.$container) && !isInside(transition, source.$container)
            && findPseudos(source.$container.$container, source.kind as 'entry' | 'exit', source.name).length > 1) {
            accept('error', regionPointAmbiguityMessage(source.name, source.kind as 'entry' | 'exit'),
                { node: transition, property: 'source' });
        }
        if (target && isRegionPoint(target) && ast.isRegion(target.$container) && !isInside(transition, target.$container)
            && findPseudos(target.$container.$container, target.kind as 'entry' | 'exit', target.name).length > 1) {
            accept('error', regionPointAmbiguityMessage(target.name, target.kind as 'entry' | 'exit'),
                { node: transition, property: 'target' });
        }
    }

    checkDeterminism(transition: ast.Transition, accept: ValidationAcceptor): void {
        const source = transition.source?.ref;
        const triggers = transition.spec?.triggers.filter(ast.isEventTrigger).map(t => t.event.$refText) ?? [];
        if (!source || triggers.length === 0 || hasGuard(transition)) {
            return;
        }
        const conflicts = allTransitions(rootOf(transition)).filter(t => t !== transition
            && t.source?.ref === source && !hasGuard(t)
            && t.spec?.triggers.some(trigger => ast.isEventTrigger(trigger) && triggers.includes(trigger.event.$refText)));
        if (conflicts.length > 0) {
            accept('warning', `'${source.name}' has several unguarded transitions for the same event; the first one in the text has priority.`, { node: transition, property: 'spec' });
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

function hasTrigger(transition: ast.Transition): boolean {
    return (transition.spec?.triggers.length ?? 0) > 0;
}

function hasGuard(transition: ast.Transition): boolean {
    return transition.spec?.guard !== undefined;
}

function isDefaultTrigger(trigger: ast.Trigger): trigger is ast.BuiltinTrigger {
    return ast.isBuiltinTrigger(trigger) && (trigger.kind === 'else' || trigger.kind === 'default');
}

/** Named entry point / exit node of a composite state (also inside its regions; the first one if there are several). */
export function findPseudo(state: ast.State, kind: 'entry' | 'exit', name: string): ast.PseudoState | undefined {
    return findPseudos(state, kind, name)[0];
}

/**
 * All entry points / exit nodes with the given name of a composite state (one per region at most).
 * For a submachine state: the entry points / exit nodes of the top level of the instance's state machine.
 */
export function findPseudos(state: ast.State, kind: 'entry' | 'exit', name: string): ast.PseudoState[] {
    const candidates = [...state.vertices, ...state.regions.flatMap(r => r.vertices), ...submachineOf(state)?.machine.vertices ?? []];
    return candidates.filter((v): v is ast.PseudoState => ast.isPseudoState(v) && v.kind === kind && v.name === name);
}

/** Entry points and exit nodes: they may have the same name in different regions of a state. */
function isRegionPoint(vertex: ast.Vertex): vertex is ast.PseudoState {
    return ast.isPseudoState(vertex) && (vertex.kind === 'entry' || vertex.kind === 'exit');
}

function isInside(node: AstNode, container: AstNode): boolean {
    for (let current: AstNode | undefined = node; current; current = current.$container) {
        if (current === container) {
            return true;
        }
    }
    return false;
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
