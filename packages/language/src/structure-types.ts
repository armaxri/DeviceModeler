import * as ast from './generated/ast.js';
import type { CppDeclaration } from './cpp-header/model.js';
import { devmTypeOfCpp, isStructType } from './cpp-types.js';
import { structureCppImports, structureModelOf, visibleElements } from './structure-imports.js';
import { isAssignable, resolveTypeName, sameType, typeName, type DevmType } from './typesystem.js';

/**
 * Data types of the structure language (`.devm`): the types of sync ports, event payloads and struct
 * fields.
 *
 * A type name denotes (in this order) a built-in type (`integer`, `real`, `boolean`, `string`), a
 * struct of the model or of an imported structure file (`Position`, `types.Position` for a file with
 * `package types`) or a C++ type of an imported header (`motor::Mode`, `uint8_t`, mapped like in state
 * machines, see cpp-types.ts).
 *
 * The types share the type system of the state machines ({@link DevmType}); structs of structure files
 * are types of their own ({@link StructDataType}). Compatibility (see {@link isDataAssignable}):
 * identical types, `integer` -> `real`, and a struct of a structure file is the same type as a C++
 * struct with the same (unqualified) name, so a port typed `Position` matches a variable of a state
 * machine typed `geo::Position` of an imported header.
 */

/** A struct declared in a structure file. */
export interface StructDataType {
    readonly kind: 'structDeclaration';
    readonly struct: ast.StructDeclaration;
}

/** The type of a port (data or event payload) or struct field. */
export type DataType = DevmType | StructDataType;

export function isStructDataType(type: unknown): type is StructDataType {
    return typeof type === 'object' && type !== null && (type as StructDataType).kind === 'structDeclaration';
}

/** The meaning of a type name. */
export type DataTypeResolution =
    | { readonly kind: 'data', readonly type: DataType, readonly struct?: ast.StructDeclaration, readonly cpp?: CppDeclaration }
    | { readonly kind: 'error', readonly message: string };

const structTypes = new WeakMap<ast.StructDeclaration, StructDataType>();

/** The type of a struct of a structure file. */
export function structType(struct: ast.StructDeclaration): StructDataType {
    let type = structTypes.get(struct);
    if (!type) {
        type = { kind: 'structDeclaration', struct };
        structTypes.set(struct, type);
    }
    return type;
}

/** Resolves a type name of a structure file (see the comment of this module). */
export function resolveDataType(reference: ast.DataTypeReference | undefined): DataTypeResolution {
    const name = reference?.name;
    if (!reference || !name) {
        return { kind: 'error', message: 'The type is missing.' };
    }
    const builtin = resolveTypeName(name);
    if (builtin) {
        return { kind: 'data', type: builtin };
    }
    const model = structureModelOf(reference);
    const element = model ? visibleElements(model).get(name) : undefined;
    if (ast.isStructDeclaration(element)) {
        return { kind: 'data', type: structType(element), struct: element };
    }
    if (element) {
        return { kind: 'error', message: `'${name}' is a component type, not a data type.` };
    }
    if (!name.includes('.')) {
        const index = structureCppImports(model).index;
        const resolved = index.resolveType(name);
        if (resolved) {
            const mapping = devmTypeOfCpp(resolved, index);
            if (mapping.error) {
                return { kind: 'error', message: `The C++ type '${name}' cannot be used: ${mapping.error}.` };
            }
            const declaration = index.lookup(name);
            return { kind: 'data', type: mapping.type!, cpp: declaration && declaration.kind !== 'namespace' ? declaration : undefined };
        }
    }
    const hint = name.includes('::') && structureCppImports(model).headers.length === 0 ? ' No C/C++ header is imported (\'import "file.h"\').' : '';
    return { kind: 'error', message: `Unknown type '${name}'.${hint}` };
}

/** The data type denoted by a type reference (`error` for unknown names). */
export function dataTypeOf(reference: ast.DataTypeReference | undefined): DataType {
    const resolution = resolveDataType(reference);
    return resolution.kind === 'data' ? resolution.type : 'error';
}

/** The name of a type for messages and hovers. */
export function dataTypeName(type: DataType): string {
    return isStructDataType(type) ? type.struct.name : typeName(type);
}

/** The payload of an event for messages: the name of its type or `no value`. */
export function payloadLabel(type: DataType): string {
    return type === 'void' ? 'no value' : dataTypeName(type);
}

/** The unqualified name of a struct type (`Position` for `geo::Position`), `undefined` for other types. */
function structName(type: DataType): string | undefined {
    if (isStructDataType(type)) {
        return type.struct.name;
    }
    return isStructType(type) ? type.cppName.split('::').pop() : undefined;
}

/** Whether two types are the same type (structs of structure files match C++ structs with the same name). */
export function sameDataType(a: DataType, b: DataType): boolean {
    if (a === 'error' || b === 'error') {
        return true;
    }
    if (isStructDataType(a) || isStructDataType(b)) {
        if (isStructDataType(a) && isStructDataType(b)) {
            return a.struct === b.struct;
        }
        return structName(a) !== undefined && structName(a) === structName(b);
    }
    return sameType(a, b);
}

/** Whether a value of type `source` can be used where a value of type `target` is expected (`integer` -> `real`). */
export function isDataAssignable(target: DataType, source: DataType): boolean {
    if (sameDataType(target, source)) {
        return true;
    }
    if (isStructDataType(target) || isStructDataType(source)) {
        return false;
    }
    return isAssignable(target, source);
}

// ---------------------------------------------------------------------------------------------
// Ports

/** The direction of the data of a port: `in` (received), `out` (sent), `inout` (shared, sync only). */
export type PortDirection = ast.Port['direction'];

/** The data type of a port: the data of a sync port, the payload of an async port (`void`: an event without payload). */
export function portDataType(port: ast.Port): DataType {
    if (!port.type) {
        return port.kind === 'async' ? 'void' : 'error';
    }
    return dataTypeOf(port.type);
}

/** A short description of the type of a port: `Position`, `integer`, `` (an event without payload). */
export function portTypeLabel(port: ast.Port): string {
    return port.type?.name ?? (port.kind === 'async' ? '' : '?');
}

/** The direction, kind and type of a port for messages: `out async integer`, `in sync Position`, `in async` (no payload). */
export function portSignature(port: ast.Port): string {
    const type = portTypeLabel(port);
    return `${port.direction} ${port.kind}${type ? ` ${type}` : ''}`;
}

/** The declaration of a port as written: `out async up : integer`, `in async open`. */
export function portDeclarationText(port: ast.Port): string {
    const type = portTypeLabel(port);
    return `${port.direction} ${port.kind} ${port.name}${type ? ` : ${type}` : ''}`;
}

/** A side of a connection or delegation for messages: the port and its text (`door.motor`, `remote`). */
export interface PortSide {
    readonly port: ast.Port;
    readonly text: string;
}

/**
 * The incompatibilities of the data of the port at the source and the port at the target of a
 * connection or delegation (empty if they are compatible), each explaining concretely why. The data
 * flows from the source to the target (for two inout ports in both directions):
 * - both ports have the same kind (sync / async),
 * - sync: the data of the source must be assignable to the data of the target (`integer` -> `real`);
 *   inout ports share the data: the same type,
 * - async: both events carry no payload, or the payload of the source is assignable to the payload of
 *   the target.
 * The directions are checked by the validator (see {@link directionProblem}). The ports are named by
 * `sourceText` / `targetText` (default: their names).
 */
export function portIncompatibilities(source: ast.Port, target: ast.Port, sourceText = source.name, targetText = target.name): string[] {
    if (source.kind !== target.kind) {
        const what = (kind: string) => kind === 'sync' ? 'a sync port (data)' : 'an async port (an event)';
        return [`${sourceText} is ${what(source.kind)}, ${targetText} is ${what(target.kind)} – sync ports are connected with sync ports, async ports with async ports`];
    }
    const sent = portDataType(source);
    const expected = portDataType(target);
    if (source.kind === 'sync') {
        if (source.direction === 'inout' && target.direction === 'inout') {
            return sameDataType(sent, expected) ? [] : [`${sourceText} and ${targetText} share data of different types (${dataTypeName(sent)} and ${dataTypeName(expected)})`];
        }
        return isDataAssignable(expected, sent) ? [] : [`the data ${dataTypeName(sent)} of ${sourceText} is not assignable to ${dataTypeName(expected)} (expected by ${targetText})`];
    }
    if (isDataAssignable(expected, sent)) {
        return [];
    }
    if (sent === 'void') {
        return [`the event ${sourceText} has no payload, but ${targetText} expects ${dataTypeName(expected)}`];
    }
    if (expected === 'void') {
        return [`the event ${sourceText} carries ${dataTypeName(sent)}, but ${targetText} expects no payload`];
    }
    return [`the payload ${dataTypeName(sent)} of ${sourceText} is not assignable to ${dataTypeName(expected)} (expected by ${targetText})`];
}

/**
 * Why the directions of the ports of a connection (`connect`, both ports of parts) or of a delegation
 * (`delegate`, `outer` tells which side is the boundary port) do not fit, `undefined` if they do. Data
 * flows from the source to the target of the statement:
 * - `connect`: from an out port to an in port; inout ports only with inout ports (in any order),
 * - `delegate`: an in boundary port to an in port of a part (outer -> inner), an out port of a part to an
 *   out boundary port (inner -> outer); inout ports only with inout ports (in any order).
 * `swapped` is set if the statement is right when written the other way round.
 */
export function directionProblem(kind: 'connect' | 'delegate', source: PortSide, target: PortSide, outer?: 'source' | 'target'): { message: string, swapped?: boolean } | undefined {
    const from = source.port.direction;
    const to = target.port.direction;
    if (from === 'inout' || to === 'inout') {
        if (from === to) {
            return undefined;
        }
        const [inout, other] = from === 'inout' ? [source, target] : [target, source];
        return { message: `${inout.text} is an inout port (shared data) and can only be ${kind === 'connect' ? 'connected' : 'delegated'} to an inout port, but ${other.text} is an ${other.port.direction} port` };
    }
    if (kind === 'connect') {
        if (from === 'out' && to === 'in') {
            return undefined;
        }
        if (from === 'in' && to === 'out') {
            return { message: `the data flows from the out port ${target.text} to the in port ${source.text}: write 'connect ${target.text} -> ${source.text}'`, swapped: true };
        }
        return { message: `a connection goes from an out port to an in port, but ${source.text} and ${target.text} are both ${from} ports` };
    }
    if (from !== to) {
        return { message: `a delegation connects ports of the same direction, but ${source.text} is an ${from} port and ${target.text} is an ${to} port` };
    }
    const [outerSide, innerSide] = outer === 'target' ? [target, source] : [source, target];
    if (from === 'in' && outer === 'target') {
        return { message: `the data of an in port flows from the boundary to the part: write 'delegate ${outerSide.text} -> ${innerSide.text}'`, swapped: true };
    }
    if (from === 'out' && outer === 'source') {
        return { message: `the data of an out port flows from the part to the boundary: write 'delegate ${innerSide.text} -> ${outerSide.text}'`, swapped: true };
    }
    return undefined;
}

/**
 * Why the ports of a connection (`connect`) or delegation (`delegate`) from `source` to `target` are
 * incompatible (data: kinds, types and payloads; not the directions, see {@link directionProblem}), as
 * one message naming both ports with their signatures, undefined if they are compatible:
 * `door.up (out async integer) cannot be connected to drive.up (in async boolean): the payload integer
 * of door.up is not assignable to boolean (expected by drive.up).`
 */
export function incompatibilityMessage(kind: 'connect' | 'delegate', source: PortSide, target: PortSide): string | undefined {
    const problems = portIncompatibilities(source.port, target.port, source.text, target.text);
    if (problems.length === 0) {
        return undefined;
    }
    return mismatchMessage(kind, source, target, problems);
}

/** `door.up (out async integer) cannot be connected to drive.up (in async boolean): problem; problem.` */
export function mismatchMessage(kind: 'connect' | 'delegate', source: PortSide, target: PortSide, problems: readonly string[]): string {
    return `${source.text} (${portSignature(source.port)}) cannot be ${kind === 'connect' ? 'connected' : 'delegated'} to `
        + `${target.text} (${portSignature(target.port)}): ${problems.join('; ')}.`;
}
