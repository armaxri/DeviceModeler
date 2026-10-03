import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { LangiumDocument } from 'langium';
import * as ast from '../src/generated/ast.js';
import { HsmTestWorkspace, runTests, toJUnitXml, type LoadedDocument, type TestResult } from '../src/testing/index.js';

const workspace = new HsmTestWorkspace();
let counter = 0;

const DOOR = `
statemachine Door {
    @EventDriven
    interface:
        in event open
        in event close
        in event level : integer
        out event opened
        out event alarm : integer
        var count : integer = 0
        var ratio : real = 0.5
        var readonly version : integer = 3
        const MAX : integer = 3
        operation motor(on : boolean) : void
        operation sensor(id : integer) : boolean
        operation name() : string
    internal:
        event tick
    [*] -> Closed
    state Closed {
        entry / motor(false)
    }
    state Opened {
        entry / motor(true); count += 1; raise opened
        level / raise alarm : valueof(level) * 2
    }
    Closed -> Opened : open [count < MAX && sensor(1)]
    Opened -> Closed : close
    Opened -> Closed : after 10 s
    Closed -> [*] : close [count >= MAX]
}`;

const CYCLIC = `
statemachine Cyclic {
    @CycleBased(100)
    interface:
        in event go
        out event done
        var ticks : integer = 0
    [*] -> A
    state A {
        oncycle / ticks += 1
    }
    state B
    A -> B : go / raise done
    B -> A : after 1 s
}`;

/** Loads the models and the test text; returns the test document. */
async function load(testText: string, ...models: string[]): Promise<LoadedDocument> {
    const id = counter++;
    const documents = await workspace.load([
        ...models.map((text, index) => ({ uri: `memory:///t${id}/model${index}.devm`, text })),
        { uri: `memory:///t${id}/test.devmtest`, text: testText }
    ]);
    return documents[documents.length - 1];
}

function errors(loaded: LoadedDocument): string[] {
    return loaded.diagnostics.filter(d => d.severity === 1).map(d => d.message);
}

/** Wraps test operations into a test class for the door. */
function doorTests(body: string): string {
    return `testclass DoorTest for statemachine Door {\n${body}\n}`;
}

async function run(testText: string, ...models: string[]): Promise<TestResult[]> {
    const loaded = await load(testText, ...(models.length > 0 ? models : [DOOR]));
    expect(errors(loaded)).toEqual([]);
    return runTests(loaded.document as LangiumDocument<ast.TestModel>);
}

/** Runs a single test body against the door; returns its result. */
async function runBody(body: string, prefix = ''): Promise<TestResult> {
    const results = await run(doorTests(`${prefix}\n@Test operation t() {\n${body}\n}`));
    expect(results).toHaveLength(1);
    return results[0];
}

describe('test language: parsing and linking', () => {

    test('parses all statements', async () => {
        const loaded = await load(doorTests(`
            @SetUp
            operation init() { enter }

            @Test
            operation all() {
                assert active(Door.Closed) message "closed"
                mock sensor returns (true)
                mock sensor(2) returns (false)
                raise open
                raise level : 4
                proceed 1 cycle
                proceed 2 cycles; proceed 200 ms; proceed 1 s; proceed 5 us; proceed 5 ns
                assert called motor with (true) times 1
                assert !called sensor with (2)
                var i : integer = 0
                var r = 1.5
                while (i < 3) { i += 1; i++ }
                if (i == 3) { count = 2 } else if (i > 3) { assert false } else { exit }
                helper(i, true)
                assert opened && valueof(alarm) == 8 && !is_final
            }

            operation helper(n : integer, flag : boolean) {
                assert n > 0 == flag
            }`), DOOR);
        expect(loaded.document.parseResult.parserErrors).toEqual([]);
        expect(errors(loaded)).toEqual([]);
        const model = loaded.document.parseResult.value as ast.TestModel;
        const testClass = model.testClasses[0];
        expect(testClass.machine.ref?.name).toBe('Door');
        expect(testClass.operations.map(op => op.name)).toEqual(['init', 'all', 'helper']);
        const statements = testClass.operations[1].body.statements;
        expect(statements.map(s => s.$type)).toEqual([
            'AssertStatement', 'MockStatement', 'MockStatement', 'RaiseStatement', 'RaiseStatement',
            'ProceedStatement', 'ProceedStatement', 'ProceedStatement', 'ProceedStatement', 'ProceedStatement', 'ProceedStatement',
            'AssertCalledStatement', 'AssertCalledStatement', 'LocalVariableStatement', 'LocalVariableStatement',
            'WhileStatement', 'IfStatement', 'OperationCallStatement', 'AssertStatement'
        ]);
        const called = statements[12] as ast.AssertCalledStatement;
        expect(called.negated).toBe(true);
        expect(called.operation.ref?.name).toBe('sensor');
        const helperCall = statements[17] as ast.OperationCallStatement;
        expect(helperCall.operation.ref?.name).toBe('helper');
    });

    test('resolves the state machine across documents and states by qualified names', async () => {
        const nested = `statemachine Nested {
            [*] -> A
            state A { [*] -> X state X }
            state B { [*] -> X state X }
        }`;
        const loaded = await load(`testclass T for statemachine Nested {
            @Test operation t() { assert active(A.X) || active(Nested.B.X) || active(Nested.A) }
        }`, DOOR, nested);
        expect(errors(loaded)).toEqual([]);
        const ambiguous = await load(`testclass T for statemachine Nested {
            @Test operation t() { assert active(X) }
        }`, nested);
        expect(errors(ambiguous)).toEqual([expect.stringContaining(`Could not resolve reference to Vertex named 'X'`)]);
    });

    test('local variables are visible after their declaration and shadow declarations of the machine', async () => {
        const loaded = await load(doorTests(`
            @Test operation t() {
                assert later == 1
                var later : integer = 1
                var count : boolean = true
                assert count
                if (true) { var inner : integer = 2 }
                assert inner == 2
            }`), DOOR);
        expect(errors(loaded)).toEqual([
            `Could not resolve reference to Declaration named 'later'.`,
            `Could not resolve reference to Declaration named 'inner'.`
        ]);
    });
});

describe('test language: validation', () => {

    test('unknown state machine', async () => {
        const loaded = await load('testclass T for statemachine Unknown { @Test operation t() { enter } }', DOOR);
        expect(errors(loaded)).toEqual([`Could not resolve reference to StateMachine named 'Unknown'.`]);
    });

    test('unknown events, variables, states and operations', async () => {
        const loaded = await load(doorTests(`
            @Test operation t() {
                raise nothing
                assert active(Nowhere)
                assert unknown == 1
                mock missing returns (1)
                assert called missing
                helperMissing()
            }`), DOOR);
        expect(errors(loaded)).toEqual([
            `Could not resolve reference to EventDeclaration named 'nothing'.`,
            `Could not resolve reference to Vertex named 'Nowhere'.`,
            `Could not resolve reference to Declaration named 'unknown'.`,
            `Could not resolve reference to OperationDeclaration named 'missing'.`,
            `Could not resolve reference to OperationDeclaration named 'missing'.`,
            `Could not resolve reference to TestOperation named 'helperMissing'.`
        ]);
    });

    test('type checks', async () => {
        const loaded = await load(doorTests(`
            @Test operation t() {
                assert count
                raise level : true
                raise level
                raise open : 1
                raise opened
                raise tick
                proceed 1.5 cycles
                proceed true s
                proceed 1 minute
                mock sensor returns (1)
                mock motor returns (true)
                mock sensor(true) returns (false)
                assert called motor with (1, 2)
                assert called motor times true
                var x : integer = "a"
                count = true
                MAX = 4
                version = 4
                is_final = true
                if (count) { }
                while (1) { }
                assert open
                assert tick
                assert sensor(1)
                assert opened
            }`), DOOR);
        expect(errors(loaded)).toEqual([
            'The asserted expression must be of type boolean, but is of type integer.',
            `Type mismatch: a value of type boolean cannot be assigned to event 'level' of type integer.`,
            `Event 'level' requires a value of type integer: 'raise level : value'.`,
            `Event 'open' has no type and cannot carry a value.`,
            `Cannot raise 'opened': only in events can be raised by a test ('opened' is an out event).`,
            `Cannot raise 'tick': only in events can be raised by a test ('tick' is an internal event).`,
            'The number of cycles must be of type integer, but is of type real.',
            'The time must be of type integer or real, but is of type boolean.',
            `Unknown unit 'minute'. Use 'cycle(s)' or one of the time units s, ms, us, ns.`,
            `Type mismatch: the operation 'sensor' returns boolean, but the mocked value is of type integer.`,
            `The operation 'motor' has no return value (void) and cannot be mocked with a value.`,
            `Type mismatch: an argument of type boolean cannot be assigned to the parameter 'id' of type integer.`,
            `'motor' expects 1 argument, but 2 are given.`,
            'The number of calls must be of type integer, but is of type boolean.',
            `Type mismatch: the initial value of type string cannot be assigned to 'x' of type integer.`,
            `Type mismatch: a value of type boolean cannot be assigned to 'count' of type integer.`,
            `Cannot assign a value to the constant 'MAX'.`,
            `Cannot assign a value to the readonly variable 'version'.`,
            `Cannot assign a value to the constant 'is_final'.`,
            'The condition must be of type boolean, but is of type integer.',
            'The condition must be of type boolean, but is of type integer.',
            `Only out events can be used as conditions in a test ('open' is an in event).`,
            `Only out events can be used as conditions in a test ('tick' is an internal event).`,
            `The operation 'sensor' of the state machine cannot be called in a test; use 'mock sensor returns (...)' and 'assert called sensor'.`
        ]);
    });

    test('test operations and annotations', async () => {
        const loaded = await load(doorTests(`
            @Test operation withParameter(x : integer) { }
            @SetUp operation a() { }
            @SetUp operation b() { }
            @Ignore operation c() { }
            @Test @SetUp operation d() { }
            operation helper(x : integer, x : boolean) { }
            operation helper() { }
            operation other(x : integer, y : boolean) { }
            @Test operation calls() { other(true) }
        `), DOOR);
        expect(errors(loaded)).toEqual([
            `Only one operation can be annotated with @SetUp ('a' is already).`,
            `Only one operation can be annotated with @SetUp ('a' is already).`,
            `Duplicate operation 'helper'.`,
            'An operation annotated with @Test cannot have parameters.',
            `Unknown annotation '@Ignore'. Known annotations are @Test, @SetUp.`,
            'An operation cannot be a test and the set up operation at the same time.',
            `Duplicate parameter 'x'.`,
            `'other' expects 2 arguments, but 1 is given.`
        ]);
    });

    test('a test class without tests is reported', async () => {
        const loaded = await load(doorTests('operation helper() { }'), DOOR);
        expect(loaded.diagnostics.map(d => d.message)).toEqual([`The test class 'DoorTest' contains no test (an operation annotated with @Test).`]);
    });

    test('the .devm language is not affected by the test language', async () => {
        const loaded = await workspace.load([{ uri: `memory:///plain${counter++}.devm`, text: DOOR }]);
        expect(errors(loaded[0])).toEqual([]);
        expect(ast.isStateMachine(loaded[0].document.parseResult.value)).toBe(true);
    });
});

describe('test runner', () => {

    test('passing test', async () => {
        const result = await runBody(`
            enter
            assert active(Closed) && !active(Opened)
            mock sensor returns (true)
            raise open
            assert active(Opened)
            assert count == 1
            assert opened
            assert called motor with (false)
            assert called motor with (true) times 1
            assert called sensor with (1)
            assert !called sensor with (2)
        `);
        expect(result).toMatchObject({ testClass: 'DoorTest', name: 't', status: 'passed', trace: [] });
    });

    test('a failed assertion reports the line, the message and a trace excerpt', async () => {
        const result = await runBody(`enter
            raise open
            assert active(Opened) message "the guard needs the sensor"`);
        expect(result.status).toBe('failed');
        expect(result.message).toBe('the guard needs the sensor');
        expect(result.line).toBe(6);
        expect(result.trace).toEqual([
            '> enter', '  transition [*] -> Closed', '  enter Closed', '  reaction Closed: entry / motor(false)', '  call motor(false)', 'step @0ms',
            '> raise open', '  raise in open', 'step @0ms [open]', '  call sensor(1) = false', '> assert active(Opened) -> false'
        ]);
    });

    test('failure messages explain comparisons and calls', async () => {
        expect((await runBody('enter\nassert count + 1 == MAX')).message).toBe('Assertion failed: count + 1 == MAX (count + 1 = 1, MAX = 3)');
        expect((await runBody('enter\nassert count > 2 message "too few"')).message).toBe('too few (count = 0)');
        expect((await runBody('enter\nassert called motor with (true)')).message)
            .toBe(`Assertion failed: 'motor(true)' was not called (calls: motor(false))`);
        expect((await runBody('enter\nassert called motor times 2')).message)
            .toBe(`Assertion failed: 'motor' was called 1 time, expected 2 (calls: motor(false))`);
        expect((await runBody('enter\nassert !called motor')).message)
            .toBe(`Assertion failed: 'motor' was called 1 time, expected no call (calls: motor(false))`);
        expect((await runBody('assert called sensor')).message).toBe(`Assertion failed: 'sensor' was not called ('sensor' was never called)`);
    });

    test('runtime errors are reported as errors with the line of the statement', async () => {
        const result = await runBody('assert true\nraise open');
        expect(result.status).toBe('error');
        expect(result.message).toContain(`State machine 'Door' is not entered`);
        expect(result.line).toBe(5);
    });

    test('the set up operation runs before every test on a fresh state machine', async () => {
        const results = await run(doorTests(`
            @SetUp operation init() { mock sensor returns (true); enter }
            @Test operation first() { raise open; assert count == 1 }
            @Test operation second() { raise open; assert count == 1; assert called motor times 2 }
        `));
        expect(results.map(r => r.status)).toEqual(['passed', 'passed']);
    });

    test('mocks with arguments take precedence, later mocks replace earlier ones', async () => {
        const result = await runBody(`
            mock sensor returns (false)
            mock sensor(1) returns (true)
            enter
            raise open
            assert active(Opened)
            raise close
            mock sensor(1) returns (false)
            raise open
            assert active(Closed)
            mock name returns ("x")
        `);
        expect(result.status).toBe('passed');
    });

    test('out events are present after the step that raised them only; valueof keeps the value', async () => {
        const result = await runBody(`
            mock sensor returns (true)
            enter
            assert !opened
            raise open
            assert opened
            raise level : 21
            assert alarm && valueof(alarm) == 42 && !opened
            raise close
            assert !alarm && valueof(alarm) == 42
        `);
        expect(result).toMatchObject({ status: 'passed' });
    });

    test('event driven: proceed with time processes time events, proceed cycles performs steps without events', async () => {
        const result = await runBody(`
            mock sensor returns (true)
            enter
            raise open
            proceed 5 cycles
            assert active(Opened)
            proceed 9999 ms
            assert active(Opened)
            proceed 1 ms
            assert active(Closed)
        `);
        expect(result).toMatchObject({ status: 'passed' });
    });

    test('cycle based: raised events wait for the next cycle, proceed with time runs the cycles', async () => {
        const results = await run(`testclass CyclicTest for statemachine Cyclic {
            @Test operation t() {
                enter
                proceed 3 cycles
                assert ticks == 3
                proceed 1 s
                assert ticks == 13 message "10 cycles of 100 ms"
                raise go
                assert active(A)
                proceed 1 cycle
                assert active(B) && done
                proceed 50 ms
                assert !done message "no cycle ran, but the out event is cleared"
                proceed 950 ms
                assert active(A)
                assert ticks == 13
                proceed 1 cycle
                assert ticks == 14
            }
        }`, CYCLIC);
        expect(results).toMatchObject([{ status: 'passed' }]);
    });

    test('is_final, exit and machine variables', async () => {
        const result = await runBody(`
            mock sensor returns (true)
            enter
            count = 3
            raise close
            assert is_final
            assert count == 3
            ratio = 1
            assert ratio == 1.0
            ratio += 1
            assert ratio == 2.0
            exit
            assert !active(Closed)
        `);
        expect(result).toMatchObject({ status: 'passed' });
    });

    test('local variables, loops, conditions and helper operations', async () => {
        const result = await runBody(`
            mock sensor returns (true)
            enter
            var i : integer = 0
            var sum = 0.0
            while (i < 3) {
                openAndClose(i)
                var squared : integer = i * i
                sum += squared
                i++
            }
            assert count == 3
            assert sum == 5.0
            if (sum > 10) { assert false } else if (sum > 4) { i = 100 } else { assert false }
            assert i == 100
        `, `operation openAndClose(n : integer) {
                raise open
                assert count == n + 1
                raise close
            }`);
        expect(result).toMatchObject({ status: 'passed' });
    });

    test('a failure in a helper operation reports the line in the helper', async () => {
        const result = await runBody('enter\ncheck(2)', `operation check(n : integer) {
            assert count == n
        }`);
        expect(result).toMatchObject({ status: 'failed', line: 3, message: 'Assertion failed: count == n (count = 0, n = 2)' });
    });

    test('endless loops are stopped', async () => {
        const loaded = await load(doorTests('@Test operation t() { while (true) { } }'), DOOR);
        const [result] = runTests(loaded.document as LangiumDocument<ast.TestModel>, undefined, { maxIterations: 1000 });
        expect(result.status).toBe('error');
        expect(result.message).toContain('Iteration limit of 1000 reached');
    });

    test('filter selects tests', async () => {
        const loaded = await load(doorTests('@Test operation a() { } @Test operation b() { }'), DOOR);
        const results = runTests(loaded.document as LangiumDocument<ast.TestModel>, undefined, { filter: (_c, name) => name === 'b' });
        expect(results.map(r => r.name)).toEqual(['b']);
    });

    test('JUnit XML report', async () => {
        const results = await run(doorTests(`
            @Test operation ok() { enter }
            @Test operation fails() { enter; assert count > 0 message "count <positive>" }
            @Test operation breaks() { raise open }
        `));
        const xml = toJUnitXml(results, { fileName: () => 'door.devmtest' });
        expect(xml).toContain('<testsuites name="hsm-tests" tests="3" failures="1" errors="1"');
        expect(xml).toContain('<testsuite name="DoorTest" tests="3" failures="1" errors="1" skipped="0"');
        expect(xml).toMatch(/<testcase name="ok" classname="DoorTest" time="[\d.]+" file="door.devmtest"\/>/);
        expect(xml).toContain('<failure message="count &lt;positive&gt; (count = 0)" type="AssertionFailure">line 4: count &lt;positive&gt; (count = 0)');
        expect(xml).toContain(`<error message="State machine 'Door' is not entered; call enter() first" type="Error">`);
    });
});

describe('example tests', () => {

    const examples = path.resolve(__dirname, '../../../examples');
    const testFiles = fs.readdirSync(path.join(examples, 'tests')).filter(f => f.endsWith('.devmtest'));

    test('there is a test file for every example', () => {
        const models = fs.readdirSync(examples).filter(f => f.endsWith('.devm'));
        expect(testFiles.map(f => f.replace('.devmtest', '.devm')).sort()).toEqual(models.sort());
    });

    test.each(testFiles)('%s passes', async (file) => {
        const model = file.replace('.devmtest', '.devm');
        const { documents, results } = await new HsmTestWorkspace().run([
            { uri: `file:///examples/${model}`, text: fs.readFileSync(path.join(examples, model), 'utf-8') },
            { uri: `file:///examples/tests/${file}`, text: fs.readFileSync(path.join(examples, 'tests', file), 'utf-8') }
        ]);
        expect(documents[1].diagnostics.map(d => d.message)).toEqual([]);
        expect(results.length).toBeGreaterThan(2);
        expect(results.filter(r => r.status !== 'passed')).toEqual([]);
    });
});
