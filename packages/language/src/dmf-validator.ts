import { UriUtils, type AstNode, type ValidationAcceptor, type ValidationChecks } from 'langium';
import * as ast from './generated/ast.js';
import { displayPath, headerDiagnosticMessage } from './cpp-headers.js';
import { behaviorMapping } from './dmf-behavior.js';
import { dmfCppImports, resolvedBehavior, resolvedDmfImports, visibleElements } from './dmf-imports.js';
import type { DmfServices } from './dmf-module.js';
import {
    argumentNumber, DURATION_UNITS, enclosingStructure, instanceType, isCompositeType, portReferenceText, structureInstances, threadsOf
} from './dmf-model.js';
import { portIncompatibilities, resolveDataType } from './dmf-types.js';
import { connectionThreads } from './dmf-routes.js';
import { resolveTypeName } from './hsm-typesystem.js';

export function registerDmfValidationChecks(services: DmfServices): void {
    const validator = services.validation.DmfValidator;
    const checks: ValidationChecks<ast.HsmAstType> = {
        DmfModel: [validator.checkImports, validator.checkElementNames],
        StructDeclaration: validator.checkStruct,
        PortInterface: validator.checkInterface,
        DataTypeReference: validator.checkDataTypeReference,
        Component: [validator.checkPortNames, validator.checkBehavior],
        Structure: [validator.checkPortNames, validator.checkStructureNames, validator.checkPortUsage, validator.checkBoundaryPorts],
        Port: validator.checkPort,
        ComponentInstance: validator.checkInstance,
        ThreadMember: validator.checkThreadMember,
        Connection: validator.checkConnection,
        Delegation: validator.checkDelegation,
        DmfAnnotation: validator.checkAnnotation
    };
    services.validation.ValidationRegistry.register(checks, validator);
}

/**
 * Known annotations of structure files, by name: where they may be written and what they mean.
 * Other annotations are reported as unknown (warning). Tools may add names (e.g. layout annotations
 * of the diagram) before the services are created.
 */
export const DMF_ANNOTATIONS: Record<string, { readonly targets: readonly string[], readonly description: string }> = {
    priority: { targets: ['Thread'], description: 'priority of the thread: @priority(5)' },
    period: { targets: ['Thread'], description: 'period of a cyclic thread: @period(10 ms) (units s, ms, us, ns)' },
    stack: { targets: ['Thread'], description: 'stack size of the thread in bytes: @stack(4096)' }
};

/**
 * Checks of structure files (see docs/structure-language.md): imports, names, types, ports and
 * their mapping onto the behavior state machine, instances, threads, connections and delegations.
 */
export class DmfValidator {

    // -----------------------------------------------------------------------------------------
    // Imports and names

    checkImports(model: ast.DmfModel, accept: ValidationAcceptor): void {
        const seen = new Set<string>();
        const base = model.$document ? UriUtils.dirname(model.$document.uri) : undefined;
        for (const resolved of resolvedDmfImports(model)) {
            const target = { node: resolved.node, property: 'path' } as const;
            if (!resolved.path) {
                accept('error', 'The import path is empty.', target);
                continue;
            }
            if (resolved.kind === 'unsupported') {
                accept('error', `Cannot import '${resolved.path}': only structure files ('.dmf'), state machines ('.hsm') and C/C++ headers ('.h', '.hpp') can be imported.`, target);
                continue;
            }
            const key = resolved.uri?.toString() ?? resolved.path;
            if (seen.has(key)) {
                accept('warning', `'${resolved.path}' is imported more than once.`, target);
                continue;
            }
            seen.add(key);
            if (resolved.uri && resolved.uri.toString() === model.$document?.uri.toString()) {
                accept('error', 'A structure file cannot import itself.', target);
                continue;
            }
            if (resolved.kind === 'header') {
                const header = resolved.header;
                if (!header?.found) {
                    const searched = (header?.searched ?? []).map(uri => displayPath(uri.toString(), base));
                    accept('error', `Cannot resolve the import '${resolved.path}': the header was not found${searched.length > 0 ? ` (searched: ${searched.join(', ')})` : ''}.`, target);
                    continue;
                }
                const files = new Set(header.headers.map(h => h.uri.toString()));
                const errors = dmfCppImports(model).index.diagnostics.filter(d => d.severity === 'error' && files.has(d.fileName));
                for (const error of errors.slice(0, 5)) {
                    accept('error', `Error in the imported header: ${headerDiagnosticMessage(error, base)}`, target);
                }
                continue;
            }
            if ((resolved.kind === 'dmf' && !resolved.model) || (resolved.kind === 'hsm' && !resolved.machine)) {
                const location = resolved.uri ? (resolved.uri.scheme === 'file' ? resolved.uri.fsPath : resolved.uri.path) : resolved.path;
                accept('error', `Cannot resolve the import '${resolved.path}': the file '${location}' was not found.`, target);
            }
        }
    }

    /** Names of structs, interfaces and component types are unique in a model and are not names of built-in types. */
    checkElementNames(model: ast.DmfModel, accept: ValidationAcceptor): void {
        const own = new Map<string, ast.DmfElement>();
        for (const element of model.elements) {
            if (!element.name) {
                continue;
            }
            if (own.has(element.name)) {
                accept('error', `Duplicate name '${element.name}'.`, { node: element, property: 'name' });
                continue;
            }
            own.set(element.name, element);
            if (resolveTypeName(element.name)) {
                accept('error', `'${element.name}' is the name of a built-in type.`, { node: element, property: 'name' });
            }
        }
        // the own elements shadow imported elements with the same name
        const visible = visibleElements(model);
        for (const resolved of resolvedDmfImports(model)) {
            for (const element of resolved.model?.elements ?? []) {
                const shadowing = own.get(element.name);
                if (shadowing && resolved.model !== model) {
                    accept('warning', `'${element.name}' hides the element with the same name imported from '${resolved.path}'.`, { node: shadowing, property: 'name' });
                } else if (!shadowing && visible.get(element.name) !== element) {
                    accept('warning', `'${element.name}' is declared in several imported files; '${resolved.path}' is not used for this name (use 'package.${element.name}').`, { node: resolved.node, property: 'path' });
                }
            }
        }
    }

    checkStruct(struct: ast.StructDeclaration, accept: ValidationAcceptor): void {
        checkUnique(struct.fields, 'field', accept);
        for (const field of struct.fields) {
            if (field.type && containsStruct(field.type, struct, new Set())) {
                accept('error', `The struct '${struct.name}' contains itself (through '${field.name}').`, { node: field, property: 'type' });
            }
            this.checkDataType(field.type, `the field '${field.name}'`, accept);
        }
    }

    checkInterface(portInterface: ast.PortInterface, accept: ValidationAcceptor): void {
        checkUnique(portInterface.events, 'event', accept);
        for (const event of portInterface.events) {
            this.checkDataType(event.type, `the event '${event.name}'`, accept);
        }
    }

    /** Unknown type names (whether a data type or an interface is expected is checked by the containing element). */
    checkDataTypeReference(reference: ast.DataTypeReference, accept: ValidationAcceptor): void {
        const resolution = resolveDataType(reference);
        if (resolution.kind === 'error') {
            accept('error', resolution.message, { node: reference, property: 'name' });
        }
    }

    /** A data type (of a field, event payload or sync port) must not be an interface or `void`. */
    protected checkDataType(reference: ast.DataTypeReference | undefined, what: string, accept: ValidationAcceptor): void {
        if (!reference) {
            return;
        }
        const resolution = resolveDataType(reference);
        if (resolution.kind === 'interface') {
            accept('error', `The interface '${reference.name}' is not a data type: it can only be the type of an async port (${what}).`, { node: reference, property: 'name' });
        } else if (resolution.kind === 'data' && resolution.type === 'void') {
            accept('error', `'void' is not a data type (${what}).`, { node: reference, property: 'name' });
        }
    }

    // -----------------------------------------------------------------------------------------
    // Ports

    checkPortNames(type: ast.ComponentType, accept: ValidationAcceptor): void {
        checkUnique(type.ports, 'port', accept);
    }

    checkPort(port: ast.Port, accept: ValidationAcceptor): void {
        if (port.kind === 'sync') {
            if (port.events.length > 0) {
                accept('error', `The sync port '${port.name}' carries data, not events: write 'sync ${port.name} : Type' or declare it 'async'.`, { node: port, property: 'kind' });
                return;
            }
            this.checkDataType(port.type, `the sync port '${port.name}'`, accept);
            return;
        }
        checkUnique(port.events, 'event', accept);
        for (const event of port.events) {
            this.checkDataType(event.type, `the event '${event.name}'`, accept);
        }
        if (port.type) {
            const resolution = resolveDataType(port.type);
            if (resolution.kind === 'data') {
                accept('error', `The async port '${port.name}' carries events: its type must be an interface ('interface ${port.type.name} { event ... }') or a list of events ('event a, event b : integer'), not the data type ${port.type.name}. Data ports are 'sync'.`,
                    { node: port.type, property: 'name' });
            }
        }
    }

    /** The ports of a component with a behavior must match the definition section of the state machine (see dmf-behavior.ts). */
    checkBehavior(component: ast.Component, accept: ValidationAcceptor): void {
        const behavior = component.behavior;
        if (!behavior) {
            return;
        }
        if (behavior.path !== undefined) {
            const resolved = resolvedBehavior(behavior);
            if (!behavior.path) {
                accept('error', 'The behavior path is empty.', { node: behavior, property: 'path' });
                return;
            }
            if (!behavior.path.toLowerCase().endsWith('.hsm')) {
                accept('error', `The behavior of a component is a state machine file ('.hsm'), not '${behavior.path}'.`, { node: behavior, property: 'path' });
                return;
            }
            if (!resolved.machine) {
                const uri = resolved.uri;
                const location = uri ? (uri.scheme === 'file' ? uri.fsPath : uri.path) : behavior.path;
                accept('error', `Cannot resolve the behavior '${behavior.path}': the state machine file '${location}' was not found.`, { node: behavior, property: 'path' });
                return;
            }
        }
        const mapping = behaviorMapping(component);
        if (!mapping) {
            return; // unresolved reference (reported by the linker)
        }
        for (const port of mapping.ports) {
            for (const event of port.events) {
                if (event.problem) {
                    accept('error', event.problem, { node: event.event, property: 'name' });
                }
            }
            if (port.data?.problem) {
                accept('error', port.data.problem, { node: port.port, property: 'name' });
            }
        }
        for (const declaration of mapping.unmapped) {
            const what = ast.isEventDeclaration(declaration) ? `The ${declaration.direction ?? 'in'} event` : 'The operation';
            const port = ast.isEventDeclaration(declaration)
                ? `a ${(declaration.direction ?? 'in') === 'in' ? 'provided' : 'required'} async port`
                : 'a required sync port';
            accept('warning', `${what} '${declaration.name}' of the state machine '${mapping.machine.name}' does not belong to any port of '${component.name}' (add it to ${port}).`,
                { node: behavior, property: behavior.path !== undefined ? 'path' : 'machine' });
        }
    }

    // -----------------------------------------------------------------------------------------
    // Structures

    /** Names of instances and threads are unique in a structure. */
    checkStructureNames(structure: ast.Structure, accept: ValidationAcceptor): void {
        checkUnique(structureInstances(structure), 'instance', accept);
        checkUnique(structure.threads, 'thread', accept);
    }

    checkInstance(instance: ast.ComponentInstance, accept: ValidationAcceptor): void {
        const type = instanceType(instance);
        if (!isCompositeType(type)) {
            return;
        }
        if (type.kind === 'system') {
            accept('error', `'${type.name}' is a system and cannot be instantiated; declare it as 'structure ${type.name}' to use it as a part.`, { node: instance, property: 'type' });
            return;
        }
        const structure = enclosingStructure(instance);
        const cycle = structure ? instantiationCycle(type, structure) : undefined;
        if (cycle) {
            accept('error', `Recursive instantiation: ${[structure!.name, ...cycle].join(' -> ')}.`, { node: instance, property: 'type' });
        }
    }

    checkThreadMember(member: ast.ThreadMember, accept: ValidationAcceptor): void {
        const instance = member.instance?.ref;
        if (!instance) {
            return;
        }
        const threads = threadsOf(instance);
        const thread = member.$container;
        const first = threads[0];
        if (first && first !== thread) {
            accept('error', `The instance '${instance.name}' is already assigned to the thread '${first.name}'. An instance belongs to one thread only.`, { node: member, property: 'instance' });
        } else if (thread.members.filter(m => m.instance?.ref === instance).indexOf(member) > 0 || thread.instances.includes(instance)) {
            accept('warning', `The instance '${instance.name}' is already part of the thread '${thread.name}'.`, { node: member, property: 'instance' });
        }
    }

    /**
     * Required ports of the instances are connected (or delegated); a sync required port has one provider
     * only; connections are not duplicated.
     */
    checkPortUsage(structure: ast.Structure, accept: ValidationAcceptor): void {
        const uses = new Map<string, Array<ast.Connection | ast.Delegation>>();
        const keyOf = (reference: ast.PortReference | undefined) => reference?.instance?.ref && reference.port?.ref
            ? `${reference.instance.ref.name}.${reference.port.ref.name}` : undefined;
        const seen = new Set<string>();
        for (const element of [...structure.connections, ...structure.delegations]) {
            const source = keyOf(element.source);
            if (source) {
                uses.set(source, [...uses.get(source) ?? [], element]);
            }
            const text = `${element.$type}:${element.source ? portReferenceText(element.source) : ''}->${element.target ? portReferenceText(element.target) : ''}`;
            if (seen.has(text)) {
                accept('warning', `Duplicate ${ast.isConnection(element) ? 'connection' : 'delegation'}.`, { node: element });
            }
            seen.add(text);
        }
        for (const instance of structureInstances(structure)) {
            for (const port of instanceType(instance)?.ports ?? []) {
                if (port.direction !== 'requires') {
                    continue;
                }
                const connections = uses.get(`${instance.name}.${port.name}`) ?? [];
                if (connections.length === 0) {
                    accept('warning', `The required port '${instance.name}.${port.name}' is not connected.`, { node: instance, property: 'name' });
                } else if (port.kind === 'sync' && connections.length > 1) {
                    for (const extra of connections.slice(1)) {
                        accept('error', `The sync port '${instance.name}.${port.name}' requires one provider, but it is connected ${connections.length} times.`, { node: extra, property: 'source' });
                    }
                }
            }
        }
    }

    /** Provided boundary ports are delegated to a part (a sync one to exactly one), required boundary ports are used by a part. */
    checkBoundaryPorts(structure: ast.Structure, accept: ValidationAcceptor): void {
        for (const port of structure.ports) {
            if (port.direction === 'provides') {
                const delegations = structure.delegations.filter(d => !d.source?.instance && d.source?.port?.ref === port);
                if (delegations.length === 0) {
                    accept('warning', `The provided port '${port.name}' is not delegated to a part ('delegate ${port.name} -> part.port').`, { node: port, property: 'name' });
                } else if (port.kind === 'sync' && delegations.length > 1) {
                    for (const extra of delegations.slice(1)) {
                        accept('error', `The sync port '${port.name}' can be delegated to one provider only.`, { node: extra, property: 'target' });
                    }
                }
            } else if (!structure.delegations.some(d => !d.target?.instance && d.target?.port?.ref === port)) {
                accept('warning', `The required port '${port.name}' is not used by any part ('delegate part.port -> ${port.name}').`, { node: port, property: 'name' });
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Connections and delegations

    checkConnection(connection: ast.Connection, accept: ValidationAcceptor): void {
        const source = connection.source;
        const target = connection.target;
        const from = source?.port?.ref;
        const to = target?.port?.ref;
        if (!source || !target || !from || !to) {
            return; // linking error
        }
        if (!source.instance || !target.instance) {
            accept('error', `'connect' connects ports of parts ('a.port -> b.port'); boundary ports of '${enclosingStructure(connection)?.name}' are connected with 'delegate'.`,
                { node: connection, property: source.instance ? 'target' : 'source' });
            return;
        }
        if (from.direction === 'provides' && to.direction === 'requires') {
            accept('error', `Connections go from the required to the provided port: write 'connect ${portReferenceText(target)} -> ${portReferenceText(source)}'.`, { node: connection, property: 'source' });
            return;
        }
        if (from.direction !== 'requires') {
            accept('error', `The source '${portReferenceText(source)}' of a connection must be a required port.`, { node: connection, property: 'source' });
            return;
        }
        if (to.direction !== 'provides') {
            accept('error', `The target '${portReferenceText(target)}' of a connection must be a provided port.`, { node: connection, property: 'target' });
            return;
        }
        this.checkCompatibility(connection, from, to, accept);
        // (a composite outside of threads: the threads of the component ports inside it)
        const { source: threadA, target: threadB } = connectionThreads(connection);
        if (threadA && threadB && threadA !== threadB) {
            accept('info', `The connection crosses threads ('${threadA.name}' -> '${threadB.name}').`, { node: connection });
        }
    }

    checkDelegation(delegation: ast.Delegation, accept: ValidationAcceptor): void {
        const source = delegation.source;
        const target = delegation.target;
        const from = source?.port?.ref;
        const to = target?.port?.ref;
        if (!source || !target || !from || !to) {
            return; // linking error
        }
        if (!!source.instance === !!target.instance) {
            accept('error', 'A delegation connects a boundary port with a port of a part: \'delegate port -> part.port\' (provided) or \'delegate part.port -> port\' (required).',
                { node: delegation, property: 'source' });
            return;
        }
        if (from.direction !== to.direction) {
            accept('error', `A delegation connects ports of the same direction, but '${portReferenceText(source)}' is ${direction(from)} and '${portReferenceText(target)}' is ${direction(to)}.`,
                { node: delegation, property: 'target' });
            return;
        }
        const outer = source.instance ? target : source;
        const inner = source.instance ? source : target;
        if (from.direction === 'provides' && source.instance) {
            accept('error', `A provided port is delegated from the boundary to the part: write 'delegate ${portReferenceText(outer)} -> ${portReferenceText(inner)}'.`, { node: delegation, property: 'source' });
            return;
        }
        if (from.direction === 'requires' && !source.instance) {
            accept('error', `A required port is delegated from the part to the boundary: write 'delegate ${portReferenceText(inner)} -> ${portReferenceText(outer)}'.`, { node: delegation, property: 'source' });
            return;
        }
        this.checkCompatibility(delegation, from, to, accept);
    }

    protected checkCompatibility(node: ast.Connection | ast.Delegation, from: ast.Port, to: ast.Port, accept: ValidationAcceptor): void {
        const problems = portIncompatibilities(from, to);
        if (problems.length > 0) {
            accept('error', `Incompatible ports '${portReferenceText(node.source!)}' and '${portReferenceText(node.target!)}': ${problems.join('; ')}.`, { node, property: 'target' });
        }
    }

    // -----------------------------------------------------------------------------------------
    // Annotations

    checkAnnotation(annotation: ast.DmfAnnotation, accept: ValidationAcceptor): void {
        const known = DMF_ANNOTATIONS[annotation.name];
        const owner = annotation.$container as AstNode;
        if (!known) {
            accept('warning', `Unknown annotation '@${annotation.name}'.`, { node: annotation, property: 'name' });
            return;
        }
        if (!known.targets.includes(owner.$type)) {
            accept('warning', `'@${annotation.name}' has no effect here (${known.description}).`, { node: annotation, property: 'name' });
            return;
        }
        const argument = annotation.arguments[0];
        const value = argumentNumber(argument);
        const usage = () => accept('error', `Invalid arguments: ${known.description}.`, { node: annotation, property: 'name' });
        if (annotation.arguments.length !== 1 || value === undefined || !Number.isInteger(value)) {
            usage();
            return;
        }
        switch (annotation.name) {
            case 'priority':
                if (argument.unit) {
                    usage();
                }
                break;
            case 'stack':
                if (argument.unit || value <= 0) {
                    usage();
                }
                break;
            case 'period':
                if (!argument.unit || DURATION_UNITS[argument.unit] === undefined || value <= 0) {
                    usage();
                }
                break;
        }
        const duplicate = (owner as { annotations?: ast.DmfAnnotation[] }).annotations?.find(a => a.name === annotation.name);
        if (duplicate && duplicate !== annotation) {
            accept('warning', `'@${annotation.name}' is given more than once; the first one is used.`, { node: annotation, property: 'name' });
        }
    }
}

function direction(port: ast.Port): string {
    return port.direction === 'provides' ? 'provided' : 'required';
}

/** Reports nodes with the same name as an earlier node. */
function checkUnique(nodes: ReadonlyArray<AstNode & { name: string }>, what: string, accept: ValidationAcceptor): void {
    const names = new Set<string>();
    for (const node of nodes) {
        if (!node.name) {
            continue;
        }
        if (names.has(node.name)) {
            accept('error', `Duplicate ${what} '${node.name}'.`, { node, property: 'name' });
        }
        names.add(node.name);
    }
}

/** Whether a field type contains the struct (directly or through other structs). */
function containsStruct(reference: ast.DataTypeReference, struct: ast.StructDeclaration, visited: Set<ast.StructDeclaration>): boolean {
    const resolution = resolveDataType(reference);
    const inner = resolution.kind === 'data' ? resolution.struct : undefined;
    if (!inner || inner === struct) {
        return inner === struct;
    }
    if (visited.has(inner)) {
        return false;
    }
    visited.add(inner);
    return inner.fields.some(field => field.type && containsStruct(field.type, struct, visited));
}

/**
 * The structures through which `type` (transitively) instantiates `structure`: `['Sub', 'Car']` if
 * `Sub` contains an instance of `Car`; `undefined` if there is no such cycle.
 */
export function instantiationCycle(type: ast.Structure, structure: ast.Structure): string[] | undefined {
    const visited = new Set<ast.Structure>();
    const search = (current: ast.Structure, path: string[]): string[] | undefined => {
        if (current === structure) {
            return [...path, current.name];
        }
        if (visited.has(current)) {
            return undefined;
        }
        visited.add(current);
        for (const instance of structureInstances(current)) {
            const next = instanceType(instance);
            if (isCompositeType(next)) {
                const cycle = search(next, [...path, current.name]);
                if (cycle) {
                    return cycle;
                }
            }
        }
        return undefined;
    };
    return search(type, []);
}

