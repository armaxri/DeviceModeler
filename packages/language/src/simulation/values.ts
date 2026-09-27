import type { AstNode } from 'langium';
import type { TypeReference } from '../generated/ast.js';
import { SimulationError } from './errors.js';

/**
 * Runtime value inside the interpreter. Integers are represented as `bigint` (64-bit signed,
 * wrapping on overflow), reals as `number`, so the two kinds stay distinguishable at run time.
 */
export type Value = bigint | number | boolean | string;

/**
 * Value exchanged with the host (API, callbacks, scenarios): integers are converted to JS numbers
 * (exact up to 2^53).
 */
export type HostValue = number | boolean | string;

/** Built-in type names of the language. */
export type TypeName = 'integer' | 'real' | 'boolean' | 'string' | 'void';

const TYPE_NAMES: readonly string[] = ['integer', 'real', 'boolean', 'string', 'void'];

/** The built-in type named by a type reference (`undefined` for a missing or unknown type). */
export function declaredType(ref: TypeReference | undefined): TypeName | undefined {
    return ref && TYPE_NAMES.includes(ref.name) ? ref.name as TypeName : undefined;
}

/** Default value of a type: `0`, `0.0`, `false`, `""`; `undefined` for `void`. Untyped: integer `0`. */
export function defaultValueOf(type: TypeName | undefined): Value | undefined {
    switch (type) {
        case 'real': return 0;
        case 'boolean': return false;
        case 'string': return '';
        case 'void': return undefined;
        default: return 0n;
    }
}

/** The type of a runtime value. */
export function typeOfValue(value: Value | undefined): TypeName {
    switch (typeof value) {
        case 'bigint': return 'integer';
        case 'number': return 'real';
        case 'boolean': return 'boolean';
        case 'string': return 'string';
        default: return 'void';
    }
}

/** Wraps an integer to 64 bits (two's complement). */
export function int64(value: bigint): bigint {
    return BigInt.asIntN(64, value);
}

/** Converts a runtime value for the host. */
export function toHost(value: Value | undefined): HostValue | undefined {
    return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * Converts a value given by the host (API call, operation callback, scenario) to the given type.
 * JS numbers are accepted for integers if they are integral.
 */
export function fromHost(value: unknown, type: TypeName | undefined, what: string, node?: AstNode): Value | undefined {
    if (value === undefined || value === null) {
        return type === 'void' ? undefined : defaultValueOf(type);
    }
    switch (type) {
        case 'integer':
            if (typeof value === 'bigint') {
                return int64(value);
            }
            if (typeof value === 'number' && Number.isInteger(value)) {
                return int64(BigInt(value));
            }
            break;
        case 'real':
            if (typeof value === 'number') {
                return value;
            }
            if (typeof value === 'bigint') {
                return Number(value);
            }
            break;
        case 'boolean':
            if (typeof value === 'boolean') {
                return value;
            }
            break;
        case 'string':
            if (typeof value === 'string') {
                return value;
            }
            break;
        case 'void':
            return undefined;
        default:
            if (typeof value === 'number') {
                return Number.isInteger(value) ? int64(BigInt(value)) : value;
            }
            if (typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'string') {
                return value;
            }
    }
    throw new SimulationError(`${what}: ${JSON.stringify(String(value))} is not a valid ${type ?? 'value'}`, node);
}

/**
 * Converts a value computed by the state machine for an assignment, an argument or an event value
 * of the given type. Only the implicit conversion `integer` -> `real` is allowed.
 */
export function convert(value: Value | undefined, type: TypeName | undefined, what: string, node?: AstNode): Value | undefined {
    if (type === undefined) {
        return value;
    }
    if (type === 'void') {
        return undefined;
    }
    const actual = typeOfValue(value);
    if (actual === type) {
        return value;
    }
    if (type === 'real' && actual === 'integer') {
        return Number(value);
    }
    throw new SimulationError(`${what}: cannot convert ${actual} value ${formatValue(value)} to ${type}`, node);
}

/**
 * Canonical text of a value, used in traces and scenarios: integers `42`, reals always with a
 * decimal point or exponent (`2.0`, `0.5`, `1e+21`), booleans `true`, strings as JSON strings.
 */
export function formatValue(value: Value | undefined): string {
    switch (typeof value) {
        case 'bigint':
            return value.toString();
        case 'number': {
            const text = String(value);
            return /^-?\d+$/.test(text) ? `${text}.0` : text;
        }
        case 'string':
            return JSON.stringify(value);
        case 'boolean':
            return String(value);
        default:
            return 'void';
    }
}

/** `name` or `name(arg1, arg2)` with canonically formatted values. */
export function formatCall(name: string, values: ReadonlyArray<Value | undefined>): string {
    return values.length === 0 ? name : `${name}(${values.map(formatValue).join(', ')})`;
}
