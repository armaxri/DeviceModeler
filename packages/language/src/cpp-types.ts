import { AstUtils, type AstNode } from 'langium';
import * as ast from './generated/ast.js';
import type { CppDeclaration, CppArrayType, CppEnumType, CppResolvedField, CppResolvedType, CppStructType } from './cpp-header/model.js';
import type { CppConstantInfo, CppTypeIndex } from './cpp-header/type-index.js';
import { cppImports } from './imports.js';
import type { HsmType } from './hsm-typesystem.js';

/**
 * The C++ types and constants of imported headers in the HSM language (see docs/cpp-integration.md).
 *
 * Mapping of the resolved C++ types (`CppResolvedType`) onto the HSM type system:
 * - integer types (`std::uint8_t`, `int`, `char`, ...) are `integer`; their width is kept as the
 *   *storage type* of variables, members, event values and parameters: values are converted to the
 *   storage type on assignment (wrap-around like the generated C++ code), literals out of range are
 *   reported,
 * - `float` / `double` are `real` (`float` storage rounds to single precision), `bool` is `boolean`,
 *   `std::string` is `string` (`const char*` / `std::string_view` constants can be read as strings),
 * - enums, structs and arrays are types of their own ({@link CppHsmType}, identified by the
 *   qualified C++ name): enum values are compared with `==` / `!=` (unscoped enums convert to integer
 *   like in C++), structs have members (`pos.x`) and are assigned as a whole, arrays have elements (`a[i]`),
 * - everything else (pointers, unions, templates, ...) is unsupported (an error where it is used).
 */

/** An imported C++ enum, struct or array type. */
export interface CppHsmType {
    readonly kind: 'enum' | 'struct' | 'array';
    /** Qualified C++ name (canonical spelling: aliases are resolved), e.g. `motor::Mode`. */
    readonly cppName: string;
    readonly resolved: CppEnumType | CppStructType | CppArrayType;
    /** The index the type was resolved with (used to compute default values). */
    readonly index: CppTypeIndex;
}

export function isCppType(type: unknown): type is CppHsmType {
    return typeof type === 'object' && type !== null && 'resolved' in type && 'cppName' in type;
}

export function isEnumType(type: HsmType | undefined): type is CppHsmType & { resolved: CppEnumType } {
    return isCppType(type) && type.kind === 'enum';
}

export function isStructType(type: HsmType | undefined): type is CppHsmType & { resolved: CppStructType } {
    return isCppType(type) && type.kind === 'struct';
}

export function isArrayType(type: HsmType | undefined): type is CppHsmType & { resolved: CppArrayType } {
    return isCppType(type) && type.kind === 'array';
}

/** Whether a type is an unscoped enum (which converts implicitly to integer, as in C++). */
export function isUnscopedEnum(type: HsmType | undefined): boolean {
    return isEnumType(type) && !type.resolved.scoped;
}

/** The HSM type of a C++ type, or the reason why it cannot be used. */
export type CppTypeMapping = { readonly type: HsmType, readonly error?: undefined } | { readonly error: string, readonly type?: undefined };

const typeCache = new WeakMap<object, CppHsmType>();

/** The HSM type of a resolved C++ type. */
export function hsmTypeOfCpp(resolved: CppResolvedType, index: CppTypeIndex): CppTypeMapping {
    switch (resolved.kind) {
        case 'integer':
            return resolved.bits > 64 ? { error: `${resolved.bits}-bit integers are not supported` } : { type: 'integer' };
        case 'real':
            return { type: 'real' };
        case 'boolean':
            return { type: 'boolean' };
        case 'string':
            return { type: 'string' };
        case 'enum':
        case 'struct':
        case 'array': {
            if (resolved.kind === 'array') {
                if (resolved.length === undefined) {
                    return { error: `arrays of unknown length are not supported ('${resolved.cppName}')` };
                }
                const element = hsmTypeOfCpp(resolved.element, index);
                if (element.error) {
                    return { error: `the element type of '${resolved.cppName}' is not supported: ${element.error}` };
                }
            }
            if (resolved.kind === 'struct') {
                for (const field of resolved.fields) {
                    const fieldType = hsmTypeOfCpp(field.type, index);
                    if (fieldType.error) {
                        return { error: `the member '${field.name}' of '${resolved.cppName}' has an unsupported type: ${fieldType.error}` };
                    }
                }
            }
            let type = typeCache.get(resolved);
            if (!type) {
                type = { kind: resolved.kind, cppName: resolved.cppName, resolved, index } as CppHsmType;
                typeCache.set(resolved, type);
            }
            return { type };
        }
        case 'unsupported':
            return { error: `'${resolved.cppName}' is not supported (${resolved.reason})` };
    }
}

/** Whether a string storage type is only readable (`const char*`, `std::string_view`): only `std::string` can be stored. */
export function isReadonlyString(storage: CppResolvedType | undefined): boolean {
    return storage?.kind === 'string' && storage.cppName !== 'std::string';
}

// ---------------------------------------------------------------------------------------------
// Context

/**
 * The state machine whose imports are visible at `node`: the containing state machine, or in a test
 * document the state machine tested by the test class.
 */
export function contextMachine(node: AstNode | undefined): ast.StateMachine | undefined {
    if (!node) {
        return undefined;
    }
    const machine = AstUtils.getContainerOfType(node, ast.isStateMachine);
    if (machine) {
        return machine;
    }
    return AstUtils.getContainerOfType(node, ast.isTestClass)?.machine?.ref;
}

/** The index of the C++ headers visible at `node`. */
export function cppIndexAt(node: AstNode | undefined): CppTypeIndex {
    return cppImports(contextMachine(node)).index;
}

// ---------------------------------------------------------------------------------------------
// Type references

/** A type reference resolved as C++ type. */
export interface CppTypeResolution {
    /** The C++ type (aliases resolved). */
    readonly resolved: CppResolvedType;
    /** The HSM type, or the reason why the type cannot be used. */
    readonly mapping: CppTypeMapping;
    /** The declaration of the name (enum, class, alias), `undefined` for fundamental / library types. */
    readonly declaration?: CppDeclaration;
}

/**
 * C++ keywords naming fundamental types are not type names of the HSM language: models use `integer`,
 * `real`, `boolean` or the `<cstdint>` typedefs (`int32_t`, `uint8_t`, ...), which are always known.
 * (Fundamental types are of course used inside the headers.)
 */
const FUNDAMENTAL_TYPE_NAMES: ReadonlySet<string> = new Set([
    'int', 'long', 'short', 'char', 'float', 'double', 'bool', 'unsigned', 'signed', 'void', 'wchar_t', 'char8_t', 'char16_t', 'char32_t', 'auto'
]);

const referenceCache = new WeakMap<ast.TypeReference, { index: CppTypeIndex, result: CppTypeResolution | undefined }>();

/**
 * Resolves the name of a type reference as C++ type in the headers imported by the context machine:
 * `motor::Mode`, `::Color`, `uint8_t`, `std::int32_t`, `int`, `double`. `undefined` if the name is
 * not a C++ type (names with `.` never are).
 */
export function cppTypeOfReference(reference: ast.TypeReference): CppTypeResolution | undefined {
    let name = reference.name;
    // the C++ class sections use C++ types: fundamental types, pointers (`const` before a pointer type
    // belongs to the pointee: `const char*`), template arguments (see class-members.ts)
    const classMember = AstUtils.getContainerOfType(reference, ast.isClassScope) !== undefined;
    if (!name || name.includes('.') || (!classMember && FUNDAMENTAL_TYPE_NAMES.has(name.split(' ')[0]))) {
        return undefined;
    }
    if (reference.const && name.includes('*')) {
        name = `const ${name}`;
    }
    const index = cppIndexAt(reference);
    const cached = referenceCache.get(reference);
    if (cached && cached.index === index) {
        return cached.result;
    }
    let result: CppTypeResolution | undefined;
    const resolved = index.resolveType(name);
    if (resolved) {
        const declaration = index.lookup(name);
        result = {
            resolved, mapping: hsmTypeOfCpp(resolved, index),
            declaration: declaration && declaration.kind !== 'namespace' ? declaration : undefined
        };
    }
    referenceCache.set(reference, { index, result });
    return result;
}

// ---------------------------------------------------------------------------------------------
// Member paths of element references (`pos.x`)

const memberPaths = new WeakMap<ast.ElementReference, readonly string[]>();

/** Records the members of an element reference (called by the linker). */
export function setReferenceMembers(reference: ast.ElementReference, members: readonly string[] | undefined): void {
    if (members && members.length > 0) {
        memberPaths.set(reference, members);
    } else {
        memberPaths.delete(reference);
    }
}

/**
 * The members following the referenced declaration in the name of an element reference: `['x']`
 * for `pos.x`, `['home', 'y']` for `cfg.home.y`, `[]` if the whole name denotes a declaration.
 */
export function referenceMembers(reference: ast.ElementReference): readonly string[] {
    // the linker records the members when it resolves the reference
    void reference.element?.ref;
    return memberPaths.get(reference) ?? [];
}

/** The name of the referenced declaration without the members (`pos` for `pos.x`). */
export function referenceBaseText(reference: ast.ElementReference): string {
    const text = (reference.element?.$refText ?? '').replace(/\s+/g, '');
    const members = referenceMembers(reference);
    return members.length === 0 ? text : text.split('.').slice(0, -members.length).join('.');
}

// ---------------------------------------------------------------------------------------------
// Members and elements

/** A member of a struct type. */
export type MemberResolution = { readonly field: CppResolvedField, readonly type: HsmType, readonly error?: undefined } | { readonly error: string, readonly type?: undefined, readonly field?: undefined };

/** The member `name` of a value of type `type`. */
export function memberOf(type: HsmType, name: string): MemberResolution {
    if (!isStructType(type)) {
        return { error: `a value of type ${typeLabel(type)} has no members` };
    }
    const field = type.resolved.fields.find(f => f.name === name);
    if (!field) {
        const names = type.resolved.fields.map(f => f.name);
        return { error: `'${type.cppName}' has no member '${name}'${names.length > 0 ? ` (members: ${names.join(', ')})` : ''}` };
    }
    const mapping = hsmTypeOfCpp(field.type, type.index);
    return mapping.error ? { error: `the member '${name}' of '${type.cppName}' cannot be used: ${mapping.error}` } : { field, type: mapping.type! };
}

/** The element type of an array type. */
export function elementOf(type: HsmType): { readonly type: HsmType, readonly storage: CppResolvedType, readonly length: number } | undefined {
    if (!isArrayType(type)) {
        return undefined;
    }
    const mapping = hsmTypeOfCpp(type.resolved.element, type.index);
    return mapping.type ? { type: mapping.type, storage: type.resolved.element, length: type.resolved.length ?? 0 } : undefined;
}

function typeLabel(type: HsmType): string {
    return isCppType(type) ? type.cppName : type === 'error' ? 'unknown' : type === 'instance' ? 'state machine instance' : type;
}

// ---------------------------------------------------------------------------------------------
// Constants and enumerators (`motor::kMaxSpeed`, `motor::Mode::Fast`)

/** A resolved C++ name used as value. */
export type CppValueResolution =
    | { readonly info: CppConstantInfo, readonly type: HsmType, readonly index: CppTypeIndex, readonly error?: undefined }
    | { readonly error: string, readonly declaration?: CppDeclaration, readonly type?: undefined, readonly info?: undefined };

const valueCache = new WeakMap<ast.CppReference, { index: CppTypeIndex, result: CppValueResolution }>();

/** Resolves a C++ name used as value: a constant or an enumerator of the imported headers. */
export function resolveCppValue(reference: ast.CppReference): CppValueResolution {
    const index = cppIndexAt(reference);
    const cached = valueCache.get(reference);
    if (cached && cached.index === index) {
        return cached.result;
    }
    const result = computeCppValue(reference.name ?? '', index);
    valueCache.set(reference, { index, result });
    return result;
}

function computeCppValue(name: string, index: CppTypeIndex): CppValueResolution {
    const declaration = index.lookup(name);
    if (!declaration) {
        return { error: index.headers.length === 0
            ? `Unknown C++ name '${name}': no C/C++ header is imported ('import "file.h"').`
            : `Unknown C++ name '${name}': it is not declared in the imported headers.` };
    }
    const info = index.constant(name);
    if (!info) {
        const what = declaration.kind === 'namespace' ? 'a namespace'
            : declaration.kind === 'enum' || declaration.kind === 'record' || declaration.kind === 'alias' ? 'a type'
                : declaration.kind === 'field' ? 'a data member' : 'not a constant';
        return { error: `'${name}' is ${what}, not a constant or enumerator.`, declaration };
    }
    if (info.value === undefined) {
        return { error: `The value of the C++ constant '${name}' is unknown: ${info.error ?? 'it cannot be evaluated'}.`, declaration: info.declaration };
    }
    const mapping = hsmTypeOfCpp(info.type, index);
    if (mapping.error) {
        return { error: `The C++ constant '${name}' cannot be used: ${mapping.error}.`, declaration: info.declaration };
    }
    return { info, type: mapping.type!, index };
}
