import * as ast from './generated/ast.js';
import { behaviorMachine } from './dmf-imports.js';
import { dmfTypeName, eventType, payloadLabel, portDataType, portEvents, sameDmfType } from './dmf-types.js';
import { eventDirection, returnTypeOf, typeOfEvent, typeOfParameter, typeOfVariable } from './hsm-typesystem.js';

/**
 * The mapping of the ports of a component onto the definition section of its state machine
 * (`behavior "door.devm"`), see docs/structure-language.md:
 *
 * - async provided port `p`: every event `e` of the port is an `in event e` of the state machine,
 * - async required port `r`: every event `e` of the port is an `out event e`,
 *   (the event is looked up in the interface named like the port, `interface p: in event e`, then in
 *   the unnamed interface; payload types must be the same),
 * - sync provided port `p : T`: a variable (or constant) `p : T` of the state machine, the data the
 *   component provides,
 * - sync required port `r : T`: an operation of the state machine, called to get the data
 *   (`operation r() : T`) or to pass it (`operation r(value : T) : void`),
 *   (variables and operations are looked up in the unnamed interface, then in the named interfaces).
 *
 * Conversely, every `in` / `out` event and every operation of the interfaces of the state machine
 * should belong to a port ({@link BehaviorMapping.unmapped}).
 */

/** The state machine element a port (event) is mapped to, or the reason why there is none. */
export interface MappedElement<T> {
    readonly declaration?: T;
    readonly problem?: string;
}

export interface PortMapping {
    readonly port: ast.Port;
    /** Async ports: the state machine event of each event of the port. */
    readonly events: ReadonlyArray<MappedElement<ast.EventDeclaration> & { readonly event: ast.PortEvent }>;
    /** Sync ports: the variable (provided) or operation (required). */
    readonly data?: MappedElement<ast.VariableDeclaration | ast.OperationDeclaration>;
}

export interface BehaviorMapping {
    readonly component: ast.Component;
    readonly machine: ast.StateMachine;
    readonly ports: readonly PortMapping[];
    /** Interface events and operations of the state machine that do not belong to any port. */
    readonly unmapped: ReadonlyArray<ast.EventDeclaration | ast.OperationDeclaration>;
}

/** The mapping of the ports of a component onto its state machine (`undefined` without a resolved behavior). */
export function behaviorMapping(component: ast.Component): BehaviorMapping | undefined {
    const machine = behaviorMachine(component);
    if (!machine) {
        return undefined;
    }
    const used = new Set<ast.Declaration>();
    const ports = component.ports.map(port => {
        const mapping = port.kind === 'async' ? mapAsyncPort(port, machine) : mapSyncPort(port, machine);
        mapping.events.forEach(e => e.declaration && used.add(e.declaration));
        if (mapping.data?.declaration) {
            used.add(mapping.data.declaration);
        }
        return mapping;
    });
    const unmapped: Array<ast.EventDeclaration | ast.OperationDeclaration> = [];
    for (const scope of machine.scopes.filter(ast.isInterfaceScope)) {
        for (const declaration of scope.declarations) {
            if ((ast.isEventDeclaration(declaration) || ast.isOperationDeclaration(declaration)) && !used.has(declaration)) {
                unmapped.push(declaration);
            }
        }
    }
    return { component, machine, ports, unmapped };
}

/** The interface declarations named `name`: in the interface named `scope` (if given), else in the unnamed interface, else in named interfaces. */
function lookup(machine: ast.StateMachine, name: string, scope?: string): ast.Declaration | undefined {
    const interfaces = machine.scopes.filter(ast.isInterfaceScope);
    const find = (candidates: ast.InterfaceScope[]) => candidates.flatMap(s => s.declarations).find(d => d.name === name);
    return (scope !== undefined ? find(interfaces.filter(s => s.name === scope)) : undefined)
        ?? find(interfaces.filter(s => !s.name))
        ?? (scope === undefined ? find(interfaces.filter(s => s.name)) : undefined);
}

function mapAsyncPort(port: ast.Port, machine: ast.StateMachine): PortMapping {
    const direction = port.direction === 'provides' ? 'in' : 'out';
    const events = portEvents(port).map(event => {
        const declaration = lookup(machine, event.name, port.name);
        if (!ast.isEventDeclaration(declaration)) {
            return { event, problem: `The state machine '${machine.name}' has no ${direction} event '${event.name}' for the port '${port.name}' (declare '${direction} event ${event.name}' in its interface).` };
        }
        const actual = eventDirection(declaration);
        if (actual !== direction) {
            return { event, declaration, problem: `The event '${event.name}' of the ${port.direction === 'provides' ? 'provided' : 'required'} port '${port.name}' must be an ${direction} event of '${machine.name}', but it is ${actual === 'internal' ? 'an internal' : `an ${actual}`} event.` };
        }
        const expected = eventType(event);
        const type = typeOfEvent(declaration);
        if (!sameDmfType(expected, type)) {
            return { event, declaration, problem: `The event '${event.name}' of the port '${port.name}' carries ${payloadLabel(expected)}, but the event of '${machine.name}' carries ${payloadLabel(type)}.` };
        }
        return { event, declaration };
    });
    return { port, events };
}

function mapSyncPort(port: ast.Port, machine: ast.StateMachine): PortMapping {
    const type = portDataType(port);
    const declaration = lookup(machine, port.name);
    if (port.direction === 'provides') {
        if (!ast.isVariableDeclaration(declaration)) {
            return { port, events: [], data: { problem: `The state machine '${machine.name}' has no variable '${port.name}' for the provided sync port '${port.name}' (declare 'var ${port.name} : ${dmfTypeName(type)}' in its interface).` } };
        }
        const actual = typeOfVariable(declaration);
        return sameDmfType(type, actual)
            ? { port, events: [], data: { declaration } }
            : { port, events: [], data: { declaration, problem: `The variable '${port.name}' of '${machine.name}' has the type ${dmfTypeName(actual)}, but the port has the type ${dmfTypeName(type)}.` } };
    }
    if (!ast.isOperationDeclaration(declaration)) {
        return { port, events: [], data: { problem: `The state machine '${machine.name}' has no operation '${port.name}' for the required sync port '${port.name}' (declare 'operation ${port.name}() : ${dmfTypeName(type)}' or 'operation ${port.name}(value : ${dmfTypeName(type)}) : void' in its interface).` } };
    }
    const parameters = declaration.parameters;
    const getter = parameters.length === 0 && sameDmfType(type, returnTypeOf(declaration));
    const setter = parameters.length === 1 && returnTypeOf(declaration) === 'void' && sameDmfType(type, typeOfParameter(parameters[0]));
    return getter || setter
        ? { port, events: [], data: { declaration } }
        : { port, events: [], data: { declaration, problem: `The operation '${port.name}' of '${machine.name}' must be 'operation ${port.name}() : ${dmfTypeName(type)}' or 'operation ${port.name}(value : ${dmfTypeName(type)}) : void' for the required sync port '${port.name}'.` } };
}
