import { AstUtils } from 'langium';
import { describe, expect, test } from 'vitest';
import * as ast from '../src/generated/ast.js';
import {
    binaryResultType, commonType, eventDirection, inferType, isAssignable, isCastable, resolveTypeName,
    typeOfDeclaration, typeOfTypeReference, unaryResultType
} from '../src/hsm-typesystem.js';
import { errors, parse, warnings } from './helpers.js';

type Parsed = Awaited<ReturnType<typeof parse>>;

function infos(parsed: Parsed): string[] {
    return parsed.diagnostics.filter(d => d.severity === 3).map(d => d.message);
}

/** The source text covered by the (first) diagnostic whose message contains `message`. */
function location(parsed: Parsed, message: string): string | undefined {
    const diagnostic = parsed.diagnostics.find(d => d.message.includes(message));
    return diagnostic ? parsed.document.textDocument.getText(diagnostic.range) : undefined;
}

/**
 * A state machine with the given definitions (appended to an unnamed interface with the in event
 * `go`), a local reaction body for state `A` and a transition specification from `A` to `B`.
 */
async function machine(options: { definitions?: string, body?: string, spec?: string, annotations?: string }): Promise<Parsed> {
    const parsed = await parse(`statemachine M {
        ${options.annotations ?? ''}
        interface:
            in event go
            ${options.definitions ?? ''}
        [*] -> A
        state A {
            ${options.body ?? ''}
        }
        state B
        A -> B : ${options.spec ?? 'go'}
    }`);
    expect(parsed.hasSyntaxErrors, parsed.diagnostics.map(d => d.message).join('\n')).toBe(false);
    return parsed;
}

/** Declarations used in many tests. */
const DEFS = `
    in event e
    in event ie : integer
    out event o
    out event oi : integer
    out event os : string
    var i : integer = 0
    var r : real = 0.0
    var b : boolean = false
    var s : string = ""
    const C : integer = 3
    var readonly RO : integer = 1
    operation v() : void
    operation f(x : integer, y : real) : integer
    operation g(x : integer, rest... : string) : boolean
    operation n() : integer
`;

async function body(statements: string, definitions = DEFS): Promise<Parsed> {
    return machine({ definitions, body: `go / ${statements}` });
}

async function guard(expression: string, definitions = DEFS): Promise<Parsed> {
    return machine({ definitions, spec: `go [${expression}]` });
}

function expressionOf(parsed: Parsed): ast.Expression {
    const transition = parsed.model.transitions.find(t => t.spec?.guard);
    const result = transition?.spec?.guard;
    if (!result) {
        throw new Error('no guard');
    }
    return result;
}

describe('type system', () => {
    test('type names', () => {
        expect(resolveTypeName('integer')).toBe('integer');
        expect(resolveTypeName('void')).toBe('void');
        expect(resolveTypeName('int')).toBeUndefined();
        expect(typeOfTypeReference(undefined)).toBe('error');
    });

    test('assignability', () => {
        expect(isAssignable('real', 'integer')).toBe(true);
        expect(isAssignable('integer', 'real')).toBe(false);
        expect(isAssignable('string', 'integer')).toBe(false);
        expect(isAssignable('boolean', 'boolean')).toBe(true);
        expect(isAssignable('integer', 'error')).toBe(true);
        expect(isAssignable('error', 'string')).toBe(true);
        expect(isAssignable('integer', 'void')).toBe(false);
    });

    test('operators', () => {
        expect(binaryResultType('+', 'integer', 'integer')).toBe('integer');
        expect(binaryResultType('+', 'integer', 'real')).toBe('real');
        expect(binaryResultType('+', 'string', 'string')).toBe('string');
        expect(binaryResultType('+', 'string', 'integer')).toBeUndefined();
        expect(binaryResultType('%', 'real', 'integer')).toBeUndefined();
        expect(binaryResultType('<', 'real', 'integer')).toBe('boolean');
        expect(binaryResultType('==', 'string', 'string')).toBe('boolean');
        expect(binaryResultType('==', 'string', 'integer')).toBeUndefined();
        expect(binaryResultType('&&', 'boolean', 'error')).toBe('boolean');
        expect(binaryResultType('*', 'integer', 'error')).toBe('error');
        expect(unaryResultType('-', 'real')).toBe('real');
        expect(unaryResultType('!', 'integer')).toBeUndefined();
        expect(unaryResultType('~', 'integer')).toBe('integer');
        expect(commonType('integer', 'real')).toBe('real');
        expect(commonType('integer', 'boolean')).toBeUndefined();
        expect(isCastable('real', 'integer')).toBe(true);
        expect(isCastable('boolean', 'integer')).toBe(false);
    });

    test.each([
        ['true', 'boolean'],
        ['1', 'integer'],
        ['0xFF', 'integer'],
        ['1.5', 'real'],
        ['"x"', 'string'],
        ['i', 'integer'],
        ['r', 'real'],
        ['C', 'integer'],
        ['f(1, 2)', 'integer'],
        ['g(1)', 'boolean'],
        ['v()', 'void'],
        ['f', 'error'],
        ['i()', 'error'],
        ['valueof(ie)', 'integer'],
        ['valueof(e)', 'error'],
        ['active(A)', 'boolean'],
        ['-r', 'real'],
        ['!b', 'boolean'],
        ['~i', 'integer'],
        ['i + r', 'real'],
        ['i * 2', 'integer'],
        ['s + s', 'string'],
        ['i % 2', 'integer'],
        ['i < r', 'boolean'],
        ['b && true', 'boolean'],
        ['i << 2', 'integer'],
        ['b ? i : r', 'real'],
        ['b ? s : i', 'error'],
        ['r as integer', 'integer'],
        ['(i + 1)', 'integer'],
        ['i = 3', 'integer'],
        ['r += 1', 'real'],
        ['unknown + 1', 'error']
    ])('type of %s is %s', async (expression, type) => {
        const parsed = await guard(expression);
        expect(inferType(expressionOf(parsed))).toBe(type);
    });

    test('declaration types', async () => {
        const parsed = await machine({ definitions: `
            var a = 1
            var c = a + 0.5
            const S = "s"
            var loop1 = loop2
            var loop2 = loop1
            out event x : real
            operation op() ` });
        const declarations = parsed.model.scopes.flatMap(s => s.declarations);
        const typeOf = (name: string) => typeOfDeclaration(declarations.find(d => d.name === name)!);
        expect(typeOf('a')).toBe('integer');
        expect(typeOf('c')).toBe('real');
        expect(typeOf('S')).toBe('string');
        expect(typeOf('loop1')).toBe('error');
        expect(typeOf('x')).toBe('real');
        expect(typeOf('op')).toBe('void');
        expect(typeOf('go')).toBe('void');
    });

    test('event directions', async () => {
        const parsed = await parse(`statemachine M {
            interface: in event a out event b event c
            internal: event d
        }`);
        const events = AstUtils.streamAllContents(parsed.model).filter(ast.isEventDeclaration).toArray();
        expect(events.map(eventDirection)).toEqual(['in', 'out', 'in', 'internal']);
    });
});

describe('declarations', () => {
    test('unknown type names', async () => {
        const parsed = await machine({ definitions: 'var x : int = 0 operation op(p : float) : number in event q : bool' });
        const messages = errors(parsed).filter(m => m.startsWith('Unknown type'));
        expect(messages).toHaveLength(4);
        expect(location(parsed, `Unknown type 'float'`)).toBe('float');
        // no cascading type errors
        expect(errors(parsed)).toHaveLength(4);
    });

    test('void is only allowed as return type', async () => {
        const parsed = await machine({ definitions: 'var x : void operation op(p : void) : void in event q : void' });
        expect(errors(parsed).filter(m => m.includes(`'void' can only be used as the return type`))).toHaveLength(3);
    });

    test('unknown type in casts', async () => {
        const parsed = await guard('(1 as long) == 1');
        expect(errors(parsed)).toEqual([`Unknown type 'long'. Known types are integer, real, boolean, string, void and type aliases ('alias Name : type').`]);
    });

    test('duplicate parameters and varargs', async () => {
        const parsed = await machine({ definitions: 'operation op(a : integer, a : real) operation va(a... : integer, b : integer)' });
        expect(errors(parsed)).toContain(`Duplicate parameter 'a'.`);
        expect(errors(parsed)).toContain(`Only the last parameter of an operation can be a variable argument list ('...').`);
        expect(location(parsed, 'Only the last parameter')).toBe('...');
        const valid = await machine({ definitions: 'operation va(a : integer, b... : integer)' });
        expect(errors(valid)).toEqual([]);
    });

    test('initial values must match the declared type', async () => {
        const parsed = await machine({ definitions: `
            var a : integer = 1.5
            var b : real = 1
            var c : boolean = 1
            var d : string = "x"
            const e : integer = true` });
        expect(errors(parsed)).toEqual([
            `Type mismatch: the initial value of type real cannot be assigned to 'a' of type integer.`,
            `Type mismatch: the initial value of type integer cannot be assigned to 'c' of type boolean.`,
            `Type mismatch: the initial value of type boolean cannot be assigned to 'e' of type integer.`
        ]);
        expect(location(parsed, `to 'a' of type integer`)).toBe('1.5');
    });

    test('variables need a type or an initial value, constants an initial value', async () => {
        const parsed = await machine({ definitions: 'var a var b : integer var c = 1 const d : integer const e = 2' });
        expect(errors(parsed)).toEqual([
            `Variable 'a' needs a type or an initial value.`,
            `Constant 'd' must have an initial value.`
        ]);
    });

    test('directions in the internal scope', async () => {
        const parsed = await parse(`statemachine M {
            internal:
                in event a
                out event b
                event c
            [*] -> A state A { a / raise c } state B A -> B : b
            A -> B : c
        }`);
        expect(errors(parsed).filter(m => m.includes('is not allowed in the internal scope'))).toHaveLength(2);
        expect(location(parsed, `The direction 'in'`)).toBe('in');
    });

    test('events without direction in interfaces', async () => {
        const parsed = await parse(`statemachine M {
            interface: event a
            interface I: event b
            internal: event c
            [*] -> A state A state B A -> B : a B -> A : I.b A -> A : c
        }`);
        expect(warnings(parsed)).toEqual([
            `Event 'a' has no direction ('in' or 'out'); it is treated as an 'in' event.`,
            `Event 'b' has no direction ('in' or 'out'); it is treated as an 'in' event.`
        ]);
    });

    test('unused declarations', async () => {
        const parsed = await machine({ definitions: 'in event unusedEvent var unusedVar = 1 const USED = 2 var x = USED operation op()' });
        expect(infos(parsed)).toEqual([
            `Event 'unusedEvent' is never used.`,
            `Variable 'unusedVar' is never used.`,
            `Variable 'x' is never used.`,
            `Operation 'op' is never used.`
        ]);
        expect(errors(parsed)).toEqual([]);
        expect(warnings(parsed)).toEqual([]);
    });
});

describe('assignments', () => {
    test('valid assignments', async () => {
        const parsed = await body('i = 1; r = i; r = 2.5; b = !b; s = s + "x"; i += 1; r *= 2; r /= i; i %= 2; i <<= 1; i &= 3; i |= 4; i ^= 5; s += "y"; i = f(1, 2); b = g(1, "a", "b")');
        expect(errors(parsed)).toEqual([]);
        expect(warnings(parsed)).toEqual([]);
    });

    test('value must be assignable', async () => {
        const parsed = await body('i = 1.5; b = 1; s = 1');
        expect(errors(parsed)).toEqual([
            `Type mismatch: a value of type real cannot be assigned to 'i' of type integer.`,
            `Type mismatch: a value of type integer cannot be assigned to 'b' of type boolean.`,
            `Type mismatch: a value of type integer cannot be assigned to 's' of type string.`
        ]);
        expect(location(parsed, `to 'i' of type integer`)).toBe('1.5');
    });

    test('constants and readonly variables cannot be assigned', async () => {
        const parsed = await body('C = 1; C += 1; RO = 2; RO -= 1');
        expect(errors(parsed)).toEqual([
            `Cannot assign a value to the constant 'C'.`,
            `Cannot assign a value to the constant 'C'.`,
            `Cannot assign a value to the readonly variable 'RO'.`,
            `Cannot assign a value to the readonly variable 'RO'.`
        ]);
        expect(location(parsed, 'constant')).toBe('C');
    });

    test('left side must be a variable', async () => {
        const parsed = await body('n() = 1; f = 1; 1 = 1; (i) = 1; i + 1 = 2');
        expect(errors(parsed).filter(m => m === 'The left-hand side of an assignment must be a variable.')).toHaveLength(5);
    });

    test('compound assignments', async () => {
        const parsed = await body('i += 1.5; i %= 1.5; r %= 1; r <<= 1; b += 1; s -= "a"; b &= true');
        expect(errors(parsed)).toEqual([
            `Type mismatch: the result of '+=' is of type real and cannot be assigned to 'i' of type integer.`,
            `The operator '%=' cannot be applied to integer and real.`,
            `The operator '%=' cannot be applied to real and integer.`,
            `The operator '<<=' cannot be applied to real and integer.`,
            `The operator '+=' cannot be applied to boolean and integer.`,
            `The operator '-=' cannot be applied to string and string.`,
            `The operator '&=' cannot be applied to boolean and boolean.`
        ]);
        expect(location(parsed, `'%=' cannot be applied to integer`)).toBe('%=');
    });
});

describe('operators', () => {
    test('valid expressions', async () => {
        const parsed = await guard('(i + r * 2 - 1) / 3 > 0 && !b || s == "x" && (i % 2 == 0) && ((i & 1) | (i ^ 2) | (i << 1) | (i >> 1) | ~i) != 0 && -r < +i && (b ? 1 : 2.0) >= 1 && (r as integer) == i && b != false && s != s + "y" && active(B) && valueof(ie) > 0');
        expect(errors(parsed)).toEqual([]);
    });

    test('logical operators need boolean operands', async () => {
        const parsed = await guard('i && b || s');
        expect(errors(parsed)).toEqual([
            `The operator '||' requires boolean operands, but the right operand is of type string.`,
            `The operator '&&' requires boolean operands, but the left operand is of type integer.`
        ]);
        expect(location(parsed, `left operand is of type integer`)).toBe('i');
        const not = await guard('!i');
        expect(errors(not)).toEqual([`The operator '!' requires a boolean operand, but the operand is of type integer.`]);
    });

    test('arithmetic operators need numeric operands', async () => {
        const parsed = await body('i = i - b; r = s * 2; i = -b; i = +s');
        expect(errors(parsed)).toEqual([
            `The operator '-' requires numeric operands, but the right operand is of type boolean.`,
            `The operator '*' requires numeric operands, but the left operand is of type string.`,
            `The operator '-' requires a numeric operand, but the operand is of type boolean.`,
            `The operator '+' requires a numeric operand, but the operand is of type string.`
        ]);
    });

    test('plus with strings', async () => {
        const parsed = await body('s = s + 1; i = b + b');
        expect(errors(parsed)).toEqual([
            `The operator '+' cannot be applied to string and integer.`,
            `The operator '+' requires numeric (or string) operands, but the left operand is of type boolean.`,
            `The operator '+' requires numeric (or string) operands, but the right operand is of type boolean.`
        ]);
        expect(location(parsed, `cannot be applied to string and integer`)).toBe('+');
    });

    test('bitwise, shift and modulo operators need integer operands', async () => {
        const parsed = await body('i = i & r; i = b | 1; i = i ^ 1.0; i = r << 1; i = i >> r; i = r % 2; i = ~r');
        expect(errors(parsed)).toEqual([
            `The operator '&' requires integer operands, but the right operand is of type real.`,
            `The operator '|' requires integer operands, but the left operand is of type boolean.`,
            `The operator '^' requires integer operands, but the right operand is of type real.`,
            `The operator '<<' requires integer operands, but the left operand is of type real.`,
            `The operator '>>' requires integer operands, but the right operand is of type real.`,
            `The operator '%' requires integer operands, but the left operand is of type real.`,
            `The operator '~' requires an integer operand, but the operand is of type real.`
        ]);
    });

    test('relational operators need numeric operands', async () => {
        const parsed = await guard('s < "b" && b >= true');
        expect(errors(parsed)).toEqual([
            `The operator '<' requires numeric operands, but the left operand is of type string.`,
            `The operator '<' requires numeric operands, but the right operand is of type string.`,
            `The operator '>=' requires numeric operands, but the left operand is of type boolean.`,
            `The operator '>=' requires numeric operands, but the right operand is of type boolean.`
        ]);
    });

    test('comparison of incompatible types', async () => {
        const parsed = await guard('i == b || s != 1 || i == r');
        expect(errors(parsed)).toEqual([
            `Cannot compare a value of type integer with a value of type boolean.`,
            `Cannot compare a value of type string with a value of type integer.`
        ]);
        expect(location(parsed, 'type integer with a value of type boolean')).toBe('==');
    });

    test('conditional expressions', async () => {
        const parsed = await body('i = i ? 1 : 2; r = b ? 1 : "x"; r = b ? i : r');
        expect(errors(parsed)).toEqual([
            `The condition must be of type boolean, but is of type integer.`,
            `The branches of the conditional expression have incompatible types integer and string.`
        ]);
        expect(location(parsed, 'incompatible types')).toBe('"x"');
        expect(location(parsed, 'The condition must be')).toBe('i');
    });

    test('casts', async () => {
        const parsed = await body('i = r as integer; r = i as real; i = b as integer; s = i as string');
        expect(errors(parsed)).toEqual([
            `Cannot cast a value of type boolean to integer.`,
            `Cannot cast a value of type integer to string.`
        ]);
    });

    test('no cascading errors for unresolved references', async () => {
        const parsed = await guard('unknown + 1 > 2 && other');
        expect(errors(parsed).every(m => m.startsWith('Could not resolve reference'))).toBe(true);
        expect(errors(parsed)).toHaveLength(2);
    });
});

describe('guards and statements', () => {
    test('guards must be boolean', async () => {
        const parsed = await machine({ definitions: DEFS, spec: 'go [i + 1]', body: 'go [s] / i = 1' });
        expect(errors(parsed)).toEqual([
            `The guard must be of type boolean, but is of type integer.`,
            `The guard must be of type boolean, but is of type string.`
        ]);
        expect(location(parsed, 'is of type integer')).toBe('i + 1');
    });

    test('statements without effect', async () => {
        const parsed = await body('i + 1; i; f(1, 2); v(); i = 2; raise o; 3; (i = 4)');
        expect(warnings(parsed)).toEqual([
            'The expression has no effect.',
            'The expression has no effect.',
            'The expression has no effect.',
            'The expression has no effect.'
        ]);
        expect(location(parsed, 'no effect')).toBe('i + 1');
    });
});

describe('operation calls', () => {
    test('valid calls', async () => {
        const parsed = await body('i = f(1, 2.5); i = f(x = 1, y = 2); i = f(1, y = 2); i = f(y = 2, x = 1); b = g(1); b = g(1, "a", "b", "c"); b = g(x = 1); i = n(); v()');
        expect(errors(parsed)).toEqual([]);
    });

    test('argument count', async () => {
        const parsed = await body('i = f(1); i = f(1, 2, 3); b = g(); i = n(1)');
        expect(errors(parsed)).toEqual([
            `The operation 'f' expects 2 arguments; missing 'y'.`,
            `Too many arguments: the operation 'f' expects 2 arguments.`,
            `The operation 'g' expects at least 1 argument; missing 'x'.`,
            `Too many arguments: the operation 'n' expects 0 arguments.`
        ]);
        expect(location(parsed, 'Too many arguments')).toBe('3');
    });

    test('argument types', async () => {
        const parsed = await body('i = f(1.5, true); b = g(1, "a", 2)');
        expect(errors(parsed)).toEqual([
            `Type mismatch: an argument of type real cannot be assigned to the parameter 'x' of type integer.`,
            `Type mismatch: an argument of type boolean cannot be assigned to the parameter 'y' of type real.`,
            `Type mismatch: an argument of type integer cannot be assigned to the parameter 'rest' of type string.`
        ]);
        expect(location(parsed, `parameter 'y'`)).toBe('true');
    });

    test('named arguments', async () => {
        const parsed = await body('i = f(x = 1, z = 2); i = f(x = 1, 2); i = f(1, x = 2)');
        expect(errors(parsed)).toEqual([
            `The operation 'f' has no parameter 'z'.`,
            `The operation 'f' expects 2 arguments; missing 'y'.`,
            'Positional arguments must not follow named arguments.',
            `The operation 'f' expects 2 arguments; missing 'y'.`,
            `The parameter 'x' is already assigned.`,
            `The operation 'f' expects 2 arguments; missing 'y'.`
        ]);
        expect(location(parsed, `has no parameter`)).toBe('z');
    });

    test('operations must be called, variables cannot be called', async () => {
        const parsed = await body('i = n; i = i(); b = C()');
        expect(errors(parsed)).toEqual([
            `The operation 'n' must be called with parentheses: 'n(...)'.`,
            `'i' is a variable and cannot be called.`,
            `'C' is a constant and cannot be called.`
        ]);
        expect(location(parsed, 'must be called')).toBe('n');
        expect(location(parsed, `'i' is a variable`)).toBe('(');
    });

    test('void operations cannot be used as values', async () => {
        const parsed = await body('i = v(); v(); f(v(), 1)');
        expect(errors(parsed)).toEqual([
            `The operation 'v' has no return value (void) and cannot be used as a value.`,
            `The operation 'v' has no return value (void) and cannot be used as a value.`
        ]);
        const inGuard = await guard('v()');
        expect(errors(inGuard)).toEqual([`The operation 'v' has no return value (void) and cannot be used as a value.`]);
    });
});

describe('events', () => {
    test('raise', async () => {
        const parsed = await body('raise o; raise oi : 1; raise os : "x"');
        expect(errors(parsed)).toEqual([]);
    });

    test('raise values', async () => {
        const parsed = await body('raise oi; raise o : 1; raise oi : true; raise os : 1');
        expect(errors(parsed)).toEqual([
            `Event 'oi' requires a value of type integer: 'raise oi : value'.`,
            `Event 'o' has no type and cannot carry a value.`,
            `Type mismatch: a value of type boolean cannot be assigned to event 'oi' of type integer.`,
            `Type mismatch: a value of type integer cannot be assigned to event 'os' of type string.`
        ]);
        expect(location(parsed, 'cannot carry a value')).toBe('1');
    });

    test('raise integer as real', async () => {
        const parsed = await body('raise x : 1', 'out event x : real');
        expect(errors(parsed)).toEqual([]);
    });

    test('in events cannot be raised', async () => {
        const parsed = await body('raise e; raise ie : 1');
        expect(errors(parsed)).toEqual([
            `Cannot raise 'e': in events can only be raised by the environment.`,
            `Cannot raise 'ie': in events can only be raised by the environment.`
        ]);
        const internal = await parse(`statemachine M {
            internal: event tick var n : integer = 0
            [*] -> A state A { entry / raise tick  tick / n += 1 }
        }`);
        expect(errors(internal)).toEqual([]);
    });

    test('valueof', async () => {
        const parsed = await guard('valueof(e) > 0 && valueof(ie) > 0 && valueof(oi) > 0');
        expect(errors(parsed)).toEqual([`Event 'e' has no type: valueof() requires an event with a value.`]);
    });
});

describe('triggers', () => {
    test('out events cannot be triggers', async () => {
        const parsed = await machine({ definitions: DEFS, spec: 'o, e', body: 'oi / i = 1' });
        expect(errors(parsed)).toEqual([
            `The out event 'o' cannot be used as a trigger: out events are raised by the state machine.`,
            `The out event 'oi' cannot be used as a trigger: out events are raised by the state machine.`
        ]);
        expect(location(parsed, `out event 'o'`)).toBe('o');
    });

    test('time triggers', async () => {
        const valid = await machine({ definitions: DEFS, spec: 'after 1 s, after C ms, after 1.5 us, every i ns', body: 'every r s / i = 1' });
        expect(errors(valid)).toEqual([]);
        const parsed = await machine({ definitions: DEFS, spec: 'after b s, after "x" ms, after 1 min', body: 'every 1 h / i = 1' });
        expect(errors(parsed)).toEqual([
            `The time value must be of type integer (or real), but is of type boolean.`,
            `The time value must be of type integer (or real), but is of type string.`,
            `Unknown time unit 'min'. Use one of s, ms, us, ns.`,
            `Unknown time unit 'h'. Use one of s, ms, us, ns.`
        ]);
        expect(location(parsed, `'min'`)).toBe('min');
    });

    test('else and default are still checked', async () => {
        const parsed = await machine({ spec: 'else' });
        expect(errors(parsed)).toContain(`'else' can only be used on transitions leaving a choice.`);
    });
});

describe('annotations', () => {
    test('known annotations', async () => {
        const parsed = await machine({ annotations: '@CycleBased(100) @ParentFirstExecution' });
        expect(errors(parsed)).toEqual([]);
        expect(warnings(parsed)).toEqual([]);
        const eventDriven = await machine({ annotations: '@EventDriven @ChildFirstExecution @CycleBased' });
        expect(errors(eventDriven)).toEqual([`@CycleBased cannot be combined with @EventDriven.`]);
    });

    test('annotation arguments', async () => {
        const parsed = await machine({ annotations: '@CycleBased(1.5) @ChildFirstExecution(1)', definitions: 'const PERIOD : integer = 10' });
        expect(errors(parsed)).toEqual([
            'The cycle period must be of type integer, but is of type real.',
            '@ChildFirstExecution takes no arguments.'
        ]);
        const tooMany = await machine({ annotations: '@CycleBased(1, 2)' });
        expect(errors(tooMany)).toEqual(['@CycleBased takes at most one argument (the cycle period in milliseconds).']);
        const constant = await machine({ annotations: '@CycleBased(PERIOD)', definitions: 'const PERIOD : integer = 10' });
        expect(errors(constant)).toEqual([]);
        expect(infos(constant)).toEqual([]);
    });

    test('conflicting annotations', async () => {
        const parsed = await machine({ annotations: '@CycleBased @EventDriven @ParentFirstExecution @ChildFirstExecution' });
        expect(errors(parsed)).toEqual([
            '@EventDriven cannot be combined with @CycleBased.',
            '@ChildFirstExecution cannot be combined with @ParentFirstExecution.'
        ]);
    });

    test('unsupported and unknown annotations', async () => {
        const parsed = await machine({ annotations: '@SuperSteps(yes) @SuperSteps(no) @EventBuffering(false) @InEventQueue @Something' });
        expect(errors(parsed)).toEqual([]);
        expect(warnings(parsed)).toEqual([
            `Duplicate annotation '@SuperSteps'.`,
            '@SuperSteps is not supported yet and is ignored.',
            '@SuperSteps is not supported yet and is ignored.',
            '@EventBuffering is not supported yet and is ignored.',
            '@InEventQueue is not supported yet and is ignored.',
            `Unknown annotation '@Something'. Known annotations are @CycleBased, @EventDriven, @ParentFirstExecution, @ChildFirstExecution, @SuperSteps, @EventBuffering, @InEventQueue, @at, @size, @regions, @via, @label, @initial, @final, @definitions.`
        ]);
    });
});

describe('vertex references', () => {
    test('ambiguous names', async () => {
        const parsed = await parse(`statemachine M {
            [*] -> A
            state A { [*] -> X state X }
            state B { [*] -> X state X }
            A -> X
        }`);
        expect(errors(parsed)).toEqual([`'X' is ambiguous, use a qualified name like 'A.X' or 'B.X'.`]);
        expect(location(parsed, 'ambiguous')).toBe('X');
    });

    test('ambiguous names in active()', async () => {
        const parsed = await parse(`statemachine M {
            [*] -> A
            state A { [*] -> X state X }
            state B { [*] -> X state X }
            state C { [*] -> X state X }
            A -> B : [active(X)]
        }`);
        expect(errors(parsed)).toEqual([`'X' is ambiguous, use a qualified name like 'A.X', 'B.X' or 'C.X'.`]);
    });

    test('nearest name wins, qualified names resolve', async () => {
        const parsed = await parse(`statemachine M {
            [*] -> A
            state A { [*] -> X state X state Y X -> Y }
            state B { [*] -> X state X }
            A.X -> B.X
        }`);
        expect(errors(parsed)).toEqual([]);
        const inner = parsed.model.vertices[0] as ast.State;
        expect(inner.transitions[1].source?.ref).toBe(inner.vertices[0]);
    });

    test('unknown names keep the default message', async () => {
        const parsed = await parse(`statemachine M { [*] -> A state A A -> Nope }`);
        expect(errors(parsed)).toEqual([`Could not resolve reference to Vertex named 'Nope'.`]);
    });

    test('reloading the same document uses fresh scopes', async () => {
        const { loader } = await import('./helpers.js');
        const first = await loader.load('statemachine M { [*] -> A state A state B A -> B }', 'memory:///same.devm');
        expect(errors(first)).toEqual([]);
        const second = await loader.load('statemachine M { [*] -> A state A state C A -> B }', 'memory:///same.devm');
        expect(errors(second)).toEqual([`Could not resolve reference to Vertex named 'B'.`]);
        const third = await loader.load('statemachine M { [*] -> A state A state B A -> B }', 'memory:///same.devm');
        expect(errors(third)).toEqual([]);
        expect(third.model.transitions[1].target?.ref).toBe(third.model.vertices[1]);
    });

    test('big models link in reasonable time', async () => {
        const states = Array.from({ length: 150 }, (_, i) => `state S${i} { [*] -> T${i} state T${i} { [*] -> U${i} state U${i} } }`).join('\n');
        const transitions = Array.from({ length: 150 }, (_, i) => `U${i} -> T${(i + 1) % 150} S${i} -> U${(i + 7) % 150}`).join('\n');
        const start = Date.now();
        const parsed = await parse(`statemachine Big { [*] -> S0 ${states} ${transitions} }`);
        expect(errors(parsed)).toEqual([]);
        expect(Date.now() - start).toBeLessThan(10000);
    });
});

describe('itemis compatibility extensions', () => {
    test('events as conditions, postfix operators and statechart reactions', async () => {
        const parsed = await parse(`statemachine M {
            interface:
                in event e1
                in event start
                var x : integer = 0
                var b : boolean
            internal:
                const C : integer = 1
            always / x++
            [*] -> A
            state A
            state B
            A -> B : e1, start [e1 && x > 0] / x--; b = start
        }`);
        expect(errors(parsed)).toEqual([]);
    });

    test('postfix operators require numeric variables', async () => {
        const parsed = await parse(`statemachine M {
            interface:
                in event e1
                var b : boolean
                const C : integer = 1
            [*] -> A
            state A
            A -> A : e1 / b++; C--; e1++
        }`);
        const messages = errors(parsed).join('\\n');
        expect(messages).toContain(`'++' requires a numeric variable, but 'b' is boolean.`);
        expect(messages).toContain(`Cannot modify the constant 'C'.`);
        expect(messages).toContain(`'++' can only be applied to a variable.`);
    });

    test('transitions from states without trigger and guard are never taken', async () => {
        const parsed = await parse(`statemachine M {
            interface:
                var x : integer
            [*] -> A
            state A
            state B
            A -> B
            B -> A : [x > 0]
        }`);
        expect(warnings(parsed)).toContain(`Missing trigger: this transition is never taken. Use 'always' or 'oncycle' to take it in every step.`);
        expect(warnings(parsed).filter(w => w.startsWith('Missing trigger'))).toHaveLength(1);
    });
});

describe('null', () => {
    test('null is compatible with strings only', () => {
        expect(isAssignable('string', 'null')).toBe(true);
        expect(isAssignable('integer', 'null')).toBe(false);
        expect(isAssignable('boolean', 'null')).toBe(false);
        expect(commonType('string', 'null')).toBe('string');
        expect(commonType('null', 'null')).toBe('null');
        expect(commonType('integer', 'null')).toBeUndefined();
        expect(binaryResultType('==', 'null', 'null')).toBe('boolean');
        expect(binaryResultType('!=', 'string', 'null')).toBe('boolean');
        expect(binaryResultType('==', 'integer', 'null')).toBeUndefined();
        expect(binaryResultType('+', 'string', 'null')).toBeUndefined();
        expect(isCastable('null', 'string')).toBe(true);
    });

    test('valid uses of null', async () => {
        const parsed = await body('s = null; raise os : null; s = b ? null : "x"', DEFS);
        expect(errors(parsed)).toEqual([]);
        const guarded = await guard('null == null && s != null && null == s');
        expect(errors(guarded)).toEqual([]);
        expect(inferType(expressionOf(await guard('null == null')))).toBe('boolean');
        const initialized = await machine({ definitions: 'var t : string = null' });
        expect(errors(initialized)).toEqual([]);
    });

    test('invalid uses of null', async () => {
        const assigned = await body('i = null');
        expect(errors(assigned)).toEqual([`Type mismatch: a value of type null cannot be assigned to 'i' of type integer.`]);
        const compared = await guard('i == null');
        expect(errors(compared)).toEqual([`Cannot compare a value of type integer with a value of type null.`]);
        const untyped = await machine({ definitions: 'var t = null' });
        expect(errors(untyped)).toContain(`The type of 't' cannot be inferred from 'null'. Declare its type.`);
        const arithmetic = await guard('null + null == null');
        expect(errors(arithmetic).length).toBeGreaterThan(0);
    });
});

describe('type aliases', () => {
    const ALIASES = `
        alias inti : integer
        alias word : string
        alias count : inti
        var myVar : inti = 1
        var myString : word
        var n : count = 3
        out event ev : word
        operation op(p : inti) : count
    `;

    test('aliases resolve to their base types', async () => {
        const parsed = await machine({ definitions: ALIASES, body: 'go / myVar = op(n) + 1; myString = "a"; raise ev : myString' });
        expect(errors(parsed)).toEqual([]);
        const declarations = parsed.model.scopes.flatMap(s => s.declarations);
        const byName = (name: string) => declarations.find(d => d.name === name)!;
        expect(typeOfDeclaration(byName('myVar'))).toBe('integer');
        expect(typeOfDeclaration(byName('myString'))).toBe('string');
        expect(typeOfDeclaration(byName('n'))).toBe('integer');
        expect(typeOfDeclaration(byName('ev'))).toBe('string');
        expect(typeOfDeclaration(byName('count'))).toBe('integer');
        expect(infos(parsed).filter(i => i.startsWith('Type alias'))).toEqual([]);
    });

    test('type checks use the base type', async () => {
        const parsed = await machine({ definitions: ALIASES, body: 'go / myVar = "x"' });
        expect(errors(parsed)).toEqual([`Type mismatch: a value of type string cannot be assigned to 'myVar' of type integer.`]);
        const cast = await machine({ definitions: ALIASES, body: 'go / myVar = 2.5 as inti' });
        expect(errors(cast)).toEqual([]);
    });

    test('aliases of named interfaces', async () => {
        const parsed = await parse(`statemachine M {
            interface T:
                alias Id : integer
            interface:
                var a : T.Id
                var b : Id
            [*] -> A
            state A
        }`);
        expect(errors(parsed)).toEqual([]);
    });

    test('cycles, unknown types, built-in names and unused aliases', async () => {
        const parsed = await machine({ definitions: `
            alias A : B
            alias B : A
            alias integer : real
            alias U : integer
            alias V : void
            var x : A
            var y : V
            var z : Unknown
        ` });
        const messages = errors(parsed);
        expect(messages).toContain(`The type alias 'A' refers to itself.`);
        expect(messages).toContain(`The type alias 'B' refers to itself.`);
        expect(messages).toContain(`The built-in type 'integer' cannot be redefined.`);
        expect(messages).toContain(`The type 'void' can only be used as the return type of an operation.`);
        expect(messages).toContain(`Unknown type 'Unknown'. Known types are integer, real, boolean, string, void and type aliases ('alias Name : type').`);
        expect(infos(parsed)).toContain(`Type alias 'U' is never used.`);
    });

    test('aliases are not values', async () => {
        const parsed = await body('i = inti', ALIASES + DEFS);
        expect(errors(parsed)).toContain(`Could not resolve reference to Declaration named 'inti'.`);
    });
});
