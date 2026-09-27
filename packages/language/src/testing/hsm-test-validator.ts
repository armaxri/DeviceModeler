import type { AstNode, ValidationAcceptor, ValidationChecks } from 'langium';
import * as ast from '../generated/ast.js';
import { HsmExpressionValidator, TIME_UNITS } from '../hsm-expression-validator.js';
import {
    eventDirection, inferType, isAssignable, isNumeric, returnTypeOf, typeName, typeOfEvent, typeOfTypeReference,
    type HsmType
} from '../hsm-typesystem.js';
import type { HsmTestServices } from './hsm-test-module.js';
import { builtinVariable } from './hsm-test-scope.js';

/** Annotations of test operations. */
export const TEST_ANNOTATIONS = ['Test', 'SetUp'];
/** Units of `proceed`: cycles or time units. */
export const CYCLE_UNITS = ['cycle', 'cycles'];

export function registerTestValidationChecks(services: HsmTestServices): void {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.HsmTestValidator;
    const checks: ValidationChecks<ast.HsmAstType> = {
        TestClass: validator.checkTestClass,
        TestOperation: validator.checkTestOperation,
        Block: validator.checkBlock,
        ProceedStatement: validator.checkProceed,
        AssertStatement: validator.checkAssert,
        AssertCalledStatement: validator.checkAssertCalled,
        MockStatement: validator.checkMock,
        RaiseStatement: validator.checkRaiseFromTest,
        IfStatement: validator.checkCondition,
        WhileStatement: validator.checkCondition,
        OperationCallStatement: validator.checkOperationCall,
        ElementReference: validator.checkTestElementReference,
        // checks shared with the HSM language
        TypeReference: validator.checkTypeReference,
        VariableDeclaration: validator.checkVariable,
        ValueOfExpression: validator.checkValueOf,
        AssignmentExpression: validator.checkAssignment,
        PostfixExpression: validator.checkPostfix,
        BinaryExpression: validator.checkBinary,
        UnaryExpression: validator.checkUnary,
        ConditionalExpression: validator.checkConditional,
        CastExpression: validator.checkCast,
        CppReference: validator.checkCppReference,
        MemberAccessExpression: validator.checkMemberAccess,
        IndexExpression: validator.checkIndex
    };
    registry.register(checks, validator);
}

/**
 * Semantic checks of the test language. The checks of expressions are inherited from the HSM
 * language; the type checks use `hsm-typesystem.ts`.
 */
export class HsmTestValidator extends HsmExpressionValidator {

    checkTestClass(testClass: ast.TestClass, accept: ValidationAcceptor): void {
        const names = new Set<string>();
        let setUp: ast.TestOperation | undefined;
        for (const operation of testClass.operations) {
            if (names.has(operation.name)) {
                accept('error', `Duplicate operation '${operation.name}'.`, { node: operation, property: 'name' });
            }
            names.add(operation.name);
            if (hasAnnotation(operation, 'SetUp')) {
                if (setUp) {
                    accept('error', `Only one operation can be annotated with @SetUp ('${setUp.name}' is already).`, { node: operation, property: 'name' });
                }
                setUp ??= operation;
            }
        }
        if (!testClass.operations.some(op => hasAnnotation(op, 'Test'))) {
            accept('warning', `The test class '${testClass.name}' contains no test (an operation annotated with @Test).`, { node: testClass, property: 'name' });
        }
    }

    checkTestOperation(operation: ast.TestOperation, accept: ValidationAcceptor): void {
        const seen = new Set<string>();
        for (const annotation of operation.annotations) {
            if (!TEST_ANNOTATIONS.includes(annotation.name)) {
                accept('error', `Unknown annotation '@${annotation.name}'. Known annotations are ${TEST_ANNOTATIONS.map(a => `@${a}`).join(', ')}.`,
                    { node: annotation, property: 'name' });
                continue;
            }
            if (seen.has(annotation.name)) {
                accept('warning', `Duplicate annotation '@${annotation.name}'.`, { node: annotation, property: 'name' });
            }
            seen.add(annotation.name);
            if (annotation.arguments.length > 0) {
                accept('error', `@${annotation.name} takes no arguments.`, { node: annotation, property: 'arguments', index: 0 });
            }
            if (operation.parameters.length > 0) {
                accept('error', `An operation annotated with @${annotation.name} cannot have parameters.`, { node: annotation, property: 'name' });
            }
        }
        if (seen.has('Test') && seen.has('SetUp')) {
            accept('error', 'An operation cannot be a test and the set up operation at the same time.', { node: operation, property: 'name' });
        }
        const names = new Set<string>();
        for (const parameter of operation.parameters) {
            if (names.has(parameter.name)) {
                accept('error', `Duplicate parameter '${parameter.name}'.`, { node: parameter, property: 'name' });
            }
            names.add(parameter.name);
        }
    }

    /** Local variables must have different names within a block. */
    checkBlock(block: ast.Block, accept: ValidationAcceptor): void {
        const names = new Set<string>();
        for (const statement of block.statements) {
            if (ast.isLocalVariableStatement(statement)) {
                const name = statement.declaration.name;
                if (names.has(name)) {
                    accept('error', `Duplicate local variable '${name}'.`, { node: statement.declaration, property: 'name' });
                }
                names.add(name);
            }
        }
    }

    checkProceed(statement: ast.ProceedStatement, accept: ValidationAcceptor): void {
        const cycles = CYCLE_UNITS.includes(statement.unit);
        if (!cycles && !TIME_UNITS.includes(statement.unit)) {
            accept('error', `Unknown unit '${statement.unit}'. Use 'cycle(s)' or one of the time units ${TIME_UNITS.join(', ')}.`,
                { node: statement, property: 'unit' });
        }
        const type = inferType(statement.value);
        if (cycles ? !isValue(type) || type === 'integer' : !isValue(type) || isNumeric(type)) {
            return;
        }
        accept('error', `The ${cycles ? 'number of cycles must be of type integer' : 'time must be of type integer or real'}, but is of type ${typeName(type)}.`,
            { node: statement, property: 'value' });
    }

    checkAssert(statement: ast.AssertStatement, accept: ValidationAcceptor): void {
        this.requireBoolean(statement.expression, 'The asserted expression', statement, 'expression', accept);
    }

    checkCondition(statement: ast.IfStatement | ast.WhileStatement, accept: ValidationAcceptor): void {
        this.requireBoolean(statement.condition, 'The condition', statement, 'condition', accept);
    }

    checkAssertCalled(statement: ast.AssertCalledStatement, accept: ValidationAcceptor): void {
        const operation = statement.operation.ref;
        if (operation && statement.arguments.length > 0) {
            this.checkPositionalArguments(statement.arguments, operation.parameters, `'${operation.name}'`, statement, accept);
        }
        if (statement.times) {
            const type = inferType(statement.times);
            if (isValue(type) && type !== 'integer') {
                accept('error', `The number of calls must be of type integer, but is of type ${typeName(type)}.`, { node: statement, property: 'times' });
            }
            if (statement.negated) {
                accept('error', `'times' cannot be combined with '!called'; use 'times 0' instead.`, { node: statement, property: 'times' });
            }
        }
    }

    checkMock(statement: ast.MockStatement, accept: ValidationAcceptor): void {
        const operation = statement.operation.ref;
        if (!operation) {
            return;
        }
        const returnType = returnTypeOf(operation);
        if (returnType === 'void') {
            accept('error', `The operation '${statement.operation.$refText}' has no return value (void) and cannot be mocked with a value.`,
                { node: statement, property: 'operation' });
        } else {
            const valueType = inferType(statement.value);
            if (isValue(valueType) && !isAssignable(returnType, valueType)) {
                accept('error', `Type mismatch: the operation '${statement.operation.$refText}' returns ${typeName(returnType)}, but the mocked value is of type ${typeName(valueType)}.`,
                    { node: statement, property: 'value' });
            }
        }
        if (statement.withArguments) {
            this.checkPositionalArguments(statement.arguments, operation.parameters, `'${operation.name}'`, statement, accept);
        }
    }

    /** In a test, only `in` events can be raised (the test is the environment of the state machine). */
    checkRaiseFromTest(statement: ast.RaiseStatement, accept: ValidationAcceptor): void {
        const event = statement.event.ref;
        if (!event) {
            return;
        }
        const name = statement.event.$refText;
        const direction = eventDirection(event);
        if (direction !== 'in') {
            accept('error', `Cannot raise '${name}': only in events can be raised by a test ('${name}' is ${direction === 'out' ? 'an out' : 'an internal'} event).`,
                { node: statement, property: 'event' });
        }
        if (!event.type) {
            if (statement.value) {
                accept('error', `Event '${name}' has no type and cannot carry a value.`, { node: statement, property: 'value' });
            }
            return;
        }
        const eventType = typeOfEvent(event);
        if (!statement.value) {
            accept('error', `Event '${name}' requires a value of type ${typeName(eventType)}: 'raise ${name} : value'.`, { node: statement, property: 'event' });
            return;
        }
        const valueType = inferType(statement.value);
        if (isValue(valueType) && !isAssignable(eventType, valueType)) {
            accept('error', `Type mismatch: a value of type ${typeName(valueType)} cannot be assigned to event '${name}' of type ${typeName(eventType)}.`,
                { node: statement, property: 'value' });
        }
    }

    checkOperationCall(statement: ast.OperationCallStatement, accept: ValidationAcceptor): void {
        const operation = statement.operation.ref;
        if (!operation) {
            return;
        }
        if (operation.annotations.some(a => a.name === 'Test' || a.name === 'SetUp')) {
            accept('warning', `'${operation.name}' is a ${hasAnnotation(operation, 'Test') ? 'test' : 'set up operation'}; it is executed by the test runner as well.`,
                { node: statement, property: 'operation' });
        }
        this.checkPositionalArguments(statement.arguments, operation.parameters, `'${operation.name}'`, statement, accept);
    }

    checkTestElementReference(reference: ast.ElementReference, accept: ValidationAcceptor): void {
        const element = reference.element.ref;
        const name = reference.element.$refText;
        if (ast.isOperationDeclaration(element)) {
            accept('error', `The operation '${name}' of the state machine cannot be called in a test; use 'mock ${name} returns (...)' and 'assert called ${name}'.`,
                { node: reference, property: 'element' });
            return;
        }
        if (ast.isEventDeclaration(element) && !reference.call && eventDirection(element) !== 'out') {
            accept('error', `Only out events can be used as conditions in a test ('${name}' is ${eventDirection(element) === 'in' ? 'an in' : 'an internal'} event).`,
                { node: reference, property: 'element' });
            return;
        }
        if (builtinVariable(element) && reference.call) {
            accept('error', `'${name}' cannot be called.`, { node: reference, property: 'call' });
            return;
        }
        super.checkElementReference(reference, accept);
    }

    protected requireBoolean(expression: ast.Expression, what: string, node: AstNode, property: string, accept: ValidationAcceptor): void {
        const type = inferType(expression);
        if (isValue(type) && type !== 'boolean') {
            accept('error', `${what} must be of type boolean, but is of type ${typeName(type)}.`, { node, property });
        }
    }

    protected checkPositionalArguments(args: ast.Expression[], parameters: ReadonlyArray<ast.Parameter | ast.VariableDeclaration>, what: string, node: AstNode, accept: ValidationAcceptor): void {
        const last = parameters[parameters.length - 1];
        const varArgs = ast.isParameter(last) && last.varArgs;
        const required = varArgs ? parameters.length - 1 : parameters.length;
        if (args.length < required || (!varArgs && args.length > parameters.length)) {
            accept('error', `${what} expects ${varArgs ? `at least ${required}` : required} argument${required === 1 ? '' : 's'}, but ${args.length} ${args.length === 1 ? 'is' : 'are'} given.`,
                { node, property: 'arguments' });
            return;
        }
        args.forEach((argument, index) => {
            const parameter = parameters[Math.min(index, parameters.length - 1)];
            const parameterType: HsmType = typeOfTypeReference(parameter.type);
            const argumentType = inferType(argument);
            if (isValue(argumentType) && !isAssignable(parameterType, argumentType)) {
                accept('error', `Type mismatch: an argument of type ${typeName(argumentType)} cannot be assigned to the parameter '${parameter.name}' of type ${typeName(parameterType)}.`,
                    { node, property: 'arguments', index });
            }
        });
    }
}

export function hasAnnotation(operation: ast.TestOperation, name: string): boolean {
    return operation.annotations.some(a => a.name === name);
}

function isValue(type: HsmType): boolean {
    return type !== 'error' && type !== 'void';
}
