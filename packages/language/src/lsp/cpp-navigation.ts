import { AstUtils, CstUtils, type AstNode, type CstNode, type LangiumDocument } from 'langium';
import type { Range } from 'vscode-languageserver-types';
import * as ast from '../generated/ast.js';
import type { CppDeclaration, CppRange, CppResolvedType, CppTypeRef } from '../cpp-header/model.js';
import type { CppTypeIndex } from '../cpp-header/type-index.js';
import { cppTypeOfReference, isCppType, referenceMembers } from '../cpp-types.js';
import { resolvedImports } from '../imports.js';
import { typeOfDeclaration, typeOfTypeReference, type HsmType } from '../hsm-typesystem.js';
import { cppElementAt, type CppElementAt, type CppLocation } from './cpp-lsp.js';

/**
 * Navigation from models and test files into the imported C/C++ headers (go to definition,
 * declaration and type definition), shared by the language server of the VS Code extension and the
 * tests. The locations are the `fileName` (URI of the header) and the ranges recorded by the header
 * parser for every declaration; the origin is the segment of the qualified name at the position
 * (`app`, `Mode` or `Fast` in `app::Mode::Fast`), so that each segment leads to its own declaration.
 */

/** What is asked for: the definition, all declarations (definition first) or the declaration of the type. */
export type CppNavigationKind = 'definition' | 'declaration' | 'typeDefinition';

function toRange(range: CppRange): Range {
    return { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } };
}

/** The location of a declaration in its header. */
export function cppDeclarationLocation(declaration: CppDeclaration, origin: Range): CppLocation {
    return { uri: declaration.fileName, range: toRange(declaration.range), selection: toRange(declaration.nameRange), origin };
}

/**
 * The header locations for a position of a model or test document (empty if the position is not on a
 * C++ name, struct member or header import):
 * - `definition`: the definition of the name: the enum definition rather than an opaque declaration, the
 *   target of a using-declaration (`using hw::Channel;`) rather than the using-declaration, the first
 *   block of a namespace; for a header import the header itself,
 * - `declaration`: all declarations of the name, the definition first (all blocks of a namespace,
 *   opaque declarations of an enum, a using-declaration and its target),
 * - `typeDefinition`: the declaration of the type of a constant, enumerator or struct member (the enum
 *   or struct, also behind aliases).
 */
export function cppLocations(document: LangiumDocument, offset: number, kind: CppNavigationKind): CppLocation[] {
    const element = cppElementAt(document, offset);
    if (element?.declaration) {
        const declarations = kind === 'definition' ? [cppDefinitionOf(element.declaration, element.index)]
            : kind === 'declaration' ? cppDeclarationsOf(element.declaration, element.index)
                : typeDeclarationsOf(element);
        return unique(declarations).map(d => cppDeclarationLocation(d, element.origin));
    }
    if (kind === 'typeDefinition') {
        return [];
    }
    const header = headerImportAt(document, offset);
    if (header) {
        const start = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        return [{ uri: header.uri, range: start, selection: start, origin: header.origin }];
    }
    return [];
}

/** The header of a header import at an offset (`import "motor.h"`), if it was found. */
export function headerImportAt(document: LangiumDocument, offset: number): { uri: string, origin: Range } | undefined {
    const root = document.parseResult.value.$cstNode;
    const leaf = root ? CstUtils.findLeafNodeAtOffset(root, offset) : undefined;
    const node = leaf?.astNode;
    if (!leaf || !ast.isImportPath(node)) {
        return undefined;
    }
    const machine = AstUtils.getContainerOfType(node, ast.isStateMachine);
    const resolved = machine ? resolvedImports(machine).find(i => i.node === node) : undefined;
    return resolved?.kind === 'header' && resolved.header?.found && resolved.uri ? { uri: resolved.uri.toString(), origin: leaf.range } : undefined;
}

/** The definition of a declaration: the target of a using-declaration, otherwise the declaration itself. */
export function cppDefinitionOf(declaration: CppDeclaration, index: CppTypeIndex, depth = 0): CppDeclaration {
    const target = depth < 8 ? usingTarget(declaration, index) : undefined;
    return target ? cppDefinitionOf(target, index, depth + 1) : declaration;
}

/** All declarations of the entity a declaration declares, the definition first. */
export function cppDeclarationsOf(declaration: CppDeclaration, index: CppTypeIndex, depth = 0): CppDeclaration[] {
    const target = depth < 8 ? usingTarget(declaration, index) : undefined;
    if (target) {
        return [...cppDeclarationsOf(target, index, depth + 1), declaration];
    }
    if (declaration.kind === 'namespace' || declaration.kind === 'enum') {
        const same = index.allDeclarations().filter(d => d.kind === declaration.kind && d.qualifiedName === declaration.qualifiedName);
        const definitions = same.filter(d => d.kind !== 'enum' || !d.opaque);
        return [declaration, ...definitions, ...same];
    }
    return [declaration];
}

/** The declaration named by a using-declaration (`using hw::Channel;`), `undefined` for other declarations. */
function usingTarget(declaration: CppDeclaration, index: CppTypeIndex): CppDeclaration | undefined {
    if (declaration.kind !== 'alias' || declaration.syntax !== 'usingDeclaration' || declaration.type.name.kind !== 'named') {
        return undefined;
    }
    const target = index.lookup(declaration.type.name.name, index.scopeOf(declaration));
    return target && target !== declaration ? target : undefined;
}

/** The declaration of a resolved type: the enum or struct (of the elements of an array). */
function declarationOfType(type: CppResolvedType | undefined): CppDeclaration | undefined {
    switch (type?.kind) {
        case 'enum':
        case 'struct':
            return type.declaration;
        case 'array':
            return declarationOfType(type.element);
        default:
            return undefined;
    }
}

/** The declaration of the type name of a declaration (`Rpm` of `Rpm speed;`), for types that are not enums or structs. */
function namedTypeOf(type: CppTypeRef, owner: CppDeclaration, index: CppTypeIndex): CppDeclaration | undefined {
    if (type.name.kind !== 'named' || type.pointer > 0) {
        return undefined;
    }
    const found = index.lookup(type.name.name, index.scopeOf(owner));
    return found && found.kind !== 'namespace' && found !== owner ? cppDefinitionOf(found, index) : undefined;
}

/** The declarations of the type of a C++ element (the enum of an enumerator, the struct of a member). */
function typeDeclarationsOf(element: CppElementAt): CppDeclaration[] {
    const { declaration, index } = element;
    if (element.field) {
        const type = declarationOfType(element.field.type) ?? namedTypeOf(element.field.declaration.type, element.field.declaration, index);
        return type ? [type] : [];
    }
    switch (declaration?.kind) {
        case 'constant':
        case 'enumerator': {
            const type = declarationOfType(index.constant(declaration)?.type)
                ?? (declaration.kind === 'constant' ? namedTypeOf(declaration.type, declaration, index) : undefined);
            return type ? [type] : [];
        }
        case 'enum':
        case 'record':
            return [cppDefinitionOf(declaration, index)];
        case 'alias': {
            const definition = cppDefinitionOf(declaration, index);
            if (definition.kind !== 'alias') {
                return typeDeclarationsOf({ ...element, declaration: definition });
            }
            // an alias of an enum or struct leads to it, an alias of a built-in type to the alias
            return [declarationOfType(index.typeOf(definition)) ?? definition];
        }
        default:
            return [];
    }
}

/**
 * Go to type definition from an element of a model (a variable, event, parameter, operation or type
 * alias, at its declaration or at a reference to it) whose type is a C++ type: the enum or struct
 * declaration, or the C++ alias (`using Rpm = std::int32_t;`) for types that are not enums or structs.
 */
export function cppTypeLocationsOf(target: AstNode, origin: Range): CppLocation[] {
    const reference = typeReferenceOf(target);
    const resolution = reference ? cppTypeOfReference(reference) : undefined;
    let declaration = declarationOfType(resolution?.resolved) ?? resolution?.declaration;
    if (!declaration) {
        const type: HsmType | undefined = reference ? typeOfTypeReference(reference) : ast.isDeclaration(target) ? typeOfDeclaration(target) : undefined;
        declaration = isCppType(type) ? declarationOfType(type.resolved) : undefined;
    }
    return declaration ? [cppDeclarationLocation(declaration, origin)] : [];
}

/** The type reference of a declaration (the return type of an operation). */
function typeReferenceOf(node: AstNode): ast.TypeReference | undefined {
    if (ast.isVariableDeclaration(node) || ast.isEventDeclaration(node) || ast.isParameter(node) || ast.isTypeAliasDeclaration(node)) {
        return node.type;
    }
    if (ast.isOperationDeclaration(node)) {
        return node.returnType;
    }
    return undefined;
}

/**
 * The range of the name of the referenced declaration in an element reference followed by struct
 * members (`cfg` in `cfg.reading.speed`, `Iface.pos` in `Iface.pos.x`); `undefined` if there are no members.
 */
export function referenceBaseRange(reference: ast.ElementReference): Range | undefined {
    const members = referenceMembers(reference);
    const cst = reference.element?.$refNode;
    if (members.length === 0 || !cst) {
        return undefined;
    }
    const names: CstNode[] = CstUtils.flattenCst(cst).filter(n => !n.hidden && /^\w+$/.test(n.text)).toArray();
    const last = names[names.length - 1 - members.length];
    return last ? { start: cst.range.start, end: last.range.end } : undefined;
}

function unique<T>(items: readonly T[]): T[] {
    return [...new Set(items)];
}
