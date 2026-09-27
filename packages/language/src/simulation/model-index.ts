import { AstUtils, type AstNode } from 'langium';
import * as ast from '../generated/ast.js';
import { qualifiedName } from '../hsm-scope.js';
import type { EventDirection } from '../hsm-typesystem.js';
import { commonContainer, scopeOf, type ScopeContainer } from '../model-utils.js';
import { SimulationError } from './errors.js';

/**
 * A region in the execution sense: the state machine (top-level region), a composite state without
 * explicit regions (its implicit region) or an explicit `region`.
 */
export type RegionNode = ScopeContainer;

/** The final state (`[*]` as target) of a region. */
export interface FinalState {
    readonly $type: 'FinalState';
    readonly region: RegionNode;
}

/** Something a region can be "in": a state or its final state. */
export type ActiveVertex = ast.State | FinalState;

/** Target of a transition: a vertex or a final state. */
export type TargetVertex = ast.Vertex | FinalState;

export function isFinalState(node: unknown): node is FinalState {
    return typeof node === 'object' && node !== null && (node as FinalState).$type === 'FinalState';
}


/**
 * Structural information about a state machine that is needed for execution, computed once:
 * outgoing / incoming transitions in priority order, regions, final states, names.
 */
export class ModelIndex {

    readonly machine: ast.StateMachine;
    private readonly outgoingMap = new Map<ast.Vertex, ast.Transition[]>();
    private readonly incomingMap = new Map<ast.Vertex, ast.Transition[]>();
    private readonly exitMap = new Map<ast.State, ast.Transition[]>();
    private readonly finals = new Map<RegionNode, FinalState>();
    private readonly timeTriggerMap = new Map<ast.State | ast.StateMachine, ast.TimeTrigger[]>();
    private readonly stateNames = new Map<string, ast.State>();
    private readonly qualifiedNames = new Map<ast.State, string>();
    /** Declarations by their referable name (`x`, `Iface.x`). */
    readonly declarations = new Map<string, ast.Declaration>();
    private readonly declarationNames = new Map<ast.Declaration, string>();
    /** All states in document order. */
    readonly states: ast.State[] = [];

    constructor(machine: ast.StateMachine) {
        this.machine = machine;
        for (const scope of machine.scopes) {
            for (const declaration of scope.declarations) {
                const name = ast.isInterfaceScope(scope) && scope.name ? `${scope.name}.${declaration.name}` : declaration.name;
                if (!this.declarations.has(name)) {
                    this.declarations.set(name, declaration);
                }
                this.declarationNames.set(declaration, name);
            }
        }
        const transitions: ast.Transition[] = [];
        for (const node of AstUtils.streamAllContents(machine)) {
            if (ast.isTransition(node)) {
                transitions.push(node);
            } else if (ast.isState(node)) {
                this.states.push(node);
            }
        }
        transitions.sort((a, b) => documentOffset(a) - documentOffset(b));
        this.states.sort((a, b) => documentOffset(a) - documentOffset(b));
        for (const transition of transitions) {
            const source = transition.source?.ref;
            const target = transition.target?.ref;
            if (source) {
                if (transition.exitPoints.length > 0 && ast.isState(source)) {
                    push(this.exitMap, source, transition);
                } else {
                    push(this.outgoingMap, source, transition);
                }
            }
            if (target) {
                push(this.incomingMap, target, transition);
            }
            if (source && ast.isState(source) && transition.exitPoints.length === 0) {
                for (const trigger of transition.spec?.triggers ?? []) {
                    if (ast.isTimeTrigger(trigger)) {
                        push(this.timeTriggerMap, source, trigger);
                    }
                }
            }
        }
        for (const reaction of machine.reactions) {
            for (const trigger of reaction.triggers) {
                if (ast.isTimeTrigger(trigger)) {
                    push(this.timeTriggerMap, machine, trigger);
                }
            }
        }
        for (const state of this.states) {
            for (const reaction of state.reactions) {
                for (const trigger of reaction.triggers) {
                    if (ast.isTimeTrigger(trigger)) {
                        push(this.timeTriggerMap, state, trigger);
                    }
                }
            }
            this.timeTriggerMap.get(state)?.sort((a, b) => documentOffset(a) - documentOffset(b));
            this.qualifiedNames.set(state, qualifiedName(state));
        }
        // fully qualified names win, then unique suffixes (`Playing` for `Closed.Active.Playing`)
        const suffixes = new Map<string, ast.State[]>();
        for (const [state, name] of this.qualifiedNames) {
            this.stateNames.set(name, state);
            const segments = name.split('.');
            for (let i = 1; i < segments.length; i++) {
                push(suffixes, segments.slice(i).join('.'), state);
            }
        }
        for (const [suffix, candidates] of suffixes) {
            if (candidates.length === 1 && !this.stateNames.has(suffix)) {
                this.stateNames.set(suffix, candidates[0]);
            }
        }
    }

    /** Outgoing transitions of a vertex in priority (document) order, without `# X>` transitions. */
    outgoing(vertex: ast.Vertex): readonly ast.Transition[] {
        return this.outgoingMap.get(vertex) ?? [];
    }

    /** Incoming transitions of a vertex in document order. */
    incoming(vertex: ast.Vertex): readonly ast.Transition[] {
        return this.incomingMap.get(vertex) ?? [];
    }

    /** Transitions `state -> ... # X>` (also `# X> Y>`) leaving the given state through its exit node `X`. */
    exitTransitions(state: ast.State, exitNode: string): ast.Transition[] {
        return (this.exitMap.get(state) ?? []).filter(t => t.exitPoints.includes(exitNode));
    }

    /** Time triggers of the local reactions and outgoing transitions of a state (or of the reactions of the state machine). */
    timeTriggers(state: ast.State | ast.StateMachine): readonly ast.TimeTrigger[] {
        return this.timeTriggerMap.get(state) ?? [];
    }

    /** The final state of a region (created on demand, one per region). */
    finalState(region: RegionNode): FinalState {
        let final = this.finals.get(region);
        if (!final) {
            final = { $type: 'FinalState', region };
            this.finals.set(region, final);
        }
        return final;
    }

    /** The regions of a state (its explicit regions, its implicit region or none). */
    regionsOf(state: ast.State): RegionNode[] {
        if (state.regions.length > 0) {
            return state.regions;
        }
        return state.vertices.length > 0 ? [state] : [];
    }

    /** The region directly containing a vertex. */
    regionOf(vertex: TargetVertex): RegionNode {
        return isFinalState(vertex) ? vertex.region : scopeOf(vertex);
    }

    /** The state owning a region (`undefined` for the top-level region). */
    ownerState(region: RegionNode): ast.State | undefined {
        if (ast.isState(region)) {
            return region;
        }
        return ast.isRegion(region) ? region.$container : undefined;
    }

    /** The target of a transition (a vertex or the final state of the transition's container). */
    targetOf(transition: ast.Transition): TargetVertex {
        if (transition.final) {
            return this.finalState(scopeOf(transition));
        }
        const target = transition.target?.ref;
        if (!target) {
            throw new SimulationError(`Unresolved transition target '${transition.target?.$refText ?? ''}'`, transition);
        }
        return target;
    }

    /**
     * The transition scope of vertices: the innermost region containing all of them. If they are in
     * different regions of the same composite state, the region containing that state.
     */
    scopeRegion(vertices: TargetVertex[]): RegionNode {
        return this.commonRegion(vertices.map(v => this.regionOf(v)));
    }

    /**
     * The innermost region containing all given regions. If they are different regions of the same
     * composite state, the region containing that state.
     */
    commonRegion(regions: RegionNode[]): RegionNode {
        let common = regions[0];
        for (const region of regions.slice(1)) {
            common = commonContainer(common, region);
        }
        if (ast.isState(common) && common.regions.length > 0) {
            return scopeOf(common);
        }
        return common;
    }

    /** The vertex directly in `region` that is (or contains) `vertex`, or `undefined`. */
    childIn(region: RegionNode, vertex: TargetVertex): TargetVertex | undefined {
        let current: TargetVertex = vertex;
        for (;;) {
            const container = this.regionOf(current);
            if (container === region) {
                return current;
            }
            const owner = this.ownerState(container);
            if (!owner) {
                return undefined;
            }
            current = owner;
        }
    }

    /** Fully qualified name of a state. */
    stateName(state: ast.State): string {
        return this.qualifiedNames.get(state) ?? qualifiedName(state);
    }

    /** Resolves a fully qualified state name or a unique suffix of it (`Playing`, `Active.Playing`). */
    findState(name: string): ast.State | undefined {
        return this.stateNames.get(name);
    }

    /** Display name of a target vertex (final states: `Owner.[*]`). */
    vertexName(vertex: TargetVertex | undefined): string {
        if (!vertex) {
            return '[*]';
        }
        if (isFinalState(vertex)) {
            const owner = this.ownerState(vertex.region);
            const region = ast.isRegion(vertex.region) && vertex.region.name ? `${vertex.region.name}.` : '';
            return owner ? `${this.stateName(owner)}.${region}[*]` : '[*]';
        }
        return ast.isState(vertex) ? this.stateName(vertex) : qualifiedName(vertex);
    }

    /** Referable name of a declaration (`x` or `Iface.x`). */
    declarationName(declaration: ast.Declaration): string {
        return this.declarationNames.get(declaration) ?? declaration.name;
    }

    /** Resolves an event by its declared name; a simple name is accepted if it is unique. */
    findEvent(name: string): ast.EventDeclaration | undefined {
        return this.findDeclaration(name, ast.isEventDeclaration);
    }

    /** Resolves a variable or constant by its declared name; a simple name is accepted if it is unique. */
    findVariable(name: string): ast.VariableDeclaration | undefined {
        return this.findDeclaration(name, ast.isVariableDeclaration);
    }

    private findDeclaration<T extends ast.Declaration>(name: string, filter: (d: ast.Declaration) => d is T): T | undefined {
        const declaration = this.declarations.get(name);
        if (declaration && filter(declaration)) {
            return declaration;
        }
        const candidates = [...this.declarations.values()].filter(filter).filter(d => d.name === name);
        return candidates.length === 1 ? candidates[0] : undefined;
    }

    /** Direction of an event: internal scope events are internal, interface events are `in` unless declared `out`. */
    eventDirection(event: ast.EventDeclaration): EventDirection {
        if (ast.isInternalScope(event.$container)) {
            return 'internal';
        }
        return event.direction === 'out' ? 'out' : 'in';
    }

    /** All variables and constants in declaration order. */
    variables(): ast.VariableDeclaration[] {
        return this.machine.scopes.flatMap(s => s.declarations).filter(ast.isVariableDeclaration);
    }

    /** All events in declaration order. */
    events(): ast.EventDeclaration[] {
        return this.machine.scopes.flatMap(s => s.declarations).filter(ast.isEventDeclaration);
    }

    /** Named entry point / exit node of a composite state (also inside its regions). */
    findPseudo(state: ast.State, kind: 'entry' | 'exit', name: string): ast.PseudoState | undefined {
        const candidates = [...state.vertices, ...state.regions.flatMap(r => r.vertices)];
        return candidates.find((v): v is ast.PseudoState => ast.isPseudoState(v) && v.kind === kind && v.name === name);
    }

    /**
     * The entry point named `name` of a region (a direct vertex of the region), if any. Entering a state
     * through `# >E` enters every region with an entry point `E` through it (docs/semantics.md §7).
     */
    entryPointIn(region: RegionNode, name: string): ast.PseudoState | undefined {
        return region.vertices.find((v): v is ast.PseudoState => ast.isPseudoState(v) && v.kind === 'entry' && v.name === name);
    }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}

/** Position of a node in the text; used to sort transitions into priority order. */
function documentOffset(node: AstNode): number {
    return node.$cstNode?.offset ?? 0;
}
