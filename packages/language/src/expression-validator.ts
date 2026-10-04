import {
    LAYOUT_ANNOTATIONS, annotationOwner, containerAnnotations, elementAnnotations, isElementAnnotation, semanticAnnotations,
    type AnnotatedElement, type AnnotationContainer
} from './model-annotations.js';
import { annotationAnchor, annotationNumbers } from './diagram/layout-annotations.js';
import { isAnchorSide } from './diagram/edge-anchors.js';
import {
    AstUtils, DefaultDocumentValidator, DocumentValidator, isReference,
    type AstNode, type LangiumDocument, type ValidationAcceptor, type ValidationOptions
} from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import * as ast from './generated/ast.js';
import {
    BUILTIN_TYPES, binaryResultType, commonType, compoundOperator, eventDirection, inferType, isAssignable,
    isCastable, isComparable, isCyclicAlias, isError, isNumeric, resolveTypeAlias, resolveTypeName, returnTypeOf,
    typeName, typeOfAlias, typeOfEvent, typeOfParameter, typeOfTypeReference, typeOfVariable, type DevmType
} from './typesystem.js';
import { cppImports, hasUnresolvedHeaders, hasUnresolvedImports, importedMachines, isInstance, isUnresolvedInstance, machineType, referableName, referencedInstance } from './imports.js';
import {
    contextMachine, cppTypeOfReference, elementOf, isCppType, isReadonlyString, isUnscopedEnum, memberOf, referenceMembers, resolveCppValue
} from './cpp-types.js';
import { constantInteger, lvalueOf, rangeWarning, storageOfTarget, storageOfTypeReference } from './cpp-storage.js';
import { isAssignableArray, memberPathType, typeOfDeclaration } from './typesystem.js';
import {
    balancedTemplateArguments, isClassMember, isConstantVariable, isReferenceMember, unusableReason, usesCppTypeSyntax, writtenCppType
} from './class-members.js';

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
export class ExpressionValidator {

    // -----------------------------------------------------------------------------------------
    // Annotations

    checkAnnotation(annotation: ast.Annotation, accept: ValidationAcceptor): void {
        const name = annotation.name;
        const container = annotation.$container;
        if (!ast.isStateMachine(container) && !ast.isState(container) && !ast.isRegion(container)) {
            return;
        }
        if (LAYOUT_ANNOTATIONS.includes(name)) {
            this.checkLayoutAnnotation(annotation, accept);
            return;
        }
        if (!ast.isStateMachine(container) && (SUPPORTED_ANNOTATIONS.includes(name) || UNSUPPORTED_ANNOTATIONS.includes(name))) {
            accept('error', `@${name} is an annotation of the state machine.`, { node: annotation, property: 'name' });
            return;
        }
        if (UNSUPPORTED_ANNOTATIONS.includes(name)) {
            accept('warning', `@${name} is not supported yet and is ignored.`, { node: annotation, property: 'name' });
            return;
        }
        if (!SUPPORTED_ANNOTATIONS.includes(name)) {
            const known = ast.isStateMachine(container) ? [...SUPPORTED_ANNOTATIONS, ...UNSUPPORTED_ANNOTATIONS, ...LAYOUT_ANNOTATIONS] : LAYOUT_ANNOTATIONS;
            accept('warning', `Unknown annotation '@${name}'. Known annotations are ${known.map(a => `@${a}`).join(', ')}.`,
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

    /** Layout annotations (see model-annotations.ts): the element they belong to and their arguments. */
    private checkLayoutAnnotation(annotation: ast.Annotation, accept: ValidationAcceptor): void {
        const name = annotation.name;
        const owner = annotationOwner(annotation);
        if (!owner) {
            accept('error', `@${name} must be written directly before the element it belongs to.`, { node: annotation, property: 'name' });
            return;
        }
        const allowed: Record<string, Array<(node: unknown) => boolean>> = {
            at: [ast.isState, ast.isPseudoState, ast.isRegion],
            size: [ast.isState, ast.isRegion],
            regions: [ast.isState],
            via: [ast.isTransition],
            label: [ast.isTransition],
            from: [ast.isTransition],
            to: [ast.isTransition],
            initial: [ast.isStateMachine, ast.isState, ast.isRegion],
            final: [ast.isStateMachine, ast.isState, ast.isRegion],
            definitions: [ast.isStateMachine]
        };
        const elements: Record<string, string> = {
            at: 'states, pseudo states and regions', size: 'states and regions', regions: 'states', via: 'transitions',
            label: 'transitions', from: 'transitions', to: 'transitions', initial: 'the state machine, states and regions', final: 'the state machine, states and regions',
            definitions: 'the state machine'
        };
        if (!allowed[name].some(is => is(owner))) {
            accept('error', `@${name} is a layout annotation of ${elements[name]}.`, { node: annotation, property: 'name' });
            return;
        }
        const siblings = isElementAnnotation(annotation) ? elementAnnotations(owner as AnnotatedElement) : containerAnnotations(owner as AnnotationContainer);
        if (siblings.find(a => a.name === name) !== annotation) {
            accept('error', `Duplicate annotation '@${name}'.`, { node: annotation, property: 'name' });
            return;
        }
        if (name === 'regions') {
            const argument = annotation.arguments[0];
            const value = annotation.arguments.length === 1 && ast.isStringLiteral(argument) ? argument.value : undefined;
            if (value !== 'vertical' && value !== 'horizontal') {
                accept('error', '@regions takes one argument: "vertical" or "horizontal".', { node: annotation, property: 'name' });
            }
            return;
        }
        if (name === 'from' || name === 'to') {
            this.checkAnchorAnnotation(annotation, owner as ast.Transition, accept);
            return;
        }
        const numbers = annotationNumbers(annotation);
        if (!numbers) {
            const index = annotation.arguments.findIndex(a => annotationNumbers({ ...annotation, arguments: [a] } as ast.Annotation) === undefined);
            accept('error', `The arguments of @${name} must be numbers.`, { node: annotation, property: 'arguments', index: Math.max(0, index) });
            return;
        }
        const count = numbers.length;
        if (name === 'via' ? count < 2 || count % 2 !== 0 : name === 'definitions' ? count !== 2 && count !== 4 : count !== 2) {
            const expected = name === 'via' ? 'the coordinates of one or more waypoints (x1, y1, x2, y2, ...)'
                : name === 'definitions' ? 'x, y and optionally width and height'
                    : name === 'size' ? 'width and height' : name === 'label' ? 'the offset dx, dy' : 'x and y';
            accept('error', `@${name} takes ${expected}.`, { node: annotation, property: 'name' });
        }
    }

    /** `@from(side, position)` / `@to(side, position)`: a side of the state and a position along it in percent. */
    private checkAnchorAnnotation(annotation: ast.Annotation, transition: ast.Transition, accept: ValidationAcceptor): void {
        const name = annotation.name;
        const side = annotation.arguments[0];
        if (annotation.arguments.length !== 2 || !ast.isStringLiteral(side) || !isAnchorSide(side.value)) {
            accept('error', `@${name} takes a side ("top", "right", "bottom" or "left") and the position along the side in percent (0 to 100).`,
                { node: annotation, property: 'name' });
            return;
        }
        const anchor = annotationAnchor(annotation);
        if (!anchor) {
            accept('error', `The position of @${name} must be a number.`, { node: annotation, property: 'arguments', index: 1 });
            return;
        }
        if (anchor.position < 0 || anchor.position > 100) {
            accept('error', `The position of @${name} must be between 0 and 100 (percent of the side).`, { node: annotation, property: 'arguments', index: 1 });
            return;
        }
        const end = name === 'from' ? (transition.initial ? undefined : transition.source?.ref) : (transition.final ? undefined : transition.target?.ref);
        const pseudo = name === 'from' ? transition.initial : transition.final;
        if (pseudo || (end && !ast.isState(end))) {
            accept('warning', `@${name} is ignored: the ${name === 'from' ? 'source' : 'target'} of the transition is a pseudo state `
                + '(only the ends at states can be anchored).', { node: annotation, property: 'name' });
        }
    }

    checkAnnotationCombinations(machine: ast.StateMachine, accept: ValidationAcceptor): void {
        // the definition section (annotations of the state machine, interfaces, internal scope) comes first
        const offset = (node: { $cstNode?: { offset: number } }) => node.$cstNode?.offset ?? Number.POSITIVE_INFINITY;
        const firstElement = Math.min(...[...machine.vertices, ...machine.transitions, ...machine.reactions].map(offset));
        const firstScope = Math.min(...machine.scopes.map(offset));
        for (const scope of machine.scopes) {
            if (offset(scope) > firstElement) {
                accept('error', ast.isClassScope(scope)
                    ? `The class section '${scope.access}:' must come before the states and transitions.`
                    : 'Interfaces and the internal scope must come before the states and transitions.', { node: scope });
            }
        }
        for (const annotation of semanticAnnotations(machine)) {
            if (offset(annotation) > Math.min(firstElement, firstScope)) {
                accept('error', `@${annotation.name} must come before the interfaces, states and transitions.`, { node: annotation, property: 'name' });
            }
        }
        const seen = new Map<string, ast.Annotation>();
        for (const annotation of semanticAnnotations(machine)) {
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

    /**
     * The C++ class sections: variables, constants and operations (no events and aliases); variables are
     * data members, so their types cannot be references, and their initial values are evaluated when the
     * object is constructed (see class-members.ts).
     */
    checkClassScope(scope: ast.ClassScope, accept: ValidationAcceptor): void {
        for (const declaration of scope.declarations) {
            if (ast.isEventDeclaration(declaration) || ast.isTypeAliasDeclaration(declaration)) {
                accept('error', `${ast.isEventDeclaration(declaration) ? 'Events' : 'Type aliases'} cannot be declared in '${scope.access}:'; `
                    + `the class sections contain variables, constants and operations (members of the generated C++ class).`, { node: declaration, property: 'name' });
                continue;
            }
            if (!ast.isVariableDeclaration(declaration)) {
                continue;
            }
            const type = declaration.type;
            if (isInstance(declaration)) {
                accept('error', `The submachine instance '${declaration.name}' cannot be declared in '${scope.access}:'; declare it in an interface or the internal scope.`,
                    { node: declaration, property: 'type' });
            } else if (type?.reference) {
                if (declaration.const) {
                    accept('error', `The reference member '${declaration.name}' cannot be declared with 'const'; write 'var ${declaration.name} : const T&' for a reference to a constant.`,
                        { node: declaration, property: 'name' });
                } else if (declaration.initialValue) {
                    accept('error', `The reference member '${declaration.name}' cannot have an initial value: it is bound by the constructor of the generated class.`,
                        { node: declaration, property: 'initialValue' });
                }
                continue;
            } else if (type?.const && !(type.name ?? '').includes('*')) {
                accept('error', `Declare the constant member with 'const ${declaration.name} : ${type.name}' instead of 'const' in the type.`,
                    { node: declaration, property: 'type' });
            }
            if (declaration.initialValue) {
                this.checkMemberInitialValue(declaration, scope, accept);
            }
        }
    }

    /**
     * The initial value of a class member is evaluated when the object is constructed (a default member
     * initializer): it may use literals, C++ constants and the members of the class sections declared before.
     */
    private checkMemberInitialValue(variable: ast.VariableDeclaration, scope: ast.ClassScope, accept: ValidationAcceptor): void {
        const machine = scope.$container;
        const order = machine.scopes.filter(ast.isClassScope).flatMap(s => s.declarations);
        for (const node of AstUtils.streamAst(variable.initialValue!)) {
            let problem: string | undefined;
            if (ast.isValueOfExpression(node) || ast.isActiveExpression(node)) {
                problem = `'${ast.isValueOfExpression(node) ? 'valueof' : 'active'}' cannot be used`;
            } else if (ast.isAssignmentExpression(node) || ast.isPostfixExpression(node)) {
                problem = 'assignments are not allowed';
            } else if (ast.isElementReference(node)) {
                const element = node.element.ref;
                if (!element) {
                    continue;
                }
                if (node.call || ast.isOperationDeclaration(element)) {
                    problem = 'operations cannot be called';
                } else if (!isClassMember(element)) {
                    problem = `'${node.element.$refText}' is not a member of a class section`;
                } else if (order.indexOf(element) >= order.indexOf(variable)) {
                    problem = `'${node.element.$refText}' is declared ${element === variable ? 'here' : 'later'}`;
                }
            }
            if (problem) {
                accept('error', `The initial value of the member '${variable.name}' is evaluated when the object is constructed: ${problem} `
                    + `(use literals, C++ constants and the members declared before).`, { node: variable, property: 'initialValue' });
                return;
            }
        }
    }

    checkTypeReference(reference: ast.TypeReference, accept: ValidationAcceptor): void {
        if (!balancedTemplateArguments(reference.name ?? '')) {
            accept('error', `The angle brackets of the template arguments of '${writtenCppType(reference)}' are not balanced.`, { node: reference, property: 'name' });
            return;
        }
        if (isClassMember(reference)) {
            this.checkClassMemberType(reference, accept);
            return;
        }
        if (reference.const || reference.reference || /[<>*]/.test(reference.name ?? '')) {
            accept('error', `C++ type syntax ('const', references, pointers, template arguments) can only be used in the C++ class sections (public:, protected:, private:).`,
                { node: reference });
            return;
        }
        const builtin = resolveTypeName(reference.name);
        const alias = builtin ? undefined : resolveTypeAlias(reference);
        const machine = builtin || alias ? undefined : machineType(reference);
        const cpp = builtin || alias || machine ? undefined : cppTypeOfReference(reference);
        if (cpp) {
            if (cpp.mapping.error) {
                accept('error', `The C++ type '${reference.name}' cannot be used: ${cpp.mapping.error}.`, { node: reference, property: 'name' });
            } else if (isReadonlyString(cpp.resolved) && !ast.isCastExpression(reference.$container)) {
                accept('error', `The C++ type '${reference.name}' (${cpp.resolved.cppName}) cannot store strings; use 'string' (std::string).`,
                    { node: reference, property: 'name' });
            }
            return;
        }
        if (machine) {
            if (!ast.isVariableDeclaration(reference.$container) || reference.$containerProperty !== 'type') {
                accept('error', `The state machine type '${reference.name}' can only be used as the type of a variable (a submachine instance).`,
                    { node: reference, property: 'name' });
            }
            return;
        }
        if (!builtin && !alias) {
            if (hasUnresolvedHeaders(contextMachine(reference)) && /::|_t$/.test(reference.name)) {
                return; // the unresolved header import is reported
            }
            const container = AstUtils.getContainerOfType(reference, ast.isStateMachine);
            if (container && hasUnresolvedImports(container) && /^[A-Z]/.test(reference.name)) {
                accept('error', `Unknown type '${reference.name}' (an import could not be resolved; does it define '${reference.name}'?).`, { node: reference, property: 'name' });
                return;
            }
            const imported = container ? [...importedMachines(container).keys()] : [];
            const machines = imported.length > 0 ? `, imported state machines (${imported.join(', ')})` : '';
            const headers = cppImports(contextMachine(reference)).headers.length > 0 ? ', the types of the imported C++ headers' : '';
            accept('error', `Unknown type '${reference.name}'. Known types are ${BUILTIN_TYPES.join(', ')}${machines}${headers} and type aliases ('alias Name : type').`,
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

    /**
     * A type in a C++ class section: any C++ type can be declared; types the model does not know (pointers,
     * templates, unknown classes) make the member unusable in the model, which is reported where it is used.
     */
    private checkClassMemberType(reference: ast.TypeReference, accept: ValidationAcceptor): void {
        if (!usesCppTypeSyntax(reference) && machineType(reference)) {
            if (!ast.isVariableDeclaration(reference.$container)) { // (instances are reported at the variable)
                accept('error', `The state machine type '${reference.name}' cannot be used in the C++ class sections.`, { node: reference, property: 'name' });
            }
            return;
        }
        const type = typeOfTypeReference(reference);
        const isReturnType = ast.isOperationDeclaration(reference.$container) && reference.$containerProperty === 'returnType';
        if (type === 'void' && !isReturnType && !(reference.name ?? '').includes('*')) {
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
        if (variable.static) {
            accept('error', `Static members are not supported: '${variable.name}' cannot be 'static' (declare it without 'static').`, { node: variable, keyword: 'static' });
        }
        if (isReferenceMember(variable)) {
            return; // bound by the constructor (checked by checkClassScope)
        }
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
            return;
        }
        this.checkRange(variable.initialValue, storageOfTypeReference(variable.type), `'${variable.name}'`, { node: variable, property: 'initialValue' }, accept);
    }

    /** Warns if a constant integer value is out of the range of the C++ integer storage type it is assigned to. */
    protected checkRange(value: ast.Expression | undefined, storage: ReturnType<typeof storageOfTypeReference>, target: string,
        location: { node: AstNode, property?: string, index?: number }, accept: ValidationAcceptor): void {
        const constant = storage?.kind === 'integer' ? constantInteger(value) : undefined;
        const warning = constant === undefined ? undefined : rangeWarning(constant, storage, target);
        if (warning) {
            accept('warning', warning, location as never);
        }
    }

    checkOperation(operation: ast.OperationDeclaration, accept: ValidationAcceptor): void {
        if (operation.static) {
            accept('error', `Static members are not supported: '${operation.name}' cannot be 'static' (declare it without 'static').`, { node: operation, keyword: 'static' });
        }
        if (operation.const && !isClassMember(operation)) {
            accept('error', `Only the operations of the C++ class sections (public:, protected:, private:) can be const member functions; remove 'const'.`,
                { node: operation, keyword: 'const' });
        }
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
            if (ast.isClassScope(scope)) {
                continue; // members of the generated class, also used by the application's C++ code
            }
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
            return;
        }
        this.checkRange(statement.value, storageOfTypeReference(event.type), `the event '${name}'`, { node: statement, property: 'value' }, accept);
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
        const target = lvalueOf(operand);
        if (target?.partial) {
            this.checkModifiable(target.variable, target.reference, accept);
            const type = inferType(operand);
            if (isValueType(type) && !isNumeric(type)) {
                accept('error', `'${expression.operator}' requires a numeric operand, but the operand is of type ${typeName(type)}.`, { node: expression, property: 'operator' });
            }
            return;
        }
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
            if (isConstantVariable(element) || element.readonly) {
                accept('error', `Cannot modify the ${isConstantVariable(element) ? 'constant' : 'readonly variable'} '${operand.element.$refText}'.`, { node: operand, property: 'element' });
            }
            const type = typeOfVariable(element);
            if (isValueType(type) && !isNumeric(type)) {
                accept('error', `'${expression.operator}' requires a numeric variable, but '${operand.element.$refText}' is ${typeName(type)}.`, { node: expression, property: 'operator' });
            }
        }
    }

    checkAssignment(assignment: ast.AssignmentExpression, accept: ValidationAcceptor): void {
        const left = assignment.left;
        const target = lvalueOf(left);
        let root = left;
        while (ast.isMemberAccessExpression(root) || ast.isIndexExpression(root)) {
            root = root.receiver;
        }
        if (!ast.isElementReference(root)) {
            accept('error', 'The left-hand side of an assignment must be a variable.', { node: left });
            return;
        }
        const element = root.element.ref;
        if (!element) {
            return; // linking error
        }
        if (!target) {
            accept('error', 'The left-hand side of an assignment must be a variable.', { node: left });
            return;
        }
        const name = target.partial ? nodeTextOf(left) : left.$type === 'ElementReference' ? (left as ast.ElementReference).element.$refText : nodeTextOf(left);
        if (!this.checkModifiable(target.variable, target.reference, accept)) {
            return;
        }
        const variableType = target.partial ? inferType(left) : typeOfVariable(target.variable);
        if (isCppType(variableType) && variableType.kind === 'array' && !isAssignableArray(variableType)) {
            accept('error', `The C array '${name}' (${variableType.cppName}) cannot be assigned as a whole; assign its elements.`, { node: left });
            return;
        }
        const valueType = inferType(assignment.value);
        if (valueType === 'void') {
            return; // reported at the operation call
        }
        const operator = compoundOperator(assignment.operator);
        if (!operator) {
            if (!isAssignable(variableType, valueType)) {
                accept('error', `Type mismatch: a value of type ${typeName(valueType)} cannot be assigned to '${name}' of type ${typeName(variableType)}.`,
                    { node: assignment, property: 'value' });
                return;
            }
            this.checkRange(assignment.value, storageOfTarget(left), `'${name}'`, { node: assignment, property: 'value' }, accept);
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

    /** Whether the variable can be modified (reports constants, readonly variables and instances). */
    protected checkModifiable(variable: ast.VariableDeclaration, reference: ast.ElementReference, accept: ValidationAcceptor): boolean {
        const name = reference.element.$refText;
        if (isInstance(variable)) {
            accept('error', `Cannot assign to the submachine instance '${name}': instances cannot be assigned.`, { node: reference, property: 'element' });
            return false;
        }
        if (isConstantVariable(variable)) {
            accept('error', variable.const ? `Cannot assign a value to the constant '${name}'.`
                : `Cannot assign a value to '${name}': it is a reference to a constant ('${writtenCppType(variable.type!)}').`, { node: reference, property: 'element' });
        } else if (variable.readonly) {
            accept('error', `Cannot assign a value to the readonly variable '${name}'.`, { node: reference, property: 'element' });
        }
        return true;
    }

    // -----------------------------------------------------------------------------------------
    // C++ names, members and elements

    checkCppReference(reference: ast.CppReference, accept: ValidationAcceptor): void {
        const resolved = resolveCppValue(reference);
        if (resolved.error && !(resolved.declaration === undefined && hasUnresolvedHeaders(contextMachine(reference)))) {
            accept('error', resolved.error, { node: reference, property: 'name' });
        }
    }

    checkMemberAccess(expression: ast.MemberAccessExpression, accept: ValidationAcceptor): void {
        const receiver = inferType(expression.receiver);
        if (!isValueType(receiver)) {
            return;
        }
        const member = memberOf(receiver, expression.member);
        if (member.error) {
            accept('error', `${capitalize(member.error)}.`, { node: expression, property: 'member' });
        }
    }

    checkIndex(expression: ast.IndexExpression, accept: ValidationAcceptor): void {
        const receiver = inferType(expression.receiver);
        if (isValueType(receiver)) {
            const element = elementOf(receiver);
            if (!element) {
                accept('error', `Only values of C++ array types have elements, but the value is of type ${typeName(receiver)}.`, { node: expression, property: 'receiver' });
            } else {
                const index = constantInteger(expression.index);
                if (index !== undefined && (index < 0n || index >= BigInt(element.length))) {
                    accept('error', `The index ${index} is out of the bounds of '${typeName(receiver)}' (0..${element.length - 1}).`, { node: expression, property: 'index' });
                }
            }
        }
        const index = promotedType(inferType(expression.index));
        if (isValueType(index) && index !== 'integer') {
            accept('error', `The index must be of type integer, but is of type ${typeName(index)}.`, { node: expression, property: 'index' });
        }
    }

    /** Members in the name of an element reference (`pos.x`). */
    protected checkReferenceMembers(reference: ast.ElementReference, members: readonly string[], accept: ValidationAcceptor): void {
        const element = reference.element.ref;
        const base = reference.element.$refText.replace(/\s+/g, '').split('.').slice(0, -members.length).join('.');
        if (!ast.isVariableDeclaration(element) || reference.call) {
            accept('error', `'${base}' is not a variable: '${members.join('.')}' cannot be accessed.`, { node: reference, property: 'element' });
            return;
        }
        let type = typeOfDeclaration(element);
        if (type === 'instance') {
            const machine = machineType(element.type);
            accept('error', `The state machine '${machine?.name ?? element.type?.name}' of the instance '${base}' has no interface member '${members.join('.')}'.`,
                { node: reference, property: 'element' });
            return;
        }
        for (const [i, name] of members.entries()) {
            if (!isValueType(type)) {
                return;
            }
            const member = memberOf(type, name);
            if (member.error) {
                const path = [base, ...members.slice(0, i)].join('.');
                accept('error', `Cannot access '${name}' of '${path}': ${member.error}.`, { node: reference, property: 'element' });
                return;
            }
            type = member.type!;
        }
        void memberPathType;
    }

    checkBinary(expression: ast.BinaryExpression, accept: ValidationAcceptor): void {
        const operator = expression.operator;
        // unscoped enums are integers in arithmetic, bitwise and relational operations (C++ promotion)
        const equality = operator === '==' || operator === '!=';
        const left = equality ? inferType(expression.left) : promotedType(inferType(expression.left));
        const right = equality ? inferType(expression.right) : promotedType(inferType(expression.right));
        const requireOperands = (predicate: (type: DevmType) => boolean, description: string) => {
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
                // values of the same enum (also of an enum class) are ordered by their values, like in C++
                if (binaryResultType(operator, inferType(expression.left), inferType(expression.right)) === undefined) {
                    requireOperands(isNumeric, 'numeric');
                }
                break;
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
        const type = promotedType(inferType(expression.operand));
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
        if (!this.checkUsable(element, reference, 'element', accept)) {
            return;
        }
        const members = referenceMembers(reference);
        if (members.length > 0) {
            this.checkReferenceMembers(reference, members, accept);
            return;
        }
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

    /** Reports a member of a C++ class section that cannot be used in the model (see class-members.ts); false if reported. */
    protected checkUsable(declaration: ast.Declaration | undefined, node: AstNode, property: string, accept: ValidationAcceptor): boolean {
        const unusable = declaration ? unusableReason(declaration) : undefined;
        if (unusable) {
            accept('error', `The member '${declaration!.name}' cannot be used in the model: ${unusable}. It can only be used by the C++ code of the application.`,
                { node, property } as never);
        }
        return unusable === undefined;
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
            } else {
                this.checkRange(argument.value, storageOfTypeReference(parameter.type), `the parameter '${parameter.name}'`, { node: argument, property: 'value' }, accept);
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
export class DevmDocumentValidator extends DefaultDocumentValidator {

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

/** Whether a type reference denotes a built-in type, a type alias, an imported state machine or a C++ type. */
export function isKnownType(reference: ast.TypeReference): boolean {
    return resolveTypeName(reference.name) !== undefined || resolveTypeAlias(reference) !== undefined || machineType(reference) !== undefined
        || cppTypeOfReference(reference) !== undefined;
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The text of a node without line breaks (for messages). */
function nodeTextOf(node: AstNode): string {
    return (node.$cstNode?.text ?? '').replace(/\s+/g, ' ').trim();
}

/** Unscoped enums are integers as index / operand. */
function promotedType(type: DevmType): DevmType {
    return isUnscopedEnum(type) ? 'integer' : type;
}

function isFreeAnnotationArgument(node: AstNode): boolean {
    const annotation = AstUtils.getContainerOfType(node, ast.isAnnotation);
    return annotation !== undefined && !EXPRESSION_ANNOTATIONS.includes(annotation.name);
}

/** Types which denote a value that can be checked: `error` has been reported before, `void` at the operation call. */
function isValueType(type: DevmType): boolean {
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
