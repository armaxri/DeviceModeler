import { UriUtils, type AstNode, type ValidationAcceptor, type ValidationChecks } from 'langium';
import * as ast from './generated/ast.js';
import { displayPath, headerDiagnosticMessage } from './cpp-headers.js';
import { behaviorMapping } from './structure-behavior.js';
import { structureCppImports, resolvedBehavior, resolvedStructureImports, visibleElements } from './structure-imports.js';
import type { DevmServices } from './devm-module.js';
import {
    argumentNumber, DURATION_UNITS, enclosingComposite, instanceType, portReferenceText, compositeInstances, systemPortsMessage, threadsOf
} from './structure-model.js';
import { directionProblem, incompatibilityMessage, mismatchMessage, resolveDataType } from './structure-types.js';
import { connectionThreads } from './structure-routes.js';
import { resolveTypeName } from './typesystem.js';
import { isModelPath } from './imports.js';
import {
    IBD_EDGE_ELEMENTS, IBD_LAYOUT_ANNOTATIONS, IBD_NODE_ELEMENTS, IBD_PORT_OWNERS, structureAnnotationArguments, portAnnotation
} from './diagram/ibd-layout-annotations.js';

export function registerStructureValidationChecks(services: DevmServices): void {
    const validator = services.validation.StructureValidator;
    const checks: ValidationChecks<ast.DevmAstType> = {
        StructureModel: [validator.checkImports, validator.checkElementNames],
        StructDeclaration: validator.checkStruct,
        DataTypeReference: validator.checkDataTypeReference,
        Component: [validator.checkPortNames, validator.checkBehavior],
        CompositeType: [validator.checkPortNames, validator.checkCompositeNames, validator.checkSystemClosed, validator.checkPortUsage, validator.checkBoundaryPorts],
        Port: validator.checkPort,
        ComponentInstance: validator.checkInstance,
        ThreadMember: validator.checkThreadMember,
        Connection: validator.checkConnection,
        Delegation: validator.checkDelegation,
        StructureAnnotation: validator.checkAnnotation
    };
    services.validation.ValidationRegistry.register(checks, validator);
}

/**
 * Known annotations of structure files, by name: where they may be written and what they mean.
 * Other annotations are reported as unknown (warning). Tools may add names (e.g. layout annotations
 * of the diagram) before the services are created.
 */
export const STRUCTURE_ANNOTATIONS: Record<string, { readonly targets: readonly string[], readonly description: string }> = {
    priority: { targets: ['Thread'], description: 'priority of the thread: @priority(5)' },
    period: { targets: ['Thread'], description: 'period of a cyclic thread: @period(10 ms) (units s, ms, us, ns)' },
    stack: { targets: ['Thread'], description: 'stack size of the thread in bytes: @stack(4096)' },
    // layout annotations of the structure diagram (see docs/manual-layout.md, ibd-layout-annotations.ts)
    at: { targets: IBD_NODE_ELEMENTS, description: 'position in the structure diagram: @at(x, y)' },
    size: { targets: IBD_NODE_ELEMENTS, description: 'size in the structure diagram: @size(width, height)' },
    via: { targets: IBD_EDGE_ELEMENTS, description: 'waypoints of the connector in the structure diagram: @via(x1, y1, x2, y2, ...)' },
    port: { targets: IBD_PORT_OWNERS, description: 'side and offset of a port in the structure diagram: @port(name, left | right | top | bottom, offset)' }
};

/**
 * Checks of structure files (see docs/structure-language.md): imports, names, types, ports and
 * their mapping onto the behavior state machine, instances, threads, connections and delegations.
 */
export class StructureValidator {

    // -----------------------------------------------------------------------------------------
    // Imports and names

    checkImports(model: ast.StructureModel, accept: ValidationAcceptor): void {
        const seen = new Set<string>();
        const base = model.$document ? UriUtils.dirname(model.$document.uri) : undefined;
        for (const resolved of resolvedStructureImports(model)) {
            const target = { node: resolved.node, property: 'path' } as const;
            if (!resolved.path) {
                accept('error', 'The import path is empty.', target);
                continue;
            }
            if (resolved.kind === 'unsupported') {
                accept('error', `Cannot import '${resolved.path}': only model files ('.devm': structure files and state machines) and C/C++ headers ('.h', '.hpp') can be imported.`, target);
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
                const errors = structureCppImports(model).index.diagnostics.filter(d => d.severity === 'error' && files.has(d.fileName));
                for (const error of errors.slice(0, 5)) {
                    accept('error', `Error in the imported header: ${headerDiagnosticMessage(error, base)}`, target);
                }
                continue;
            }
            if (resolved.kind === 'model') {
                const location = resolved.uri ? (resolved.uri.scheme === 'file' ? resolved.uri.fsPath : resolved.uri.path) : resolved.path;
                accept('error', `Cannot resolve the import '${resolved.path}': the file '${location}' was not found.`, target);
            }
        }
    }

    /** Names of structs and component types are unique in a model and are not names of built-in types. */
    checkElementNames(model: ast.StructureModel, accept: ValidationAcceptor): void {
        const own = new Map<string, ast.StructureElement>();
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
        for (const resolved of resolvedStructureImports(model)) {
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

    /** Unknown type names. */
    checkDataTypeReference(reference: ast.DataTypeReference, accept: ValidationAcceptor): void {
        const resolution = resolveDataType(reference);
        if (resolution.kind === 'error') {
            accept('error', resolution.message, { node: reference, property: 'name' });
        }
    }

    /** A data type (of a field or port) must not be `void`. */
    protected checkDataType(reference: ast.DataTypeReference | undefined, what: string, accept: ValidationAcceptor): void {
        if (!reference) {
            return;
        }
        const resolution = resolveDataType(reference);
        if (resolution.kind === 'data' && resolution.type === 'void') {
            accept('error', `'void' is not a data type (${what}).`, { node: reference, property: 'name' });
        }
    }

    // -----------------------------------------------------------------------------------------
    // Ports

    checkPortNames(type: ast.ComponentType, accept: ValidationAcceptor): void {
        checkUnique(type.ports, 'port', accept);
    }

    /**
     * Sync ports carry data of a type (`in sync pos : Position`); async ports one event with an optional
     * payload (`out async up : integer`, `in async open`) and are `in` or `out` (data is shared by
     * `inout sync` ports only).
     */
    checkPort(port: ast.Port, accept: ValidationAcceptor): void {
        if (port.kind === 'async' && port.direction === 'inout') {
            accept('error', `The async port '${port.name}' cannot be 'inout': an event is sent ('out async') or received ('in async'). Shared data is an 'inout sync' port.`, { node: port, property: 'direction' });
        }
        if (port.kind === 'sync' && !port.type) {
            accept('error', `The sync port '${port.name}' carries data: write '${port.direction} sync ${port.name} : Type' (a built-in type, a struct or a C/C++ type).`, { node: port, property: 'name' });
            return;
        }
        this.checkDataType(port.type, `the ${port.kind} port '${port.name}'`, accept);
    }

    /** The ports of a component with a behavior must match the definition section of the state machine (see structure-behavior.ts). */
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
            if (!isModelPath(behavior.path)) {
                accept('error', `The behavior of a component is a state machine file ('.devm'), not '${behavior.path}'.`, { node: behavior, property: 'path' });
                return;
            }
            if (!resolved.machine && resolved.structureFile) {
                accept('error', `The behavior of a component is a state machine file: '${behavior.path}' is a structure file.`, { node: behavior, property: 'path' });
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
            if (port.problem) {
                accept('error', port.problem, { node: port.port, property: 'name' });
            }
        }
        for (const declaration of mapping.unmapped) {
            const type = declaration.type ? ` : ${declaration.type.name}` : '';
            const [what, port] = ast.isEventDeclaration(declaration)
                ? [`The ${declaration.direction ?? 'in'} event`, `${declaration.direction === 'out' ? 'out' : 'in'} async ${declaration.name}${type}`]
                : [`The ${declaration.readonly ? 'read-only ' : ''}variable`, `${declaration.readonly ? 'in' : 'out'} sync ${declaration.name}${type}`];
            const inout = ast.isVariableDeclaration(declaration) && !declaration.readonly ? ' or \'inout sync\'' : '';
            accept('warning', `${what} '${declaration.name}' of the state machine '${mapping.machine.name}' does not belong to any port of '${component.name}' (add the port '${port}'${inout}).`,
                { node: behavior, property: behavior.path !== undefined ? 'path' : 'machine' });
        }
    }

    // -----------------------------------------------------------------------------------------
    // Structures

    /** Names of instances and threads are unique in a structure. */
    checkCompositeNames(structure: ast.CompositeType, accept: ValidationAcceptor): void {
        checkUnique(compositeInstances(structure), 'instance', accept);
        checkUnique(structure.threads, 'thread', accept);
    }

    /**
     * Instances of components run in a thread: they are declared in a thread or assigned to one by name.
     * Instances of subsystems are placed outside of the threads (their parts run in the threads of the
     * subsystem). Systems cannot be instantiated, subsystems not recursively.
     */
    checkInstance(instance: ast.ComponentInstance, accept: ValidationAcceptor): void {
        const type = instanceType(instance);
        if (!type) {
            return; // linking error
        }
        if (!ast.isCompositeType(type)) {
            if (!ast.isThread(instance.$container) && threadsOf(instance).length === 0) {
                accept('error', `The component instance '${instance.name}' is outside of a thread: instances of components run in a thread. `
                    + `Declare it in a thread ('thread T { ${instance.name} : ${instance.type?.$refText ?? type.name} }') or assign it to one ('thread T { ${instance.name} }').`,
                    { node: instance, property: 'name' });
            }
            return;
        }
        if (type.kind === 'system') {
            accept('error', `'${type.name}' is a system and cannot be instantiated; declare it as 'subsystem ${type.name}' to use it as a part.`, { node: instance, property: 'type' });
            return;
        }
        if (ast.isThread(instance.$container)) {
            accept('error', `'${instance.name}' is an instance of the subsystem '${type.name}' and cannot be placed in the thread '${instance.$container.name}': `
                + `the parts of a subsystem run in the threads of the subsystem. Declare '${instance.name}' outside of the threads.`,
                { node: instance, property: 'type' });
        }
        const structure = enclosingComposite(instance);
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
        const type = instanceType(instance);
        const thread = member.$container;
        if (ast.isCompositeType(type)) {
            accept('error', `'${instance.name}' is an instance of the subsystem '${type.name}' and cannot be assigned to the thread '${thread.name}': `
                + 'the parts of a subsystem run in the threads of the subsystem. Only instances of components are assigned to threads.',
                { node: member, property: 'instance' });
            return;
        }
        const threads = threadsOf(instance);
        const first = threads[0];
        if (first && first !== thread) {
            accept('error', `The instance '${instance.name}' is already assigned to the thread '${first.name}'. An instance belongs to one thread only.`, { node: member, property: 'instance' });
        } else if (thread.members.filter(m => m.instance?.ref === instance).indexOf(member) > 0 || thread.instances.includes(instance)) {
            accept('warning', `The instance '${instance.name}' is already part of the thread '${thread.name}'.`, { node: member, property: 'instance' });
        }
    }

    /**
     * The ports of the parts receive their data: an in port (and an inout port) of a part is connected
     * (or delegated), a sync in port has one source only and an async in port exactly one sender (the
     * same for out boundary ports: the data of one part leaves the subsystem); connections are not duplicated. Out ports may be left unconnected (nobody uses
     * the data).
     */
    checkPortUsage(structure: ast.CompositeType, accept: ValidationAcceptor): void {
        const uses = new Map<string, Array<ast.Connection | ast.Delegation>>();
        const keyOf = (reference: ast.PortReference | undefined) => reference?.port?.ref
            ? `${reference.instance ? `${reference.instance.ref?.name ?? '?'}.` : ''}${reference.port.ref.name}` : undefined;
        const use = (key: string | undefined, element: ast.Connection | ast.Delegation) => {
            if (key) {
                uses.set(key, [...uses.get(key) ?? [], element]);
            }
        };
        const seen = new Set<string>();
        for (const element of [...structure.connections, ...structure.delegations]) {
            const source = keyOf(element.source);
            const target = keyOf(element.target);
            use(target, element);
            if (source !== target) {
                use(source, element);
            }
            const text = `${element.$type}:${element.source ? portReferenceText(element.source) : ''}->${element.target ? portReferenceText(element.target) : ''}`;
            if (seen.has(text)) {
                accept('warning', `Duplicate ${ast.isConnection(element) ? 'connection' : 'delegation'}.`, { node: element });
            }
            seen.add(text);
        }
        /** The statements delivering data to a port (it is their target; without unresolved sources and duplicates). */
        const sources = (key: string, port: ast.Port) => {
            const statements = (uses.get(key) ?? []).filter(e => e.target?.port?.ref === port && keyOf(e.target) === key && keyOf(e.source));
            return statements.filter((e, i) => statements.findIndex(o => o.$type === e.$type && keyOf(o.source) === keyOf(e.source)) === i);
        };
        const checkOneSource = (key: string, port: ast.Port, label: string) => {
            if (port.direction === 'inout') {
                return;
            }
            const statements = sources(key, port);
            const first = statements[0];
            for (const extra of statements.slice(1)) {
                if (port.kind === 'sync') {
                    accept('error', `The sync port '${label}' receives its data from one source only, but it has ${statements.length} sources.`, { node: extra, property: 'target' });
                } else {
                    const from = first.source ? portReferenceText(first.source) : '?';
                    accept('error', `${label} already receives its events from ${from} (${ast.isConnection(first) ? 'connect' : 'delegate'}) – `
                        + `an async ${port.direction === 'out' ? 'out boundary' : 'in'} port has exactly one sender.`, { node: extra, property: 'target' });
                }
            }
        };
        for (const instance of compositeInstances(structure)) {
            for (const port of instanceType(instance)?.ports ?? []) {
                const key = `${instance.name}.${port.name}`;
                if (port.direction === 'out') {
                    continue;
                }
                if ((uses.get(key) ?? []).length === 0) {
                    accept('warning', port.direction === 'in'
                        ? `The in port '${key}' is not connected: it receives no ${port.kind === 'sync' ? 'data' : 'events'}.`
                        : `The inout port '${key}' is not connected: it shares its data with no other port.`, { node: instance, property: 'name' });
                    continue;
                }
                checkOneSource(key, port, key);
            }
        }
        for (const port of structure.ports) {
            if (port.direction === 'out') {
                checkOneSource(port.name, port, port.name);
            }
        }
    }

    /**
     * A system is the closed, complete top level of a product: no boundary ports (its environment is
     * modeled as parts), and so no delegations.
     */
    checkSystemClosed(structure: ast.CompositeType, accept: ValidationAcceptor): void {
        if (structure.kind !== 'system') {
            return;
        }
        for (const port of structure.ports) {
            accept('error', systemPortsMessage(structure.name), { node: port, property: port.name ? 'name' : undefined });
        }
        for (const delegation of structure.delegations) {
            accept('error', `A system has no boundary ports and so no delegations: connect the parts of '${structure.name}' with 'connect a.port -> b.port'.`,
                { node: delegation });
        }
    }

    /** The data of the boundary ports is passed on: in ports to parts, out ports from parts, inout ports to and from parts. */
    checkBoundaryPorts(structure: ast.CompositeType, accept: ValidationAcceptor): void {
        if (structure.kind === 'system') {
            return; // (no ports: checkSystemClosed)
        }
        for (const port of structure.ports) {
            const delegated = structure.delegations.some(d => (!d.source?.instance && d.source?.port?.ref === port) || (!d.target?.instance && d.target?.port?.ref === port));
            if (delegated || !port.name) {
                continue;
            }
            const message = port.direction === 'in'
                ? `The in port '${port.name}' is not delegated to a part: nobody receives its ${port.kind === 'sync' ? 'data' : 'events'} ('delegate ${port.name} -> part.port').`
                : port.direction === 'out'
                    ? `The out port '${port.name}' is not delegated from a part: no part sends its ${port.kind === 'sync' ? 'data' : 'events'} ('delegate part.port -> ${port.name}').`
                    : `The inout port '${port.name}' is not delegated to a part ('delegate ${port.name} -> part.port').`;
            accept('warning', message, { node: port, property: 'name' });
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
            accept('error', `'connect' connects ports of parts ('a.port -> b.port'); boundary ports of '${enclosingComposite(connection)?.name}' are connected with 'delegate'.`,
                { node: connection, property: source.instance ? 'target' : 'source' });
            return;
        }
        if (!this.checkDirections(connection, from, to, accept)) {
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
            accept('error', 'A delegation connects a boundary port with a port of a part: \'delegate port -> part.port\' (in) or \'delegate part.port -> port\' (out).',
                { node: delegation, property: 'source' });
            return;
        }
        if (!this.checkDirections(delegation, from, to, accept)) {
            return;
        }
        this.checkCompatibility(delegation, from, to, accept);
    }

    /** The directions of the ports of a connection or delegation (see `directionProblem`); false if they do not fit. */
    protected checkDirections(node: ast.Connection | ast.Delegation, from: ast.Port, to: ast.Port, accept: ValidationAcceptor): boolean {
        const kind = ast.isConnection(node) ? 'connect' : 'delegate';
        const source = { port: from, text: portReferenceText(node.source!) };
        const target = { port: to, text: portReferenceText(node.target!) };
        const problem = directionProblem(kind, source, target, kind === 'delegate' ? (node.source?.instance ? 'target' : 'source') : undefined);
        if (problem) {
            accept('error', mismatchMessage(kind, source, target, [problem.message]), { node, property: problem.swapped ? 'source' : 'target' });
            return false;
        }
        return true;
    }

    protected checkCompatibility(node: ast.Connection | ast.Delegation, from: ast.Port, to: ast.Port, accept: ValidationAcceptor): void {
        const message = incompatibilityMessage(ast.isConnection(node) ? 'connect' : 'delegate',
            { port: from, text: portReferenceText(node.source!) }, { port: to, text: portReferenceText(node.target!) });
        if (message) {
            accept('error', message, { node, property: 'target' });
        }
    }

    // -----------------------------------------------------------------------------------------
    // Annotations

    checkAnnotation(annotation: ast.StructureAnnotation, accept: ValidationAcceptor): void {
        const known = STRUCTURE_ANNOTATIONS[annotation.name];
        const owner = annotation.$container as AstNode;
        if (!known) {
            accept('warning', `Unknown annotation '@${annotation.name}'.`, { node: annotation, property: 'name' });
            return;
        }
        if (!known.targets.includes(owner.$type)) {
            accept('warning', `'@${annotation.name}' has no effect here (${known.description}).`, { node: annotation, property: 'name' });
            return;
        }
        if (IBD_LAYOUT_ANNOTATIONS.includes(annotation.name)) {
            this.checkLayoutAnnotation(annotation, owner, known.description, accept);
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
        const duplicate = (owner as { annotations?: ast.StructureAnnotation[] }).annotations?.find(a => a.name === annotation.name);
        if (duplicate && duplicate !== annotation) {
            accept('warning', `'@${annotation.name}' is given more than once; the first one is used.`, { node: annotation, property: 'name' });
        }
    }

    /** Layout annotations of the structure diagram: their arguments, duplicates, the ports of `@port`. */
    private checkLayoutAnnotation(annotation: ast.StructureAnnotation, owner: AstNode, description: string, accept: ValidationAcceptor): void {
        const name = annotation.name;
        const siblings = (owner as { annotations?: ast.StructureAnnotation[] }).annotations ?? [];
        if (name === 'port') {
            const port = portAnnotation(annotation);
            if (!port) {
                accept('error', `Invalid arguments: ${description}.`, { node: annotation, property: 'name' });
                return;
            }
            if (siblings.find(a => a.name === 'port' && portAnnotation(a)?.port === port.port) !== annotation) {
                accept('error', `Duplicate annotation '@port' of the port '${port.port}'.`, { node: annotation, property: 'name' });
                return;
            }
            const type = ast.isComponentInstance(owner) ? instanceType(owner) : ast.isCompositeType(owner) ? owner : undefined;
            if (type && !type.ports.some(p => p.name === port.port)) {
                accept('warning', `${ast.isCompositeType(owner) ? `${owner.kind} ${owner.name}` : `${type.name}`} has no port '${port.port}' (the annotation is ignored).`,
                    { node: annotation, property: 'arguments', index: 0 });
            }
            return;
        }
        if (siblings.find(a => a.name === name) !== annotation) {
            accept('error', `Duplicate annotation '@${name}'.`, { node: annotation, property: 'name' });
            return;
        }
        const values = structureAnnotationArguments(annotation);
        const count = values?.length ?? 0;
        if (!values || values.some(v => typeof v !== 'number') || (name === 'via' ? count < 2 || count % 2 !== 0 : count !== 2)
            || (name === 'size' && (values as number[]).some(v => v < 0))) {
            accept('error', `Invalid arguments: ${description}.`, { node: annotation, property: 'name' });
        }
    }
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
export function instantiationCycle(type: ast.CompositeType, structure: ast.CompositeType): string[] | undefined {
    const visited = new Set<ast.CompositeType>();
    const search = (current: ast.CompositeType, path: string[]): string[] | undefined => {
        if (current === structure) {
            return [...path, current.name];
        }
        if (visited.has(current)) {
            return undefined;
        }
        visited.add(current);
        for (const instance of compositeInstances(current)) {
            const next = instanceType(instance);
            if (ast.isCompositeType(next)) {
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

