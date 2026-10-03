import * as ast from './generated/ast.js';
import type { CppIntegerType, CppResolvedType } from './cpp-header/model.js';
import { cppTypeOfReference, isCppType, memberOf, referenceMembers, resolveCppValue } from './cpp-types.js';
import { baseTypeReference, inferType, typeOfVariable } from './typesystem.js';

/**
 * Storage types: the C++ type of a place a value is stored in (a variable, a struct member, an array
 * element, an event value, a parameter). They refine the HSM type (`integer` -> `std::uint8_t`):
 * values are converted to the storage type on assignment (integers wrap around to the width,
 * `float` rounds to single precision), like in the generated C++ code.
 */

/** The C++ storage type of a type reference (through aliases), `undefined` for HSM types. */
export function storageOfTypeReference(reference: ast.TypeReference | undefined): CppResolvedType | undefined {
    const base = baseTypeReference(reference);
    return base ? cppTypeOfReference(base)?.resolved : undefined;
}

/** The integer storage type of a type reference (`std::uint8_t`, ...), `undefined` for other types. */
export function integerStorage(reference: ast.TypeReference | undefined): CppIntegerType | undefined {
    const storage = storageOfTypeReference(reference);
    return storage?.kind === 'integer' ? storage : undefined;
}

/** An assignable expression: a variable, optionally followed by members and elements (`pos.x`, `a[i]`, `cfg.gains[1]`). */
export interface LValue {
    /** The variable at the root of the expression. */
    readonly variable: ast.VariableDeclaration;
    /** The element reference to the variable. */
    readonly reference: ast.ElementReference;
    /** Whether the expression accesses a member or element of the variable. */
    readonly partial: boolean;
}

/** The variable an assignable expression stores into, `undefined` if the expression is not assignable. */
export function lvalueOf(expression: ast.Expression | undefined): LValue | undefined {
    let partial = false;
    let current = expression;
    while (ast.isMemberAccessExpression(current) || ast.isIndexExpression(current)) {
        partial = true;
        current = current.receiver;
    }
    if (!ast.isElementReference(current) || current.call) {
        return undefined;
    }
    const variable = current.element.ref;
    if (!ast.isVariableDeclaration(variable)) {
        return undefined;
    }
    return { variable, reference: current, partial: partial || referenceMembers(current).length > 0 };
}

/** The C++ storage type of an assignable expression (`undefined` for HSM typed places). */
export function storageOfTarget(expression: ast.Expression | undefined): CppResolvedType | undefined {
    if (ast.isMemberAccessExpression(expression)) {
        const member = memberOf(inferType(expression.receiver), expression.member);
        return member.field?.type;
    }
    if (ast.isIndexExpression(expression)) {
        const receiver = inferType(expression.receiver);
        return isCppType(receiver) && receiver.resolved.kind === 'array' ? receiver.resolved.element : undefined;
    }
    if (!ast.isElementReference(expression)) {
        return undefined;
    }
    const variable = expression.element.ref;
    if (!ast.isVariableDeclaration(variable)) {
        return undefined;
    }
    let storage = storageOfTypeReference(variable.type);
    let type = typeOfVariable(variable);
    for (const name of referenceMembers(expression)) {
        const member = memberOf(type, name);
        if (member.error) {
            return undefined;
        }
        storage = member.field!.type;
        type = member.type!;
    }
    return storage;
}

/**
 * The value of a constant integer expression (literals, `-` / `+` / `~`, parentheses, C++ integer
 * constants and enumerators of unscoped enums), `undefined` if the expression is not constant.
 */
export function constantInteger(expression: ast.Expression | undefined): bigint | undefined {
    switch (expression?.$type) {
        case 'IntLiteral': {
            const literal = expression as ast.IntLiteral;
            return BigInt(literal.$cstNode?.text ?? literal.value);
        }
        case 'HexLiteral':
            return BigInt((expression as ast.HexLiteral).value);
        case 'ParenthesizedExpression':
            return constantInteger((expression as ast.ParenthesizedExpression).expression);
        case 'UnaryExpression': {
            const unary = expression as ast.UnaryExpression;
            const operand = constantInteger(unary.operand);
            if (operand === undefined) {
                return undefined;
            }
            return unary.operator === '-' ? -operand : unary.operator === '+' ? operand : unary.operator === '~' ? ~operand : undefined;
        }
        case 'CppReference': {
            const resolved = resolveCppValue(expression as ast.CppReference);
            return resolved.type === 'integer' && typeof resolved.info.value === 'bigint' ? resolved.info.value : undefined;
        }
        default:
            return undefined;
    }
}

/** The range of values of an integer type. */
export function integerRange(type: CppIntegerType): [bigint, bigint] {
    const bits = BigInt(type.bits);
    return type.signed ? [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n] : [0n, (1n << bits) - 1n];
}

/** Wraps an integer to the width of an integer type (two's complement). */
export function wrapInteger(value: bigint, type: CppIntegerType): bigint {
    return type.signed ? BigInt.asIntN(type.bits, value) : BigInt.asUintN(type.bits, value);
}

/**
 * A warning text if the constant `value` is out of the range of the integer storage type (it is
 * converted with wrap-around), `undefined` otherwise.
 */
export function rangeWarning(value: bigint, storage: CppResolvedType | undefined, target: string): string | undefined {
    if (storage?.kind !== 'integer') {
        return undefined;
    }
    const [min, max] = integerRange(storage);
    if (value >= min && value <= max) {
        return undefined;
    }
    return `The value ${value} is out of the range of ${storage.cppName} (${min}..${max}) of ${target}; it is converted to ${wrapInteger(value, storage)}.`;
}
