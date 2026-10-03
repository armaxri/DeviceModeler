import * as ast from './generated/ast.js';
import { isInstance } from './imports.js';
import { behaviorMachine } from './structure-imports.js';
import { dataTypeName, payloadLabel, portDataType, sameDataType } from './structure-types.js';
import { eventDirection, typeOfEvent, typeOfVariable } from './typesystem.js';

/**
 * The mapping of the ports of a component onto the definition section of its state machine
 * (`behavior "door.devm"`), see docs/structure-language.md:
 *
 * | port                  | state machine            |
 * |-----------------------|--------------------------|
 * | `out sync p : T`      | `var p : T`              |
 * | `in sync p : T`       | `var readonly p : T`     |
 * | `inout sync p : T`    | `var p : T`              |
 * | `in async p : T`      | `in event p : T`         |
 * | `out async p : T`     | `out event p : T`        |
 *
 * The element is looked up by the name of the port in all interfaces of the state machine (the unnamed
 * interface and the named ones, not the internal scope); the name must be unique there (two elements
 * with the name of a port in different interfaces are ambiguous: an error). Types must be the same
 * (`integer` and `real` are different here); an async port without type is an event without payload.
 *
 * Conversely, every `in` / `out` event and every variable of the interfaces of the state machine
 * should belong to a port ({@link BehaviorMapping.unmapped}); constants, operations, type aliases
 * and submachine instances are not mapped.
 */

export interface PortMapping {
    readonly port: ast.Port;
    /** The variable or event the port is mapped to (also set if it does not fit, see {@link problem}). */
    readonly declaration?: ast.VariableDeclaration | ast.EventDeclaration;
    /** Why the port does not match the state machine. */
    readonly problem?: string;
}

export interface BehaviorMapping {
    readonly component: ast.Component;
    readonly machine: ast.StateMachine;
    readonly ports: readonly PortMapping[];
    /** Interface events and variables of the state machine that do not belong to any port. */
    readonly unmapped: ReadonlyArray<ast.EventDeclaration | ast.VariableDeclaration>;
}

/** The mapping of the ports of a component onto its state machine (`undefined` without a resolved behavior). */
export function behaviorMapping(component: ast.Component): BehaviorMapping | undefined {
    const machine = behaviorMachine(component);
    if (!machine) {
        return undefined;
    }
    const used = new Set<ast.Declaration>();
    const ports = component.ports.filter(p => p.name).map(port => {
        const mapping = mapPort(port, machine);
        if (mapping.declaration) {
            used.add(mapping.declaration);
        }
        return mapping;
    });
    const unmapped: Array<ast.EventDeclaration | ast.VariableDeclaration> = [];
    for (const declaration of interfaceDeclarations(machine)) {
        if (used.has(declaration)) {
            continue;
        }
        if (ast.isEventDeclaration(declaration) || (ast.isVariableDeclaration(declaration) && !declaration.const && !isInstance(declaration))) {
            unmapped.push(declaration);
        }
    }
    return { component, machine, ports, unmapped };
}

/** The declarations of all interfaces (unnamed and named) of a state machine. */
function interfaceDeclarations(machine: ast.StateMachine): ast.Declaration[] {
    return machine.scopes.filter(ast.isInterfaceScope).flatMap(scope => scope.declarations);
}

/** Where a declaration is: `the unnamed interface`, `interface motor`. */
function scopeLabel(declaration: ast.Declaration): string {
    const scope = declaration.$container;
    return ast.isInterfaceScope(scope) && scope.name ? `interface ${scope.name}` : 'the unnamed interface';
}

/** The state machine element a port is mapped to: `var readonly p : T`, `in event p : T`. */
export function expectedDeclaration(port: ast.Port): string {
    const type = port.type ? ` : ${dataTypeName(portDataType(port))}` : '';
    if (port.kind === 'async') {
        return `${port.direction === 'out' ? 'out' : 'in'} event ${port.name}${type}`;
    }
    return `var ${port.direction === 'in' ? 'readonly ' : ''}${port.name}${type}`;
}

function mapPort(port: ast.Port, machine: ast.StateMachine): PortMapping {
    const candidates = interfaceDeclarations(machine).filter(d => d.name === port.name
        && (ast.isEventDeclaration(d) || ast.isVariableDeclaration(d) || ast.isOperationDeclaration(d)));
    const expected = expectedDeclaration(port);
    if (candidates.length === 0) {
        return { port, problem: `The state machine '${machine.name}' has no element '${port.name}' for the port '${port.name}' (declare '${expected}' in an interface).` };
    }
    if (candidates.length > 1) {
        return { port, problem: `The port '${port.name}' is ambiguous: the state machine '${machine.name}' declares '${port.name}' in ${candidates.map(scopeLabel).join(' and ')} (port names are looked up in all interfaces).` };
    }
    const declaration = candidates[0];
    return port.kind === 'async' ? mapEvent(port, machine, declaration, expected) : mapVariable(port, machine, declaration, expected);
}

function mapEvent(port: ast.Port, machine: ast.StateMachine, declaration: ast.Declaration, expected: string): PortMapping {
    const direction = port.direction === 'out' ? 'out' : 'in';
    if (!ast.isEventDeclaration(declaration)) {
        return { port, problem: `The async port '${port.name}' is an event: '${port.name}' of '${machine.name}' must be '${expected}', not ${ast.isVariableDeclaration(declaration) ? 'a variable' : 'an operation'}.` };
    }
    const actual = eventDirection(declaration);
    if (actual !== direction) {
        return { port, declaration, problem: `The ${port.direction} async port '${port.name}' must be an ${direction} event of '${machine.name}', but '${port.name}' is ${actual === 'internal' ? 'an internal' : `an ${actual}`} event.` };
    }
    const type = portDataType(port);
    const actualType = typeOfEvent(declaration);
    if (!sameDataType(type, actualType)) {
        return { port, declaration, problem: `The port '${port.name}' carries ${payloadLabel(type)}, but the event '${port.name}' of '${machine.name}' carries ${payloadLabel(actualType)}.` };
    }
    return { port, declaration };
}

function mapVariable(port: ast.Port, machine: ast.StateMachine, declaration: ast.Declaration, expected: string): PortMapping {
    if (!ast.isVariableDeclaration(declaration) || declaration.const) {
        const what = ast.isEventDeclaration(declaration) ? 'an event' : ast.isOperationDeclaration(declaration) ? 'an operation' : 'a constant';
        return { port, problem: `The sync port '${port.name}' is data: '${port.name}' of '${machine.name}' must be '${expected}', not ${what}.` };
    }
    if (port.direction === 'in' && !declaration.readonly) {
        return { port, declaration, problem: `The in port '${port.name}' is written by its source: the variable '${port.name}' of '${machine.name}' must be read-only ('${expected}').` };
    }
    if (port.direction !== 'in' && declaration.readonly) {
        return { port, declaration, problem: `The ${port.direction} port '${port.name}' is written by the state machine: the variable '${port.name}' of '${machine.name}' must not be read-only ('${expected}').` };
    }
    const type = portDataType(port);
    const actual = typeOfVariable(declaration);
    if (!sameDataType(type, actual)) {
        return { port, declaration, problem: `The variable '${port.name}' of '${machine.name}' has the type ${dataTypeName(actual)}, but the port has the type ${dataTypeName(type)}.` };
    }
    return { port, declaration };
}
