import { AstUtils, type AstNode } from 'langium';
import * as ast from '../../generated/ast.js';
import {
    inferType, isCastable, memberPathType, returnTypeOf, sameType, typeName as devmTypeName, typeOfEvent, typeOfParameter, typeOfTypeReference,
    type DevmType
} from '../../typesystem.js';
import { elementOf, isCppType, isEnumType, isUnscopedEnum, memberOf, referenceMembers, resolveCppValue } from '../../cpp-types.js';
import { storageOfTarget, storageOfTypeReference } from '../../cpp-storage.js';
import type { CppResolvedType } from '../../cpp-header/model.js';
import { CBlock, cInteger, cString, stripParens } from './code.js';

/**
 * Runtime helper functions of the generated code that are emitted only when used. The expression
 * compiler uses the arithmetic helpers; the string and event helpers are used by the dialects.
 */
export type Helper =
    | 'int_add' | 'int_sub' | 'int_mul' | 'int_neg' | 'int_div' | 'int_mod' | 'int_shl' | 'int_shr'
    | 'real_to_int' | 'real_round' | 'str_concat' | 'str_assign' | 'str_nonnull' | 'raise_internal' | 'raise_out';

/** A compiled expression: code without side effects (they have been emitted as statements before). */
export interface Code {
    readonly text: string;
    readonly type: DevmType;
    /** A literal: it can be evaluated at any time. */
    readonly constant: boolean;
}

/**
 * Access of the expression compiler to the names of the generated code and to the differences
 * between the target languages (C, C++).
 */
export interface ExpressionContext {
    /** Lvalue of a variable or constant. */
    variable(variable: ast.VariableDeclaration): string;
    variableType(variable: ast.VariableDeclaration): DevmType;
    /** Condition that an event is present in the current step. */
    eventPresent(event: ast.EventDeclaration): string;
    /** Lvalue of the value of an event (`valueof`). */
    eventValue(event: ast.EventDeclaration): string;
    /** Condition that a vertex is active. */
    stateActive(vertex: ast.Vertex): string;
    /**
     * The call of an operation with the compiled arguments per parameter (in parameter order; a
     * variable-length parameter has any number of arguments, the others exactly one).
     */
    operationCall(operation: ast.OperationDeclaration, args: Code[][]): string;
    /** The value of an operation call that is stored in a temporary (e.g. `NULL` -> `""` for C strings). */
    operationResult(type: DevmType, call: string): string;
    /** Emits the statements raising an event whose value (if any) has been stored. */
    raise(event: ast.EventDeclaration, block: CBlock): void;
    /** Marks a helper as used and returns its name. */
    helper(name: Helper): string;
    /** Arguments of a helper that needs the state machine (C: `h, a, b`; C++: `a, b`, a member function). */
    withHandle(args: string): string;
    /** Name of a value type (`sc_integer`, `sc::integer`, ...). */
    typeName(type: DevmType): string;
    /** Explicit conversion of an integer expression to real. */
    toReal(text: string): string;
    /** Statement assigning a converted value to an lvalue of the given type. */
    store(target: string, type: DevmType, value: string): string;
    /** `==` / `!=` of two strings. */
    compareStrings(left: Code, right: Code, operator: '==' | '!='): string;
    /** Concatenation of two strings. */
    concatStrings(left: Code, right: Code): string;
    /** Reports an unsupported construct (throws). */
    unsupported(message: string, node: AstNode): never;
    /**
     * Converts a value to the C++ storage type of the place it is stored in (e.g. `static_cast<std::uint8_t>(...)`
     * for a variable of type `uint8_t`); the value unchanged if no conversion is needed.
     */
    storageCast(storage: CppResolvedType | undefined, value: Code): string;
    /** The index of an element access into an array of `length` elements, checked at run time (`check_index(i, 3)`). */
    checkedIndex(index: string, length: number, node: AstNode): string;
}

const VOID: Code = { text: '', type: 'void', constant: true };

/**
 * Compiles expressions and effects into C or C++ (the differences are provided by the
 * {@link ExpressionContext}). Expressions are evaluated left to right like in the
 * interpreter (docs/semantics.md §2): side effects (operation calls, assignments, `x++`) are emitted as
 * statements in evaluation order, values computed before a later side effect are spilled into
 * temporaries. Integer arithmetic uses wrap-around helpers, integer division / shifts report errors.
 */
export class ExpressionCompiler {

    private temps = 0;

    constructor(private readonly context: ExpressionContext) { }

    /** Starts a new function body (temporaries are numbered per function). */
    resetTemporaries(): void {
        this.temps = 0;
    }

    /** Emits the statements of an effect. */
    effect(effect: ast.Effect | undefined, block: CBlock): void {
        for (const statement of effect?.statements ?? []) {
            if (ast.isRaiseStatement(statement)) {
                this.raise(statement, block);
            } else {
                this.statement(statement.expression, block);
            }
        }
    }

    /** Evaluates an expression for its side effects only. */
    statement(expression: ast.Expression, block: CBlock): void {
        const inner = unparenthesize(expression);
        if (ast.isAssignmentExpression(inner)) {
            this.assignment(inner, block);
            return;
        }
        if (ast.isPostfixExpression(inner)) {
            this.postfix(inner, block, false);
            return;
        }
        if (ast.isElementReference(inner) && inner.call && ast.isOperationDeclaration(inner.element.ref)) {
            const call = this.callText(inner, inner.element.ref, block);
            block.add(returnTypeOf(inner.element.ref) === 'void' ? `${call};` : `(void)${call};`);
            return;
        }
        const code = this.compile(expression, block);
        if (code.type !== 'void' && !code.constant) {
            block.add(`(void)(${stripParens(code.text)});`);
        }
    }

    /** Compiles a guard into a condition; statements for side effects are appended to `block`. */
    condition(expression: ast.Expression | undefined, block: CBlock): string {
        if (!expression) {
            return 'true';
        }
        return stripParens(this.value(expression, 'boolean', block).text);
    }

    /** Compiles an expression and converts it to the given type (only `integer` -> `real` is implicit). */
    value(expression: ast.Expression, type: DevmType | undefined, block: CBlock): Code {
        const code = this.compile(expression, block);
        return type ? this.convert(code, type, expression) : code;
    }

    private raise(statement: ast.RaiseStatement, block: CBlock): void {
        const event = statement.event.ref;
        if (!event) {
            return this.context.unsupported(`Unresolved event '${statement.event.$refText}'`, statement);
        }
        if (statement.value) {
            const type = typeOfEvent(event);
            const code = this.value(statement.value, type, block);
            this.store(this.context.eventValue(event), type, this.context.storageCast(storageOfTypeReference(event.type), code), block);
        }
        this.context.raise(event, block);
    }

    /** Emits an assignment of a (converted) value to an lvalue of the given type. */
    store(target: string, type: DevmType, value: string, block: CBlock): void {
        block.add(this.context.store(target, type, stripParens(value)));
    }

    compile(expression: ast.Expression, block: CBlock): Code {
        switch (expression.$type) {
            case 'BoolLiteral':
                return { text: expression.value, type: 'boolean', constant: true };
            case 'IntLiteral':
                return { text: cInteger(BigInt.asIntN(64, BigInt(expression.$cstNode?.text ?? expression.value))), type: 'integer', constant: true };
            case 'HexLiteral':
                return { text: cInteger(BigInt.asIntN(64, BigInt(expression.value))), type: 'integer', constant: true };
            case 'RealLiteral':
                return { text: expression.value, type: 'real', constant: true };
            case 'StringLiteral':
                return { text: cString(expression.value), type: 'string', constant: true };
            case 'NullLiteral':
                // `null` denotes the empty string (docs/semantics.md §2)
                return { text: cString(''), type: 'string', constant: true };
            case 'ParenthesizedExpression':
                return this.compile(expression.expression, block);
            case 'ValueOfExpression': {
                const event = expression.event.ref;
                if (!event) {
                    return this.context.unsupported(`Unresolved event '${expression.event.$refText}'`, expression);
                }
                const type = typeOfEvent(event);
                if (type === 'void' || type === 'error') {
                    return this.context.unsupported(`Event '${event.name}' has no value`, expression);
                }
                return { text: this.context.eventValue(event), type, constant: false };
            }
            case 'ActiveExpression': {
                const state = expression.state.ref;
                if (!state) {
                    return this.context.unsupported(`Unresolved state '${expression.state.$refText}'`, expression);
                }
                return { text: this.context.stateActive(state), type: 'boolean', constant: false };
            }
            case 'ElementReference':
                return this.reference(expression, block);
            case 'CppReference': {
                const resolved = resolveCppValue(expression);
                if (resolved.error) {
                    return this.context.unsupported(resolved.error, expression);
                }
                return { text: expression.name.replace(/\s+/g, ''), type: resolved.type!, constant: true };
            }
            case 'MemberAccessExpression': {
                const receiver = this.compile(expression.receiver, block);
                const member = memberOf(receiver.type, expression.member);
                if (member.error) {
                    return this.context.unsupported(member.error, expression);
                }
                return { text: `${receiver.text}.${expression.member}`, type: member.type!, constant: receiver.constant };
            }
            case 'IndexExpression': {
                const [receiver, index] = this.operands([{ expression: expression.receiver }, { expression: expression.index, type: 'integer' }], block);
                const element = elementOf(receiver.type);
                if (!element) {
                    return this.context.unsupported(`${devmTypeName(receiver.type)} has no elements`, expression);
                }
                return { text: `${receiver.text}[${this.context.checkedIndex(stripParens(index.text), element.length, expression)}]`, type: element.type, constant: false };
            }
            case 'UnaryExpression':
                return this.unary(expression, block);
            case 'BinaryExpression':
                return this.binary(expression, block);
            case 'ConditionalExpression':
                return this.conditional(expression, block);
            case 'CastExpression':
                return this.cast(expression, block);
            case 'AssignmentExpression':
                return this.assignment(expression, block);
            case 'PostfixExpression':
                return this.postfix(expression, block, true);
        }
    }

    private reference(node: ast.ElementReference, block: CBlock): Code {
        const element = node.element.ref;
        if (!element) {
            return this.context.unsupported(`Unresolved reference '${node.element.$refText}'`, node);
        }
        if (ast.isVariableDeclaration(element) && !node.call) {
            const members = referenceMembers(node);
            const type = this.context.variableType(element);
            if (members.length > 0) {
                return { text: `${this.context.variable(element)}.${members.join('.')}`, type: memberPathType(type, members), constant: false };
            }
            return { text: this.context.variable(element), type, constant: false };
        }
        if (ast.isOperationDeclaration(element)) {
            const call = this.callText(node, element, block);
            const type = returnTypeOf(element);
            if (type === 'void') {
                block.add(`${call};`);
                return VOID;
            }
            return this.temporary(type, this.context.operationResult(type, call), block);
        }
        if (ast.isEventDeclaration(element) && !node.call) {
            return { text: this.context.eventPresent(element), type: 'boolean', constant: false };
        }
        return this.context.unsupported(`'${element.name}' cannot be used in an expression`, node);
    }

    /** The call of an operation; the arguments are evaluated in the order of the text, passed in parameter order. */
    private callText(node: ast.ElementReference, operation: ast.OperationDeclaration, block: CBlock): string {
        const parameters = operation.parameters;
        const slots: Code[][] = parameters.map(() => []);
        const given = new Set<number>();
        const argumentIndex: number[] = [];
        let position = 0;
        for (const argument of node.arguments) {
            let index: number;
            if (argument.parameter) {
                index = parameters.findIndex(p => p.name === argument.parameter);
                if (index < 0) {
                    return this.context.unsupported(`Operation '${operation.name}' has no parameter '${argument.parameter}'`, argument);
                }
            } else {
                index = Math.min(position, parameters.length - 1);
                if (index < 0 || (position >= parameters.length && !parameters[index].varArgs)) {
                    return this.context.unsupported(`Too many arguments for operation '${operation.name}'`, argument);
                }
                position++;
            }
            if (given.has(index) && !parameters[index].varArgs) {
                return this.context.unsupported(`Parameter '${parameters[index].name}' of '${operation.name}' is given twice`, argument);
            }
            given.add(index);
            argumentIndex.push(index);
        }
        const values = this.operands(node.arguments.map((argument, i) => ({
            expression: argument.value,
            type: typeOfParameter(parameters[argumentIndex[i]]),
            storage: storageOfTypeReference(parameters[argumentIndex[i]].type)
        })), block);
        values.forEach((value, i) => slots[argumentIndex[i]].push(value));
        parameters.forEach((parameter, index) => {
            if (!parameter.varArgs && slots[index].length === 0) {
                this.context.unsupported(`Missing argument '${parameter.name}' for operation '${operation.name}'`, node);
            }
        });
        return this.context.operationCall(operation, slots);
    }

    /**
     * Compiles operands left to right. If a later operand emits statements (side effects), the values
     * of earlier operands are stored in temporaries first.
     */
    private operands(items: Array<{ expression: ast.Expression; type?: DevmType; storage?: CppResolvedType }>, block: CBlock): Code[] {
        const results: Code[] = [];
        const ends: number[] = [];
        for (const item of items) {
            const code = item.type ? this.value(item.expression, item.type, block) : this.compile(item.expression, block);
            results.push(item.storage ? { ...code, text: this.context.storageCast(item.storage, code) } : code);
            ends.push(block.length);
        }
        for (let i = items.length - 2; i >= 0; i--) {
            if (ends[items.length - 1] > ends[i] && !results[i].constant && results[i].type !== 'void') {
                const name = this.newTemp();
                block.insert(ends[i], `${this.context.typeName(results[i].type)} ${name} = ${stripParens(results[i].text)};`);
                results[i] = { text: name, type: results[i].type, constant: false };
            }
        }
        return results;
    }

    private temporary(type: DevmType, value: string, block: CBlock): Code {
        const name = this.newTemp();
        block.add(`${this.context.typeName(type)} ${name} = ${stripParens(value)};`);
        return { text: name, type, constant: false };
    }

    private newTemp(): string {
        return `t${++this.temps}`;
    }

    private unary(node: ast.UnaryExpression, block: CBlock): Code {
        const operand = this.promote(this.compile(node.operand, block));
        switch (node.operator) {
            case '!':
                return { text: `(!${operand.text})`, type: 'boolean', constant: operand.constant };
            case '~':
                return { text: `(~${operand.text})`, type: 'integer', constant: operand.constant };
            case '+':
                return operand;
            case '-':
                if (operand.type === 'integer') {
                    if (operand.constant && /^\d+$/.test(operand.text)) {
                        return { text: `(-${operand.text})`, type: 'integer', constant: true };
                    }
                    return { text: `${this.context.helper('int_neg')}(${stripParens(operand.text)})`, type: 'integer', constant: operand.constant };
                }
                return { text: `(-${operand.text})`, type: 'real', constant: operand.constant };
        }
    }

    private binary(node: ast.BinaryExpression, block: CBlock): Code {
        const operator = node.operator;
        if (operator === '&&' || operator === '||') {
            const left = this.value(node.left, 'boolean', block);
            const rightBlock = new CBlock();
            const right = this.value(node.right, 'boolean', rightBlock);
            if (rightBlock.isEmpty) {
                return { text: `(${left.text} ${operator} ${right.text})`, type: 'boolean', constant: left.constant && right.constant };
            }
            const name = this.newTemp();
            block.add(`${this.context.typeName('boolean')} ${name} = ${stripParens(left.text)};`);
            rightBlock.add(`${name} = ${stripParens(right.text)};`);
            block.block(`if (${operator === '&&' ? name : `!${name}`})`, rightBlock);
            return { text: name, type: 'boolean', constant: false };
        }
        const [left, right] = this.operands([{ expression: node.left }, { expression: node.right }], block);
        return this.applyBinary(operator, left, right, node);
    }

    /** An unscoped enum value as integer operand (C++ integral promotion). */
    private promote(code: Code): Code {
        return isUnscopedEnum(code.type) ? { text: `static_cast<sc::integer>(${stripParens(code.text)})`, type: 'integer', constant: code.constant } : code;
    }

    /** A binary operator applied to compiled operands (also used by compound assignments). */
    private applyBinary(operator: string, leftOperand: Code, rightOperand: Code, node: AstNode): Code {
        const equality = operator === '==' || operator === '!=';
        const left = equality && isEnumType(leftOperand.type) && isEnumType(rightOperand.type) ? leftOperand : this.promote(leftOperand);
        const right = equality && isEnumType(leftOperand.type) && isEnumType(rightOperand.type) ? rightOperand : this.promote(rightOperand);
        const constant = left.constant && right.constant;
        const bool = (text: string): Code => ({ text, type: 'boolean', constant });
        switch (operator) {
            case '==':
            case '!=':
                if (left.type === 'string' && right.type === 'string') {
                    return bool(this.context.compareStrings(left, right, operator));
                }
                if (left.type !== right.type && isNumeric(left.type) && isNumeric(right.type)) {
                    return bool(`(${this.toReal(left)} ${operator} ${this.toReal(right)})`);
                }
                return bool(`(${left.text} ${operator} ${right.text})`);
            case '<': case '<=': case '>': case '>=':
                if (left.type !== right.type) {
                    return bool(`(${this.toReal(left)} ${operator} ${this.toReal(right)})`);
                }
                return bool(`(${left.text} ${operator} ${right.text})`);
            case '+':
                if (left.type === 'string' && right.type === 'string') {
                    return { text: this.context.concatStrings(left, right), type: 'string', constant: false };
                }
                return this.arithmetic(operator, left, right, node);
            case '-': case '*': case '/': case '%':
                return this.arithmetic(operator, left, right, node);
            case '&': case '|': case '^':
                return { text: `(${left.text} ${operator} ${right.text})`, type: 'integer', constant };
            case '<<':
                return { text: `${this.context.helper('int_shl')}(${this.context.withHandle(`${stripParens(left.text)}, ${stripParens(right.text)}`)})`, type: 'integer', constant: false };
            case '>>':
                return { text: `${this.context.helper('int_shr')}(${this.context.withHandle(`${stripParens(left.text)}, ${stripParens(right.text)}`)})`, type: 'integer', constant: false };
            default:
                return this.context.unsupported(`Unsupported operator '${operator}'`, node);
        }
    }

    private arithmetic(operator: string, left: Code, right: Code, node: AstNode): Code {
        if (left.type === 'integer' && right.type === 'integer') {
            const args = `${stripParens(left.text)}, ${stripParens(right.text)}`;
            switch (operator) {
                case '+': return { text: `${this.context.helper('int_add')}(${args})`, type: 'integer', constant: false };
                case '-': return { text: `${this.context.helper('int_sub')}(${args})`, type: 'integer', constant: false };
                case '*': return { text: `${this.context.helper('int_mul')}(${args})`, type: 'integer', constant: false };
                case '/': return { text: `${this.context.helper('int_div')}(${this.context.withHandle(args)})`, type: 'integer', constant: false };
                case '%': return { text: `${this.context.helper('int_mod')}(${this.context.withHandle(args)})`, type: 'integer', constant: false };
            }
        }
        if (!isNumeric(left.type) || !isNumeric(right.type) || operator === '%') {
            return this.context.unsupported(`Operator '${operator}' cannot be applied to ${left.type} and ${right.type}`, node);
        }
        return { text: `(${this.toReal(left)} ${operator} ${this.toReal(right)})`, type: 'real', constant: left.constant && right.constant };
    }

    private toReal(code: Code): string {
        if (code.type !== 'integer') {
            return code.text;
        }
        return code.constant && /^\d+$/.test(code.text) ? `${code.text}.0` : this.context.toReal(code.text);
    }

    /** Implicit conversion for assignments, arguments and event values (`integer` -> `real`). */
    convert(code: Code, type: DevmType, node: AstNode): Code {
        if (type === 'error' || sameType(code.type, type)) {
            return code;
        }
        if (isUnscopedEnum(code.type) && (type === 'integer' || type === 'real')) {
            return this.convert(this.promote(code), type, node);
        }
        if (type === 'real' && code.type === 'integer') {
            return { text: this.toReal(code), type: 'real', constant: code.constant };
        }
        if (type === 'void') {
            return code;
        }
        return this.context.unsupported(`Cannot convert ${devmTypeName(code.type)} to ${devmTypeName(type)}`, node);
    }

    private conditional(node: ast.ConditionalExpression, block: CBlock): Code {
        const condition = this.value(node.condition, 'boolean', block);
        const trueBlock = new CBlock();
        const falseBlock = new CBlock();
        const type = inferType(node);
        let trueCase = this.compile(node.trueCase, trueBlock);
        let falseCase = this.compile(node.falseCase, falseBlock);
        if (type === 'void' || trueCase.type === 'void') {
            block.block(`if (${stripParens(condition.text)})`, trueBlock);
            if (!falseBlock.isEmpty) {
                block.block('else', falseBlock);
            }
            return VOID;
        }
        trueCase = this.convert(trueCase, type, node.trueCase);
        falseCase = this.convert(falseCase, type, node.falseCase);
        if (trueBlock.isEmpty && falseBlock.isEmpty) {
            return {
                text: `(${condition.text} ? ${trueCase.text} : ${falseCase.text})`,
                type,
                constant: condition.constant && trueCase.constant && falseCase.constant
            };
        }
        const name = this.newTemp();
        block.add(`${this.context.typeName(type)} ${name};`);
        trueBlock.add(`${name} = ${stripParens(trueCase.text)};`);
        falseBlock.add(`${name} = ${stripParens(falseCase.text)};`);
        block.block(`if (${stripParens(condition.text)})`, trueBlock);
        block.block('else', falseBlock);
        return { text: name, type, constant: false };
    }

    private cast(node: ast.CastExpression, block: CBlock): Code {
        const operand = this.compile(node.operand, block);
        const target = typeOfTypeReference(node.type);
        const storage = storageOfTypeReference(node.type);
        if (isCppType(target) || isCppType(operand.type)) {
            if (sameType(operand.type, target)) {
                return operand;
            }
            if (!isCastable(operand.type, target)) {
                return this.context.unsupported(`Cannot cast ${devmTypeName(operand.type)} to ${node.type.name}`, node);
            }
            const text = isCppType(target) ? `static_cast<${target.cppName}>(${stripParens(operand.text)})` : `static_cast<sc::integer>(${stripParens(operand.text)})`;
            const code: Code = { text, type: target, constant: operand.constant };
            return storage?.kind === 'integer' ? { ...code, text: `static_cast<sc::integer>(${this.context.storageCast(storage, code)})` } : code;
        }
        if (storage?.kind === 'integer' && (operand.type === 'integer' || operand.type === 'real')) {
            // `x as uint8_t`: the value converted to the C++ integer type (wrap-around)
            const integer = operand.type === 'integer' ? operand : this.cast({ ...node, type: { ...node.type, name: 'integer' } } as ast.CastExpression, block);
            return { text: `static_cast<sc::integer>(${this.context.storageCast(storage, integer)})`, type: 'integer', constant: operand.constant };
        }
        if (operand.type === target) {
            return operand;
        }
        if (target === 'real' && operand.type === 'integer') {
            return { text: this.toReal(operand), type: 'real', constant: operand.constant };
        }
        if (target === 'integer' && operand.type === 'real') {
            return { text: `${this.context.helper('real_to_int')}(${this.context.withHandle(stripParens(operand.text))})`, type: 'integer', constant: false };
        }
        return this.context.unsupported(`Cannot cast ${operand.type} to ${node.type.name}`, node);
    }

    /**
     * An assignable place: a variable, or a member / element of a variable (`pos.x`, `a[i]`). Index
     * expressions are evaluated (into temporaries) before the assigned value, like in the interpreter.
     */
    private lvalue(target: ast.Expression, message: string, block: CBlock): { text: string, type: DevmType, storage?: CppResolvedType } {
        const inner = unparenthesize(target);
        if (ast.isMemberAccessExpression(inner)) {
            const receiver = this.lvalue(inner.receiver, message, block);
            const member = memberOf(receiver.type, inner.member);
            if (member.error) {
                return this.context.unsupported(member.error, inner);
            }
            return { text: `${receiver.text}.${inner.member}`, type: member.type!, storage: member.field!.type };
        }
        if (ast.isIndexExpression(inner)) {
            const receiver = this.lvalue(inner.receiver, message, block);
            const element = elementOf(receiver.type);
            if (!element) {
                return this.context.unsupported(`${devmTypeName(receiver.type)} has no elements`, inner);
            }
            let index = this.value(inner.index, 'integer', block);
            if (!index.constant) {
                index = this.temporary('integer', index.text, block);
            }
            return { text: `${receiver.text}[${this.context.checkedIndex(stripParens(index.text), element.length, inner)}]`, type: element.type, storage: element.storage };
        }
        const variable = ast.isElementReference(inner) && !inner.call ? inner.element.ref : undefined;
        if (!variable || !ast.isVariableDeclaration(variable)) {
            return this.context.unsupported(message, target);
        }
        if (variable.const) {
            return this.context.unsupported(`Cannot assign to constant '${variable.name}'`, target);
        }
        const members = referenceMembers(inner as ast.ElementReference);
        const type = this.context.variableType(variable);
        const text = members.length > 0 ? `${this.context.variable(variable)}.${members.join('.')}` : this.context.variable(variable);
        return { text, type: members.length > 0 ? memberPathType(type, members) : type, storage: storageOfTarget(inner) };
    }

    private assignment(node: ast.AssignmentExpression, block: CBlock): Code {
        const { text: target, type, storage } = this.lvalue(node.left, 'The left side of an assignment must be a variable', block);
        let value = this.compile(node.value, block);
        if (node.operator !== '=') {
            // the current value is read after the right side has been evaluated
            value = this.applyBinary(node.operator.slice(0, -1), { text: target, type, constant: false }, value, node);
        }
        value = this.convert(value, type, node);
        this.store(target, type, this.context.storageCast(storage, value), block);
        return { text: target, type, constant: false };
    }

    private postfix(node: ast.PostfixExpression, block: CBlock, needValue: boolean): Code {
        const { text: target, type, storage } = this.lvalue(node.operand, `The operand of '${node.operator}' must be a variable`, block);
        if (!isNumeric(type)) {
            return this.context.unsupported(`'${node.operator}' requires a numeric variable`, node);
        }
        const before = needValue ? this.temporary(type, target, block) : undefined;
        const current: Code = { text: target, type, constant: false };
        const one: Code = { text: '1', type: 'integer', constant: true };
        const updated = this.arithmetic(node.operator === '++' ? '+' : '-', current, one, node);
        this.store(target, type, this.context.storageCast(storage, updated), block);
        return before ?? { text: target, type, constant: false };
    }
}

function isNumeric(type: DevmType): boolean {
    return type === 'integer' || type === 'real';
}

function unparenthesize(expression: ast.Expression): ast.Expression {
    return ast.isParenthesizedExpression(expression) ? unparenthesize(expression.expression) : expression;
}

/** Number of string concatenations in an expression (each needs a scratch buffer while the expression is evaluated). */
export function countConcatenations(node: AstNode | undefined): number {
    if (!node) {
        return 0;
    }
    let count = 0;
    for (const n of AstUtils.streamAst(node)) {
        if (ast.isBinaryExpression(n) && n.operator === '+' && inferType(n) === 'string') {
            count++;
        } else if (ast.isAssignmentExpression(n) && n.operator === '+=' && inferType(n.left) === 'string') {
            count++;
        }
    }
    return count;
}
