import { describe, expect, test } from 'vitest';
import { errors, example, parse, warnings } from './helpers.js';

describe('examples', () => {
    for (const file of ['traffic-light.hsm', 'cd-player.hsm', 'keyboard.hsm', 'door.hsm']) {
        test(`${file} is valid`, async () => {
            const parsed = await parse(example(file));
            expect(parsed.hasSyntaxErrors).toBe(false);
            expect(errors(parsed)).toEqual([]);
            expect(warnings(parsed)).toEqual([]);
        });
    }
});

describe('linking', () => {
    test('transitions may refer to nested states', async () => {
        const parsed = await parse(`statemachine M {
            [*] -> A
            state A { [*] -> A1 state A1 }
            state B
            B -> A1
            A1 -> B
        }`);
        expect(errors(parsed)).toEqual([]);
        expect(parsed.model.transitions[1].target?.ref?.name).toBe('A1');
    });

    test('unknown states are reported', async () => {
        const parsed = await parse(`statemachine M { [*] -> A state A A -> X }`);
        expect(errors(parsed).join()).toContain(`Could not resolve reference to Vertex named 'X'`);
    });
});

describe('validation', () => {
    test('duplicate names', async () => {
        const parsed = await parse(`statemachine M { [*] -> A state A state B { [*] -> A state A } }`);
        expect(errors(parsed)).toEqual([]);
        const siblings = await parse(`statemachine M { [*] -> A state A state B { [*] -> C state C state C } }`);
        expect(errors(siblings)).toContain(`Duplicate name 'C'. Sibling states must have different names.`);
    });

    test('multiple initial transitions', async () => {
        const parsed = await parse(`statemachine M { [*] -> A [*] -> B state A state B }`);
        expect(errors(parsed)).toContain(`Only one initial transition is allowed in state machine 'M'.`);
    });

    test('missing initial transition in composite state', async () => {
        const parsed = await parse(`statemachine M { [*] -> A state A { state A1 } }`);
        expect(warnings(parsed)).toContain(`State 'A' has no initial transition ('[*] -> ...').`);
    });

    test('transitions between orthogonal regions', async () => {
        const parsed = await parse(`statemachine M { [*] -> S state S {
            region { [*] -> A state A }
            region { [*] -> B state B }
            A -> B
        } }`);
        expect(errors(parsed).join()).toContain('Transitions between orthogonal regions are not allowed');
    });

    test('non-deterministic transitions', async () => {
        const parsed = await parse(`statemachine M { interface: in event e in event x [*] -> A state A state B A -> B : e B -> A : x A -> A : e }`);
        expect(warnings(parsed).join()).toContain(`'A' has several unguarded transitions for the same event`);
    });

    test('history on top level', async () => {
        const parsed = await parse(`statemachine M { [*] -> A state A history H }`);
        expect(errors(parsed)).toContain('History pseudo states must be placed inside a composite state.');
    });

    test('unreachable state', async () => {
        const parsed = await parse(`statemachine M { [*] -> A state A state B }`);
        expect(warnings(parsed)).toContain(`State 'B' is never entered: it has no incoming transition.`);
    });
});
