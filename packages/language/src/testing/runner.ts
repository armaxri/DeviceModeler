import type { AstNode, LangiumDocument, Reference } from 'langium';
import * as ast from '../generated/ast.js';
import { qualifiedName } from '../statemachine-scope.js';
import { instanceOfReference, referableName } from '../imports.js';
import { SimulationError } from '../simulation/errors.js';
import { ExpressionEvaluator, type EvaluationContext } from '../simulation/expressions.js';
import { StatechartInterpreter, type TraceEntry } from '../simulation/interpreter.js';
import { formatTraceEntry } from '../simulation/scenario.js';
import {
    convert, declaredType, defaultValueOf, formatValue, fromHost, runtimeTypeOfValue, toHost, type HostValue, type Value
} from '../simulation/values.js';
import type { CoverageCollector } from './coverage.js';
import { builtinVariable, isLocalVariable } from './devm-test-scope.js';
import { CYCLE_UNITS, hasAnnotation } from './devm-test-validator.js';

/** Result of one test (an operation annotated with `@Test`). */
export interface TestResult {
    /** Name of the test class. */
    readonly testClass: string;
    /** Name of the test operation. */
    readonly name: string;
    /** `failed`: an assertion failed; `error`: the test could not be executed (e.g. a runtime error of the model). */
    readonly status: 'passed' | 'failed' | 'error';
    /** Failure or error message. */
    readonly message?: string;
    /** 1-based line of the failed assertion (or of the statement that caused the error) in the test document. */
    readonly line?: number;
    /** URI of the test document, if known. */
    readonly uri?: string;
    /** Failed tests: the last lines of the execution trace (test statements prefixed with `>`); empty for passed tests. */
    readonly trace: readonly string[];
    /** Execution time in milliseconds (wall clock). */
    readonly durationMs: number;
}

export interface TestRunOptions {
    /** Runs only the tests for which the filter returns true. */
    filter?: (testClass: string, test: string) => boolean;
    /** Number of trace lines kept for failure reports. Default: 15. */
    traceLength?: number;
    /** Maximum number of loop iterations (`while`) and nested operation calls per test. Default: 100000. */
    maxIterations?: number;
    /** Called for every trace line (test statements and interpreter trace). */
    onTrace?: (line: string) => void;
    /** Called after every test. */
    onResult?: (result: TestResult) => void;
    /** Collects the model coverage of the tests (states, transitions, reactions, guards); see `coverage.ts`. */
    coverage?: CoverageCollector;
    /** Hooks of a debugger (called synchronously during the execution, see {@link TestDebugHooks}). */
    debug?: TestDebugHooks;
}

/**
 * Hooks for a debugger: they are called synchronously while a test executes, so a debugger can inspect
 * the execution ({@link TestExecutionState}) and pause it by blocking inside the hook (e.g. a worker
 * thread waiting for the next command of the debug adapter).
 */
export interface TestDebugHooks {
    /** A test starts (before its `@SetUp` operation). */
    testStarted?(execution: TestExecutionState): void;
    /** Before every statement of a test, its `@SetUp` and the helper operations it calls. */
    beforeStatement?(statement: ast.TestStatement, execution: TestExecutionState): void;
    /**
     * Every trace entry of the interpreter while the state machine executes (a statement like `raise` or
     * `proceed`): states entered and exited, transitions taken, reactions executed, events, calls. The
     * state of the interpreter is consistent: `enter` is reported after the state became active, `exit`
     * after it became inactive, `transition` and `reaction` before their effect is executed.
     */
    traceEntry?(entry: TraceEntry, execution: TestExecutionState): void;
    /**
     * An assertion failed ({@link AssertionFailure}) or an error occurred (e.g. {@link SimulationError});
     * called before the stack unwinds (once per error, at the innermost statement).
     */
    failure?(error: unknown, node: AstNode | undefined, execution: TestExecutionState): void;
    /** A test ended (the result is reported to `onResult` as well). */
    testFinished?(result: TestResult, execution: TestExecutionState): void;
}

/** A frame of the call stack of a test: the test operation, `@SetUp` or a called helper operation. */
export interface TestStackFrame {
    readonly operation: ast.TestOperation;
    /** The statement being executed (undefined before the first one). */
    readonly statement?: ast.TestStatement;
    /** Values of the parameters and local variables. */
    readonly locals: ReadonlyMap<ast.VariableDeclaration, Value>;
}

/** The state of a test execution, for debuggers ({@link TestDebugHooks}). */
export interface TestExecutionState {
    readonly testClass: ast.TestClass;
    readonly test: ast.TestOperation;
    readonly machine: ast.StateMachine;
    /** The interpreter of the test (undefined only before it was created). */
    readonly sim: StatechartInterpreter | undefined;
    /** The call stack, outermost (the test or `@SetUp`) first. */
    readonly stack: readonly TestStackFrame[];
    /** The operation calls of the state machine since the start of the test. */
    readonly calls: ReadonlyArray<{ readonly operation: string, readonly args: readonly HostValue[] }>;
    /** The mocks (`mock op returns (x)`) by operation name, in the order they were defined. */
    readonly mocks: ReadonlyMap<string, ReadonlyArray<{ readonly args?: readonly Value[], readonly value: Value }>>;
    /** Evaluates an expression of the test document in the current frame (locals, state machine members). */
    evaluate(expression: ast.Expression): Value;
}

/** A failed assertion. */
export class AssertionFailure extends Error {
    constructor(message: string, readonly node: AstNode) {
        super(message);
        this.name = 'AssertionFailure';
    }
}

type TestInput = LangiumDocument<ast.TestModel> | ast.TestModel;
type MachineInput = LangiumDocument<ast.StateMachine> | ast.StateMachine;

/**
 * Runs the tests of all test classes of a test document. Every test runs on a fresh
 * {@link StatechartInterpreter}; the `@SetUp` operation of the class is executed first.
 *
 * The state machine is the one referenced by `testclass ... for statemachine M`. If `machine` is
 * given, it is used for test classes whose reference could not be resolved (and whose name matches).
 */
export function runTests(test: TestInput, machine?: MachineInput, options: TestRunOptions = {}): TestResult[] {
    const model = isDocument(test) ? test.parseResult.value : test;
    const fallback = machine && (isDocument(machine) ? machine.parseResult.value : machine);
    const results: TestResult[] = [];
    for (const testClass of model.testClasses) {
        const target = testClass.machine.ref ?? (fallback?.name === testClass.machine.$refText ? fallback : undefined);
        for (const operation of testClass.operations) {
            if (!hasAnnotation(operation, 'Test') || (options.filter && !options.filter(testClass.name, operation.name))) {
                continue;
            }
            const result = target
                ? new TestExecution(testClass, target, options).run(operation)
                : {
                    testClass: testClass.name, name: operation.name, status: 'error' as const, trace: [], durationMs: 0,
                    message: `Unknown state machine '${testClass.machine.$refText}'`, line: lineOf(testClass), uri: uriOf(testClass)
                };
            options.onResult?.(result);
            results.push(result);
        }
    }
    return results;
}

interface RecordedCall {
    readonly operation: string;
    readonly args: readonly HostValue[];
}

interface Mock {
    readonly args?: readonly Value[];
    readonly value: Value;
}

interface Frame {
    readonly operation: ast.TestOperation;
    statement?: ast.TestStatement;
    readonly locals: Map<ast.VariableDeclaration, Value>;
}

/** Execution of the tests of one test class. */
class TestExecution implements TestExecutionState {

    sim!: StatechartInterpreter;
    private evaluator!: ExpressionEvaluator;
    private frames: Frame[] = [];
    calls: RecordedCall[] = [];
    private mockTable = new Map<string, Mock[]>();
    private trace: string[] = [];
    /** Out events of submachine instances raised during the last call of the interpreter (`motor.stopped`). */
    private instanceOutEvents = new Set<string>();
    private budget = 0;
    private current?: AstNode;
    /** The error last reported to the `failure` hook (reported once, at the innermost statement). */
    private reported?: unknown;
    test!: ast.TestOperation;

    constructor(
        readonly testClass: ast.TestClass,
        readonly machine: ast.StateMachine,
        private readonly options: TestRunOptions
    ) { }

    get stack(): readonly TestStackFrame[] {
        return this.frames;
    }

    get mocks(): ReadonlyMap<string, ReadonlyArray<{ readonly args?: readonly Value[], readonly value: Value }>> {
        return this.mockTable;
    }

    evaluate(expression: ast.Expression): Value {
        return this.evaluator.evaluate(expression);
    }

    run(operation: ast.TestOperation): TestResult {
        const result = this.execute(operation);
        this.options.debug?.testFinished?.(result, this);
        return result;
    }

    private execute(operation: ast.TestOperation): TestResult {
        const start = Date.now();
        this.test = operation;
        this.reported = undefined;
        const base = { testClass: this.testClass.name, name: operation.name, uri: uriOf(operation) };
        this.frames = [];
        this.calls = [];
        this.mockTable = new Map();
        this.trace = [];
        this.budget = this.options.maxIterations ?? 100000;
        this.current = undefined;
        const coverage = this.options.coverage;
        coverage?.register(this.machine);
        coverage?.beginTest(`${this.testClass.name}.${operation.name}`);
        try {
            const simulationOptions = { onTrace: (entry: TraceEntry) => this.onTrace(entry) };
            this.sim = new StatechartInterpreter(this.machine, coverage ? coverage.attach(simulationOptions) : simulationOptions);
            this.evaluator = new ExpressionEvaluator(this.createContext());
            this.options.debug?.testStarted?.(this);
            const setUp = this.testClass.operations.find(op => hasAnnotation(op, 'SetUp'));
            if (setUp) {
                this.invoke(setUp, []);
            }
            this.invoke(operation, []);
            return { ...base, status: 'passed', trace: [], durationMs: Date.now() - start };
        } catch (error) {
            const failure = error instanceof AssertionFailure;
            const node = failure ? error.node : this.current;
            const message = error instanceof Error ? error.message : String(error);
            return {
                ...base, status: failure ? 'failed' : 'error', message, line: node ? lineOf(node) : undefined,
                trace: this.trace, durationMs: Date.now() - start
            };
        } finally {
            coverage?.endTest();
        }
    }

    // -----------------------------------------------------------------------------------------
    // Statements

    private invoke(operation: ast.TestOperation, args: Value[]): void {
        if (this.frames.length > 100) {
            throw new SimulationError(`Too many nested operation calls (recursion in '${operation.name}'?)`, operation);
        }
        const frame = new Map<ast.VariableDeclaration, Value>();
        operation.parameters.forEach((parameter, index) => {
            frame.set(parameter, convert(args[index], declaredType(parameter.type), `Argument '${parameter.name}' of '${operation.name}'`, operation)!);
        });
        this.frames.push({ operation, locals: frame });
        try {
            this.block(operation.body);
        } finally {
            this.frames.pop();
        }
    }

    private block(block: ast.Block): void {
        // local variables of the block are removed at its end (they may be declared again in a loop)
        const frame = this.frame();
        const declared: ast.VariableDeclaration[] = [];
        try {
            for (const statement of block.statements) {
                if (ast.isLocalVariableStatement(statement)) {
                    declared.push(statement.declaration);
                }
                this.statement(statement);
            }
        } finally {
            declared.forEach(d => frame.delete(d));
        }
    }

    private statement(statement: ast.TestStatement): void {
        this.current = statement;
        const debug = this.options.debug;
        if (!debug) {
            this.executeStatement(statement);
            return;
        }
        this.frames[this.frames.length - 1].statement = statement;
        debug.beforeStatement?.(statement, this);
        try {
            this.executeStatement(statement);
        } catch (error) {
            if (error !== this.reported) {
                this.reported = error;
                debug.failure?.(error, error instanceof AssertionFailure ? error.node : this.current, this);
            }
            throw error;
        }
    }

    private executeStatement(statement: ast.TestStatement): void {
        switch (statement.$type) {
            case 'EnterStatement':
                this.instanceOutEvents.clear();
                this.log('> enter');
                this.sim.enter();
                break;
            case 'ExitStatement':
                this.instanceOutEvents.clear();
                this.log('> exit');
                this.sim.exit();
                break;
            case 'RaiseStatement': {
                const event = statement.event.ref;
                if (!event) {
                    throw new SimulationError(`Unresolved event '${statement.event.$refText}'`, statement);
                }
                const value = statement.value ? this.evaluator.evaluate(statement.value) : undefined;
                const name = this.sim.index.declarationName(event);
                this.instanceOutEvents.clear();
                this.log(`> raise ${name}${value === undefined ? '' : ` : ${formatValue(value)}`}`);
                this.sim.raise(name, value);
                break;
            }
            case 'ProceedStatement':
                this.proceed(statement);
                break;
            case 'AssertStatement':
                this.assert(statement);
                break;
            case 'AssertCalledStatement':
                this.assertCalled(statement);
                break;
            case 'MockStatement':
                this.mock(statement);
                break;
            case 'LocalVariableStatement': {
                const declaration = statement.declaration;
                const type = declaredType(declaration.type);
                const initial = declaration.initialValue ? this.evaluator.evaluate(declaration.initialValue) : defaultValueOf(type ?? 'integer');
                this.frame().set(declaration, convert(initial, type ?? runtimeTypeOfValue(initial), `Initial value of '${declaration.name}'`, declaration)!);
                break;
            }
            case 'IfStatement':
                this.ifStatement(statement);
                break;
            case 'WhileStatement':
                while (this.condition(statement.condition)) {
                    this.consumeBudget(statement);
                    this.block(statement.body);
                    this.current = statement;
                }
                break;
            case 'OperationCallStatement': {
                const operation = statement.operation.ref;
                if (!operation) {
                    throw new SimulationError(`Unknown operation '${statement.operation.$refText}'`, statement);
                }
                this.consumeBudget(statement);
                this.invoke(operation, statement.arguments.map(a => this.evaluator.evaluate(a)));
                break;
            }
            case 'AssignmentStatement':
                this.evaluator.evaluate(statement.expression);
                break;
        }
    }

    private ifStatement(statement: ast.IfStatement): void {
        if (this.condition(statement.condition)) {
            this.block(statement.then);
        } else if (statement.else) {
            this.block(statement.else);
        } else if (statement.elseIf) {
            this.current = statement.elseIf;
            this.ifStatement(statement.elseIf);
        }
    }

    private proceed(statement: ast.ProceedStatement): void {
        const amount = Number(this.evaluator.evaluate(statement.value));
        const unit = statement.unit;
        this.instanceOutEvents.clear();
        this.log(`> proceed ${amount} ${unit}`);
        if (CYCLE_UNITS.includes(unit)) {
            if (!Number.isInteger(amount) || amount < 0) {
                throw new SimulationError(`Invalid number of cycles ${amount}`, statement);
            }
            for (let i = 0; i < amount; i++) {
                this.sim.runCycle();
            }
            return;
        }
        const factor = MS_PER_UNIT[unit];
        if (factor === undefined) {
            throw new SimulationError(`Unknown unit '${unit}'`, statement);
        }
        // cycle based: run cycles like a host would; event driven: process the expiring time events
        this.sim.runFor(amount * factor);
    }

    private assert(statement: ast.AssertStatement): void {
        const value = this.evaluator.evaluate(statement.expression);
        if (typeof value !== 'boolean') {
            throw new SimulationError(`The asserted expression is not boolean but ${formatValue(value)}`, statement);
        }
        this.log(`> assert ${sourceText(statement.expression)}${value ? '' : ' -> false'}`);
        if (!value) {
            const detail = this.describeOperands(statement.expression);
            throw new AssertionFailure(`${statement.message ?? `Assertion failed: ${sourceText(statement.expression)}`}${detail}`, statement);
        }
    }

    /** ` (count = 2, MAX = 3)`: the values of the operands of a comparison (literals are omitted). */
    private describeOperands(expression: ast.Expression): string {
        if (!ast.isBinaryExpression(expression) || !['==', '!=', '<', '<=', '>', '>='].includes(expression.operator)) {
            return '';
        }
        try {
            const operands = [expression.left, expression.right]
                .filter(operand => !isLiteral(operand))
                .map(operand => `${sourceText(operand)} = ${formatValue(this.evaluator.evaluate(operand))}`);
            return operands.length > 0 ? ` (${operands.join(', ')})` : '';
        } catch {
            return '';
        }
    }

    private assertCalled(statement: ast.AssertCalledStatement): void {
        const operation = statement.operation.ref;
        if (!operation) {
            throw new SimulationError(`Unknown operation '${statement.operation.$refText}'`, statement);
        }
        const name = this.hostName(operation, statement.operation);
        const expected = statement.arguments.map(a => toHost(this.evaluator.evaluate(a))!);
        const matching = this.calls.filter(call => call.operation === name
            && (statement.arguments.length === 0 || sameValues(call.args, expected))).length;
        const times = statement.times ? Number(this.evaluator.evaluate(statement.times)) : undefined;
        const ok = statement.negated ? matching === 0 : times !== undefined ? matching === times : matching > 0;
        const text = sourceText(statement);
        this.log(`> ${text}${ok ? '' : ' -> false'}`);
        if (!ok) {
            const call = statement.arguments.length > 0 ? `${name}(${expected.map(v => JSON.stringify(v)).join(', ')})` : name;
            const actual = this.calls.filter(c => c.operation === name).map(c => `${name}(${c.args.map(v => JSON.stringify(v)).join(', ')})`);
            const summary = actual.length === 0 ? `'${name}' was never called` : `calls: ${actual.slice(-5).join(', ')}${actual.length > 5 ? ` (${actual.length} in total)` : ''}`;
            const expectation = statement.negated ? `'${call}' was called ${matching} time${matching === 1 ? '' : 's'}, expected no call`
                : times !== undefined ? `'${call}' was called ${matching} time${matching === 1 ? '' : 's'}, expected ${times}`
                    : `'${call}' was not called`;
            throw new AssertionFailure(statement.message ?? `Assertion failed: ${expectation} (${summary})`, statement);
        }
    }

    private mock(statement: ast.MockStatement): void {
        const operation = statement.operation.ref;
        if (!operation) {
            throw new SimulationError(`Unknown operation '${statement.operation.$refText}'`, statement);
        }
        const name = this.hostName(operation, statement.operation);
        const value = this.evaluator.evaluate(statement.value);
        const args = statement.withArguments ? statement.arguments.map(a => this.evaluator.evaluate(a)) : undefined;
        this.log(`> ${sourceText(statement)}`);
        let mocks = this.mockTable.get(name);
        if (!mocks) {
            mocks = [];
            this.mockTable.set(name, mocks);
            const returnType = declaredType(operation.returnType);
            this.sim.setOperation(name, (...actual: HostValue[]) => {
                // the most recent matching mock wins; mocks with arguments take precedence over the general one
                const all = this.mockTable.get(name) ?? [];
                const match = [...all].reverse().find(m => m.args && sameValues(m.args.map(v => toHost(v)!), actual))
                    ?? [...all].reverse().find(m => !m.args);
                return match ? convert(match.value, returnType, `Mocked result of '${name}'`, statement) : defaultValueOf(returnType);
            });
        }
        mocks.push({ args, value });
    }

    private condition(expression: ast.Expression): boolean {
        const value = this.evaluator.evaluate(expression);
        if (typeof value !== 'boolean') {
            throw new SimulationError(`Expected a boolean condition but got ${formatValue(value)}`, expression);
        }
        return value;
    }

    private consumeBudget(node: AstNode): void {
        if (--this.budget < 0) {
            throw new SimulationError(`Iteration limit of ${this.options.maxIterations ?? 100000} reached (endless loop?)`, node);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Expressions

    /**
     * The name of a declaration of the state machine for the interpreter API: `speed`, `Iface.x`, or
     * `motor.speed` for a member of the submachine instance `motor` (referenced as `motor.speed`).
     */
    private hostName(declaration: ast.Declaration, reference: Reference | undefined): string {
        const instance = reference ? instanceOfReference(reference, this.machine) : undefined;
        return instance ? `${this.sim.index.declarationName(instance)}.${referableName(declaration)}` : this.sim.index.declarationName(declaration);
    }

    private frame(): Map<ast.VariableDeclaration, Value> {
        return this.frames[this.frames.length - 1].locals;
    }

    private createContext(): EvaluationContext {
        return {
            getVariable: (variable, node) => {
                if (builtinVariable(variable) === 'is_final') {
                    return this.sim.isFinal();
                }
                if (isLocalVariable(variable)) {
                    const value = this.frame().get(variable);
                    if (value === undefined) {
                        throw new SimulationError(`Variable '${variable.name}' is not initialized`, node);
                    }
                    return value;
                }
                const value = this.sim.getValue(this.hostName(variable, referenceOf(node)));
                if (value === undefined) {
                    throw new SimulationError(`Variable '${variable.name}' has no value`, node);
                }
                return value;
            },
            assignVariable: (variable, value, node, reference) => {
                if (builtinVariable(variable) || variable.const) {
                    throw new SimulationError(`Cannot assign to the constant '${variable.name}'`, node);
                }
                if (isLocalVariable(variable)) {
                    const current = this.frame().get(variable);
                    const converted = convert(value, declaredType(variable.type) ?? runtimeTypeOfValue(current), `Assignment to '${variable.name}'`, node)!;
                    this.frame().set(variable, converted);
                    return converted;
                }
                const name = this.hostName(variable, referenceOf(reference));
                this.sim.setVariable(name, value);
                return this.sim.getValue(name)!;
            },
            isEventPresent: (event, node) => {
                const name = this.hostName(event, referenceOf(node));
                return this.sim.outEvents.some(e => e.name === name) || this.instanceOutEvents.has(name);
            },
            eventValue: (event, node) => fromHost(this.sim.getEventValue(this.hostName(event, referenceOf(node))), declaredType(event.type), `Value of '${event.name}'`, node),
            isActive: (vertex, node) => {
                if (!ast.isState(vertex)) {
                    return false;
                }
                const instance = ast.isActiveExpression(node) ? instanceOfReference(node.state, this.machine) : undefined;
                // states of submachine instances: `motor.Running`
                return instance ? this.sim.isActive(`${this.sim.index.declarationName(instance)}.${qualifiedName(vertex)}`) : this.sim.isActive(vertex);
            },
            callOperation: (operation, _args, node) => {
                throw new SimulationError(`The operation '${operation.name}' of the state machine cannot be called in a test`, node);
            },
            raiseEvent: (event, value) => this.sim.raise(this.sim.index.declarationName(event), value)
        };
    }

    // -----------------------------------------------------------------------------------------
    // Trace

    private onTrace(entry: TraceEntry): void {
        if (entry.kind === 'call') {
            this.calls.push({ operation: entry.operation, args: entry.args });
        }
        if (entry.kind === 'raise' && entry.direction === 'out' && this.sim && [...this.sim.instanceInterpreters.keys()].some(name => entry.event.startsWith(`${name}.`))) {
            this.instanceOutEvents.add(entry.event);
        }
        this.log(formatTraceEntry(entry));
        this.options.debug?.traceEntry?.(entry, this);
    }

    private log(line: string): void {
        this.options.onTrace?.(line);
        this.trace.push(line);
        const max = this.options.traceLength ?? 15;
        if (this.trace.length > max) {
            this.trace.splice(0, this.trace.length - max);
        }
    }
}

const MS_PER_UNIT: Record<string, number> = { s: 1000, ms: 1, us: 1e-3, ns: 1e-6 };

/** The reference of a node referencing a declaration (`motor.speed`, `valueof(motor.failed)`). */
function referenceOf(node: AstNode | undefined): Reference | undefined {
    if (ast.isElementReference(node)) {
        return node.element;
    }
    if (ast.isValueOfExpression(node)) {
        return node.event;
    }
    return undefined;
}

function isLiteral(expression: ast.Expression): boolean {
    return ast.isLiteral(expression) || (ast.isUnaryExpression(expression) && ast.isLiteral(expression.operand));
}

function sameValues(actual: readonly HostValue[], expected: readonly HostValue[]): boolean {
    return actual.length === expected.length && actual.every((value, index) => JSON.stringify(value) === JSON.stringify(expected[index]));
}

function sourceText(node: AstNode): string {
    return node.$cstNode?.text.replace(/\s+/g, ' ').trim() ?? node.$type;
}

function lineOf(node: AstNode): number | undefined {
    const line = node.$cstNode?.range.start.line;
    return line === undefined ? undefined : line + 1;
}

function uriOf(node: AstNode): string | undefined {
    let root: AstNode = node;
    while (root.$container) {
        root = root.$container;
    }
    return root.$document?.uri.toString();
}

function isDocument<T extends AstNode>(input: LangiumDocument<T> | T): input is LangiumDocument<T> {
    return 'parseResult' in input;
}
