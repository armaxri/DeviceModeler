import { describe, expect, test } from 'vitest';
import type { AstNode, LangiumDocument } from 'langium';
import * as ast from '../src/generated/ast.js';
import { formatValue } from '../src/simulation/values.js';
import { AssertionFailure, HsmTestWorkspace, runTests, type TestDebugHooks, type TestExecutionState } from '../src/testing/index.js';

const LAMP = `
statemachine Lamp {
    @EventDriven
    interface:
        in event toggle
        out event switched
        var count : integer = 0
    [*] -> Off
    state Off
    state On {
        entry / count += 1; raise switched
    }
    Off -> On : toggle
    On -> Off : toggle
}`;

const TESTS = `testclass LampTest for statemachine Lamp {
    @SetUp
    operation init() {
        enter
    }

    @Test
    operation togglesTwice() {
        raise toggle
        press(1)
        assert active(Off)
    }

    @Test
    operation fails() {
        raise toggle
        assert count == 2 message "count"
    }

    @Test
    operation errors() {
        exit
        raise toggle
    }

    operation press(n : integer) {
        var i : integer = 0
        while (i < n) { raise toggle; i += 1 }
    }
}`;

const workspace = new HsmTestWorkspace();

async function loadTests(): Promise<LangiumDocument<ast.TestModel>> {
    const documents = await workspace.load([
        { uri: 'memory:///debug/lamp.hsm', text: LAMP },
        { uri: 'memory:///debug/lamp.hsmtest', text: TESTS }
    ]);
    const loaded = documents[1];
    expect(loaded.diagnostics.filter(d => d.severity === 1)).toEqual([]);
    return loaded.document as LangiumDocument<ast.TestModel>;
}

function line(node: AstNode): number {
    return node.$cstNode!.range.start.line + 1;
}

describe('debug hooks of the test runner', () => {

    test('statements are reported in execution order with the call stack and locals', async () => {
        const document = await loadTests();
        const events: string[] = [];
        const hooks: TestDebugHooks = {
            testStarted: execution => events.push(`start ${execution.test.name}`),
            beforeStatement: (statement, execution) => {
                const frame = execution.stack[execution.stack.length - 1];
                const locals = [...frame.locals].map(([d, v]) => `${d.name}=${formatValue(v)}`).join(',');
                events.push(`${execution.stack.map(f => f.operation.name).join('>')}:${line(statement)}:${statement.$type}${locals ? `[${locals}]` : ''}`);
                expect(frame.statement).toBe(statement);
            },
            testFinished: result => events.push(`end ${result.name} ${result.status}`)
        };
        const results = runTests(document, undefined, { debug: hooks, filter: (_c, t) => t === 'togglesTwice' });
        expect(results.map(r => r.status)).toEqual(['passed']);
        expect(events).toEqual([
            'start togglesTwice',
            'init:4:EnterStatement',
            'togglesTwice:9:RaiseStatement',
            'togglesTwice:10:OperationCallStatement',
            'togglesTwice>press:27:LocalVariableStatement[n=1]',
            'togglesTwice>press:28:WhileStatement[n=1,i=0]',
            'togglesTwice>press:28:RaiseStatement[n=1,i=0]',
            'togglesTwice>press:28:AssignmentStatement[n=1,i=0]',
            'togglesTwice:11:AssertStatement',
            'end togglesTwice passed'
        ]);
    });

    test('trace entries are reported while the machine executes, with a consistent interpreter state', async () => {
        const document = await loadTests();
        const seen: string[] = [];
        runTests(document, undefined, {
            filter: (_c, t) => t === 'togglesTwice',
            debug: {
                traceEntry: (entry, execution) => {
                    const sim = execution.sim!;
                    if (entry.kind === 'enter') {
                        expect(sim.isActive(entry.state)).toBe(true);
                        seen.push(`enter ${entry.state} [${sim.activeStates.join(',')}]`);
                    } else if (entry.kind === 'exit') {
                        expect(sim.isActive(entry.state)).toBe(false);
                        seen.push(`exit ${entry.state}`);
                    } else if (entry.kind === 'transition') {
                        seen.push(`transition ${entry.source}->${entry.target}`);
                    } else if (entry.kind === 'reaction') {
                        // reported before its effect: the counter is not incremented yet
                        seen.push(`reaction ${entry.label} count=${formatValue(sim.getValue('count'))}`);
                    }
                }
            }
        });
        expect(seen.slice(0, 7)).toEqual([
            'transition [*]->Off',
            'enter Off [Off]',
            'exit Off',
            'transition Off->On',
            'enter On [On]',
            'reaction entry / count += 1; raise switched count=0',
            'exit On'
        ]);
    });

    test('failures are reported once, before the stack unwinds', async () => {
        const document = await loadTests();
        const failures: Array<{ test: string, assertion: boolean, line?: number, depth: number, message: string }> = [];
        let evaluated: string | undefined;
        const results = runTests(document, undefined, {
            filter: (_c, t) => t !== 'togglesTwice',
            debug: {
                failure: (error: unknown, node: AstNode | undefined, execution: TestExecutionState) => {
                    failures.push({
                        test: execution.test.name,
                        assertion: error instanceof AssertionFailure,
                        line: node && line(node),
                        depth: execution.stack.length,
                        message: error instanceof Error ? error.message : String(error)
                    });
                    const statement = execution.stack[execution.stack.length - 1].statement;
                    if (ast.isAssertStatement(statement) && ast.isBinaryExpression(statement.expression)) {
                        evaluated = formatValue(execution.evaluate(statement.expression.left));
                    }
                }
            }
        });
        expect(results.map(r => r.status)).toEqual(['failed', 'error']);
        expect(failures).toHaveLength(2);
        expect(failures[0]).toMatchObject({ test: 'fails', assertion: true, line: 17, depth: 1 });
        expect(failures[0].message).toContain('count');
        expect(evaluated).toBe('1');
        expect(failures[1]).toMatchObject({ test: 'errors', assertion: false, line: 23, depth: 1 });
    });

    test('the calls and mocks of the test are visible', async () => {
        const documents = await workspace.load([
            { uri: 'memory:///debug2/m.hsm', text: 'statemachine M {\n@EventDriven\ninterface:\nin event go\noperation probe(x : integer) : integer\nvar r : integer = 0\n[*] -> A\nstate A\nA -> A : go / r = probe(2)\n}' },
            { uri: 'memory:///debug2/m.hsmtest', text: 'testclass T for statemachine M {\n@Test operation t() {\nmock probe returns (7)\nenter\nraise go\nassert r == 7\n}\n}' }
        ]);
        let snapshot: { calls: string[], mocks: string[] } | undefined;
        const results = runTests(documents[1].document as LangiumDocument<ast.TestModel>, undefined, {
            debug: {
                beforeStatement: (statement, execution) => {
                    if (ast.isAssertStatement(statement)) {
                        snapshot = {
                            calls: execution.calls.map(c => `${c.operation}(${c.args.join(',')})`),
                            mocks: [...execution.mocks].map(([name, mocks]) => `${name}=${mocks.map(m => formatValue(m.value)).join(',')}`)
                        };
                    }
                }
            }
        });
        expect(results[0].status).toBe('passed');
        expect(snapshot).toEqual({ calls: ['probe(2)'], mocks: ['probe=7'] });
    });
});
