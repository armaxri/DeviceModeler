import type { CppHeaderSettings, TestResult, WorkspaceFile } from 'devm-language';
import type { DebugViewState } from '../common/protocol.js';
import type { TestFileProblem } from '../extension/logic/tests.js';

/*
 * Messages between the debug adapter (extension host) and the debug engine, which executes the tests in a
 * worker thread. The engine pauses by blocking the worker (`Atomics.wait`) inside the hooks of the test
 * runner; while paused it reads the commands of the adapter synchronously from a message port.
 */

/** A test to run: `uri#testClass.test`. */
export interface TestSelector {
    uri: string;
    testClass: string;
    /** Undefined: all tests of the class. */
    test?: string;
}

export interface SourceBreakpoint {
    id: number;
    /** URI of the `.devmtest` or `.devm` file. */
    uri: string;
    /** 1-based line (verified: the line of a statement, state, transition or reaction). */
    line: number;
}

export interface FunctionBreakpoint {
    id: number;
    /** Name of a state (`Closed`, `Door.Moving.Up`, `motor.Running`): break when it is entered. */
    name: string;
}

/** Exception breakpoint filters. */
export type ExceptionFilter = 'assertion' | 'error';

export interface BreakpointSettings {
    source: SourceBreakpoint[];
    functions: FunctionBreakpoint[];
    exceptions: ExceptionFilter[];
}

/** Data of the worker (`workerData`). */
export interface EngineStart {
    models: WorkspaceFile[];
    testFiles: WorkspaceFile[];
    headers?: CppHeaderSettings;
    /** Undefined: all tests of the test files. */
    tests?: TestSelector[];
    stopOnEntry: boolean;
    /** Run without stopping (no breakpoints, no exception stops). */
    noDebug: boolean;
    breakpoints: BreakpointSettings;
}

/** Commands of the adapter (posted to the command port of the worker). */
export type EngineCommand =
    | { type: 'continue' }
    | { type: 'next' }
    | { type: 'stepIn' }
    | { type: 'stepOut' }
    | { type: 'pause' }
    | { type: 'breakpoints', breakpoints: BreakpointSettings }
    | { type: 'evaluate', id: number, expression: string, frame?: number }
    | { type: 'terminate' };

/** A variable in the debug views; `children` for structured values. */
export interface VariableNode {
    name: string;
    value: string;
    type?: string;
    children?: VariableNode[];
}

export interface ScopeSnapshot {
    name: string;
    /** `locals` / `registers` like presentation hints of DAP. */
    hint?: 'arguments' | 'locals' | 'registers';
    variables: VariableNode[];
}

export interface FrameSnapshot {
    name: string;
    /** URI of the file (`.devmtest` for statements, `.devm` for microsteps). */
    uri?: string;
    /** 1-based. */
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    kind: 'statement' | 'microstep';
    /** Frame specific scopes (locals of a test operation, the microstep). */
    scopes: ScopeSnapshot[];
}

/** What the diagram shows while debugging (offsets into the text of the model under test). */
export interface DiagramSnapshot extends DebugViewState {
    /** URI of the `.devm` file of the state machine under test. */
    modelUri: string;
    machine: string;
}

export type StopReason = 'entry' | 'step' | 'breakpoint' | 'function breakpoint' | 'exception' | 'pause';

export interface StopSnapshot {
    reason: StopReason;
    /** Shown in the call stack view (`Paused on assertion failure`). */
    description: string;
    /** Message of the exception (assertion failures, errors). */
    text?: string;
    hitBreakpointIds?: number[];
    /** Innermost first. */
    frames: FrameSnapshot[];
    /** Scopes shared by all frames (active states, state machine variables, events, calls, execution). */
    scopes: ScopeSnapshot[];
    diagram?: DiagramSnapshot;
}

/** Messages of the worker. */
export type EngineMessage =
    | { type: 'stopped', stop: StopSnapshot }
    | { type: 'output', category: 'console' | 'stdout' | 'stderr', text: string, uri?: string, line?: number }
    | { type: 'testStarted', uri?: string, testClass: string, test: string }
    | { type: 'result', result: TestResult }
    | { type: 'evaluateResult', id: number, result?: string, error?: string, type_?: string }
    | { type: 'diagram', diagram: DiagramSnapshot }
    /** All tests were executed; `problems`: test files with errors (their tests were not executed). */
    | { type: 'done', passed: number, failed: number, errors: number, problems: TestFileProblem[] }
    | { type: 'fatal', message: string };
