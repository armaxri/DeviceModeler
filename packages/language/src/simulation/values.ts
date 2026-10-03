import type { AstNode } from 'langium';
import type { TypeReference } from '../generated/ast.js';
import { typeOfTypeReference } from '../typesystem.js';
import { devmTypeOfCpp, isCppType, type CppDevmType } from '../cpp-types.js';
import { storageOfTypeReference, wrapInteger } from '../cpp-storage.js';
import type { CppEnumType, CppIntegerType, CppRealType, CppResolvedType, CppValue } from '../cpp-header/model.js';
import type { CppTypeIndex } from '../cpp-header/type-index.js';
import { SimulationError } from './errors.js';

/**
 * Runtime value inside the interpreter. Integers are represented as `bigint` (64-bit signed,
 * wrapping on overflow), reals as `number`, so the two kinds stay distinguishable at run time.
 * Values of imported C++ enum, struct and array types are {@link EnumValue}, {@link StructValue}
 * and {@link ArrayValue}; they are immutable (an assignment to a member creates a new struct value),
 * so values are never shared between variables.
 */
export type Value = bigint | number | boolean | string | EnumValue | StructValue | ArrayValue;

/** A value of a C++ enum type: the numeric value of the enumerator (as in C++) and the enum type. */
export class EnumValue {
    constructor(readonly type: CppDevmType, readonly value: bigint) { }

    get enumType(): CppEnumType {
        return this.type.resolved as CppEnumType;
    }

    /** The first enumerator with this value (`undefined` if the value has no enumerator). */
    get enumerator(): string | undefined {
        return this.enumType.enumerators.find(e => e.value === this.value)?.name;
    }

    /** `motor::Mode::Fast`, or `motor::Mode(7)` for a value without enumerator. */
    toString(): string {
        const enumerator = this.enumerator;
        return enumerator !== undefined ? `${this.type.cppName}::${enumerator}` : `${this.type.cppName}(${this.value})`;
    }
}

/** A value of a C++ struct type: the values of its members in declaration order. */
export class StructValue {
    constructor(readonly type: CppDevmType, readonly fields: ReadonlyMap<string, Value>) { }

    /** A copy with the member `name` replaced. */
    with(name: string, value: Value): StructValue {
        const fields = new Map(this.fields);
        fields.set(name, value);
        return new StructValue(this.type, fields);
    }
}

/** A value of a C++ array type (`std::array<T, N>`, `T[N]`). */
export class ArrayValue {
    constructor(readonly type: CppDevmType, readonly elements: readonly Value[]) { }

    /** A copy with the element `index` replaced. */
    with(index: number, value: Value): ArrayValue {
        const elements = [...this.elements];
        elements[index] = value;
        return new ArrayValue(this.type, elements);
    }
}

/**
 * Value exchanged with the host (API, callbacks, scenarios): integers are converted to JS numbers
 * (exact up to 2^53), enum values to the qualified name of the enumerator (`"motor::Mode::Fast"`,
 * the number if the value has no enumerator), structs to plain objects and arrays to arrays.
 */
export type HostValue = number | boolean | string | HostValue[] | { [member: string]: HostValue };

/** Built-in type names of the language. */
export type TypeName = 'integer' | 'real' | 'boolean' | 'string' | 'void';

/**
 * The type of a value at run time: a built-in type, a C++ enum / struct / array type, or a C++
 * integer or floating point type (the storage type of a variable, member, event value or parameter:
 * integers wrap around to its width, `float` rounds to single precision).
 */
export type RuntimeType = TypeName | CppDevmType | CppIntegerType | CppRealType;

const TYPE_NAMES: readonly string[] = ['integer', 'real', 'boolean', 'string', 'void'];

/** Whether a runtime type is an integer type (`integer` or a C++ integer storage type). */
export function isIntegerType(type: RuntimeType | undefined): boolean {
    return type === 'integer' || (isStorage(type) && type.kind === 'integer');
}

function isStorage(type: RuntimeType | undefined): type is CppIntegerType | CppRealType {
    return typeof type === 'object' && !isCppType(type);
}

/** The built-in type underlying a runtime type (`integer` for C++ integer types, ...), `undefined` for C++ enum / struct / array types. */
export function baseTypeName(type: RuntimeType | undefined): TypeName | undefined {
    if (type === undefined || typeof type === 'string') {
        return type;
    }
    return isCppType(type) ? undefined : type.kind;
}

/**
 * The runtime type named by a type reference, type aliases resolved (`undefined` for a missing or
 * unknown type). C++ integer types of imported headers yield their storage type.
 */
export function declaredType(ref: TypeReference | undefined): RuntimeType | undefined {
    if (!ref) {
        return undefined;
    }
    const type = typeOfTypeReference(ref);
    if (isCppType(type)) {
        return type;
    }
    if (typeof type !== 'string' || !TYPE_NAMES.includes(type)) {
        return undefined;
    }
    const storage = storageOfTypeReference(ref);
    if (storage?.kind === 'integer' && type === 'integer') {
        return storage;
    }
    if (storage?.kind === 'real' && type === 'real' && storage.bits === 32) {
        return storage;
    }
    return type as TypeName;
}

/** The runtime type of a resolved C++ type (e.g. of a struct member or array element). */
export function runtimeTypeOfCpp(resolved: CppResolvedType, index: CppTypeIndex): RuntimeType | undefined {
    switch (resolved.kind) {
        case 'integer':
            return resolved;
        case 'real':
            return resolved.bits === 32 ? resolved : 'real';
        case 'boolean':
        case 'string':
            return resolved.kind;
        default: {
            const mapping = devmTypeOfCpp(resolved, index);
            return isCppType(mapping.type) ? mapping.type : undefined;
        }
    }
}

/** Default value of a type: `0`, `0.0`, `false`, `""`, `T{}` for C++ types; `undefined` for `void`. Untyped: integer `0`. */
export function defaultValueOf(type: RuntimeType | undefined): Value | undefined {
    if (isCppType(type)) {
        const value = type.index.defaultValue(type.resolved);
        if (value === undefined) {
            throw new SimulationError(`The C++ type '${type.cppName}' has no default value`);
        }
        return fromCppValue(value, type);
    }
    switch (baseTypeName(type)) {
        case 'real': return 0;
        case 'boolean': return false;
        case 'string': return '';
        case 'void': return undefined;
        default: return 0n;
    }
}

/** Converts a value of the C++ header analyzer (constant, default value) to a runtime value of the given type. */
export function fromCppValue(value: CppValue, type: RuntimeType | undefined): Value {
    if (isCppType(type)) {
        const resolved = type.resolved;
        switch (resolved.kind) {
            case 'enum':
                return new EnumValue(type, typeof value === 'bigint' ? value : BigInt(value as number));
            case 'struct': {
                const object = value as Record<string, CppValue>;
                const fields = new Map<string, Value>();
                for (const field of resolved.fields) {
                    const fieldType = runtimeTypeOfCpp(field.type, type.index);
                    const fieldValue = object[field.name] ?? type.index.defaultValue(field.type);
                    fields.set(field.name, fieldValue === undefined ? defaultValueOf(fieldType)! : fromCppValue(fieldValue, fieldType));
                }
                return new StructValue(type, fields);
            }
            case 'array': {
                const elementType = runtimeTypeOfCpp(resolved.element, type.index);
                const elements = (value as readonly CppValue[]).map(e => fromCppValue(e, elementType));
                while (elements.length < (resolved.length ?? 0)) {
                    elements.push(defaultValueOf(elementType)!);
                }
                return new ArrayValue(type, elements);
            }
        }
    }
    if (isStorage(type) && type.kind === 'real' && typeof value === 'number') {
        return Math.fround(value);
    }
    if (baseTypeName(type) === 'real' && typeof value === 'bigint') {
        return Number(value);
    }
    if (typeof value === 'bigint') {
        return isStorage(type) && type.kind === 'integer' ? wrapInteger(value, type) : int64(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
        return value;
    }
    throw new SimulationError(`Unsupported constant value ${String(value)}`);
}

/** The type of a runtime value (C++ values: the name of their type). */
export function typeOfValue(value: Value | undefined): string {
    if (value instanceof EnumValue || value instanceof StructValue || value instanceof ArrayValue) {
        return value.type.cppName;
    }
    switch (typeof value) {
        case 'bigint': return 'integer';
        case 'number': return 'real';
        case 'boolean': return 'boolean';
        case 'string': return 'string';
        default: return 'void';
    }
}

/** The runtime type of a value (for variables whose type is inferred from the initial value). */
export function runtimeTypeOfValue(value: Value | undefined): RuntimeType | undefined {
    if (value instanceof EnumValue || value instanceof StructValue || value instanceof ArrayValue) {
        return value.type;
    }
    const type = typeOfValue(value);
    return type === 'void' ? undefined : type as TypeName;
}

/** Human readable name of a runtime type. */
export function runtimeTypeName(type: RuntimeType | undefined): string {
    if (type === undefined) {
        return 'value';
    }
    return typeof type === 'string' ? type : type.cppName;
}

/** Wraps an integer to 64 bits (two's complement). */
export function int64(value: bigint): bigint {
    return BigInt.asIntN(64, value);
}

/** The integer value of an integer or of an unscoped enum value (which converts to integer, as in C++); `undefined` otherwise. */
export function integerOf(value: Value | undefined): bigint | undefined {
    if (typeof value === 'bigint') {
        return value;
    }
    return value instanceof EnumValue && !value.enumType.scoped ? value.value : undefined;
}

/** Converts a runtime value for the host. */
export function toHost(value: Value | undefined): HostValue | undefined {
    if (value instanceof EnumValue) {
        return value.enumerator !== undefined ? value.toString() : Number(value.value);
    }
    if (value instanceof StructValue) {
        const result: { [member: string]: HostValue } = {};
        for (const [name, field] of value.fields) {
            result[name] = toHost(field)!;
        }
        return result;
    }
    if (value instanceof ArrayValue) {
        return value.elements.map(e => toHost(e)!);
    }
    return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * Converts a value given by the host (API call, operation callback, scenario) to the given type.
 * JS numbers are accepted for integers if they are integral; enum values as the (qualified) name of
 * an enumerator or its number, structs as objects (missing members get their default value),
 * arrays as arrays.
 */
export function fromHost(value: unknown, type: RuntimeType | undefined, what: string, node?: AstNode): Value | undefined {
    if (value === undefined || value === null) {
        return baseTypeName(type) === 'void' ? undefined : defaultValueOf(type);
    }
    if (isCppType(type)) {
        return cppFromHost(value, type, what, node);
    }
    switch (baseTypeName(type)) {
        case 'integer': {
            let integer: bigint | undefined;
            if (typeof value === 'bigint') {
                integer = value;
            } else if (typeof value === 'number' && Number.isInteger(value)) {
                integer = BigInt(value);
            } else if (value instanceof EnumValue && !value.enumType.scoped) {
                integer = value.value;
            }
            if (integer !== undefined) {
                return isStorage(type) && type.kind === 'integer' ? wrapInteger(integer, type) : int64(integer);
            }
            break;
        }
        case 'real':
            if (typeof value === 'number' || typeof value === 'bigint') {
                return isStorage(type) ? Math.fround(Number(value)) : Number(value);
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
            if (typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'string'
                || value instanceof EnumValue || value instanceof StructValue || value instanceof ArrayValue) {
                return value;
            }
    }
    throw new SimulationError(`${what}: ${describeHost(value)} is not a valid ${runtimeTypeName(type)}`, node);
}

function cppFromHost(value: unknown, type: CppDevmType, what: string, node?: AstNode): Value {
    const invalid = () => new SimulationError(`${what}: ${describeHost(value)} is not a valid ${type.cppName}`, node);
    if ((value instanceof EnumValue || value instanceof StructValue || value instanceof ArrayValue)) {
        if (value.type.cppName === type.cppName && value.type.kind === type.kind) {
            return value;
        }
        throw invalid();
    }
    const resolved = type.resolved;
    switch (resolved.kind) {
        case 'enum': {
            if (typeof value === 'string') {
                const name = value.trim();
                const simple = name.startsWith(`${type.cppName}::`) ? name.slice(type.cppName.length + 2) : name;
                const enumerator = resolved.enumerators.find(e => e.name === simple || e.qualifiedName === name.replace(/^::/, ''));
                if (enumerator) {
                    return new EnumValue(type, enumerator.value);
                }
                const numeric = /^(?:.*\()?(-?\d+)\)?$/.exec(name);
                if (numeric) {
                    return new EnumValue(type, BigInt(numeric[1]));
                }
                throw new SimulationError(`${what}: '${value}' is not an enumerator of ${type.cppName} (${resolved.enumerators.map(e => e.name).join(', ')})`, node);
            }
            if (typeof value === 'number' && Number.isInteger(value)) {
                return new EnumValue(type, BigInt(value));
            }
            if (typeof value === 'bigint') {
                return new EnumValue(type, value);
            }
            throw invalid();
        }
        case 'struct': {
            if (typeof value !== 'object' || Array.isArray(value)) {
                throw invalid();
            }
            const object = value as Record<string, unknown>;
            const unknown = Object.keys(object).filter(key => !resolved.fields.some(f => f.name === key));
            if (unknown.length > 0) {
                throw new SimulationError(`${what}: ${type.cppName} has no member ${unknown.map(k => `'${k}'`).join(', ')}`, node);
            }
            const defaults = defaultValueOf(type) as StructValue;
            const fields = new Map<string, Value>();
            for (const field of resolved.fields) {
                const fieldType = runtimeTypeOfCpp(field.type, type.index);
                fields.set(field.name, field.name in object
                    ? fromHost(object[field.name], fieldType, `${what}, member '${field.name}'`, node)!
                    : defaults.fields.get(field.name)!);
            }
            return new StructValue(type, fields);
        }
        case 'array': {
            if (!Array.isArray(value)) {
                throw invalid();
            }
            const length = resolved.length ?? 0;
            if (value.length > length) {
                throw new SimulationError(`${what}: ${type.cppName} has ${length} elements, but ${value.length} are given`, node);
            }
            const elementType = runtimeTypeOfCpp(resolved.element, type.index);
            const elements = value.map((e, i) => fromHost(e, elementType, `${what}, element ${i}`, node)!);
            while (elements.length < length) {
                elements.push(defaultValueOf(elementType)!);
            }
            return new ArrayValue(type, elements);
        }
    }
}

function describeHost(value: unknown): string {
    try {
        return typeof value === 'bigint' ? value.toString() : JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

/**
 * Converts a value computed by the state machine for an assignment, an argument or an event value
 * of the given type. Implicit conversions: `integer` -> `real`, unscoped enum -> `integer` / `real`;
 * values of C++ integer types wrap around to the width of the type, `float` rounds to single precision.
 */
export function convert(value: Value | undefined, type: RuntimeType | undefined, what: string, node?: AstNode): Value | undefined {
    if (type === undefined) {
        return value;
    }
    if (type === 'void') {
        return undefined;
    }
    if (isCppType(type)) {
        if ((value instanceof EnumValue || value instanceof StructValue || value instanceof ArrayValue) && value.type.cppName === type.cppName) {
            return value;
        }
        throw new SimulationError(`${what}: cannot convert ${typeOfValue(value)} value ${formatValue(value)} to ${type.cppName}`, node);
    }
    const base = baseTypeName(type)!;
    if (base === 'integer') {
        const integer = integerOf(value);
        if (integer !== undefined) {
            return isStorage(type) && type.kind === 'integer' ? wrapInteger(integer, type) : integer;
        }
    } else if (base === 'real') {
        const number = typeof value === 'number' ? value : integerOf(value) !== undefined ? Number(integerOf(value)) : undefined;
        if (number !== undefined) {
            return isStorage(type) ? Math.fround(number) : number;
        }
    } else if (typeOfValue(value) === base) {
        return value;
    }
    throw new SimulationError(`${what}: cannot convert ${typeOfValue(value)} value ${formatValue(value)} to ${runtimeTypeName(type)}`, node);
}

/**
 * Canonical text of a value, used in traces and scenarios: integers `42`, reals always with a
 * decimal point or exponent (`2.0`, `0.5`, `1e+21`), booleans `true`, strings as JSON strings,
 * enum values `motor::Mode::Fast` (`motor::Mode(7)` without enumerator), structs `{x: 1, y: 2}`,
 * arrays `[1, 2, 3]`.
 */
export function formatValue(value: Value | undefined): string {
    if (value instanceof EnumValue) {
        return value.toString();
    }
    if (value instanceof StructValue) {
        return `{${[...value.fields].map(([name, field]) => `${name}: ${formatValue(field)}`).join(', ')}}`;
    }
    if (value instanceof ArrayValue) {
        return `[${value.elements.map(formatValue).join(', ')}]`;
    }
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

/** Whether two runtime values are equal (numbers across integer / real, enum values by type and value, structs member-wise). */
export function valuesEqual(left: Value, right: Value): boolean {
    if (left instanceof EnumValue && right instanceof EnumValue) {
        return left.type.cppName === right.type.cppName && left.value === right.value;
    }
    if (left instanceof StructValue && right instanceof StructValue) {
        return left.type.cppName === right.type.cppName && [...left.fields].every(([name, field]) => valuesEqual(field, right.fields.get(name)!));
    }
    if (left instanceof ArrayValue && right instanceof ArrayValue) {
        return left.elements.length === right.elements.length && left.elements.every((e, i) => valuesEqual(e, right.elements[i]));
    }
    const a = integerOf(left) ?? left;
    const b = integerOf(right) ?? right;
    if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number')) {
        return typeof a === typeof b ? a === b : Number(a) === Number(b);
    }
    return a === b;
}
