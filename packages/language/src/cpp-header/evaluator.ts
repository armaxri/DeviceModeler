import type {
    CppBinaryOperator, CppDataModel, CppEnumType, CppExpressionNode, CppIntegerType, CppQualifiedName, CppRange,
    CppResolvedType, CppTypeRef, CppValue
} from './model.js';

/**
 * Evaluation of C++ constant expressions with C++ semantics: integers carry their type (width and
 * signedness), the usual arithmetic conversions and integral promotions are applied and results
 * wrap around like in C++ (e.g. `0u - 1` is `0xFFFFFFFF`, `(0u - 1) / 2` is `0x7FFFFFFF`).
 * Division by zero and out of range shifts are errors (they are not constant expressions in C++).
 *
 * @module
 * @internal
 */

/** An evaluated value with its C++ type. */
export type EvalValue =
    | { readonly kind: 'integer'; readonly value: bigint; readonly bits: number; readonly signed: boolean; readonly enumType?: CppEnumType; readonly character?: boolean }
    | { readonly kind: 'real'; readonly value: number; readonly bits: 32 | 64 }
    | { readonly kind: 'boolean'; readonly value: boolean }
    | { readonly kind: 'string'; readonly value: string };

type IntValue = Extract<EvalValue, { kind: 'integer' }>;

/** A constant expression cannot be evaluated. */
export class EvaluationError extends Error {
    constructor(message: string, readonly range?: CppRange) {
        super(message);
    }
}

/** Name resolution and type resolution for the evaluation (implemented by `CppTypeIndex`). */
export interface EvaluationContext {
    readonly dataModel: CppDataModel;
    /** The value of an enumerator or constant; throws an {@link EvaluationError} if there is none. */
    resolveValue(name: CppQualifiedName, range: CppRange): EvalValue;
    resolveType(type: CppTypeRef): CppResolvedType;
    /** The type named by `name`, `undefined` if the name does not denote a type. */
    resolveTypeName(name: CppQualifiedName): CppResolvedType | undefined;
}

export const DEFAULT_DATA_MODEL: CppDataModel = { longBits: 64, pointerBits: 64, charSigned: true };

export function wrapInteger(value: bigint, bits: number, signed: boolean): bigint {
    return signed ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value);
}

export function integerFits(value: bigint, bits: number, signed: boolean): boolean {
    return wrapInteger(value, bits, signed) === value;
}

function int(value: bigint, bits: number, signed: boolean): IntValue {
    return { kind: 'integer', value: wrapInteger(value, bits, signed), bits, signed };
}

/** Integer type description used for literals: `[bits, signed]`. */
type IntKind = readonly [number, boolean];

/** Parses an integer or floating literal (with digit separators and suffixes). */
export function parseNumberLiteral(literal: string, model: CppDataModel): EvalValue {
    const text = literal.replace(/'/g, '');
    const integer = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)([uUlLzZ]*)$/.exec(text);
    if (integer) {
        const digits = integer[1];
        const suffix = integer[2].toLowerCase();
        const decimal = /^[1-9]/.test(digits) || digits === '0';
        const value = /^0[0-7]+$/.test(digits) ? BigInt('0o' + digits.slice(1)) : BigInt(digits.replace(/^0[bB]/, '0b'));
        const L: IntKind = [model.longBits, true];
        const UL: IntKind = [model.longBits, false];
        const LL: IntKind = [64, true];
        const ULL: IntKind = [64, false];
        const I: IntKind = [32, true];
        const U: IntKind = [32, false];
        let candidates: IntKind[];
        const longs = (suffix.match(/l/g) ?? []).length;
        const normalized = /z/.test(suffix) ? (/u/.test(suffix) ? 'uz' : 'z') : 'l'.repeat(longs) + (/u/.test(suffix) ? 'u' : '');
        switch (/^(|u|l|lu|ll|llu|z|uz)$/.test(normalized) && suffix.length === normalized.length ? normalized : '?') {
            case '': candidates = decimal ? [I, L, LL] : [I, U, L, UL, LL, ULL]; break;
            case 'u': candidates = [U, UL, ULL]; break;
            case 'l': candidates = decimal ? [L, LL] : [L, UL, LL, ULL]; break;
            case 'lu': candidates = [UL, ULL]; break;
            case 'll': candidates = decimal ? [LL] : [LL, ULL]; break;
            case 'llu': candidates = [ULL]; break;
            case 'z': candidates = [[model.pointerBits, true]]; break;
            case 'uz': case 'zu': candidates = [[model.pointerBits, false]]; break;
            default: throw new EvaluationError(`invalid integer literal '${literal}'`);
        }
        const kind = candidates.find(([bits, signed]) => integerFits(value, bits, signed));
        if (!kind) {
            throw new EvaluationError(`integer literal '${literal}' is too large`);
        }
        return int(value, kind[0], kind[1]);
    }
    const hexFloat = /^0[xX]([0-9a-fA-F]*)\.?([0-9a-fA-F]*)[pP]([+-]?\d+)([fFlL]?)$/.exec(text);
    if (hexFloat) {
        const mantissa = parseInt((hexFloat[1] || '0') + (hexFloat[2] || ''), 16) / Math.pow(16, hexFloat[2].length);
        return real(mantissa * Math.pow(2, Number(hexFloat[3])), hexFloat[4].toLowerCase() === 'f' ? 32 : 64);
    }
    const float = /^((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([fFlL]?)$/.exec(text);
    if (float && /[.eE]/.test(float[1])) {
        return real(Number(float[1]), float[2].toLowerCase() === 'f' ? 32 : 64);
    }
    throw new EvaluationError(`invalid number literal '${literal}'`);
}

function real(value: number, bits: 32 | 64): EvalValue {
    return { kind: 'real', value: bits === 32 ? Math.fround(value) : value, bits };
}

/** The integer value of a character literal (type `char`, `char8_t`, `char16_t`, `char32_t` or `wchar_t`). */
export function characterValue(prefix: string, codes: readonly number[], model: CppDataModel): EvalValue {
    if (codes.length === 0) {
        throw new EvaluationError('empty character literal');
    }
    if (codes.length > 1) {
        // multi-character literal: `int` with implementation defined value (GCC / Clang: big endian packing)
        const value = codes.reduce((acc, code) => (acc << 8n) | BigInt(code & 0xff), 0n);
        return int(value, 32, true);
    }
    const code = BigInt(codes[0]);
    switch (prefix) {
        case 'u8': return { ...int(code, 8, false), character: true };
        case 'u': return { ...int(code, 16, false), character: true };
        case 'U': return { ...int(code, 32, false), character: true };
        case 'L': return { ...int(code, 32, true), character: true };
        default: return { ...int(code, 8, model.charSigned), character: true };
    }
}

/** Integral promotion: `bool`, small integers and unscoped enums become `int` (or their promoted underlying type). */
function promote(value: EvalValue, range: CppRange, operator: string): IntValue {
    if (value.kind === 'boolean') {
        return int(value.value ? 1n : 0n, 32, true);
    }
    if (value.kind !== 'integer') {
        throw new EvaluationError(`operator '${operator}' cannot be applied to a ${value.kind} value`, range);
    }
    if (value.enumType?.scoped) {
        throw new EvaluationError(`operator '${operator}' cannot be applied to a value of the scoped enum '${value.enumType.cppName}' without a cast`, range);
    }
    if (value.bits < 32) {
        return int(value.value, 32, true);
    }
    return { kind: 'integer', value: value.value, bits: value.bits, signed: value.signed };
}

/** The common type of the usual arithmetic conversions for two promoted integers. */
function commonIntegerKind(a: IntValue, b: IntValue): IntKind {
    if (a.signed === b.signed) {
        return [Math.max(a.bits, b.bits), a.signed];
    }
    const unsigned = a.signed ? b : a;
    const signed = a.signed ? a : b;
    if (unsigned.bits >= signed.bits) {
        return [unsigned.bits, false];
    }
    return [signed.bits, true];
}

function isArithmetic(value: EvalValue): boolean {
    return value.kind === 'integer' || value.kind === 'real' || value.kind === 'boolean';
}

function toNumber(value: EvalValue): number {
    switch (value.kind) {
        case 'integer': return Number(value.value);
        case 'real': return value.value;
        case 'boolean': return value.value ? 1 : 0;
        default: return NaN;
    }
}

/** Contextual conversion to `bool`. */
export function truthy(value: EvalValue, range: CppRange): boolean {
    switch (value.kind) {
        case 'boolean': return value.value;
        case 'integer': return value.value !== 0n;
        case 'real': return value.value !== 0;
        case 'string': return true;
    }
    throw new EvaluationError('value cannot be converted to bool', range);
}

function binary(operator: CppBinaryOperator, left: EvalValue, right: EvalValue, range: CppRange): EvalValue {
    // comparison of values of the same (scoped) enum
    if (left.kind === 'integer' && right.kind === 'integer' && left.enumType && left.enumType === right.enumType
        && ['==', '!=', '<', '<=', '>', '>='].includes(operator)) {
        return { kind: 'boolean', value: compare(operator, left.value, right.value) };
    }
    if (left.kind === 'string' || right.kind === 'string') {
        if (left.kind === 'string' && right.kind === 'string' && (operator === '==' || operator === '!=')) {
            throw new EvaluationError('comparison of string literals compares pointers and is not a constant expression', range);
        }
        throw new EvaluationError(`operator '${operator}' cannot be applied to strings`, range);
    }
    if ((left.kind === 'real' || right.kind === 'real') && isArithmetic(left) && isArithmetic(right)) {
        if (['%', '<<', '>>', '&', '^', '|'].includes(operator)) {
            throw new EvaluationError(`operator '${operator}' cannot be applied to floating point values`, range);
        }
        if (left.kind === 'integer' && left.enumType?.scoped || right.kind === 'integer' && right.enumType?.scoped) {
            throw new EvaluationError(`operator '${operator}' cannot be applied to a scoped enum value without a cast`, range);
        }
        const bits = Math.max(left.kind === 'real' ? left.bits : 0, right.kind === 'real' ? right.bits : 0) as 32 | 64;
        const a = toNumber(left);
        const b = toNumber(right);
        switch (operator) {
            case '+': return real(a + b, bits);
            case '-': return real(a - b, bits);
            case '*': return real(a * b, bits);
            case '/':
                if (b === 0) {
                    throw new EvaluationError('division by zero', range);
                }
                return real(a / b, bits);
            case '&&': return { kind: 'boolean', value: a !== 0 && b !== 0 };
            case '||': return { kind: 'boolean', value: a !== 0 || b !== 0 };
            default: return { kind: 'boolean', value: compareNumbers(operator, a, b) };
        }
    }
    if (operator === '&&' || operator === '||') {
        const a = truthy(left, range);
        const b = truthy(right, range);
        return { kind: 'boolean', value: operator === '&&' ? a && b : a || b };
    }
    const a = promote(left, range, operator);
    const b = promote(right, range, operator);
    if (operator === '<<' || operator === '>>') {
        if (b.value < 0n || b.value >= BigInt(a.bits)) {
            throw new EvaluationError(`shift count ${b.value} is out of range for a ${a.bits} bit value`, range);
        }
        return int(operator === '<<' ? a.value << b.value : a.value >> b.value, a.bits, a.signed);
    }
    const [bits, signed] = commonIntegerKind(a, b);
    const x = wrapInteger(a.value, bits, signed);
    const y = wrapInteger(b.value, bits, signed);
    switch (operator) {
        case '+': return int(x + y, bits, signed);
        case '-': return int(x - y, bits, signed);
        case '*': return int(x * y, bits, signed);
        case '/':
        case '%':
            if (y === 0n) {
                throw new EvaluationError(operator === '/' ? 'division by zero' : 'remainder by zero', range);
            }
            return int(operator === '/' ? x / y : x % y, bits, signed);
        case '&': return int(x & y, bits, signed);
        case '|': return int(x | y, bits, signed);
        case '^': return int(x ^ y, bits, signed);
        default: return { kind: 'boolean', value: compare(operator, x, y) };
    }
}

function compare(operator: string, a: bigint, b: bigint): boolean {
    switch (operator) {
        case '<': return a < b;
        case '<=': return a <= b;
        case '>': return a > b;
        case '>=': return a >= b;
        case '==': return a === b;
        default: return a !== b;
    }
}

function compareNumbers(operator: string, a: number, b: number): boolean {
    switch (operator) {
        case '<': return a < b;
        case '<=': return a <= b;
        case '>': return a > b;
        case '>=': return a >= b;
        case '==': return a === b;
        default: return a !== b;
    }
}

/**
 * Converts a value to a (scalar) type like `static_cast` (explicit) or an implicit conversion.
 * Returns a warning for lossy implicit conversions (narrowing).
 */
export function convertScalar(value: EvalValue, type: CppResolvedType, explicit: boolean, range: CppRange): { value: EvalValue, warning?: string } {
    switch (type.kind) {
        case 'integer':
        case 'enum': {
            const target = type.kind === 'enum' ? type.underlying : type;
            const enumType = type.kind === 'enum' ? type : undefined;
            if (value.kind === 'string') {
                throw new EvaluationError(`a string cannot be converted to '${type.cppName}'`, range);
            }
            if (enumType && !explicit && !(value.kind === 'integer' && value.enumType === enumType)) {
                throw new EvaluationError(`a ${value.kind === 'integer' && value.enumType ? `value of '${value.enumType.cppName}'` : value.kind} cannot be implicitly converted to the enum '${type.cppName}'`, range);
            }
            if (!explicit && value.kind === 'integer' && value.enumType?.scoped && value.enumType !== enumType) {
                throw new EvaluationError(`a value of the scoped enum '${value.enumType.cppName}' cannot be implicitly converted to '${type.cppName}'`, range);
            }
            let integer: bigint;
            let warning: string | undefined;
            if (value.kind === 'real') {
                if (!Number.isFinite(value.value)) {
                    throw new EvaluationError(`${value.value} cannot be converted to '${type.cppName}'`, range);
                }
                integer = BigInt(Math.trunc(value.value));
                if (!explicit) {
                    warning = `conversion from floating point to '${type.cppName}' truncates the value`;
                }
            } else {
                integer = value.kind === 'boolean' ? (value.value ? 1n : 0n) : value.value;
            }
            const wrapped = wrapInteger(integer, target.bits, target.signed);
            if (wrapped !== integer && !explicit) {
                warning = `value ${integer} does not fit into '${type.cppName}' (converted to ${wrapped})`;
            }
            return { value: { kind: 'integer', value: wrapped, bits: target.bits, signed: target.signed, enumType, character: target.character }, warning };
        }
        case 'real':
            if (!isArithmetic(value) || (value.kind === 'integer' && value.enumType?.scoped && !explicit)) {
                throw new EvaluationError(`a ${describe(value)} cannot be converted to '${type.cppName}'`, range);
            }
            return { value: real(toNumber(value), type.bits) };
        case 'boolean':
            if (value.kind === 'string' || (value.kind === 'integer' && value.enumType?.scoped && !explicit)) {
                throw new EvaluationError(`a ${describe(value)} cannot be converted to 'bool'`, range);
            }
            return { value: { kind: 'boolean', value: truthy(value, range) } };
        case 'string':
            if (value.kind !== 'string') {
                throw new EvaluationError(`a ${describe(value)} cannot be converted to '${type.cppName}'`, range);
            }
            return { value };
        default:
            throw new EvaluationError(`cannot convert to '${type.cppName}'${type.kind === 'unsupported' ? ` (${type.reason})` : ''}`, range);
    }
}

function describe(value: EvalValue): string {
    if (value.kind === 'integer' && value.enumType) {
        return `value of the enum '${value.enumType.cppName}'`;
    }
    return `${value.kind} value`;
}

/** Converts an evaluated scalar value to the public value representation. */
export function toCppValue(value: EvalValue): CppValue {
    return value.value;
}

/** The evaluated value of a public integer type. */
export function integerValue(value: bigint, type: CppIntegerType, enumType?: CppEnumType): EvalValue {
    return { kind: 'integer', value: wrapInteger(value, type.bits, type.signed), bits: type.bits, signed: type.signed, enumType };
}

function sizeOf(type: CppResolvedType, range: CppRange): number {
    switch (type.kind) {
        case 'integer': return type.bits / 8;
        case 'real': return type.bits / 8;
        case 'boolean': return 1;
        case 'enum': return type.underlying.bits / 8;
        case 'array':
            if (type.length === undefined) {
                throw new EvaluationError(`the size of '${type.cppName}' is unknown`, range);
            }
            return type.length * sizeOf(type.element, range);
        default:
            throw new EvaluationError(`the size of '${type.cppName}' is not known to the analyzer`, range);
    }
}

const FLOAT_MAX = 3.4028234663852886e38;
const FLOAT_MIN = 1.1754943508222875e-38;
const DOUBLE_MIN = 2.2250738585072014e-308;

/** `std::numeric_limits<T>::max()` / `min()` / `lowest()` / `epsilon()`. */
function numericLimit(type: CppResolvedType, member: string, range: CppRange): EvalValue {
    const target = type.kind === 'enum' ? undefined : type;
    if (target?.kind === 'integer') {
        const max = target.signed ? (1n << BigInt(target.bits - 1)) - 1n : (1n << BigInt(target.bits)) - 1n;
        const min = target.signed ? -(1n << BigInt(target.bits - 1)) : 0n;
        switch (member) {
            case 'max': return int(max, target.bits, target.signed);
            case 'min':
            case 'lowest': return int(min, target.bits, target.signed);
        }
    } else if (target?.kind === 'real') {
        const max = target.bits === 32 ? FLOAT_MAX : Number.MAX_VALUE;
        switch (member) {
            case 'max': return real(max, target.bits);
            case 'lowest': return real(-max, target.bits);
            case 'min': return real(target.bits === 32 ? FLOAT_MIN : DOUBLE_MIN, target.bits);
            case 'epsilon': return real(target.bits === 32 ? Math.pow(2, -23) : Number.EPSILON, target.bits);
        }
    } else if (target?.kind === 'boolean') {
        switch (member) {
            case 'max': return { kind: 'boolean', value: true };
            case 'min':
            case 'lowest': return { kind: 'boolean', value: false };
        }
    }
    throw new EvaluationError(`std::numeric_limits<${type.cppName}>::${member}() is not supported`, range);
}

/**
 * Evaluates a constant expression to a scalar value. Throws an {@link EvaluationError} for
 * expressions that are not constant (function calls, non-constant names) or not supported.
 */
export function evaluateExpression(node: CppExpressionNode, context: EvaluationContext): EvalValue {
    switch (node.kind) {
        case 'number':
            try {
                return parseNumberLiteral(node.text, context.dataModel);
            } catch (error) {
                throw error instanceof EvaluationError ? new EvaluationError(error.message, node.range) : error;
            }
        case 'char':
            try {
                return characterValue(node.prefix, node.codes, context.dataModel);
            } catch (error) {
                throw error instanceof EvaluationError ? new EvaluationError(error.message, node.range) : error;
            }
        case 'string':
            return { kind: 'string', value: node.value };
        case 'boolean':
            return { kind: 'boolean', value: node.value };
        case 'nullptr':
            throw new EvaluationError('nullptr is not supported', node.range);
        case 'name':
            return context.resolveValue(node.name, node.range);
        case 'unary': {
            const operand = evaluateExpression(node.operand, context);
            if (node.operator === '!') {
                if (operand.kind === 'integer' && operand.enumType?.scoped) {
                    throw new EvaluationError(`operator '!' cannot be applied to a scoped enum value without a cast`, node.range);
                }
                return { kind: 'boolean', value: !truthy(operand, node.range) };
            }
            if (operand.kind === 'real' && node.operator !== '~') {
                return real(node.operator === '-' ? -operand.value : operand.value, operand.bits);
            }
            const value = promote(operand, node.range, node.operator);
            switch (node.operator) {
                case '-': return int(-value.value, value.bits, value.signed);
                case '~': return int(~value.value, value.bits, value.signed);
                default: return value;
            }
        }
        case 'binary': {
            const left = evaluateExpression(node.left, context);
            if (node.operator === '&&' || node.operator === '||') {
                const decided = truthy(left, node.left.range);
                if (node.operator === '&&' ? !decided : decided) {
                    return { kind: 'boolean', value: decided };
                }
            }
            return binary(node.operator, left, evaluateExpression(node.right, context), node.range);
        }
        case 'conditional':
            return truthy(evaluateExpression(node.condition, context), node.condition.range)
                ? evaluateExpression(node.whenTrue, context)
                : evaluateExpression(node.whenFalse, context);
        case 'cast': {
            const type = context.resolveType(node.type);
            return convertScalar(evaluateExpression(node.operand, context), type, true, node.range).value;
        }
        case 'call': {
            const callee = node.callee;
            if (callee.kind === 'name') {
                const parts = callee.name.parts;
                const limits = parts.length >= 2 ? parts[parts.length - 2] : undefined;
                if (limits?.name === 'numeric_limits' && node.arguments.length === 0) {
                    const argument = limits.templateArguments?.[0];
                    const type = argument?.type ? context.resolveType(argument.type)
                        : argument?.expression?.node.kind === 'name' ? context.resolveTypeName(argument.expression.node.name) : undefined;
                    if (!type) {
                        throw new EvaluationError(`unknown type in '${argument?.text ?? ''}'`, node.range);
                    }
                    return numericLimit(type, parts[parts.length - 1].name, node.range);
                }
                const type = context.resolveTypeName(callee.name);
                if (type) {
                    if (node.arguments.length === 0) {
                        return zeroValue(type, node.range);
                    }
                    if (node.arguments.length === 1) {
                        const value = evaluateExpression(node.arguments[0], context);
                        const converted = convertScalar(value, type, !node.braces, node.range);
                        if (node.braces && converted.warning) {
                            throw new EvaluationError(`narrowing conversion: ${converted.warning}`, node.range);
                        }
                        return converted.value;
                    }
                }
            }
            throw new EvaluationError('function calls are not supported in constant expressions', node.range);
        }
        case 'sizeof': {
            if (!node.type) {
                throw new EvaluationError(`${node.operator} of an expression is not supported`, node.range);
            }
            const type = context.resolveType(node.type);
            const size = sizeOf(type, node.range);
            return int(BigInt(node.operator === 'alignof' && type.kind === 'array' ? sizeOf(type.element, node.range) : size), context.dataModel.pointerBits, false);
        }
        case 'initializerList':
            if (node.elements.length === 1 && !node.elements[0].designator) {
                return evaluateExpression(node.elements[0].value, context);
            }
            throw new EvaluationError('an initializer list is not a scalar value', node.range);
        case 'member':
            throw new EvaluationError('member access is not supported in constant expressions', node.range);
        case 'unsupported':
            throw new EvaluationError(`unsupported expression '${node.text}'`, node.range);
    }
}

/** The value-initialized (`T{}`) value of a scalar type. */
export function zeroValue(type: CppResolvedType, range: CppRange): EvalValue {
    switch (type.kind) {
        case 'integer': return int(0n, type.bits, type.signed);
        case 'enum': return { kind: 'integer', value: 0n, bits: type.underlying.bits, signed: type.underlying.signed, enumType: type };
        case 'real': return real(0, type.bits);
        case 'boolean': return { kind: 'boolean', value: false };
        case 'string': return { kind: 'string', value: '' };
        default: throw new EvaluationError(`'${type.cppName}' is not a scalar type`, range);
    }
}
