import {
    AstUtils, DefaultDocumentValidator, DocumentValidator, isReference,
    type AstNode, type LangiumDocument, type ValidationAcceptor, type ValidationOptions
} from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import * as ast from './generated/ast.js';
import {
    BUILTIN_TYPES, binaryResultType, commonType, compoundOperator, eventDirection, inferType, isAssignable,
    isCastable, isComparable, isCyclicAlias, isError, isNumeric, resolveTypeAlias, resolveTypeName, returnTypeOf,
    typeName, typeOfAlias, typeOfEvent, typeOfParameter, typeOfTypeReference, typeOfVariable, type HsmType
} from './hsm-typesystem.js';
import { hasUnresolvedImports, importedMachines, isInstance, isUnresolvedInstance, machineType, referableName, referencedInstance } from './imports.js';

/** Annotations that select the execution semantics (see docs/semantics.md §3 and §4). */
export const SUPPORTED_ANNOTATIONS = ['CycleBased', 'EventDriven', 'ParentFirstExecution', 'ChildFirstExecution'];
/** Annotations of itemis CREATE which are recognized but not supported yet. */
export const UNSUPPORTED_ANNOTATIONS = ['SuperSteps', 'EventBuffering', 'InEventQueue'];
/** Annotations whose arguments are expressions evaluated by the tool (and therefore linked and type checked). */
const EXPRESSION_ANNOTATIONS = ['CycleBased'];
/** Pairs of annotations that exclude each other. */
const CONFLICTING_ANNOTATIONS: Array<[string, string]> = [
    ['CycleBased', 'EventDriven'],
    ['ParentFirstExecution', 'ChildFirstExecution']
];

export const TIME_UNITS = ['s', 'ms', 'us', 'ns'];

/**
 * Semantic checks of the definition section and of all expressions (triggers, guards, effects),
 * following the rules of itemis CREATE.
 */
export class HsmExpressionValidator {

    // -----------------------------------------------------------------------------------------
    // Annotations

    checkAnnotation(annotation: ast.Annotation, accept: ValidationAcceptor): void {
        const name = annotation.name;
        if (UNSUPPORTED_ANNOTATIONS.includes(name)) {
            accept('warning', `@${name} is not supported yet and is ignored.`, { node: annotation, property: 'name' });
            return;
        }
        if (!SUPPORTED_ANNOTATIONS.includes(name)) {
            accept('warning', `Unknown annotation '@${name}'. Known annotations are ${[...SUPPORTED_ANNOTATIONS, ...UNSUPPORTED_ANNOTATIONS].map(a => `@${a}`).join(', ')}.`,
                { node: annotation, property: 'name' });
            return;
        }
        if (name === 'CycleBased') {
            if (annotation.arguments.length > 1) {
                accept('error', '@CycleBased takes at most one argument (the cycle period in milliseconds).',
                    { node: annotation, property: 'arguments', index: 1 });
            }
            const period = annotation.arguments[0];
            if (period) {
                const type = inferType(period);
                if (!isError(type) && type !== 'void' && type !== 'integer') {
                    accept('error', `The cycle period must be of type integer, but is of type ${typeName(type)}.`,
                        { node: annotation, property: 'arguments', index: 0 });
                }
            }
        } else if (annotation.arguments.length > 0) {
            accept('error', `@${name} takes no arguments.`, { node: annotation, property: 'arguments', index: 0 });
        }
    }

    checkAnnotationCombinations(machine: ast.StateMachine, accept: ValidationAcceptor): void {
        const seen = new Map<string, ast.Annotation>();
        for (const annotation of machine.annotations) {
            if (seen.has(annotation.name)) {
                accept('warning', `Duplicate annotation '@${annotation.name}'.`, { node: annotation, property: 'name' });
                continue;
            }
            for (const [a, b] of CONFLICTING_ANNOTATIONS) {
                const other = annotation.name === a ? b : annotation.name === b ? a : undefined;
                if (other && seen.has(other)) {
                    accept('error', `@${annotation.name} cannot be combined with @${other}.`, { node: annotation, property: 'name' });
                }
            }
            seen.set(annotation.name, annotation);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Declarations

    checkInterfaceScope(scope: ast.InterfaceScope, accept: ValidationAcceptor): void {
        for (const declaration of scope.declarations) {
            if (ast.isEventDeclaration(declaration) && !declaration.direction) {
                accept('warning', `Event '${declaration.name}' has no direction ('in' or 'out'); it is treated as an 'in' event.`,
                    { node: declaration, property: 'name' });
            }
        }
    }

    checkInternalScope(scope: ast.InternalScope, accept: ValidationAcceptor): void {
        for (const declaration of scope.declarations) {
            if (ast.isEventDeclaration(declaration) && declaration.direction) {
                accept('error', `The direction '${declaration.direction}' is not allowed in the internal scope: internal events are raised and consumed by the state machine.`,
                    { node: declaration, property: 'direction' });
            }
        }
    }

    checkTypeReference(reference: ast.TypeReference, accept: ValidationAcceptor): void {
        const builtin = resolveTypeName(reference.name);
        const alias = builtin ? undefined : resolveTypeAlias(reference);
        const machine = builtin || alias ? undefined : machineType(reference);
        if (machine) {
            if (!ast.isVariableDeclaration(reference.$container) || reference.$containerProperty !== 'type') {
                accept('error', `The state machine type '${reference.name}' can only be used as the type of a variable (a submachine instance).`,
                    { node: reference, property: 'name' });
            }
            return;
        }
        if (!builtin && !alias) {
            const container = AstUtils.getContainerOfType(reference, ast.isStateMachine);
            if (container && hasUnresolvedImports(container) && /^[A-Z]/.test(reference.name)) {
                accept('error', `Unknown type '${reference.name}' (an import could not be resolved; does it define '${reference.name}'?).`, { node: reference, property: 'name' });
                return;
            }
            const imported = container ? [...importedMachines(container).keys()] : [];
            const machines = imported.length > 0 ? `, imported state machines (${imported.join(', ')})` : '';
            accept('error', `Unknown type '${reference.name}'. Known types are ${BUILTIN_TYPES.join(', ')}${machines} and type aliases ('alias Name : type').`,
                { node: reference, property: 'name' });
            return;
        }
        if (alias && isCyclicAlias(alias)) {
            // reported at the alias
            return;
        }
        const type = builtin ?? (alias ? typeOfAlias(alias) : 'error');
        const allowed = (ast.isOperationDeclaration(reference.$container) && reference.$containerProperty === 'returnType')
            || ast.isTypeAliasDeclaration(reference.$container);
        if (type === 'void' && !allowed) {
            accept('error', `The type 'void' can only be used as the return type of an operation.`, { node: reference, property: 'name' });
        }
    }

    checkTypeAlias(alias: ast.TypeAliasDeclaration, accept: ValidationAcceptor): void {
        if (resolveTypeName(alias.name)) {
            accept('error', `The built-in type '${alias.name}' cannot be redefined.`, { node: alias, property: 'name' });
        }
        if (isCyclicAlias(alias)) {
            accept('error', `The type alias '${alias.name}' refers to itself.`, { node: alias, property: 'type' });
        }
    }

    checkVariable(variable: ast.VariableDeclaration, accept: ValidationAcceptor): void {
        if (isInstance(variable)) {
            if (variable.const) {
                accept('error', `The submachine instance '${variable.name}' cannot be a constant; declare it with 'var'.`, { node: variable, property: 'name' });
            }
            if (variable.initialValue) {
                accept('error', `The submachine instance '${variable.name}' cannot have an initial value.`, { node: variable, property: 'initialValue' });
            }
            return;
        }
        if (!variable.initialValue) {
            if (variable.const) {
                accept('error', `Constant '${variable.name}' must have an initial value.`, { node: variable, property: 'name' });
            } else if (!variable.type) {
                accept('error', `Variable '${variable.name}' needs a type or an initial value.`, { node: variable, property: 'name' });
            }
            return;
        }
        if (!variable.type) {
            if (inferType(variable.initialValue) === 'null') {
                accept('error', `The type of '${variable.name}' cannot be inferred from 'null'. Declare its type.`, { node: variable, property: 'initialValue' });
            }
            return;
        }
        const declared = typeOfTypeReference(variable.type);
        const value = inferType(variable.initialValue);
        if (declared !== 'void' && value !== 'void' && !isAssignable(declared, value)) {
            accept('error', `Type mismatch: the initial value of type ${typeName(value)} cannot be assigned to '${variable.name}' of type ${typeName(declared)}.`,
                { node: variable, property: 'initialValue' });
        }
    }

    checkOperation(operation: ast.OperationDeclaration, accept: ValidationAcceptor): void {
        const names = new Set<string>();
        operation.parameters.forEach((parameter, index) => {
            if (names.has(parameter.name)) {
                accept('error', `Duplicate parameter '${parameter.name}'.`, { node: parameter, property: 'name' });
            }
            names.add(parameter.name);
            if (parameter.varArgs && index !== operation.parameters.length - 1) {
                accept('error', `Only the last parameter of an operation can be a variable argument list ('...').`,
                    { node: parameter, property: 'varArgs' });
            }
        });
    }

    /** Declarations which are never referenced. */
    checkUnusedDeclarations(machine: ast.StateMachine, accept: ValidationAcceptor): void {
        const used = new Set<AstNode>();
        for (const node of AstUtils.streamAst(machine)) {
            for (const reference of AstUtils.streamReferences(node)) {
                const target = reference.reference;
                if (isReference(target) && target.ref) {
                    used.add(target.ref);
                }
            }
            // type aliases are referenced by name (not by a cross-reference)
            if (ast.isTypeReference(node)) {
                const alias = resolveTypeAlias(node);
                if (alias && alias !== node.$container) {
                    used.add(alias);
                }
            }
        }
        for (const scope of machine.scopes) {
            for (const declaration of scope.declarations) {
                if (!used.has(declaration)) {
                    const kind = ast.isEventDeclaration(declaration) ? 'Event'
                        : ast.isOperationDeclaration(declaration) ? 'Operation'
                            : ast.isTypeAliasDeclaration(declaration) ? 'Type alias'
                                : declaration.const ? 'Constant' : 'Variable';
                    accept('info', `${kind} '${declaration.name}' is never used.`, { node: declaration, property: 'name' });
                }
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Reactions

    checkGuard(reaction: ast.ReactionSpec | ast.LocalReaction, accept: ValidationAcceptor): void {
        if (!reaction.guard) {
            return;
        }
        const type = inferType(reaction.guard);
        if (isValueType(type) && type !== 'boolean') {
            accept('error', `The guard must be of type boolean, but is of type ${typeName(type)}.`, { node: reaction, property: 'guard' });
        }
    }

    checkEventTrigger(trigger: ast.EventTrigger, accept: ValidationAcceptor): void {
        const event = trigger.event.ref;
        if (event && referencedInstance(trigger)) {
            if (eventDirection(event) !== 'out') {
                accept('error', `The event '${trigger.event.$refText}' cannot be used as a trigger: only the out events of a submachine instance can be observed.`,
                    { node: trigger, property: 'event' });
            }
            return;
        }
        if (event && eventDirection(event) === 'out') {
            accept('error', `The out event '${trigger.event.$refText}' cannot be used as a trigger: out events are raised by the state machine.`,
                { node: trigger, property: 'event' });
        }
    }

    checkTimeTrigger(trigger: ast.TimeTrigger, accept: ValidationAcceptor): void {
        const type = inferType(trigger.value);
        if (isValueType(type) && !isNumeric(type)) {
            accept('error', `The time value must be of type integer (or real), but is of type ${typeName(type)}.`, { node: trigger, property: 'value' });
        }
        if (!TIME_UNITS.includes(trigger.unit)) {
            accept('error', `Unknown time unit '${trigger.unit}'. Use one of ${TIME_UNITS.join(', ')}.`, { node: trigger, property: 'unit' });
        }
    }

    checkExpressionStatement(statement: ast.ExpressionStatement, accept: ValidationAcceptor): void {
        if (!hasSideEffect(statement.expression)) {
            accept('warning', 'The expression has no effect.', { node: statement, property: 'expression' });
        }
    }

    checkRaise(statement: ast.RaiseStatement, accept: ValidationAcceptor): void {
        const event = statement.event.ref;
        if (!event) {
            return;
        }
        const name = statement.event.$refText;
        if (referencedInstance(statement)) {
            if (eventDirection(event) !== 'in') {
                accept('error', `Cannot raise '${name}': only the in events of a submachine instance can be raised.`, { node: statement, property: 'event' });
            }
        } else if (eventDirection(event) === 'in') {
            accept('error', `Cannot raise '${name}': in events can only be raised by the environment.`, { node: statement, property: 'event' });
        }
        const eventType = typeOfEvent(event);
        if (!event.type) {
            if (statement.value) {
                accept('error', `Event '${name}' has no type and cannot carry a value.`, { node: statement, property: 'value' });
            }
            return;
        }
        if (!statement.value) {
            accept('error', `Event '${name}' requires a value of type ${typeName(eventType)}: 'raise ${name} : value'.`, { node: statement, property: 'event' });
            return;
        }
        const valueType = inferType(statement.value);
        if (valueType !== 'void' && eventType !== 'void' && !isAssignable(eventType, valueType)) {
            accept('error', `Type mismatch: a value of type ${typeName(valueType)} cannot be assigned to event '${name}' of type ${typeName(eventType)}.`,
                { node: statement, property: 'value' });
        }
    }

    // -----------------------------------------------------------------------------------------
    // Expressions

    checkValueOf(expression: ast.ValueOfExpression, accept: ValidationAcceptor): void {
        const event = expression.event.ref;
        if (event && !event.type) {
            accept('error', `Event '${expression.event.$refText}' has no type: valueof() requires an event with a value.`, { node: expression, property: 'event' });
        } else if (event && referencedInstance(expression) && eventDirection(event) !== 'out') {
            accept('error', `valueof() can only be applied to the out events of a submachine instance.`, { node: expression, property: 'event' });
        }
    }

    checkPostfix(expression: ast.PostfixExpression, accept: ValidationAcceptor): void {
        const operand = expression.operand;
        const element = ast.isElementReference(operand) && !operand.call ? operand.element.ref : undefined;
        if (!ast.isElementReference(operand) || operand.call || (operand.element.ref && !ast.isVariableDeclaration(element))) {
            accept('error', `'${expression.operator}' can only be applied to a variable.`, { node: expression, property: 'operator' });
            return;
        }
        if (ast.isVariableDeclaration(element)) {
            if (isInstance(element)) {
                accept('error', `Cannot modify the submachine instance '${operand.element.$refText}'.`, { node: operand, property: 'element' });
                return;
            }
            if (element.const || element.readonly) {
                accept('error', `Cannot modify the ${element.const ? 'constant' : 'readonly variable'} '${operand.element.$refText}'.`, { node: operand, property: 'element' });
            }
            const type = typeOfVariable(element);
            if (isValueType(type) && !isNumeric(type)) {
                accept('error', `'${expression.operator}' requires a numeric variable, but '${operand.element.$refText}' is ${typeName(type)}.`, { node: expression, property: 'operator' });
            }
        }
    }

    checkAssignment(assignment: ast.AssignmentExpression, accept: ValidationAcceptor): void {
        const left = assignment.left;
        if (!ast.isElementReference(left)) {
            accept('error', 'The left-hand side of an assignment must be a variable.', { node: left });
            return;
        }
        const element = left.element.ref;
        if (!element) {
            return; // linking error
        }
        if (!ast.isVariableDeclaration(element) || left.call) {
            accept('error', 'The left-hand side of an assignment must be a variable.', { node: left });
            return;
        }
        const name = left.element.$refText;
        if (isInstance(element)) {
            accept('error', `Cannot assign to the submachine instance '${name}': instances cannot be assigned.`, { node: left, property: 'element' });
            return;
        }
        if (element.const) {
            accept('error', `Cannot assign a value to the constant '${name}'.`, { node: left, property: 'element' });
        } else if (element.readonly) {
            accept('error', `Cannot assign a value to the readonly variable '${name}'.`, { node: left, property: 'element' });
        }
        const variableType = typeOfVariable(element);
        const valueType = inferType(assignment.value);
        if (valueType === 'void') {
            return; // reported at the operation call
        }
        const operator = compoundOperator(assignment.operator);
        if (!operator) {
            if (!isAssignable(variableType, valueType)) {
                accept('error', `Type mismatch: a value of type ${typeName(valueType)} cannot be assigned to '${name}' of type ${typeName(variableType)}.`,
                    { node: assignment, property: 'value' });
            }
            return;
        }
        const result = binaryResultType(operator, variableType, valueType);
        if (!result) {
            accept('error', `The operator '${assignment.operator}' cannot be applied to ${typeName(variableType)} and ${typeName(valueType)}.`,
                { node: assignment, property: 'operator' });
        } else if (!isAssignable(variableType, result)) {
            accept('error', `Type mismatch: the result of '${assignment.operator}' is of type ${typeName(result)} and cannot be assigned to '${name}' of type ${typeName(variableType)}.`,
                { node: assignment, property: 'value' });
        }
    }

    checkBinary(expression: ast.BinaryExpression, accept: ValidationAcceptor): void {
        const operator = expression.operator;
        const left = inferType(expression.left);
        const right = inferType(expression.right);
        const requireOperands = (predicate: (type: HsmType) => boolean, description: string) => {
            for (const [side, type, node] of [['left', left, expression.left], ['right', right, expression.right]] as const) {
                if (isValueType(type) && !predicate(type)) {
                    // (the operands are assigned by tree rewriting actions, so they are highlighted as nodes)
                    accept('error', `The operator '${operator}' requires ${description} operands, but the ${side} operand is of type ${typeName(type)}.`,
                        { node });
                }
            }
        };
        switch (operator) {
            case '&&':
            case '||':
                requireOperands(type => type === 'boolean', 'boolean');
                break;
            case '|':
            case '^':
            case '&':
            case '<<':
            case '>>':
            case '%':
                requireOperands(type => type === 'integer', 'integer');
                break;
            case '<':
            case '<=':
            case '>':
            case '>=':
            case '-':
            case '*':
            case '/':
                requireOperands(isNumeric, 'numeric');
                break;
            case '+':
                if (left === 'string' || right === 'string') {
                    if (isValueType(left) && isValueType(right) && left !== right) {
                        accept('error', `The operator '+' cannot be applied to ${typeName(left)} and ${typeName(right)}.`, { node: expression, property: 'operator' });
                    }
                } else {
                    requireOperands(isNumeric, 'numeric (or string)');
                }
                break;
            case '==':
            case '!=':
                if (isValueType(left) && isValueType(right) && !isComparable(left, right)) {
                    accept('error', `Cannot compare a value of type ${typeName(left)} with a value of type ${typeName(right)}.`, { node: expression, property: 'operator' });
                }
                break;
        }
    }

    checkUnary(expression: ast.UnaryExpression, accept: ValidationAcceptor): void {
        const type = inferType(expression.operand);
        if (!isValueType(type)) {
            return;
        }
        const operator = expression.operator;
        const [valid, description] = operator === '!' ? [type === 'boolean', 'a boolean']
            : operator === '~' ? [type === 'integer', 'an integer']
                : [isNumeric(type), 'a numeric'];
        if (!valid) {
            accept('error', `The operator '${operator}' requires ${description} operand, but the operand is of type ${typeName(type)}.`,
                { node: expression, property: 'operand' });
        }
    }

    checkConditional(expression: ast.ConditionalExpression, accept: ValidationAcceptor): void {
        const condition = inferType(expression.condition);
        if (isValueType(condition) && condition !== 'boolean') {
            accept('error', `The condition must be of type boolean, but is of type ${typeName(condition)}.`, { node: expression.condition });
        }
        const trueCase = inferType(expression.trueCase);
        const falseCase = inferType(expression.falseCase);
        if (isValueType(trueCase) && isValueType(falseCase) && !commonType(trueCase, falseCase)) {
            accept('error', `The branches of the conditional expression have incompatible types ${typeName(trueCase)} and ${typeName(falseCase)}.`,
                { node: expression, property: 'falseCase' });
        }
    }

    checkCast(expression: ast.CastExpression, accept: ValidationAcceptor): void {
        const source = inferType(expression.operand);
        const target = typeOfTypeReference(expression.type);
        if (isValueType(source) && isValueType(target) && !isCastable(source, target)) {
            accept('error', `Cannot cast a value of type ${typeName(source)} to ${typeName(target)}.`, { node: expression, property: 'type' });
        }
    }

    checkElementReference(reference: ast.ElementReference, accept: ValidationAcceptor): void {
        const element = reference.element.ref;
        const name = reference.element.$refText;
        if (ast.isVariableDeclaration(element)) {
            if (reference.call) {
                accept('error', `'${name}' is a ${element.const ? 'constant' : 'variable'} and cannot be called.`, { node: reference, property: 'call' });
            }
            return;
        }
        if (ast.isEventDeclaration(element)) {
            if (reference.call) {
                accept('error', `'${name}' is an event and cannot be called.`, { node: reference, property: 'call' });
            } else if (referencedInstance(reference) && eventDirection(element) !== 'out') {
                accept('error', `The in event '${name}' of a submachine instance cannot be used as a condition: only its out events can be observed.`, { node: reference, property: 'element' });
            }
            return;
        }
        if (!ast.isOperationDeclaration(element)) {
            return;
        }
        if (referencedInstance(reference)) {
            accept('error', `The operation '${name}' of a submachine instance cannot be called: operations are implemented by the host of the instance.`, { node: reference, property: 'element' });
            return;
        }
        if (!reference.call) {
            accept('error', `The operation '${name}' must be called with parentheses: '${name}(...)'.`, { node: reference, property: 'element' });
            return;
        }
        this.checkArguments(reference, element, accept);
        if (returnTypeOf(element) === 'void' && !isStatement(reference)) {
            accept('error', `The operation '${name}' has no return value (void) and cannot be used as a value.`, { node: reference, property: 'element' });
        }
    }

    protected checkArguments(reference: ast.ElementReference, operation: ast.OperationDeclaration, accept: ValidationAcceptor): void {
        const parameters = operation.parameters;
        const last = parameters[parameters.length - 1];
        const varArgs = last?.varArgs ? last : undefined;
        const bound = new Set<ast.Parameter>();
        let position = 0;
        let named = false;
        for (const argument of reference.arguments) {
            let parameter: ast.Parameter | undefined;
            if (argument.parameter !== undefined) {
                named = true;
                parameter = parameters.find(p => p.name === argument.parameter);
                if (!parameter) {
                    accept('error', `The operation '${operation.name}' has no parameter '${argument.parameter}'.`, { node: argument, property: 'parameter' });
                    continue;
                }
                if (bound.has(parameter) && parameter !== varArgs) {
                    accept('error', `The parameter '${parameter.name}' is already assigned.`, { node: argument, property: 'parameter' });
                    continue;
                }
            } else {
                if (named) {
                    accept('error', 'Positional arguments must not follow named arguments.', { node: argument, property: 'value' });
                    continue;
                }
                parameter = parameters[position];
                if (!parameter) {
                    accept('error', `Too many arguments: the operation '${operation.name}' expects ${countText(parameters.length)}.`, { node: argument, property: 'value' });
                    continue;
                }
                if (parameter !== varArgs) {
                    position++;
                }
            }
            bound.add(parameter);
            const parameterType = typeOfParameter(parameter);
            const argumentType = inferType(argument.value);
            if (isValueType(argumentType) && parameterType !== 'void' && !isAssignable(parameterType, argumentType)) {
                accept('error', `Type mismatch: an argument of type ${typeName(argumentType)} cannot be assigned to the parameter '${parameter.name}' of type ${typeName(parameterType)}.`,
                    { node: argument, property: 'value' });
            }
        }
        const missing = parameters.filter(p => p !== varArgs && !bound.has(p));
        if (missing.length > 0) {
            const expected = varArgs ? `at least ${countText(parameters.length - 1)}` : countText(parameters.length);
            accept('error', `The operation '${operation.name}' expects ${expected}; missing ${missing.map(p => `'${p.name}'`).join(', ')}.`,
                { node: reference, property: 'element' });
        }
    }
}

/**
 * Document validator which does not report linking errors in the arguments of annotations whose
 * arguments are not expressions (e.g. `@SuperSteps(yes)`) or of unknown annotations.
 */
export class HsmDocumentValidator extends DefaultDocumentValidator {

    protected override processLinkingErrors(document: LangiumDocument, diagnostics: Diagnostic[], _options: ValidationOptions): void {
        const machine = document.parseResult.value;
        // members of instances of state machines whose import could not be resolved (`motor.start`): the import is reported
        const unresolvedInstances = new Set(ast.isStateMachine(machine) && hasUnresolvedImports(machine)
            ? machine.scopes.flatMap(scope => scope.declarations).filter(ast.isVariableDeclaration)
                .filter(variable => isUnresolvedInstance(variable, isKnownType)).map(referableName)
            : []);
        for (const reference of document.references) {
            const linkingError = reference.error;
            if (!linkingError || isFreeAnnotationArgument(linkingError.info.container)) {
                continue;
            }
            const refText = linkingError.info.reference.$refText.replace(/\s+/g, '');
            if ([...unresolvedInstances].some(name => refText.startsWith(`${name}.`))) {
                continue;
            }
            diagnostics.push(this.toDiagnostic('error', linkingError.message, {
                node: linkingError.info.container,
                range: reference.$refNode?.range,
                property: linkingError.info.property,
                index: linkingError.info.index,
                data: {
                    code: DocumentValidator.LinkingError,
                    containerType: linkingError.info.container.$type,
                    property: linkingError.info.property,
                    refText: linkingError.info.reference.$refText
                }
            }));
        }
    }
}

/** Whether a type reference denotes a built-in type, a type alias or an imported state machine. */
export function isKnownType(reference: ast.TypeReference): boolean {
    return resolveTypeName(reference.name) !== undefined || resolveTypeAlias(reference) !== undefined || machineType(reference) !== undefined;
}

function isFreeAnnotationArgument(node: AstNode): boolean {
    const annotation = AstUtils.getContainerOfType(node, ast.isAnnotation);
    return annotation !== undefined && !EXPRESSION_ANNOTATIONS.includes(annotation.name);
}

/** Types which denote a value that can be checked: `error` has been reported before, `void` at the operation call. */
function isValueType(type: HsmType): boolean {
    return type !== 'error' && type !== 'void';
}

/** Assignments and operation calls have a side effect (unresolved references are reported by the linker). */
function hasSideEffect(expression: ast.Expression): boolean {
    if (ast.isAssignmentExpression(expression) || ast.isPostfixExpression(expression)) {
        return true;
    }
    if (ast.isElementReference(expression)) {
        return expression.call || !ast.isVariableDeclaration(expression.element.ref);
    }
    return false;
}

/** Whether the expression is a statement of an effect, i.e. its value is not used. */
function isStatement(expression: ast.Expression): boolean {
    return ast.isExpressionStatement(expression.$container) && expression.$containerProperty === 'expression';
}

function countText(count: number): string {
    return count === 1 ? '1 argument' : `${count} arguments`;
}
