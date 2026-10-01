import type { StateMachine } from '../generated/ast.js';
import { SimulationError } from './errors.js';
import { StatechartInterpreter, type OperationImplementation, type TraceEntry } from './interpreter.js';
import type { HostValue } from './values.js';

/**
 * Scenario tests: a JSON format describing a run of a state machine and the expected observations.
 * The format is shared by the interpreter and code generators (it only uses JSON values), see
 * `packages/language/test/scenarios/README.md`.
 */

/**
 * A value in a scenario: integers, reals, booleans and strings; values of C++ enum types as the
 * qualified name of the enumerator (`"motor::Mode::Fast"`), structs as objects (`{"x": 1, "y": 2}`,
 * in expectations only the listed members are compared), arrays as arrays.
 */
export type ScenarioValue = number | boolean | string | ScenarioValue[] | { [member: string]: ScenarioValue };

export interface Scenario {
    /** Name of the scenario (defaults to the file name). */
    name?: string;
    /** What the scenario checks, e.g. the rule of docs/semantics.md. */
    description?: string;
    /** Path of the model file, relative to the scenario file. Either `model` or `text` is required. */
    model?: string;
    /** Inline model text; an array of strings is joined with line breaks. */
    text?: string | string[];
    /**
     * Inline texts of further files the model imports, by path relative to the model
     * (`{ "motor.hsm": ["statemachine Motor {", ...] }`); arrays are joined with line breaks.
     */
    files?: Record<string, string | string[]>;
    /** Return values of operations in call order; the last value is repeated. */
    operations?: Record<string, ScenarioValue[]>;
    /** The steps, executed in order. */
    steps: ScenarioStep[];
}

/** A scenario step: exactly one action or `expect`. */
export interface ScenarioStep {
    comment?: string;
    /** Enters the state machine. */
    enter?: true;
    /** Exits the state machine. */
    exit?: true;
    /** Raises an in event (`open`, `Iface.open`), optionally with `value`. */
    raise?: string;
    value?: ScenarioValue;
    /** Runs one (or the given number of) run cycles. */
    runCycle?: true | number;
    /** Advances the virtual clock by the given ms (`advanceTime`). */
    advance?: number;
    /** Advances the clock by the given ms, running cycles at each cycle period (`runFor`). */
    runFor?: number;
    /** Sets variables. */
    set?: Record<string, ScenarioValue>;
    /** Checks observations. Out events and calls are collected since the previous `expect`. */
    expect?: ScenarioExpectation;
    /** The action of this step must fail with a runtime error whose message contains this text. */
    expectError?: string;
}

export interface ScenarioExpectation {
    /** States that must be active (qualified names or unique suffixes). */
    active?: string[];
    /** States that must not be active. */
    inactive?: string[];
    /** Exactly these states are the active leaf states (states without active sub states). */
    configuration?: string[];
    /** Whether the state machine is final. */
    final?: boolean;
    /** Values of variables and constants. Reals are compared with a relative tolerance of 1e-9. */
    variables?: Record<string, ScenarioValue>;
    /** Exactly these out events since the previous `expect`, in order: `alarm`, `led(1)`. */
    outEvents?: string[];
    /** Exactly these operation calls since the previous `expect`, in order: `setLed(1, true)`. */
    calls?: string[];
}

export interface ScenarioFailure {
    /** Index of the failed step (0-based). */
    step: number;
    message: string;
}

export interface ScenarioResult {
    name: string;
    passed: boolean;
    failures: ScenarioFailure[];
}

export interface ScenarioRunOptions {
    /** Called after each executed step. */
    onStep?: (step: ScenarioStep, index: number, interpreter: StatechartInterpreter) => void;
    /** Called for every trace entry of the interpreter. */
    onTrace?: (entry: TraceEntry) => void;
    /** Called for every failure as soon as it is detected. */
    onFailure?: (failure: ScenarioFailure) => void;
}

const ACTIONS = ['enter', 'exit', 'raise', 'runCycle', 'advance', 'runFor', 'set', 'expect'] as const;
const STEP_KEYS = new Set<string>([...ACTIONS, 'value', 'expectError', 'comment']);
const EXPECT_KEYS = new Set(['active', 'inactive', 'configuration', 'final', 'variables', 'outEvents', 'calls']);

/** Checks the structure of parsed JSON and returns it as a scenario; throws an `Error` with all problems. */
export function validateScenario(json: unknown, name = 'scenario'): Scenario {
    const problems: string[] = [];
    const scenario = json as Scenario;
    if (typeof json !== 'object' || json === null || !Array.isArray(scenario.steps)) {
        throw new Error(`${name}: a scenario must be an object with a 'steps' array`);
    }
    if ((scenario.model === undefined) === (scenario.text === undefined)) {
        problems.push(`exactly one of 'model' and 'text' is required`);
    }
    if (scenario.files !== undefined && (typeof scenario.files !== 'object' || scenario.files === null
        || Object.values(scenario.files).some(text => typeof text !== 'string' && !Array.isArray(text)))) {
        problems.push(`'files' must map file names to texts (strings or arrays of lines)`);
    }
    scenario.steps.forEach((step, index) => {
        const keys = Object.keys(step);
        const unknown = keys.filter(k => !STEP_KEYS.has(k));
        if (unknown.length > 0) {
            problems.push(`step ${index}: unknown keys ${unknown.join(', ')}`);
        }
        const actions = keys.filter(k => (ACTIONS as readonly string[]).includes(k));
        if (actions.length !== 1) {
            problems.push(`step ${index}: exactly one action (${ACTIONS.join(', ')}) expected, found ${actions.length}`);
        }
        if (step.value !== undefined && step.raise === undefined) {
            problems.push(`step ${index}: 'value' is only allowed with 'raise'`);
        }
        if (step.expect) {
            const unknownExpect = Object.keys(step.expect).filter(k => !EXPECT_KEYS.has(k));
            if (unknownExpect.length > 0) {
                problems.push(`step ${index}: unknown expectation ${unknownExpect.join(', ')}`);
            }
            if (step.expectError !== undefined) {
                problems.push(`step ${index}: 'expectError' cannot be combined with 'expect'`);
            }
        }
    });
    if (problems.length > 0) {
        throw new Error(`${name}: ${problems.join('; ')}`);
    }
    return scenario;
}

/** The inline model text of a scenario (`undefined` if it references a model file). */
export function scenarioText(scenario: Scenario): string | undefined {
    return Array.isArray(scenario.text) ? scenario.text.join('\n') : scenario.text;
}

/** The inline texts of the files imported by the model of a scenario, by relative path (empty if there are none). */
export function scenarioFiles(scenario: Scenario): Record<string, string> {
    const files: Record<string, string> = {};
    for (const [name, text] of Object.entries(scenario.files ?? {})) {
        files[name] = Array.isArray(text) ? text.join('\n') : text;
    }
    return files;
}

/** Runs a scenario against the interpreter. Execution stops at the first unexpected error. */
export function runScenario(machine: StateMachine, scenario: Scenario, options: ScenarioRunOptions = {}): ScenarioResult {
    const name = scenario.name ?? machine.name;
    const failures: ScenarioFailure[] = [];
    let outEvents: string[] = [];
    let calls: string[] = [];
    const operations: Record<string, OperationImplementation> = {};
    for (const [operation, values] of Object.entries(scenario.operations ?? {})) {
        let next = 0;
        operations[operation] = () => values.length === 0 ? undefined : values[Math.min(next++, values.length - 1)];
    }
    let sim: StatechartInterpreter;
    try {
        sim = new StatechartInterpreter(machine, {
            operations,
            onOutEvent: event => outEvents.push(event.text),
            onTrace: entry => {
                if (entry.kind === 'call') {
                    calls.push(entry.text);
                }
                options.onTrace?.(entry);
            }
        });
    } catch (error) {
        const failure = { step: -1, message: errorMessage(error) };
        options.onFailure?.(failure);
        return { name, passed: false, failures: [failure] };
    }
    for (let index = 0; index < scenario.steps.length; index++) {
        const step = scenario.steps[index];
        const fail = (message: string) => {
            const failure = { step: index, message };
            failures.push(failure);
            options.onFailure?.(failure);
        };
        if (step.expect) {
            try {
                checkExpectation(sim, step.expect, outEvents, calls, fail);
            } catch (error) {
                fail(errorMessage(error));
            }
            outEvents = [];
            calls = [];
            options.onStep?.(step, index, sim);
            continue;
        }
        try {
            performAction(sim, step);
            if (step.expectError !== undefined) {
                fail(`expected an error containing '${step.expectError}' but the step succeeded`);
            }
        } catch (error) {
            const message = errorMessage(error);
            if (step.expectError === undefined || !(error instanceof SimulationError) || !message.includes(step.expectError)) {
                fail(step.expectError === undefined ? message : `expected an error containing '${step.expectError}' but got: ${message}`);
                break;
            }
        }
        options.onStep?.(step, index, sim);
    }
    return { name, passed: failures.length === 0, failures };
}

function performAction(sim: StatechartInterpreter, step: ScenarioStep): void {
    if (step.enter) {
        sim.enter();
    } else if (step.exit) {
        sim.exit();
    } else if (step.raise !== undefined) {
        sim.raise(step.raise, step.value);
    } else if (step.runCycle !== undefined) {
        const count = step.runCycle === true ? 1 : step.runCycle;
        for (let i = 0; i < count; i++) {
            sim.runCycle();
        }
    } else if (step.advance !== undefined) {
        sim.advanceTime(step.advance);
    } else if (step.runFor !== undefined) {
        sim.runFor(step.runFor);
    } else if (step.set) {
        for (const [name, value] of Object.entries(step.set)) {
            sim.setVariable(name, value);
        }
    }
}

function checkExpectation(sim: StatechartInterpreter, expect: ScenarioExpectation, outEvents: string[], calls: string[], fail: (message: string) => void): void {
    for (const state of expect.active ?? []) {
        if (!sim.isActive(state)) {
            fail(`expected '${state}' to be active; active: [${sim.activeStates.join(', ')}]`);
        }
    }
    for (const state of expect.inactive ?? []) {
        if (sim.isActive(state)) {
            fail(`expected '${state}' to be inactive; active: [${sim.activeStates.join(', ')}]`);
        }
    }
    if (expect.configuration) {
        // states of submachine instances: `motor.Running` (docs/semantics.md §9)
        const expected = expect.configuration.map(name => sim.stateDisplayName(name)).sort();
        const actual = [...sim.activeLeafStates].sort();
        if (expected.join() !== actual.join()) {
            fail(`expected configuration [${expected.join(', ')}] but was [${actual.join(', ')}]`);
        }
    }
    if (expect.final !== undefined && sim.isFinal() !== expect.final) {
        fail(`expected the state machine ${expect.final ? '' : 'not '}to be final`);
    }
    for (const [name, expected] of Object.entries(expect.variables ?? {})) {
        const actual = sim.getVariable(name);
        if (!sameValue(actual, expected)) {
            fail(`expected variable '${name}' = ${JSON.stringify(expected)} but was ${JSON.stringify(actual)}`);
        }
    }
    compareLists('out events', expect.outEvents, outEvents, fail);
    compareLists('calls', expect.calls, calls, fail);
}

function compareLists(what: string, expected: string[] | undefined, actual: string[], fail: (message: string) => void): void {
    if (expected && expected.map(normalize).join('\n') !== actual.map(normalize).join('\n')) {
        fail(`expected ${what} [${expected.join('; ')}] but got [${actual.join('; ')}]`);
    }
}

/** Removes white space outside of string literals (`f( 1,true )` -> `f(1,true)`). */
function normalize(text: string): string {
    return text.replace(/("(?:\\.|[^"\\])*")|\s+/g, (_match, literal: string | undefined) => literal ?? '');
}

function sameValue(actual: HostValue | undefined, expected: ScenarioValue): boolean {
    if (typeof actual === 'number' && typeof expected === 'number') {
        return actual === expected || Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
    }
    if (Array.isArray(expected)) {
        return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => sameValue(actual[i], e));
    }
    if (typeof expected === 'object' && expected !== null) {
        // structs: the listed members are compared
        return typeof actual === 'object' && actual !== null && !Array.isArray(actual)
            && Object.entries(expected).every(([member, e]) => sameValue(actual[member], e));
    }
    if (typeof expected === 'string' && typeof actual === 'string') {
        // enumerators: `motor::Mode::Fast` (also with a leading `::`)
        return actual === expected || actual === expected.replace(/^::/, '');
    }
    return actual === expected;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** One line of text for a trace entry, e.g. `enter Closed.Active` or `transition Closed -> Open : eject`. */
export function formatTraceEntry(entry: TraceEntry): string {
    switch (entry.kind) {
        case 'step':
            return `step @${entry.time}ms${entry.events.length > 0 ? ` [${entry.events.join(', ')}]` : ''}`;
        case 'enter':
            return `  enter ${entry.state}`;
        case 'exit':
            return `  exit ${entry.state}`;
        case 'final':
            return `  enter ${entry.state}`;
        case 'transition':
            return `  transition ${entry.source} -> ${entry.target}${entry.label ? ` : ${entry.label}` : ''}`;
        case 'reaction':
            return `  reaction ${entry.state}: ${entry.label}`;
        case 'raise':
            return `  raise ${entry.direction} ${entry.text}`;
        case 'call':
            return `  call ${entry.text}${entry.result !== undefined ? ` = ${JSON.stringify(entry.result)}` : ''}`;
    }
}
