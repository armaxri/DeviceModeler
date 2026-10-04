import { AstUtils, type AstNode } from 'langium';
import * as ast from './generated/ast.js';
import { cppTypeOfReference, isReadonlyString } from './cpp-types.js';
import { resolveTypeAlias, resolveTypeName, typeName, typeOfTypeReference } from './typesystem.js';

/**
 * The C++ class sections `public:`, `protected:` and `private:` (see docs/language.md#c-class-sections).
 *
 * Their declarations are members of the generated C++ class: variables and constants are data members,
 * operations are member functions which the application implements. The types are C++ types, written as
 * in C++ (`unsigned int`, `const app::Config&`, `hal::Driver*`, `std::vector<int>`). A member can be used
 * in the model (guards, effects, initial values, unit tests, the simulator) if the type system knows its
 * types – the C++ types of the imported headers, fundamental types, the model types and aliases (`const T&`
 * parameters are values of type `T`). Members with other types (pointers, templates, unknown classes) are
 * declared in the generated class for the C++ code of the application, but cannot be used in the model
 * ({@link unusableReason}).
 */

/** Words of fundamental C++ types (the keywords of `FundamentalTypeName` in statemachine.langium). */
export const FUNDAMENTAL_TYPE_WORDS: ReadonlySet<string> = new Set([
    'void', 'bool', 'char', 'short', 'int', 'long', 'signed', 'unsigned', 'float', 'double'
]);

/** Whether a node is (or is contained in) a declaration of a C++ class section. */
export function isClassMember(node: AstNode | undefined): boolean {
    return classScopeOf(node) !== undefined;
}

/** The class section containing a node. */
export function classScopeOf(node: AstNode | undefined): ast.ClassScope | undefined {
    return node ? AstUtils.getContainerOfType(node, ast.isClassScope) : undefined;
}

/** Whether a type reference uses C++ type syntax: `const`, references, pointers, template arguments, fundamental types. */
export function usesCppTypeSyntax(reference: ast.TypeReference): boolean {
    const name = reference.name ?? '';
    return reference.const || reference.reference !== undefined || /[<>*]/.test(name) || FUNDAMENTAL_TYPE_WORDS.has(name.split(' ')[0]) && name !== 'void';
}

/** The C++ type as written in the model, with normalized white space (`const app::Config&`). */
export function writtenCppType(reference: ast.TypeReference): string {
    return `${reference.const ? 'const ' : ''}${reference.name ?? ''}${reference.reference ?? ''}`;
}

/** Whether the type reference denotes a built-in type of the models or a type alias (not a C++ type). */
export function isDevmTypeReference(reference: ast.TypeReference): boolean {
    return resolveTypeName(reference.name) !== undefined || resolveTypeAlias(reference) !== undefined;
}

/** Whether the angle brackets of the template arguments in a type name are balanced. */
export function balancedTemplateArguments(name: string): boolean {
    let depth = 0;
    for (const char of name) {
        depth += char === '<' ? 1 : char === '>' ? -1 : 0;
        if (depth < 0) {
            return false;
        }
    }
    return depth === 0;
}

/**
 * Why a type of a class member cannot be used in the model, `undefined` if it can. `role` describes the
 * place of the type in messages (`the type`, `the parameter 'x'`).
 */
function unusableType(reference: ast.TypeReference | undefined, role: string, place: 'variable' | 'parameter' | 'result'): string | undefined {
    if (!reference) {
        return undefined;
    }
    if (place === 'parameter' && reference.reference && (!reference.const || reference.reference === '&&')) {
        return `${role} is a ${reference.const ? 'rvalue' : 'non-const'} reference ('${writtenCppType(reference)}')`;
    }
    const cpp = cppTypeOfReference(reference);
    if (isReadonlyString(cpp?.resolved)) {
        return `${role} '${writtenCppType(reference)}' cannot hold the strings of the model (std::string)`;
    }
    if (typeOfTypeReference(reference) !== 'error') {
        return undefined;
    }
    const reason = cpp?.mapping.error ?? `'${reference.name}' is not a type of the model or of the imported headers`;
    return `${role} '${writtenCppType(reference)}' is not a type of the model: ${reason}`;
}

/**
 * Why a member of a class section cannot be used in the model (its type, or a parameter or return
 * type of an operation is not a type of the model), `undefined` if it can be used. Members of other
 * scopes can always be used.
 */
export function unusableReason(declaration: ast.Declaration): string | undefined {
    if (!isClassMember(declaration)) {
        return undefined;
    }
    if (ast.isVariableDeclaration(declaration)) {
        return unusableType(declaration.type, 'its type', 'variable');
    }
    if (ast.isOperationDeclaration(declaration)) {
        for (const parameter of declaration.parameters) {
            const reason = unusableType(parameter.type, `the type of the parameter '${parameter.name}'`, 'parameter');
            if (reason) {
                return reason;
            }
        }
        return unusableType(declaration.returnType, 'the return type', 'result');
    }
    return undefined;
}

/**
 * Whether a variable of a class section is a reference member (`var config : const app::Config&`): it is
 * bound by the constructor of the generated class (see docs/cpp-generator.md#c-class-sections).
 */
export function isReferenceMember(variable: ast.VariableDeclaration): boolean {
    return isClassMember(variable) && variable.type?.reference !== undefined;
}

/** Whether the model cannot assign a variable: constants and references to const (`const T&`) of class sections. */
export function isConstantVariable(variable: ast.VariableDeclaration): boolean {
    return variable.const || (isReferenceMember(variable) && !!variable.type?.const);
}

/** Whether a declaration can be used in the model (see {@link unusableReason}). */
export function isUsableInModel(declaration: ast.Declaration): boolean {
    return unusableReason(declaration) === undefined;
}

/** A short description of a class member type for messages (`unsigned int (integer)`). */
export function describeMemberType(reference: ast.TypeReference): string {
    const written = writtenCppType(reference);
    const type = typeName(typeOfTypeReference(reference));
    return written === type ? written : `${written} (${type})`;
}
