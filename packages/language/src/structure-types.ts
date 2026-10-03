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
 * struct or interface of the model or of an imported structure file (`Position`, `types.Position` for
 * a file with `package types`) or a C++ type of an imported header (`motor::Mode`, `uint8_t`, mapped
 * like in state machines, see cpp-types.ts). Interfaces are not data types: they are the types of
 * async ports (event groups).
 *
 * The types share the type system of the state machines ({@link DevmType}); structs of structure files
 * are types of their own ({@link StructDataType}). Compatibility (see {@link isDataAssignable}):
 * identical types, `integer` -> `real`, and a struct of a structure file is the same type as a C++
 * struct with the same (unqualified) name, so a port typed `Position` matches an event of a state
 * machine typed `geo::Position` of an imported header.
 */

/** A struct declared in a structure file. */
export interface StructDataType {
    readonly kind: 'structDeclaration';
    readonly struct: ast.StructDeclaration;
}

/** The type of a data port, event payload or struct field. */
export type DataType = DevmType | StructDataType;

export function isStructDataType(type: unknown): type is StructDataType {
    return typeof type === 'object' && type !== null && (type as StructDataType).kind === 'structDeclaration';
}

/** The meaning of a type name. */
export type DataTypeResolution =
    | { readonly kind: 'data', readonly type: DataType, readonly struct?: ast.StructDeclaration, readonly cpp?: CppDeclaration }
    | { readonly kind: 'interface', readonly interface: ast.PortInterface }
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
    if (ast.isPortInterface(element)) {
        return { kind: 'interface', interface: element };
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

/** The data type denoted by a type reference (`error` for unknown names and interfaces). */
export function dataTypeOf(reference: ast.DataTypeReference | undefined): DataType {
    const resolution = resolveDataType(reference);
    return resolution.kind === 'data' ? resolution.type : 'error';
}

/** The payload type of an event of a port or interface (`void` for an event without payload). */
export function eventType(event: ast.PortEvent): DataType {
    return event.type ? dataTypeOf(event.type) : 'void';
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

/** The interface of an async port typed by an interface (`provides async cmd : DoorCmd`). */
export function portInterface(port: ast.Port): ast.PortInterface | undefined {
    if (!port.type) {
        return undefined;
    }
    const resolution = resolveDataType(port.type);
    return resolution.kind === 'interface' ? resolution.interface : undefined;
}

/** The events of an async port: the inline events or the events of its interface. */
export function portEvents(port: ast.Port): readonly ast.PortEvent[] {
    if (port.events.length > 0) {
        return port.events;
    }
    return portInterface(port)?.events ?? [];
}

/** The data type of a sync port (`error` for async ports and unknown types). */
export function portDataType(port: ast.Port): DataType {
    return port.kind === 'sync' ? dataTypeOf(port.type) : 'error';
}

/** A short description of the type of a port: `Position`, `DoorCmd`, `event open, event start : integer`. */
export function portTypeLabel(port: ast.Port): string {
    if (port.events.length > 0) {
        return port.events.map(e => `event ${e.name}${e.type ? ` : ${e.type.name}` : ''}`).join(', ');
    }
    return port.type?.name ?? '?';
}

/** The direction, kind and type of a port for messages: `requires async MotorCmd`, `provides sync integer`. */
export function portSignature(port: ast.Port): string {
    return `${port.direction} ${port.kind} ${portTypeLabel(port)}`;
}

/** A side of a connection or delegation for messages: the port and its text (`door.motor`, `remote`). */
export interface PortSide {
    readonly port: ast.Port;
    readonly text: string;
}

/**
 * The incompatibilities between the port at the source and the port at the target of a connection or
 * delegation (empty if they are compatible), each explaining concretely why. The request direction is
 * source -> target:
 * - both ports have the same kind (sync / async),
 * - async: every event of the source must be accepted by the target, with an assignable payload
 *   (the target may accept more events),
 * - sync: the data of the target must be assignable to the data of the source (data flows from the
 *   provider back to the requester).
 * The ports are named by `sourceText` / `targetText` (default: their names).
 */
export function portIncompatibilities(source: ast.Port, target: ast.Port, sourceText = source.name, targetText = target.name): string[] {
    if (source.kind !== target.kind) {
        const what = (kind: string) => kind === 'sync' ? 'a sync port (data)' : 'an async port (events)';
        return [`${sourceText} is ${what(source.kind)}, ${targetText} is ${what(target.kind)} – sync ports are connected with sync ports, async ports with async ports`];
    }
    if (source.kind === 'sync') {
        const from = portDataType(target);
        const to = portDataType(source);
        return isDataAssignable(to, from) ? [] : [`the data ${dataTypeName(from)} of ${targetText} is not assignable to ${dataTypeName(to)} (expected by ${sourceText})`];
    }
    const problems: string[] = [];
    const accepted = new Map(portEvents(target).map(e => [e.name, e]));
    for (const event of portEvents(source)) {
        const other = accepted.get(event.name);
        if (!other) {
            problems.push(`event '${event.name}' is not accepted by ${targetText}`);
            continue;
        }
        const sent = eventType(event);
        const expected = eventType(other);
        if (isDataAssignable(expected, sent)) {
            continue;
        }
        if (sent === 'void') {
            problems.push(`event '${event.name}' has no payload, but ${targetText} expects ${dataTypeName(expected)}`);
        } else if (expected === 'void') {
            problems.push(`event '${event.name}' carries ${dataTypeName(sent)}, but ${targetText} expects no payload`);
        } else {
            problems.push(`payload ${dataTypeName(sent)} of '${event.name}' is not assignable to ${dataTypeName(expected)} (expected by ${targetText})`);
        }
    }
    return problems;
}

/**
 * Why the ports of a connection (`connect`) or delegation (`delegate`) from `source` to `target` are
 * incompatible, as one message naming both ports with their signatures, undefined if they are compatible:
 * `door.motor (requires async MotorCmd) cannot be connected to drive.ctrl (provides async DriveCmd):
 * event 'halt' is not accepted by drive.ctrl.`
 */
export function incompatibilityMessage(kind: 'connect' | 'delegate', source: PortSide, target: PortSide): string | undefined {
    const problems = portIncompatibilities(source.port, target.port, source.text, target.text);
    if (problems.length === 0) {
        return undefined;
    }
    return `${source.text} (${portSignature(source.port)}) cannot be ${kind === 'connect' ? 'connected' : 'delegated'} to `
        + `${target.text} (${portSignature(target.port)}): ${problems.join('; ')}.`;
}
