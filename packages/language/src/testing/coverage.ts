import { AstUtils, type AstNode } from 'langium';
import * as ast from '../generated/ast.js';
import { qualifiedName } from '../hsm-scope.js';
import { DEFINITION_ID, finalNodeId, initialNodeId, MACHINE_ID } from '../diagram/layout.js';
import { getStateMachine, nodeText, scopeOf, transitionLabel, type ScopeContainer } from '../model-utils.js';
import type { SimulationOptions, TraceEntry } from '../simulation/interpreter.js';

/*
 * Model coverage (like the coverage view of SCTUnit in itemis CREATE): which states were entered,
 * which transitions were taken, which local reactions were executed and whether every guard was
 * observed both true and false. Browser compatible (no Node.js dependencies); the report formats
 * are in `coverage-reports.ts`.
 */

/** Coverage metrics. */
export type CoverageMetric = 'states' | 'transitions' | 'reactions' | 'guards';

export const COVERAGE_METRICS: readonly CoverageMetric[] = ['states', 'transitions', 'reactions', 'guards'];

/**
 * Kind of a covered element: `state`, `final` (the final state of a region), `transition` (every
 * `Transition` of the model including initial transitions, choice branches, history defaults,
 * entry / exit point transitions and the parts of a fork / join) and `reaction` (local reactions
 * of states and of the state machine, including `entry` / `exit` reactions).
 */
export type CoverageElementKind = 'state' | 'final' | 'transition' | 'reaction';

export interface CoverageElement {
    /**
     * Stable id. States, final states and transitions: the id of the diagram element (see
     * `layoutStateMachine`): `Active.Playing`, `Active#final`, `Service#region1#final`,
     * `#machine#initial->Closed`, `Closed->Opened` (`Closed->Opened~1` for the second transition
     * between the same vertices). Reactions: `<id of the state>#reaction<n>` (`#machine#reaction<n>`
     * for reactions of the state machine), n is 1-based in document order.
     */
    readonly id: string;
    readonly kind: CoverageElementKind;
    /** Display name: `Active.Playing`, `Active.[*]`, `[*] -> Closed`, `Closed -> Opened : open`, `Opened: entry / x += 1`. */
    readonly name: string;
    /** 1-based source line of the element (final states: of the first transition to the final state). */
    readonly line?: number;
    /** Id of the diagram node or edge showing the element (reactions: the state showing it). */
    readonly diagramId?: string;
    /** States and final states: id of the diagram node of the region (`#machine`, `Moving`, `Service#region1`). */
    readonly region?: string;
    /** How often the element was entered / taken / executed. */
    readonly hits: number;
    /** Tests which covered the element (`TestClass.test`), sorted. */
    readonly tests: readonly string[];
}

/** Guard (decision) coverage of a guarded transition or local reaction: was the guard true and false? */
export interface GuardCoverage {
    /** Id of the transition or reaction owning the guard ({@link CoverageElement.id}). */
    readonly id: string;
    readonly kind: 'transition' | 'reaction';
    /** Display name of the owner. */
    readonly name: string;
    /** Source text of the guard expression. */
    readonly expression: string;
    /** 1-based source line of the guard. */
    readonly line?: number;
    /** How often the guard was evaluated to true / false (it is evaluated only if a trigger matched). */
    readonly trueHits: number;
    readonly falseHits: number;
    readonly trueTests: readonly string[];
    readonly falseTests: readonly string[];
}

export interface CoverageCounter {
    readonly covered: number;
    readonly total: number;
    /** Percentage (0–100), `undefined` if there is nothing to cover. */
    readonly percent?: number;
}

export type CoverageTotals = Readonly<Record<CoverageMetric, CoverageCounter>>;

export interface MachineCoverage {
    /** Name of the state machine. */
    readonly machine: string;
    /** URI of the document containing the state machine, if known. */
    readonly uri?: string;
    readonly totals: CoverageTotals;
    /** All elements in document order (states and final states, then transitions, then reactions). */
    readonly elements: readonly CoverageElement[];
    /** One entry per guard (each counts as two decisions: true and false). */
    readonly guards: readonly GuardCoverage[];
}

export interface CoverageReport {
    /** Version of the report schema. */
    readonly version: 1;
    /** Number of tests executed while collecting. */
    readonly tests: number;
    readonly totals: CoverageTotals;
    readonly machines: readonly MachineCoverage[];
}

/** Classes of diagram elements for coverage highlighting (see {@link CoverageDiagramRenderer}). */
export const COVERED_CLASS = 'hsm-covered';
export const UNCOVERED_CLASS = 'hsm-uncovered';

/**
 * Coverage of the diagram elements of a state machine: ids of diagram nodes and edges (as created by
 * `layoutStateMachine`) which were covered or not. Pseudo states (including the initial nodes) are
 * covered if one of their transitions was taken; a state with uncovered local reactions is covered.
 */
export interface CoverageHighlight {
    readonly covered: readonly string[];
    readonly uncovered: readonly string[];
    /** Diagram id -> `hsm-covered` / `hsm-uncovered`. */
    readonly classes: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------------------------
// Diagram ids

export interface DiagramIds {
    /** Vertices, regions, transitions and the state machine itself. */
    readonly nodes: ReadonlyMap<AstNode, string>;
    /** Initial pseudo state node per container. */
    readonly initial: ReadonlyMap<ScopeContainer, string>;
    /** Final state node per container. */
    readonly final: ReadonlyMap<ScopeContainer, string>;
}

/**
 * The ids of the diagram elements of a state machine, computed without a layout. They are the same
 * as in `layoutStateMachine(machine).ids` (the algorithm mirrors the diagram builder).
 */
export function diagramIds(machine: ast.StateMachine): DiagramIds {
    const nodes = new Map<AstNode, string>();
    const initial = new Map<ScopeContainer, string>();
    const final = new Map<ScopeContainer, string>();
    const used = new Set<string>([MACHINE_ID, DEFINITION_ID]);
    const registered = new Set<string>();
    const unique = (base: string) => {
        let id = base;
        let counter = 1;
        while (used.has(id)) {
            id = `${base}~${counter++}`;
        }
        used.add(id);
        return id;
    };
    const scope = (container: ScopeContainer, scopeId: string) => {
        if (container.transitions.some(t => t.initial)) {
            const id = unique(initialNodeId(scopeId));
            registered.add(id);
            initial.set(container, id);
        }
        for (const vertex of container.vertices) {
            const id = unique(vertex.name ? qualifiedName(vertex) : '#unnamed');
            registered.add(id);
            nodes.set(vertex, id);
            if (ast.isState(vertex) && (vertex.vertices.length > 0 || vertex.regions.length > 0)) {
                vertex.regions.forEach((region, index) => {
                    const regionId = unique(`${id}#region${index + 1}`);
                    registered.add(regionId);
                    nodes.set(region, regionId);
                    scope(region, regionId);
                });
                scope(vertex, id);
            }
        }
        if (container.transitions.some(t => t.final)) {
            const id = unique(finalNodeId(scopeId));
            registered.add(id);
            final.set(container, id);
        }
    };
    nodes.set(machine, MACHINE_ID);
    scope(machine, MACHINE_ID);
    const visit = (container: ScopeContainer) => {
        const scopeId = nodes.get(container)!;
        for (const transition of container.transitions) {
            const find = (id: string) => registered.has(id) ? id : undefined;
            const source = transition.initial ? find(initialNodeId(scopeId)) : nodes.get(transition.source?.ref as AstNode);
            const target = transition.final ? find(finalNodeId(scopeId)) : nodes.get(transition.target?.ref as AstNode);
            if (source && target) {
                nodes.set(transition, unique(`${source}->${target}`));
            }
        }
        for (const vertex of container.vertices) {
            if (ast.isState(vertex)) {
                visit(vertex);
                vertex.regions.forEach(visit);
            }
        }
    };
    visit(machine);
    return { nodes, initial, final };
}

// ---------------------------------------------------------------------------------------------
// Collection

interface ElementRecord {
    readonly element: Omit<CoverageElement, 'hits' | 'tests'>;
    hits: number;
    readonly tests: Set<string>;
}

interface GuardRecord {
    readonly guard: Omit<GuardCoverage, 'trueHits' | 'falseHits' | 'trueTests' | 'falseTests'>;
    trueHits: number;
    falseHits: number;
    readonly trueTests: Set<string>;
    readonly falseTests: Set<string>;
}

interface MachineRecord {
    readonly machine: ast.StateMachine;
    readonly ids: DiagramIds;
    readonly elements: ElementRecord[];
    /** Transition / reaction / state -> record */
    readonly byNode: Map<AstNode, ElementRecord>;
    /** Container -> record of its final state */
    readonly finals: Map<ScopeContainer, ElementRecord>;
    readonly guards: GuardRecord[];
    readonly byGuard: Map<ast.Expression, GuardRecord>;
}

/**
 * Collects the coverage of state machines executed by {@link StatechartInterpreter}s. Attach it to
 * any interpreter (tests, simulation):
 *
 * ```ts
 * const coverage = new CoverageCollector();
 * const sim = new StatechartInterpreter(machine, coverage.attach({ operations }));
 * sim.enter(); ...
 * const report = coverage.report();
 * ```
 *
 * Coverage is aggregated over all interpreters it was attached to. Machines are registered on
 * their first trace entry (or explicitly with {@link register}, e.g. to report machines whose
 * tests all failed before `enter`). With {@link beginTest} the covered elements are attributed to tests.
 */
export class CoverageCollector {

    private readonly machines = new Map<ast.StateMachine, MachineRecord>();
    private currentTest?: string;
    private testCount = 0;

    /** Trace listener (`SimulationOptions.onTrace`). */
    readonly onTrace = (entry: TraceEntry): void => {
        switch (entry.kind) {
            case 'enter':
            case 'transition':
            case 'reaction':
                this.hit(this.recordOf(entry.node)?.byNode.get(entry.node));
                break;
            case 'final':
                this.hit(this.recordOf(entry.region)?.finals.get(entry.region));
                break;
        }
    };

    /** Guard listener (`SimulationOptions.onGuard`). */
    readonly onGuard = (guard: ast.Expression, value: boolean): void => {
        const record = this.recordOf(guard)?.byGuard.get(guard);
        if (!record) {
            return;
        }
        if (value) {
            record.trueHits++;
        } else {
            record.falseHits++;
        }
        if (this.currentTest !== undefined) {
            (value ? record.trueTests : record.falseTests).add(this.currentTest);
        }
    };

    /** Returns simulation options that report to this collector (existing `onTrace` / `onGuard` listeners are kept). */
    attach(options: SimulationOptions = {}): SimulationOptions {
        const { onTrace, onGuard } = options;
        return {
            ...options,
            onTrace: onTrace ? entry => { this.onTrace(entry); onTrace(entry); } : this.onTrace,
            onGuard: onGuard ? (guard, value) => { this.onGuard(guard, value); onGuard(guard, value); } : this.onGuard
        };
    }

    /** Registers a state machine so that it is reported even if it was never executed. */
    register(machine: ast.StateMachine): void {
        if (!this.machines.has(machine)) {
            this.machines.set(machine, createRecord(machine));
        }
    }

    /** Attributes the following coverage to a test (`TestClass.test`). */
    beginTest(name: string): void {
        this.currentTest = name;
        this.testCount++;
    }

    endTest(): void {
        this.currentTest = undefined;
    }

    /** Forgets all collected coverage (registered machines stay registered). */
    reset(): void {
        for (const machine of [...this.machines.keys()]) {
            this.machines.set(machine, createRecord(machine));
        }
        this.testCount = 0;
    }

    /** The coverage of one state machine (`undefined` if it was neither registered nor executed). */
    machineCoverage(machine: ast.StateMachine): MachineCoverage | undefined {
        const record = this.machines.get(machine);
        return record && toMachineCoverage(record);
    }

    /** The diagram highlighting of a state machine. */
    highlight(machine: ast.StateMachine): CoverageHighlight | undefined {
        const record = this.machines.get(machine);
        return record && computeHighlight(record);
    }

    /** The state machine and its highlighting for a machine of a {@link report} (for diagrams in reports). */
    diagramSource(coverage: Pick<MachineCoverage, 'machine' | 'uri'>): { machine: ast.StateMachine, highlight: CoverageHighlight } | undefined {
        for (const record of this.machines.values()) {
            if (record.machine.name === coverage.machine && record.machine.$document?.uri.toString() === coverage.uri) {
                return { machine: record.machine, highlight: computeHighlight(record) };
            }
        }
        return undefined;
    }

    report(): CoverageReport {
        const machines = [...this.machines.values()].map(toMachineCoverage)
            .sort((a, b) => (a.uri ?? '').localeCompare(b.uri ?? '') || a.machine.localeCompare(b.machine));
        return { version: 1, tests: this.testCount, totals: sumTotals(machines.map(m => m.totals)), machines };
    }

    private recordOf(node: AstNode): MachineRecord | undefined {
        let machine: ast.StateMachine;
        try {
            machine = getStateMachine(node);
        } catch {
            return undefined;
        }
        let record = this.machines.get(machine);
        if (!record) {
            record = createRecord(machine);
            this.machines.set(machine, record);
        }
        return record;
    }

    private hit(record: ElementRecord | undefined): void {
        if (record) {
            record.hits++;
            if (this.currentTest !== undefined) {
                record.tests.add(this.currentTest);
            }
        }
    }
}

function createRecord(machine: ast.StateMachine): MachineRecord {
    const ids = diagramIds(machine);
    const record: MachineRecord = { machine, ids, elements: [], byNode: new Map(), finals: new Map(), guards: [], byGuard: new Map() };
    const add = (node: AstNode | undefined, element: Omit<CoverageElement, 'hits' | 'tests'>) => {
        const entry: ElementRecord = { element: stripUndefined(element), hits: 0, tests: new Set() };
        record.elements.push(entry);
        if (node) {
            record.byNode.set(node, entry);
        }
        return entry;
    };
    const addGuard = (guard: ast.Expression | undefined, owner: ElementRecord, kind: GuardCoverage['kind']) => {
        if (!guard) {
            return;
        }
        const entry: GuardRecord = {
            guard: stripUndefined({ id: owner.element.id, kind, name: owner.element.name, expression: nodeText(guard), line: lineOf(guard) }),
            trueHits: 0, falseHits: 0, trueTests: new Set(), falseTests: new Set()
        };
        record.guards.push(entry);
        record.byGuard.set(guard, entry);
    };

    const states: ast.State[] = [];
    const transitions: ast.Transition[] = [];
    const containers: ScopeContainer[] = [machine];
    for (const node of AstUtils.streamAllContents(machine)) {
        if (ast.isState(node)) {
            states.push(node);
            containers.push(node);
        } else if (ast.isRegion(node)) {
            containers.push(node);
        } else if (ast.isTransition(node)) {
            transitions.push(node);
        }
    }
    // states and final states in document order
    const vertexElements: Array<{ offset: number, create: () => void }> = [];
    for (const state of states) {
        vertexElements.push({
            offset: offsetOf(state),
            create: () => add(state, {
                id: ids.nodes.get(state) ?? `${qualifiedName(state)}@${lineOf(state) ?? 0}`, kind: 'state', name: qualifiedName(state),
                line: lineOf(state), diagramId: ids.nodes.get(state), region: ids.nodes.get(scopeOf(state))
            })
        });
    }
    for (const container of containers) {
        const first = container.transitions.find(t => t.final);
        if (!first) {
            continue;
        }
        vertexElements.push({
            offset: offsetOf(first),
            create: () => {
                const containerId = ids.nodes.get(container) ?? MACHINE_ID;
                const entry = add(undefined, {
                    id: ids.final.get(container) ?? finalNodeId(containerId), kind: 'final', name: finalName(container),
                    line: lineOf(first), diagramId: ids.final.get(container), region: ids.nodes.get(container)
                });
                record.finals.set(container, entry);
            }
        });
    }
    vertexElements.sort((a, b) => a.offset - b.offset).forEach(v => v.create());

    transitions.sort((a, b) => offsetOf(a) - offsetOf(b));
    for (const transition of transitions) {
        const id = ids.nodes.get(transition);
        const entry = add(transition, {
            id: id ?? `transition@${lineOf(transition) ?? 0}`, kind: 'transition', name: transitionName(transition),
            line: lineOf(transition), diagramId: id
        });
        addGuard(transition.spec?.guard, entry, 'transition');
    }

    const owners: Array<ast.State | ast.StateMachine> = [machine, ...states];
    const reactions: Array<{ reaction: ast.LocalReaction, owner: ast.State | ast.StateMachine, index: number }> = [];
    for (const owner of owners) {
        owner.reactions.forEach((reaction, index) => reactions.push({ reaction, owner, index }));
    }
    reactions.sort((a, b) => offsetOf(a.reaction) - offsetOf(b.reaction));
    for (const { reaction, owner, index } of reactions) {
        const ownerId = ids.nodes.get(owner) ?? (ast.isState(owner) ? qualifiedName(owner) : MACHINE_ID);
        const entry = add(reaction, {
            id: `${ownerId}#reaction${index + 1}`, kind: 'reaction',
            name: `${ast.isState(owner) ? qualifiedName(owner) : owner.name}: ${nodeText(reaction)}`,
            line: lineOf(reaction), diagramId: ast.isState(owner) ? ids.nodes.get(owner) : DEFINITION_ID
        });
        addGuard(reaction.guard, entry, 'reaction');
    }
    record.guards.sort((a, b) => (a.guard.line ?? 0) - (b.guard.line ?? 0));
    return record;
}

function toMachineCoverage(record: MachineRecord): MachineCoverage {
    const elements: CoverageElement[] = record.elements.map(e => ({ ...e.element, hits: e.hits, tests: [...e.tests].sort() }));
    const guards: GuardCoverage[] = record.guards.map(g => ({
        ...g.guard, trueHits: g.trueHits, falseHits: g.falseHits, trueTests: [...g.trueTests].sort(), falseTests: [...g.falseTests].sort()
    }));
    const count = (kinds: CoverageElementKind[]) => counter(
        elements.filter(e => kinds.includes(e.kind) && e.hits > 0).length,
        elements.filter(e => kinds.includes(e.kind)).length
    );
    const totals: CoverageTotals = {
        states: count(['state', 'final']),
        transitions: count(['transition']),
        reactions: count(['reaction']),
        guards: counter(guards.reduce((sum, g) => sum + (g.trueHits > 0 ? 1 : 0) + (g.falseHits > 0 ? 1 : 0), 0), 2 * guards.length)
    };
    const uri = record.machine.$document?.uri.toString();
    return stripUndefined({ machine: record.machine.name, uri, totals, elements, guards });
}

function computeHighlight(record: MachineRecord): CoverageHighlight {
    const classes: Record<string, string> = {};
    const covered = new Set<string>();
    const all = new Set<string>();
    for (const { element, hits } of record.elements) {
        if (element.kind === 'reaction' || !element.diagramId) {
            continue;
        }
        all.add(element.diagramId);
        if (hits > 0) {
            covered.add(element.diagramId);
        }
    }
    // pseudo states and initial nodes: covered if a transition from or to them was taken
    const ends = new Map<string, boolean>();
    for (const [node, entry] of record.byNode) {
        if (!ast.isTransition(node)) {
            continue;
        }
        const taken = entry.hits > 0;
        const scope = scopeOf(node);
        const endIds = [
            node.initial ? record.ids.initial.get(scope) : pseudoId(record, node.source?.ref),
            pseudoId(record, node.target?.ref)
        ];
        for (const id of endIds) {
            if (id) {
                ends.set(id, (ends.get(id) ?? false) || taken);
            }
        }
    }
    for (const [id, taken] of ends) {
        all.add(id);
        if (taken) {
            covered.add(id);
        }
    }
    const uncovered = [...all].filter(id => !covered.has(id));
    for (const id of all) {
        classes[id] = covered.has(id) ? COVERED_CLASS : UNCOVERED_CLASS;
    }
    return { covered: [...covered], uncovered, classes };
}

function pseudoId(record: MachineRecord, vertex: ast.Vertex | undefined): string | undefined {
    return vertex && ast.isPseudoState(vertex) ? record.ids.nodes.get(vertex) : undefined;
}

export function counter(covered: number, total: number): CoverageCounter {
    return total === 0 ? { covered, total } : { covered, total, percent: Math.round(covered / total * 10000) / 100 };
}

function sumTotals(list: readonly CoverageTotals[]): CoverageTotals {
    const sum = (metric: CoverageMetric) => counter(
        list.reduce((s, t) => s + t[metric].covered, 0),
        list.reduce((s, t) => s + t[metric].total, 0)
    );
    return { states: sum('states'), transitions: sum('transitions'), reactions: sum('reactions'), guards: sum('guards') };
}

function finalName(container: ScopeContainer): string {
    if (ast.isStateMachine(container)) {
        return '[*]';
    }
    if (ast.isState(container)) {
        return `${qualifiedName(container)}.[*]`;
    }
    const owner = container.$container;
    const region = container.name ?? `region${owner.regions.indexOf(container) + 1}`;
    return `${qualifiedName(owner)}.${region}.[*]`;
}

/** `[*] -> Closed`, `Closed -> Opened : open [x > 0]`, `Closed -> Moving : open # >Opening`. */
export function transitionName(transition: ast.Transition): string {
    const source = transition.initial ? '[*]' : transition.source?.ref ? qualifiedName(transition.source.ref) : transition.source?.$refText ?? '?';
    const target = transition.final ? '[*]' : transition.target?.ref ? qualifiedName(transition.target.ref) : transition.target?.$refText ?? '?';
    const label = transitionLabel(transition);
    return `${source} -> ${target}${label ? (label.startsWith('#') ? ` ${label}` : ` : ${label}`) : ''}`;
}

function lineOf(node: AstNode): number | undefined {
    const line = node.$cstNode?.range.start.line;
    return line === undefined ? undefined : line + 1;
}

function offsetOf(node: AstNode): number {
    return node.$cstNode?.offset ?? 0;
}

function stripUndefined<T extends object>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------------------------
// Thresholds

export type CoverageThresholds = Partial<Record<CoverageMetric, number>>;

/**
 * Parses thresholds: `states=100,transitions=90` (metrics: states, transitions, reactions, guards;
 * `all=80` or a plain number sets all metrics).
 */
export function parseCoverageThresholds(text: string): CoverageThresholds {
    const result: CoverageThresholds = {};
    for (const part of text.split(',').map(p => p.trim()).filter(p => p)) {
        const match = /^(?:([a-z]+)\s*[=:]\s*)?(\d+(?:\.\d+)?)%?$/i.exec(part);
        if (!match) {
            throw new Error(`Invalid coverage threshold '${part}' (expected e.g. states=100,transitions=90)`);
        }
        const value = Number(match[2]);
        if (value > 100) {
            throw new Error(`Invalid coverage threshold '${part}' (at most 100)`);
        }
        const key = (match[1] ?? 'all').toLowerCase();
        const metric = key === 'decisions' || key === 'branches' ? 'guards' : key;
        if (metric === 'all') {
            COVERAGE_METRICS.forEach(m => result[m] = value);
        } else if ((COVERAGE_METRICS as readonly string[]).includes(metric)) {
            result[metric as CoverageMetric] = value;
        } else {
            throw new Error(`Unknown coverage metric '${match[1]}' (supported: ${COVERAGE_METRICS.join(', ')}, all)`);
        }
    }
    return result;
}

/** Checks the totals of a report against thresholds; returns the failure messages (empty: all met). */
export function checkCoverageThresholds(report: CoverageReport, thresholds: CoverageThresholds): string[] {
    const failures: string[] = [];
    for (const metric of COVERAGE_METRICS) {
        const threshold = thresholds[metric];
        const actual = report.totals[metric];
        if (threshold !== undefined && actual.percent !== undefined && actual.percent < threshold) {
            failures.push(`${metric} coverage ${actual.percent}% (${actual.covered}/${actual.total}) is below the threshold of ${threshold}%`);
        }
    }
    return failures;
}
