import { describe, expect, test } from 'vitest';
import { isTransition } from '../src/generated/ast.js';
import {
    SimulationError, StatechartInterpreter, formatValue, type SimulationOptions, type TraceEntry
} from '../src/simulation/index.js';
import { example, parse } from './helpers.js';

async function load(text: string, options?: SimulationOptions): Promise<StatechartInterpreter> {
    const parsed = await parse(text);
    expect(parsed.hasSyntaxErrors).toBe(false);
    return new StatechartInterpreter(parsed.model, options);
}

/**
 * Evaluates `expression` by assigning it to a variable `r` of the given type in the entry reaction
 * of the initial state. Untyped: the variable takes the type of the value.
 */
async function evaluate(expression: string, type?: string, declarations = '', options?: SimulationOptions): Promise<unknown> {
    const sim = await load(`statemachine M {
        interface:
            ${declarations}
            var r ${type ? `: ${type}` : `= ${expression}`}
        [*] -> A
        state A { entry / ${type ? `r = ${expression}` : 'r = r'} }
    }`, options);
    sim.enter();
    return sim.getVariable('r');
}

async function evaluationError(expression: string, type = 'integer', declarations = ''): Promise<string> {
    try {
        await evaluate(expression, type, declarations);
    } catch (error) {
        expect(error).toBeInstanceOf(SimulationError);
        return (error as Error).message;
    }
    throw new Error(`'${expression}' did not fail`);
}

describe('expressions', () => {
    test.each([
        ['1 + 2 * 3', 7],
        ['(1 + 2) * 3', 9],
        ['7 / 2', 3],
        ['-7 / 2', -3],
        ['-7 % 3', -1],
        ['7 % -3', 1],
        ['0x10 + 0xff', 271],
        ['1 << 10 >> 2', 256],
        ['-16 >> 2', -4],
        ['~0', -1],
        ['6 & 3 | 8 ^ 1', 11],
        ['+5 - -5', 10],
        ['3.9 as integer', 3],
        ['-3.9 as integer', -3],
        ['true ? 1 : 2', 1],
        ['1 < 2 ? 10 : 20', 10]
    ])('integer: %s = %d', async (expression, expected) => {
        expect(await evaluate(expression, 'integer')).toBe(expected);
    });

    test.each([
        ['7.0 / 2', 3.5],
        ['1 + 0.5', 1.5],
        ['7 as real / 2', 3.5],
        ['2', 2],
        ['-2.5', -2.5],
        ['1.5e3', 1500],
        ['1.0 / 0', Infinity]
    ])('real: %s = %d', async (expression, expected) => {
        expect(await evaluate(expression, 'real')).toBe(expected);
    });

    test.each([
        ['1 == 1.0', true],
        ['1 != 2', true],
        ['2 >= 2 && 1 < 2', true],
        ['1 > 2 || 2 <= 1', false],
        ['!false', true],
        ['"a" == "a"', true],
        ['true != false', true]
    ])('boolean: %s = %s', async (expression, expected) => {
        expect(await evaluate(expression, 'boolean')).toBe(expected);
    });

    test('string concatenation', async () => {
        expect(await evaluate("'single' + \"double\" + ''", 'string')).toBe('singledouble');
    });

    test('64-bit wrap around', async () => {
        expect(await evaluate('0x7FFFFFFFFFFFFFFF + 1 == -0x7FFFFFFFFFFFFFFF - 1', 'boolean')).toBe(true);
        expect(await evaluate('(1 << 63) < 0', 'boolean')).toBe(true);
    });

    test('untyped variables take the type of their initializer', async () => {
        expect(await evaluate('1 + 1')).toBe(2);
        expect(await evaluate('"x" + "y"')).toBe('xy');
        expect(await evaluate('0.5 * 2')).toBe(1);
    });

    test('valueof and active', async () => {
        const sim = await load(`statemachine M {
            @EventDriven
            interface:
                in event e : integer
                var v : integer
                var a : boolean
            [*] -> A
            state A { e / v = valueof(e) * 2; a = active(A) && !active(B) }
            state B
        }`);
        sim.enter();
        expect(sim.getEventValue('e')).toBe(0);
        sim.raise('e', 21);
        expect(sim.variables).toEqual({ v: 42, a: true });
        expect(sim.getEventValue('e')).toBe(21);
    });

    test('operation calls: named arguments, varargs, results', async () => {
        const calls: unknown[][] = [];
        const result = await evaluate('sum(1, 2, 3) + scale(factor = 2, value = 5)', 'integer', `
            operation sum(values... : integer) : integer
            operation scale(value : integer, factor : integer) : integer`, {
            operations: {
                sum: (...values) => { calls.push(values); return (values as number[]).reduce((a, b) => a + b, 0); },
                scale: (value, factor) => { calls.push([value, factor]); return (value as number) * (factor as number); }
            }
        });
        expect(result).toBe(16);
        expect(calls).toEqual([[1, 2, 3], [5, 2]]);
    });

    test('runtime errors', async () => {
        expect(await evaluationError('1 / (1 - 1)')).toContain('Division by zero');
        expect(await evaluationError('5 % 0')).toContain('Division by zero');
        expect(await evaluationError('1 << 64')).toContain('out of range');
        expect(await evaluationError('1.5')).toContain('cannot convert real value 1.5 to integer');
        expect(await evaluationError('true + 1')).toContain(`Operator '+' cannot be applied to boolean and integer`);
        expect(await evaluationError('1 && true', 'boolean')).toContain('Expected a boolean');
        expect(await evaluationError('~1.5')).toContain('Expected an integer');
        expect(await evaluationError('5.5 % 2', 'real')).toContain('Expected an integer');
        expect(await evaluationError('true & false', 'boolean')).toContain('Expected an integer');
        expect(await evaluationError('"a" + 1', 'string')).toContain(`Operator '+' cannot be applied to string and integer`);
        expect(await evaluationError('"a" < "b"', 'boolean')).toContain(`Operator '<' cannot be applied to string and string`);
        expect(await evaluationError('"a" as integer')).toContain('Cannot cast string to integer');
        expect(await evaluationError('f()', 'integer', 'operation f() : void')).toContain('no value');
        expect(await evaluationError('K = 2', 'integer', 'const K : integer = 1')).toContain(`Cannot assign to constant 'K'`);
    });

    test('errors name the model element', async () => {
        const message = await evaluationError('10 / 0');
        expect(message).toMatch(/Division by zero \(line \d+: '10 \/ 0'\)/);
    });

    test('invalid operation results are reported', async () => {
        const sim = await load(`statemachine M {
            interface:
                var r : integer
                operation f() : integer
            [*] -> A
            state A { entry / r = f() }
        }`, { operations: { f: () => 1.5 } });
        expect(() => sim.enter()).toThrow(`Result of operation 'f'`);
    });

    test('formatValue', () => {
        expect(formatValue(3n)).toBe('3');
        expect(formatValue(3)).toBe('3.0');
        expect(formatValue(-0.25)).toBe('-0.25');
        expect(formatValue('a"b')).toBe('"a\\"b"');
        expect(formatValue(false)).toBe('false');
    });
});

describe('interpreter API', () => {
    const cdPlayer = example('cd-player.devm');

    test('execution mode and order from annotations', async () => {
        const door = await load(example('door.devm'));
        expect(door.executionMode).toBe('event');
        expect(door.executionOrder).toBe('child-first');
        const light = await load(example('traffic-light.devm'));
        expect(light.executionMode).toBe('cycle');
        expect(light.cyclePeriod).toBe(100);
        expect(light.executionOrder).toBe('parent-first');
        expect((await load(cdPlayer)).cyclePeriod).toBe(200);
    });

    test('active states, leaf states and names', async () => {
        const sim = await load(cdPlayer, { operations: { discInserted: () => true } });
        expect(sim.activeStates).toEqual([]);
        sim.enter();
        sim.setVariable('tracks', 2);
        sim.raise('play');
        sim.runCycle();
        expect(sim.activeStates).toEqual(['Closed', 'Closed.Active', 'Closed.Active.Playing']);
        expect(sim.activeLeafStates).toEqual(['Closed.Active.Playing']);
        expect(sim.isActive('Playing')).toBe(true);
        expect(sim.isActive('Active.Playing')).toBe(true);
        expect(sim.isActive('Closed.Active.Playing')).toBe(true);
        expect(sim.isActive('Open')).toBe(false);
        expect(() => sim.isActive('Nope')).toThrow(SimulationError);
    });

    test('the trace references the taken transitions', async () => {
        const trace: TraceEntry[] = [];
        const sim = await load(cdPlayer, { onTrace: entry => trace.push(entry) });
        sim.enter();
        expect(sim.trace.map(e => e.kind)).toEqual(['transition', 'enter', 'transition', 'enter', 'reaction']);
        sim.raise('eject');
        expect(sim.trace.length).toBe(5); // cycle based: raise does not execute anything
        sim.runCycle();
        const transitions = sim.trace.filter(e => e.kind === 'transition');
        expect(transitions).toHaveLength(1);
        const taken = transitions[0];
        expect(taken.kind === 'transition' && isTransition(taken.node)).toBe(true);
        expect(taken.kind === 'transition' && [taken.source, taken.target, taken.label]).toEqual(['Closed', 'Open', 'eject']);
        expect(sim.trace.map(e => e.kind)).toEqual(['step', 'exit', 'exit', 'transition', 'enter']);
        expect(trace.some(e => e.kind === 'raise' && e.event === 'eject')).toBe(true);
    });

    test('out events of the last call and callback', async () => {
        const received: string[] = [];
        const sim = await load(example('keyboard.devm'), { onOutEvent: e => received.push(e.text) });
        sim.enter();
        sim.raise('capsLock');
        sim.runCycle();
        expect(sim.outEvents).toEqual([{ name: 'led', value: 1, text: 'led(1)' }]);
        sim.runCycle();
        expect(sim.outEvents).toEqual([]);
        expect(received).toEqual(['led(1)']);
    });

    test('variables snapshot and setVariable', async () => {
        const sim = await load(example('traffic-light.devm'));
        sim.enter();
        expect(sim.variables).toEqual({ 'Pedestrian.waiting': false, RED: 1, YELLOW: 2, GREEN: 4, lights: 0 });
        sim.setVariable('Pedestrian.waiting', true);
        expect(sim.getVariable('waiting')).toBe(true);
        expect(() => sim.setVariable('RED', 3)).toThrow('constant');
        expect(() => sim.setVariable('lights', 1.5)).toThrow('not a valid integer');
        expect(() => sim.setVariable('nope', 1)).toThrow(`Unknown variable 'nope'`);
    });

    test('raising events: unknown, out events, before enter', async () => {
        const sim = await load(example('keyboard.devm'));
        expect(() => sim.raise('capsLock')).toThrow('not entered');
        sim.enter();
        expect(() => sim.raise('nope')).toThrow(`Unknown event 'nope'`);
        expect(() => sim.raise('led')).toThrow('out event');
        expect(() => sim.enter()).toThrow('already entered');
    });

    test('virtual clock', async () => {
        const sim = await load(example('traffic-light.devm'));
        sim.enter();
        sim.raise('powerOn');
        sim.runFor(20100); // the first cycle (at 100 ms) enters Red
        expect(sim.time).toBe(20100);
        expect(sim.isActive('RedYellow')).toBe(true);
        sim.advanceTime(5000);
        expect(sim.isActive('RedYellow')).toBe(true);
        sim.runCycle();
        expect(sim.isActive('Green')).toBe(true);
        expect(() => sim.advanceTime(-1)).toThrow('Invalid time span');
    });

    test('in events raised by operations during an event driven step are queued', async () => {
        let sim: StatechartInterpreter | undefined;
        sim = await load(`statemachine M {
            @EventDriven
            interface:
                in event a
                in event b
                operation notify() : void
            [*] -> A
            state A
            state B
            state C
            A -> B : a / notify()
            B -> C : b
        }`, { operations: { notify: () => sim!.raise('b') } });
        sim.enter();
        sim.raise('a');
        expect(sim.activeStates).toEqual(['C']);
    });

    test('endless loops are detected', async () => {
        const sim = await load(`statemachine M {
            @EventDriven
            interface:
                in event go
            internal:
                event ping
            [*] -> A
            state A { go / raise ping  ping / raise ping }
        }`, { maxMicrosteps: 50 });
        sim.enter();
        expect(() => sim.raise('go')).toThrow('seems to loop');
    });

    test('exit and final', async () => {
        const sim = await load(example('keyboard.devm'));
        sim.enter();
        sim.raise('unplug');
        sim.runCycle();
        expect(sim.isFinal()).toBe(true);
        expect(sim.isRunning).toBe(true);
        sim.exit();
        expect(sim.isRunning).toBe(false);
        expect(sim.isFinal()).toBe(false);
        sim.enter();
        expect(sim.activeStates).toEqual(['Active', 'Active.CapsOff', 'Active.NumOff']);
    });
});
