import type { AstNode } from 'langium';
import * as ast from '../generated/ast.js';
import { SimulationError } from './errors.js';
import {
    ArrayValue, convert, declaredType, EnumValue, formatValue, fromCppValue, int64, integerOf, isIntegerType, runtimeTypeOfCpp, StructValue,
    typeOfValue, valuesEqual, type RuntimeType, type Value
} from './values.js';
import { isCppType, referenceMembers, resolveCppValue } from '../cpp-types.js';
import { wrapInteger } from '../cpp-storage.js';
import type { CppConstantInfo, CppTypeIndex } from '../cpp-header/type-index.js';

/** A step from a value to a part of it: a struct member or an array element. */
type PathStep = { readonly member: string } | { readonly index: number };

/** Access of the expression evaluator to the state of the running state machine. */
export interface EvaluationContext {
    /** Current value of a variable or constant. */
    getVariable(variable: ast.VariableDeclaration, node: AstNode): Value;
    /**
     * Assigns a (not yet converted) value to a variable and returns the stored value. `reference` is
     * the reference to the variable (e.g. `motor.speed` for a variable of a submachine instance).
     */
    assignVariable(variable: ast.VariableDeclaration, value: Value, node: AstNode, reference?: AstNode): Value;
    /** Whether an event is present in the current step (an event used as a boolean expression). */
    isEventPresent(event: ast.EventDeclaration, node: AstNode): boolean;
    /** Value of the last occurrence of an event (`valueof`). */
    eventValue(event: ast.EventDeclaration, node: AstNode): Value | undefined;
    /** Whether a vertex is active (`active(S)`). */
    isActive(vertex: ast.Vertex, node: AstNode): boolean;
    /** Calls an operation with arguments in parameter order (varargs flattened, already converted). */
    callOperation(operation: ast.OperationDeclaration, args: Value[], node: AstNode): Value | undefined;
    /** Raises an event with an optional value (already converted). */
    raiseEvent(event: ast.EventDeclaration, value: Value | undefined, node: AstNode): void;
}

/**
 * Evaluates expressions and executes effects of the HSM expression language.
 *
 * Integers are 64-bit signed (`bigint`, wrapping on overflow), reals are doubles. Integer division
 * truncates toward zero, `%` has the sign of the dividend; integer division by zero and shift
 * amounts outside `0..63` are errors. `integer` is implicitly converted to `real` in mixed
 * arithmetic, comparisons and assignments to `real` variables. The operand types follow
 * `hsm-typesystem.ts` (`%`, bitwise and shift operators: integers; `+` on strings: concatenation;
 * relational operators: numbers); invalid operands are runtime errors.
 *
 * Values of imported C++ types (docs/cpp-integration.md): enum values compare by value, unscoped enum
 * values are integers in arithmetic; members (`pos.x`) and elements (`a[i]`) are read and assigned
 * (an assignment to a member replaces the whole struct value of the variable); values assigned to
 * places of C++ integer types wrap around to the width of the type.
 */
export class ExpressionEvaluator {

    constructor(private readonly context: EvaluationContext) { }

    /** Executes the statements of an effect in order. */
    execute(effect: ast.Effect | undefined): void {
        for (const statement of effect?.statements ?? []) {
            if (ast.isRaiseStatement(statement)) {
                const event = statement.event.ref;
                if (!event) {
                    throw new SimulationError(`Unresolved event '${statement.event.$refText}'`, statement);
                }
                let value: Value | undefined;
                if (statement.value) {
                    value = convert(this.evaluate(statement.value), declaredType(event.type), `Value of event '${event.name}'`, statement);
                }
                this.context.raiseEvent(event, value, statement);
            } else {
                this.evaluateOrVoid(statement.expression);
            }
        }
    }

    /** Evaluates a guard: `undefined` is `true`, other results must be boolean. */
    guard(expression: ast.Expression | undefined): boolean {
        if (!expression) {
            return true;
        }
        return this.boolean(this.evaluate(expression), expression);
    }

    /** Evaluates an expression. `void` operation calls yield `undefined`. */
    evaluate(expression: ast.Expression): Value {
        const value = this.evaluateOrVoid(expression);
        if (value === undefined) {
            throw new SimulationError('Expression has no value (void)', expression);
        }
        return value;
    }

    /** Evaluates an expression which may be a call of a `void` operation (result `undefined`). */
    evaluateOrVoid(expression: ast.Expression): Value | undefined {
        switch (expression.$type) {
            case 'BoolLiteral':
                return (expression as ast.BoolLiteral).value === 'true';
            case 'IntLiteral': {
                const literal = expression as ast.IntLiteral;
                return int64(BigInt(literal.$cstNode?.text ?? literal.value));
            }
            case 'HexLiteral':
                return int64(BigInt((expression as ast.HexLiteral).value));
            case 'RealLiteral':
                return parseFloat((expression as ast.RealLiteral).value);
            case 'StringLiteral':
                return (expression as ast.StringLiteral).value;
            case 'NullLiteral':
                // `null` denotes the empty string (docs/semantics.md §2)
                return '';
            case 'ParenthesizedExpression':
                return this.evaluateOrVoid((expression as ast.ParenthesizedExpression).expression);
            case 'ValueOfExpression': {
                const node = expression as ast.ValueOfExpression;
                const event = node.event.ref;
                if (!event) {
                    throw new SimulationError(`Unresolved event '${node.event.$refText}'`, node);
                }
                return this.context.eventValue(event, node);
            }
            case 'ActiveExpression': {
                const node = expression as ast.ActiveExpression;
                const state = node.state.ref;
                if (!state) {
                    throw new SimulationError(`Unresolved state '${node.state.$refText}'`, node);
                }
                return this.context.isActive(state, node);
            }
            case 'ElementReference':
                return this.reference(expression as ast.ElementReference);
            case 'CppReference': {
                const node = expression as ast.CppReference;
                const resolved = resolveCppValue(node);
                if (resolved.error) {
                    throw new SimulationError(resolved.error, node);
                }
                const { info, index } = resolved as { info: CppConstantInfo, index: CppTypeIndex };
                return fromCppValue(info.value!, runtimeTypeOfCpp(info.type, index));
            }
            case 'MemberAccessExpression': {
                const node = expression as ast.MemberAccessExpression;
                return readPath(this.evaluate(node.receiver), [{ member: node.member }], node);
            }
            case 'IndexExpression': {
                const node = expression as ast.IndexExpression;
                const receiver = this.evaluate(node.receiver);
                return readPath(receiver, [{ index: this.index(node, receiver) }], node);
            }
            case 'UnaryExpression':
                return this.unary(expression as ast.UnaryExpression);
            case 'BinaryExpression':
                return this.binary(expression as ast.BinaryExpression);
            case 'ConditionalExpression': {
                const node = expression as ast.ConditionalExpression;
                return this.boolean(this.evaluate(node.condition), node.condition)
                    ? this.evaluateOrVoid(node.trueCase)
                    : this.evaluateOrVoid(node.falseCase);
            }
            case 'CastExpression':
                return this.cast(expression as ast.CastExpression);
            case 'AssignmentExpression':
                return this.assignment(expression as ast.AssignmentExpression);
            case 'PostfixExpression':
                return this.postfix(expression as ast.PostfixExpression);
            default:
                throw new SimulationError(`Unsupported expression '${(expression as AstNode).$type}'`, expression);
        }
    }

    private reference(node: ast.ElementReference): Value | undefined {
        const element = node.element.ref;
        if (!element) {
            throw new SimulationError(`Unresolved reference '${node.element.$refText}'`, node);
        }
        if (ast.isVariableDeclaration(element)) {
            if (node.call) {
                throw new SimulationError(`'${element.name}' is a variable, not an operation`, node);
            }
            const members = referenceMembers(node);
            const value = this.context.getVariable(element, node);
            return members.length === 0 ? value : readPath(value, members.map(member => ({ member })), node);
        }
        if (ast.isOperationDeclaration(element)) {
            return this.call(element, node);
        }
        if (ast.isEventDeclaration(element) && !node.call) {
            return this.context.isEventPresent(element, node);
        }
        throw new SimulationError(`'${element.name}' cannot be used in an expression`, node);
    }

    private call(operation: ast.OperationDeclaration, node: ast.ElementReference): Value | undefined {
        const parameters = operation.parameters;
        const slots: Array<Value[] | undefined> = parameters.map(() => undefined);
        let position = 0;
        for (const argument of node.arguments) {
            let index: number;
            if (argument.parameter) {
                index = parameters.findIndex(p => p.name === argument.parameter);
                if (index < 0) {
                    throw new SimulationError(`Operation '${operation.name}' has no parameter '${argument.parameter}'`, argument);
                }
            } else {
                index = Math.min(position, parameters.length - 1);
                if (index < 0 || (position >= parameters.length && !parameters[index].varArgs)) {
                    throw new SimulationError(`Too many arguments for operation '${operation.name}'`, argument);
                }
                position++;
            }
            const parameter = parameters[index];
            const value = convert(this.evaluate(argument.value), declaredType(parameter.type),
                `Argument '${parameter.name}' of '${operation.name}'`, argument);
            if (parameter.varArgs) {
                (slots[index] ??= []).push(value!);
            } else if (slots[index]) {
                throw new SimulationError(`Parameter '${parameter.name}' of '${operation.name}' is given twice`, argument);
            } else {
                slots[index] = [value!];
            }
        }
        const args: Value[] = [];
        parameters.forEach((parameter, index) => {
            const slot = slots[index];
            if (!slot && !parameter.varArgs) {
                throw new SimulationError(`Missing argument '${parameter.name}' for operation '${operation.name}'`, node);
            }
            args.push(...(slot ?? []));
        });
        return this.context.callOperation(operation, args, node);
    }

    private unary(node: ast.UnaryExpression): Value {
        const operand = this.evaluate(node.operand);
        switch (node.operator) {
            case '!':
                return !this.boolean(operand, node.operand);
            case '~':
                return int64(~this.integer(operand, node));
            case '-': {
                const integer = integerOf(operand);
                return integer !== undefined ? int64(-integer) : -this.number(operand, node);
            }
            case '+': {
                const integer = integerOf(operand);
                return integer !== undefined ? integer : this.number(operand, node);
            }
        }
    }

    private binary(node: ast.BinaryExpression): Value {
        const operator = node.operator;
        if (operator === '&&' || operator === '||') {
            const left = this.boolean(this.evaluate(node.left), node.left);
            if (operator === '&&' ? !left : left) {
                return left;
            }
            return this.boolean(this.evaluate(node.right), node.right);
        }
        return this.applyBinary(operator, this.evaluate(node.left), this.evaluate(node.right), node);
    }

    /** Applies a binary (non short-circuit) operator; also used for compound assignments. */
    private applyBinary(operator: string, left: Value, right: Value, node: AstNode): Value {
        switch (operator) {
            case '==':
                return valuesEqual(left, right);
            case '!=':
                return !valuesEqual(left, right);
            case '<': case '<=': case '>': case '>=': {
                const [a, b] = this.numericPair(left, right, operator, node);
                switch (operator) {
                    case '<': return a < b;
                    case '<=': return a <= b;
                    case '>': return a > b;
                    default: return a >= b;
                }
            }
            case '+':
                if (typeof left === 'string' && typeof right === 'string') {
                    return left + right;
                }
                return this.arithmetic(operator, left, right, node);
            case '-': case '*': case '/':
                return this.arithmetic(operator, left, right, node);
            case '%':
                this.integer(left, node);
                this.integer(right, node);
                return this.arithmetic(operator, left, right, node);
            case '&': case '|': case '^': {
                const a = this.integer(left, node);
                const b = this.integer(right, node);
                return int64(operator === '&' ? a & b : operator === '|' ? a | b : a ^ b);
            }
            case '<<': case '>>': {
                const a = this.integer(left, node);
                const b = this.integer(right, node);
                if (b < 0n || b > 63n) {
                    throw new SimulationError(`Shift amount ${b} is out of range 0..63`, node);
                }
                return operator === '<<' ? int64(a << b) : a >> b;
            }
            default:
                throw new SimulationError(`Unsupported operator '${operator}'`, node);
        }
    }

    private arithmetic(operator: string, leftValue: Value, rightValue: Value, node: AstNode): Value {
        // unscoped enum values are integers in arithmetic (C++ integral promotion)
        const left = integerOf(leftValue) ?? leftValue;
        const right = integerOf(rightValue) ?? rightValue;
        if (typeof left === 'bigint' && typeof right === 'bigint') {
            switch (operator) {
                case '+': return int64(left + right);
                case '-': return int64(left - right);
                case '*': return int64(left * right);
                case '/': case '%':
                    if (right === 0n) {
                        throw new SimulationError('Division by zero', node);
                    }
                    return int64(operator === '/' ? left / right : left % right);
                default:
                    throw new SimulationError(`Unsupported operator '${operator}'`, node);
            }
        }
        const [a, b] = this.numericPair(left, right, operator, node);
        switch (operator) {
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '/': return a / b;
            default: throw new SimulationError(`Operator '${operator}' cannot be applied to ${typeOfValue(left)} and ${typeOfValue(right)}`, node);
        }
    }

    private numericPair(leftValue: Value, rightValue: Value, operator: string, node: AstNode): [number, number] {
        const left = integerOf(leftValue) ?? leftValue;
        const right = integerOf(rightValue) ?? rightValue;
        if ((typeof left !== 'bigint' && typeof left !== 'number') || (typeof right !== 'bigint' && typeof right !== 'number')) {
            throw new SimulationError(`Operator '${operator}' cannot be applied to ${typeOfValue(left)} and ${typeOfValue(right)}`, node);
        }
        return [Number(left), Number(right)];
    }

    private cast(node: ast.CastExpression): Value {
        const value = this.evaluate(node.operand);
        const target = declaredType(node.type);
        if (isCppType(target) || typeof target === 'object') {
            return this.cppCast(value, target, node);
        }
        const actual = typeOfValue(value);
        if (target === actual) {
            return value;
        }
        if (target === 'integer' && value instanceof EnumValue) {
            return value.value;
        }
        if (target === 'real' && value instanceof EnumValue) {
            return Number(value.value);
        }
        if (target === 'real' && actual === 'integer') {
            return Number(value);
        }
        if (target === 'integer' && actual === 'real') {
            const number = value as number;
            if (!Number.isFinite(number)) {
                throw new SimulationError(`Cannot convert ${formatValue(number)} to integer`, node);
            }
            return int64(BigInt(Math.trunc(number)));
        }
        throw new SimulationError(`Cannot cast ${actual} to ${node.type.name}`, node);
    }

    /** `x as T` for C++ types: integer / enum values to an enum type, integers to a C++ integer type (wrap-around). */
    private cppCast(value: Value, target: RuntimeType, node: ast.CastExpression): Value {
        if (isCppType(target)) {
            if (target.resolved.kind === 'enum') {
                const integer = typeof value === 'bigint' ? value : value instanceof EnumValue ? value.value : undefined;
                if (integer !== undefined) {
                    return new EnumValue(target, wrapInteger(integer, target.resolved.underlying));
                }
            } else if ((value instanceof StructValue || value instanceof ArrayValue) && value.type.cppName === target.cppName) {
                return value;
            }
            throw new SimulationError(`Cannot cast ${typeOfValue(value)} to ${target.cppName}`, node);
        }
        return convert(isIntegerType(target) && typeof value === 'number' ? this.truncate(value, node) : value instanceof EnumValue ? value.value : value,
            target, `Cast to ${node.type.name}`, node)!;
    }

    private truncate(number: number, node: AstNode): bigint {
        if (!Number.isFinite(number)) {
            throw new SimulationError(`Cannot convert ${formatValue(number)} to integer`, node);
        }
        return int64(BigInt(Math.trunc(number)));
    }

    /** `x++` / `x--`: updates the variable (or member / element), the value is the value before the update. */
    private postfix(node: ast.PostfixExpression): Value {
        const target = this.lvalue(node.operand, `The operand of '${node.operator}' must be a variable`);
        const current = target.read();
        if (typeof current !== 'bigint' && typeof current !== 'number') {
            throw new SimulationError(`'${node.operator}' requires a numeric variable but '${target.variable.name}' is ${typeOfValue(current)}`, node);
        }
        target.write(this.arithmetic(node.operator === '++' ? '+' : '-', current, 1n, node), node);
        return current;
    }

    /**
     * An assignable place: a variable, or a member / element of the value of a variable (`pos.x`,
     * `a[i]`, `cfg.gains[1]`; index expressions are evaluated once, from left to right).
     */
    private lvalue(target: ast.Expression, message: string): { variable: ast.VariableDeclaration, read: () => Value, write: (value: Value, node: AstNode) => Value } {
        const steps: Array<{ readonly member: string } | ast.IndexExpression> = [];
        let current = target;
        while (ast.isMemberAccessExpression(current) || ast.isIndexExpression(current)) {
            steps.unshift(ast.isMemberAccessExpression(current) ? { member: current.member } : current);
            current = current.receiver;
        }
        const reference = current;
        const variable = ast.isElementReference(reference) && !reference.call ? reference.element.ref : undefined;
        if (!ast.isElementReference(reference) || !variable || !ast.isVariableDeclaration(variable)) {
            throw new SimulationError(message, target);
        }
        const path: PathStep[] = referenceMembers(reference).map(member => ({ member }));
        if (path.length === 0 && steps.length === 0) {
            return {
                variable,
                read: () => this.context.getVariable(variable, reference),
                write: (value, node) => this.context.assignVariable(variable, value, node, reference)
            };
        }
        for (const step of steps) {
            if ('member' in step) {
                path.push(step);
            } else {
                const receiver = readPath(this.context.getVariable(variable, reference), path, step);
                path.push({ index: this.index(step, receiver) });
            }
        }
        return {
            variable,
            read: () => readPath(this.context.getVariable(variable, reference), path, target),
            write: (value, node) => {
                const root = this.context.getVariable(variable, reference);
                const { value: updated, stored } = writePath(root, path, value, node);
                this.context.assignVariable(variable, updated, node, reference);
                return stored;
            }
        };
    }

    /** The index of an element access (checked against the length of the array). */
    private index(node: ast.IndexExpression, receiver: Value): number {
        const index = this.integer(this.evaluate(node.index), node.index);
        const length = receiver instanceof ArrayValue ? receiver.elements.length : 0;
        if (index < 0n || index >= BigInt(length)) {
            throw new SimulationError(`Index ${index} is out of bounds 0..${length - 1}`, node);
        }
        return Number(index);
    }

    private assignment(node: ast.AssignmentExpression): Value {
        const target = this.lvalue(node.left, 'The left side of an assignment must be a variable');
        let value = this.evaluate(node.value);
        if (node.operator !== '=') {
            value = this.applyBinary(node.operator.slice(0, -1), target.read(), value, node);
        }
        return target.write(value, node);
    }

    private boolean(value: Value, node: AstNode): boolean {
        if (typeof value !== 'boolean') {
            throw new SimulationError(`Expected a boolean value but got ${formatValue(value)}`, node);
        }
        return value;
    }

    private integer(value: Value, node: AstNode): bigint {
        const integer = integerOf(value);
        if (integer === undefined) {
            throw new SimulationError(`Expected an integer value but got ${formatValue(value)}`, node);
        }
        return integer;
    }

    private number(value: Value, node: AstNode): number {
        if (typeof value !== 'number') {
            throw new SimulationError(`Expected a number but got ${formatValue(value)}`, node);
        }
        return value;
    }
}

/** The part of a value at a path of members / elements. */
export function readPath(value: Value, path: readonly PathStep[], node: AstNode): Value {
    let current = value;
    for (const step of path) {
        if ('member' in step) {
            if (!(current instanceof StructValue) || !current.fields.has(step.member)) {
                throw new SimulationError(`${formatValue(current)} has no member '${step.member}'`, node);
            }
            current = current.fields.get(step.member)!;
        } else {
            if (!(current instanceof ArrayValue) || step.index < 0 || step.index >= current.elements.length) {
                throw new SimulationError(`${formatValue(current)} has no element ${step.index}`, node);
            }
            current = current.elements[step.index];
        }
    }
    return current;
}

/**
 * A copy of `value` with the part at `path` replaced by `leaf` (converted to the type of the member /
 * element, e.g. wrapped to the width of a C++ integer type); returns the new value and the stored leaf.
 */
function writePath(value: Value, path: readonly PathStep[], leaf: Value, node: AstNode): { value: Value, stored: Value } {
    if (path.length === 0) {
        return { value: leaf, stored: leaf };
    }
    const [step, ...rest] = path;
    if ('member' in step) {
        if (!(value instanceof StructValue) || !value.fields.has(step.member)) {
            throw new SimulationError(`${formatValue(value)} has no member '${step.member}'`, node);
        }
        const field = (value.type.resolved.kind === 'struct' ? value.type.resolved.fields : []).find(f => f.name === step.member);
        const inner = rest.length === 0
            ? { value: convert(leaf, field ? runtimeTypeOfCpp(field.type, value.type.index) : undefined, `Assignment to member '${step.member}'`, node)!, stored: undefined }
            : writePath(value.fields.get(step.member)!, rest, leaf, node);
        return { value: value.with(step.member, inner.value), stored: inner.stored ?? inner.value };
    }
    if (!(value instanceof ArrayValue) || step.index < 0 || step.index >= value.elements.length) {
        throw new SimulationError(`${formatValue(value)} has no element ${step.index}`, node);
    }
    const element = value.type.resolved.kind === 'array' ? runtimeTypeOfCpp(value.type.resolved.element, value.type.index) : undefined;
    const inner = rest.length === 0
        ? { value: convert(leaf, element, `Assignment to element ${step.index}`, node)!, stored: undefined }
        : writePath(value.elements[step.index], rest, leaf, node);
    return { value: value.with(step.index, inner.value), stored: inner.stored ?? inner.value };
}
