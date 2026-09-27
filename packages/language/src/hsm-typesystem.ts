import { AstUtils, type AstNode } from 'langium';
import * as ast from './generated/ast.js';
import { machineType } from './imports.js';

/**
 * Type system of the HSM language (the statechart language of itemis CREATE).
 *
 * Types are identified by their name. `error` is an internal type which is used for expressions
 * whose type cannot be determined (unresolved references, invalid operands, unknown type names).
 * It is compatible with every type, so an error is reported only once and does not cascade.
 * `null` is the type of the literal `null` (itemis CREATE); it can only be assigned to and compared
 * with `string` (and `null`), where it denotes the empty string.
 * Type aliases (`alias Name : type`) are resolved to their base type, they are not types of their own.
 * `instance` is the type of a submachine instance (a variable whose type is an imported state machine,
 * see imports.ts): instances cannot be assigned, compared or used in operations; only their members
 * (`motor.speed`, `motor.start`) are used.
 */
export type HsmType = 'integer' | 'real' | 'boolean' | 'string' | 'void' | 'null' | 'instance' | 'error';

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

/**
 * The type denoted by a type reference: a built-in type, a type alias (resolved to its base type) or
 * an imported state machine (`instance`). Unknown type names, missing references and cyclic aliases
 * yield `error`.
 */
export function typeOfTypeReference(reference: ast.TypeReference | undefined): HsmType {
    if (!reference) {
        return 'error';
    }
    const builtin = resolveTypeName(reference.name);
    if (builtin) {
        return builtin;
    }
    const alias = resolveTypeAlias(reference);
    if (alias) {
        return typeOfAlias(alias);
    }
    return machineType(reference) ? 'instance' : 'error';
}

/** The base type of a type alias (`error` for cyclic or unresolvable aliases). */
export function typeOfAlias(alias: ast.TypeAliasDeclaration): HsmType {
    const visited = new Set<ast.TypeAliasDeclaration>();
    let current: ast.TypeAliasDeclaration | undefined = alias;
    while (current) {
        if (visited.has(current)) {
            return 'error';
        }
        visited.add(current);
        const builtin = resolveTypeName(current.type?.name);
        if (builtin) {
            return builtin;
        }
        current = current.type ? resolveTypeAlias(current.type) : undefined;
    }
    return 'error';
}

/** Whether the alias refers (directly or through other aliases) to itself. */
export function isCyclicAlias(alias: ast.TypeAliasDeclaration): boolean {
    const visited = new Set<ast.TypeAliasDeclaration>();
    let current: ast.TypeAliasDeclaration | undefined = alias;
    while (current) {
        if (visited.has(current)) {
            return current === alias;
        }
        visited.add(current);
        current = current.type && !resolveTypeName(current.type.name) ? resolveTypeAlias(current.type) : undefined;
    }
    return false;
}

/**
 * The type alias a type reference refers to: `Name` for aliases of the unnamed interface, the internal
 * scope and (if the name is unique) named interfaces, `Interface.Name` for aliases of a named interface.
 */
export function resolveTypeAlias(reference: ast.TypeReference): ast.TypeAliasDeclaration | undefined {
    const machine = AstUtils.getContainerOfType(reference, ast.isStateMachine);
    return machine ? typeAliases(machine).get(reference.name) : undefined;
}

const aliasCache = new WeakMap<ast.StateMachine, Map<string, ast.TypeAliasDeclaration>>();

/** The type aliases of a state machine by their referable names (first declaration wins). */
export function typeAliases(machine: ast.StateMachine): Map<string, ast.TypeAliasDeclaration> {
    let aliases = aliasCache.get(machine);
    if (aliases) {
        return aliases;
    }
    aliases = new Map();
    const simpleNames = new Map<string, ast.TypeAliasDeclaration[]>();
    for (const scope of machine.scopes) {
        for (const declaration of scope.declarations) {
            if (!ast.isTypeAliasDeclaration(declaration) || !declaration.name) {
                continue;
            }
            if (ast.isInterfaceScope(scope) && scope.name) {
                const qualified = `${scope.name}.${declaration.name}`;
                if (!aliases.has(qualified)) {
                    aliases.set(qualified, declaration);
                }
                simpleNames.set(declaration.name, [...simpleNames.get(declaration.name) ?? [], declaration]);
            } else if (!aliases.has(declaration.name)) {
                aliases.set(declaration.name, declaration);
            }
        }
    }
    // aliases of named interfaces may also be used by their simple name if it is unambiguous
    for (const [name, candidates] of simpleNames) {
        if (!aliases.has(name) && candidates.length === 1) {
            aliases.set(name, candidates[0]);
        }
    }
    aliasCache.set(machine, aliases);
    return aliases;
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
    if (target === 'instance' || source === 'instance') {
        return false;
    }
    return target === source || (target === 'real' && source === 'integer') || (target === 'string' && source === 'null');
}

/** The common type of two types (used for the branches of `?:`), `undefined` if they are incompatible. */
export function commonType(a: HsmType, b: HsmType): HsmType | undefined {
    if (a === 'error' || b === 'error') {
        return 'error';
    }
    if (a === 'instance' || b === 'instance') {
        return undefined;
    }
    if (a === b) {
        return a;
    }
    if (isNumeric(a) && isNumeric(b)) {
        return 'real';
    }
    if ((a === 'string' && b === 'null') || (a === 'null' && b === 'string')) {
        return 'string';
    }
    return undefined;
}

/** Whether values of the two types can be compared with `==` / `!=`. */
export function isComparable(a: HsmType, b: HsmType): boolean {
    return commonType(a, b) !== undefined && a !== 'void' && b !== 'void';
}

/** Whether a value of type `source` can be cast to `target` with `as`. */
export function isCastable(source: HsmType, target: HsmType): boolean {
    if (source === 'instance' || target === 'instance') {
        return isError(source) || isError(target);
    }
    return isError(source) || isError(target) || source === target || (isNumeric(source) && isNumeric(target))
        || (source === 'null' && target === 'string');
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
    if (ast.isTypeAliasDeclaration(declaration)) {
        return typeOfAlias(declaration);
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
        case 'NullLiteral':
            return 'null';
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
            if (ast.isEventDeclaration(element)) {
                // an event used as condition: true if the event is present
                return expression.call ? 'error' : 'boolean';
            }
            return 'error';
        }
        case 'PostfixExpression': {
            const operand = infer(expression.operand, visiting);
            return isNumeric(operand) ? operand : 'error';
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
        // the type of a variable cannot be inferred from `null` (reported by the validator)
        return type === 'void' || type === 'null' ? 'error' : type;
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
    return type === 'error' ? 'unknown' : type === 'instance' ? 'state machine instance' : type;
}
