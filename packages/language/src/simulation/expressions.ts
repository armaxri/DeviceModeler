import type { AstNode } from 'langium';
import * as ast from '../generated/ast.js';
import { SimulationError } from './errors.js';
import { convert, formatValue, int64, declaredType, typeOfValue, type Value } from './values.js';

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
            return this.context.getVariable(element, node);
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
            case '-':
                return typeof operand === 'bigint' ? int64(-operand) : -this.number(operand, node);
            case '+':
                return typeof operand === 'bigint' ? operand : this.number(operand, node);
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
                return equals(left, right);
            case '!=':
                return !equals(left, right);
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

    private arithmetic(operator: string, left: Value, right: Value, node: AstNode): Value {
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

    private numericPair(left: Value, right: Value, operator: string, node: AstNode): [number, number] {
        if ((typeof left !== 'bigint' && typeof left !== 'number') || (typeof right !== 'bigint' && typeof right !== 'number')) {
            throw new SimulationError(`Operator '${operator}' cannot be applied to ${typeOfValue(left)} and ${typeOfValue(right)}`, node);
        }
        return [Number(left), Number(right)];
    }

    private cast(node: ast.CastExpression): Value {
        const value = this.evaluate(node.operand);
        const target = declaredType(node.type);
        const actual = typeOfValue(value);
        if (target === actual) {
            return value;
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

    /** `x++` / `x--`: updates the variable, the value is the value before the update. */
    private postfix(node: ast.PostfixExpression): Value {
        const variable = this.variableOf(node.operand, `The operand of '${node.operator}' must be a variable`);
        const current = this.context.getVariable(variable, node.operand);
        if (typeof current !== 'bigint' && typeof current !== 'number') {
            throw new SimulationError(`'${node.operator}' requires a numeric variable but '${variable.name}' is ${typeOfValue(current)}`, node);
        }
        this.context.assignVariable(variable, this.arithmetic(node.operator === '++' ? '+' : '-', current, 1n, node), node, node.operand);
        return current;
    }

    private variableOf(target: ast.Expression, message: string): ast.VariableDeclaration {
        const variable = ast.isElementReference(target) && !target.call ? target.element.ref : undefined;
        if (!variable || !ast.isVariableDeclaration(variable)) {
            throw new SimulationError(message, target);
        }
        return variable;
    }

    private assignment(node: ast.AssignmentExpression): Value {
        const target = node.left;
        const variable = this.variableOf(target, 'The left side of an assignment must be a variable');
        let value = this.evaluate(node.value);
        if (node.operator !== '=') {
            const current = this.context.getVariable(variable, target);
            value = this.applyBinary(node.operator.slice(0, -1), current, value, node);
        }
        return this.context.assignVariable(variable, value, node, target);
    }

    private boolean(value: Value, node: AstNode): boolean {
        if (typeof value !== 'boolean') {
            throw new SimulationError(`Expected a boolean value but got ${formatValue(value)}`, node);
        }
        return value;
    }

    private integer(value: Value, node: AstNode): bigint {
        if (typeof value !== 'bigint') {
            throw new SimulationError(`Expected an integer value but got ${formatValue(value)}`, node);
        }
        return value;
    }

    private number(value: Value, node: AstNode): number {
        if (typeof value !== 'number') {
            throw new SimulationError(`Expected a number but got ${formatValue(value)}`, node);
        }
        return value;
    }
}

function equals(left: Value, right: Value): boolean {
    if ((typeof left === 'bigint' || typeof left === 'number') && (typeof right === 'bigint' || typeof right === 'number')) {
        return typeof left === typeof right ? left === right : Number(left) === Number(right);
    }
    return left === right;
}
