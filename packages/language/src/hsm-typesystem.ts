import type { AstNode } from 'langium';
import * as ast from './generated/ast.js';

/**
 * Type system of the HSM language (the statechart language of itemis CREATE).
 *
 * Types are identified by their name. `error` is an internal type which is used for expressions
 * whose type cannot be determined (unresolved references, invalid operands, unknown type names).
 * It is compatible with every type, so an error is reported only once and does not cascade.
 */
export type HsmType = 'integer' | 'real' | 'boolean' | 'string' | 'void' | 'error';

/** The types that can be referenced by name in a model. */
export const BUILTIN_TYPES: readonly HsmType[] = ['integer', 'real', 'boolean', 'string', 'void'];

export type BinaryOperator = ast.BinaryExpression['operator'];
export type UnaryOperator = ast.UnaryExpression['operator'];

/** Effective direction of an event: events of interfaces without direction are `in` events. */
export type EventDirection = 'in' | 'out' | 'internal';

/** The type with the given name, `undefined` for unknown names. */
export function resolveTypeName(name: string | undefined): HsmType | undefined {
    return name !== undefined && (BUILTIN_TYPES as readonly string[]).includes(name) ? name as HsmType : undefined;
}

/** The type denoted by a type reference; unknown type names (and missing references) yield `error`. */
export function typeOfTypeReference(reference: ast.TypeReference | undefined): HsmType {
    return resolveTypeName(reference?.name) ?? 'error';
}

export function isNumeric(type: HsmType): boolean {
    return type === 'integer' || type === 'real';
}

/** `error` is compatible with everything; the caller has reported the problem before. */
export function isError(type: HsmType): boolean {
    return type === 'error';
}

/**
 * Whether a value of type `source` can be assigned to a variable (parameter, event) of type `target`.
 * The only implicit conversion is `integer` -> `real`.
 */
export function isAssignable(target: HsmType, source: HsmType): boolean {
    if (target === 'error' || source === 'error') {
        return true;
    }
    return target === source || (target === 'real' && source === 'integer');
}

/** The common type of two types (used for the branches of `?:`), `undefined` if they are incompatible. */
export function commonType(a: HsmType, b: HsmType): HsmType | undefined {
    if (a === 'error' || b === 'error') {
        return 'error';
    }
    if (a === b) {
        return a;
    }
    if (isNumeric(a) && isNumeric(b)) {
        return 'real';
    }
    return undefined;
}

/** Whether values of the two types can be compared with `==` / `!=`. */
export function isComparable(a: HsmType, b: HsmType): boolean {
    return commonType(a, b) !== undefined && a !== 'void' && b !== 'void';
}

/** Whether a value of type `source` can be cast to `target` with `as`. */
export function isCastable(source: HsmType, target: HsmType): boolean {
    return isError(source) || isError(target) || source === target || (isNumeric(source) && isNumeric(target));
}

/**
 * The result type of a binary operation, `undefined` if the operator cannot be applied to operands
 * of the given types. Operands of type `error` yield the result type of the operator if it is
 * independent of the operands, `error` otherwise.
 */
export function binaryResultType(operator: BinaryOperator, left: HsmType, right: HsmType): HsmType | undefined {
    const unknown = isError(left) || isError(right);
    switch (operator) {
        case '&&':
        case '||':
            return unknown || (left === 'boolean' && right === 'boolean') ? 'boolean' : undefined;
        case '|':
        case '^':
        case '&':
        case '<<':
        case '>>':
        case '%':
            return unknown || (left === 'integer' && right === 'integer') ? 'integer' : undefined;
        case '==':
        case '!=':
            return unknown || isComparable(left, right) ? 'boolean' : undefined;
        case '<':
        case '<=':
        case '>':
        case '>=':
            return unknown || (isNumeric(left) && isNumeric(right)) ? 'boolean' : undefined;
        case '+':
            return left === 'string' && right === 'string' ? 'string' : arithmeticResultType(left, right);
        case '-':
        case '*':
        case '/':
            return arithmeticResultType(left, right);
    }
}

function arithmeticResultType(left: HsmType, right: HsmType): HsmType | undefined {
    if (isError(left) || isError(right)) {
        return 'error';
    }
    if (isNumeric(left) && isNumeric(right)) {
        return left === 'integer' && right === 'integer' ? 'integer' : 'real';
    }
    return undefined;
}

/** The result type of a unary operation, `undefined` if the operator cannot be applied to the operand. */
export function unaryResultType(operator: UnaryOperator, operand: HsmType): HsmType | undefined {
    switch (operator) {
        case '!':
            return isError(operand) || operand === 'boolean' ? 'boolean' : undefined;
        case '~':
            return isError(operand) || operand === 'integer' ? 'integer' : undefined;
        case '-':
        case '+':
            return isError(operand) || isNumeric(operand) ? operand : undefined;
    }
}

/**
 * The binary operator of a compound assignment (`+=` -> `+`), `undefined` for `=`.
 */
export function compoundOperator(operator: ast.AssignmentOperator): BinaryOperator | undefined {
    return operator === '=' ? undefined : operator.slice(0, -1) as BinaryOperator;
}

/** Declared or inferred type of a variable or constant (`error` if neither is possible). */
export function typeOfVariable(variable: ast.VariableDeclaration): HsmType {
    return declarationType(variable, new Set());
}

/** Return type of an operation (`void` if no return type is declared). */
export function returnTypeOf(operation: ast.OperationDeclaration): HsmType {
    return operation.returnType ? typeOfTypeReference(operation.returnType) : 'void';
}

/** Type of the value of an event (`void` for events without type). */
export function typeOfEvent(event: ast.EventDeclaration): HsmType {
    return event.type ? typeOfTypeReference(event.type) : 'void';
}

/** Type of a parameter. */
export function typeOfParameter(parameter: ast.Parameter): HsmType {
    return typeOfTypeReference(parameter.type);
}

/**
 * Type of a declaration: the type of a variable, the return type of an operation or the value type
 * of an event.
 */
export function typeOfDeclaration(declaration: ast.Declaration): HsmType {
    if (ast.isVariableDeclaration(declaration)) {
        return typeOfVariable(declaration);
    }
    if (ast.isOperationDeclaration(declaration)) {
        return returnTypeOf(declaration);
    }
    return typeOfEvent(declaration);
}

/** Effective direction of an event. */
export function eventDirection(event: ast.EventDeclaration): EventDirection {
    if (ast.isInternalScope(event.$container)) {
        return 'internal';
    }
    return event.direction ?? 'in';
}

/**
 * The type of an expression. Never throws: expressions that cannot be typed (unresolved references,
 * invalid operands) have the type `error`. A call of a `void` operation has the type `void`.
 */
export function inferType(expression: ast.Expression | undefined): HsmType {
    return infer(expression, new Set());
}

function infer(expression: ast.Expression | undefined, visiting: Set<AstNode>): HsmType {
    if (!expression) {
        return 'error';
    }
    switch (expression.$type) {
        case 'BoolLiteral':
            return 'boolean';
        case 'IntLiteral':
        case 'HexLiteral':
            return 'integer';
        case 'RealLiteral':
            return 'real';
        case 'StringLiteral':
            return 'string';
        case 'ParenthesizedExpression':
            return infer(expression.expression, visiting);
        case 'ActiveExpression':
            return 'boolean';
        case 'ValueOfExpression': {
            const event = expression.event.ref;
            // an event without type has no value (reported by the validator)
            return event?.type ? typeOfTypeReference(event.type) : 'error';
        }
        case 'ElementReference': {
            const element = expression.element.ref;
            if (ast.isVariableDeclaration(element)) {
                return expression.call ? 'error' : declarationType(element, visiting);
            }
            if (ast.isOperationDeclaration(element)) {
                return expression.call ? returnTypeOf(element) : 'error';
            }
            return 'error';
        }
        case 'UnaryExpression': {
            const operand = infer(expression.operand, visiting);
            return unaryResultType(expression.operator, operand) ?? 'error';
        }
        case 'BinaryExpression': {
            const left = infer(expression.left, visiting);
            const right = infer(expression.right, visiting);
            return binaryResultType(expression.operator, left, right) ?? 'error';
        }
        case 'ConditionalExpression': {
            const trueCase = infer(expression.trueCase, visiting);
            const falseCase = infer(expression.falseCase, visiting);
            return commonType(trueCase, falseCase) ?? 'error';
        }
        case 'CastExpression':
            return typeOfTypeReference(expression.type);
        case 'AssignmentExpression':
            // the value of an assignment is the assigned value, converted to the type of the variable
            return infer(expression.left, visiting);
    }
}

function declarationType(variable: ast.VariableDeclaration, visiting: Set<AstNode>): HsmType {
    if (variable.type) {
        const type = typeOfTypeReference(variable.type);
        return type === 'void' ? 'error' : type;
    }
    if (!variable.initialValue || visiting.has(variable)) {
        return 'error';
    }
    visiting.add(variable);
    try {
        const type = infer(variable.initialValue, visiting);
        return type === 'void' ? 'error' : type;
    } finally {
        visiting.delete(variable);
    }
}

/** Default value of a type: `0`, `0.0`, `false`, `""`; `undefined` for `void` and `error`. */
export function defaultValue(type: HsmType): number | boolean | string | undefined {
    switch (type) {
        case 'integer':
        case 'real':
            return 0;
        case 'boolean':
            return false;
        case 'string':
            return '';
        default:
            return undefined;
    }
}

/** Human readable name of a type for diagnostics. */
export function typeName(type: HsmType): string {
    return type === 'error' ? 'unknown' : type;
}
