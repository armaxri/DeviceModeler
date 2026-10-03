import { describe, expect, test } from 'vitest';
import { errors, example, parse, warnings } from './helpers.js';

describe('examples', () => {
    for (const file of ['traffic-light.devm', 'cd-player.devm', 'keyboard.devm', 'door.devm']) {
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

describe('entry / exit specifications', () => {
    const MODEL = (transitions: string, extra = '') => `statemachine M {
        interface:
            in event go
            in event stop
        [*] -> Idle
        state Idle
        state P {
            region R1 {
                [*] -> A
                entry E
                exit X
                state A
                state B
                E -> B
                A -> X : go
            }
            region R2 {
                [*] -> C
                entry E
                entry F
                exit X
                exit Y
                state C
                state D
                E -> D
                F -> D
                C -> X : go
                C -> Y : stop
            }
            ${extra}
        }
        ${transitions}
    }`;

    test('entry points and exit nodes may share a name across orthogonal regions', async () => {
        const parsed = await parse(MODEL('Idle -> P : go # >E\n P -> Idle # X> Y>'));
        expect(errors(parsed)).toEqual([]);
        expect(warnings(parsed)).toEqual([]);
    });

    test('several entry points: only the first one is used', async () => {
        const parsed = await parse(MODEL('Idle -> P : go # >E >F\n P -> Idle # X>'));
        expect(errors(parsed)).toEqual([]);
        expect(warnings(parsed)).toEqual([`Only the first entry point ('E') is used; remove the others (like itemis CREATE).`]);
    });

    test('unknown and duplicate entry points / exit nodes', async () => {
        const parsed = await parse(MODEL('Idle -> P : go # >G\n P -> Idle # X> Z> X>'));
        expect(errors(parsed)).toContain(`'P' has no entry point 'G'.`);
        expect(errors(parsed)).toContain(`'P' has no exit node 'Z'.`);
        expect(warnings(parsed)).toContain(`Duplicate exit node 'X'.`);
    });

    test('ambiguous references to shared names outside of their regions', async () => {
        const message = `'E' is ambiguous: several regions have an entry point with this name. Declare the transition inside the region of the entry point.`;
        // simple name: not resolved (linking error)
        const simple = await parse(MODEL('Idle -> P : go # >E\n P -> Idle # X>', 'E -> A'));
        expect(errors(simple)).toContain(message);
        // qualified name: resolved to the first entry point, but still ambiguous
        const qualified = await parse(MODEL('Idle -> P : go # >E\n P -> Idle # X>', 'P.E -> A'));
        expect(errors(qualified)).toContain(message);
    });

    test('other vertices must still have unique names', async () => {
        const parsed = await parse(`statemachine M {
            [*] -> P
            state P {
                region R1 { [*] -> A state A entry E E -> A }
                region R2 { [*] -> A state A exit E }
            }
        }`);
        const messages = errors(parsed);
        expect(messages.filter(m => m === `Duplicate name 'A'. Sibling states must have different names.`)).toHaveLength(1);
        expect(messages.filter(m => m === `Duplicate name 'E'. Sibling states must have different names.`)).toHaveLength(1);
        const sameRegion = await parse(`statemachine M {
            [*] -> P
            state P {
                region R1 { [*] -> A state A entry E entry E E -> A }
            }
        }`);
        expect(errors(sameRegion)).toContain(`Duplicate name 'E'. Sibling states must have different names.`);
    });
});
