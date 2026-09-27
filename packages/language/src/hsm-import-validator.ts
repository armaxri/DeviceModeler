import type { ValidationAcceptor, ValidationChecks } from 'langium';
import * as ast from './generated/ast.js';
import type { HsmServices } from './hsm-module.js';
import { resolveTypeName } from './hsm-typesystem.js';
import {
    instanceMachine, instanceVariables, isInstance, isUnresolvedInstance, referableName, resolvedImports, type HsmImportResolver
} from './imports.js';
import { isKnownType } from './hsm-expression-validator.js';
import { isComposite } from './model-utils.js';

export function registerImportValidationChecks(services: HsmServices): void {
    const validator = services.validation.HsmImportValidator;
    const checks: ValidationChecks<ast.HsmAstType> = {
        StateMachine: [validator.checkImports, validator.checkInstances],
        State: validator.checkSubmachineState
    };
    services.validation.ValidationRegistry.register(checks, validator);
}

/** Execution mode and order of a state machine as selected by its annotations. */
function executionSemantics(machine: ast.StateMachine): { mode: string, order: string } {
    const has = (name: string) => machine.annotations.some(a => a.name === name);
    return {
        mode: has('EventDriven') && !has('CycleBased') ? '@EventDriven' : '@CycleBased',
        order: has('ChildFirstExecution') ? '@ChildFirstExecution' : '@ParentFirstExecution'
    };
}

/**
 * Checks of imports (`import "motor.hsm"`) and submachine instances (`var motor : Motor`,
 * `state Moving : motor`), see imports.ts and docs/semantics.md §9.
 */
export class HsmImportValidator {

    protected readonly resolver: HsmImportResolver;

    constructor(services: HsmServices) {
        this.resolver = services.references.ImportResolver;
    }

    checkImports(machine: ast.StateMachine, accept: ValidationAcceptor): void {
        const byUri = new Set<string>();
        const byName = new Map<string, string>();
        for (const resolved of resolvedImports(machine)) {
            const node = resolved.node;
            const target = { node, property: 'path' } as const;
            if (!resolved.path) {
                accept('error', 'The import path is empty.', target);
                continue;
            }
            if (resolved.kind === 'header') {
                accept('info', `C/C++ header imports are not supported yet; '${resolved.path}' is ignored.`, target);
                continue;
            }
            if (resolved.kind === 'unsupported') {
                accept('error', `Cannot import '${resolved.path}': only state machines ('.hsm') and C/C++ headers ('.h', '.hpp') can be imported.`, target);
                continue;
            }
            const key = resolved.uri?.toString() ?? resolved.path;
            if (byUri.has(key)) {
                accept('warning', `'${resolved.path}' is imported more than once.`, target);
                continue;
            }
            byUri.add(key);
            const imported = resolved.machine;
            if (!imported) {
                const location = resolved.uri ? (resolved.uri.scheme === 'file' ? resolved.uri.fsPath : resolved.uri.path) : resolved.path;
                accept('error', `Cannot resolve the import '${resolved.path}': the file '${location}' was not found.`, target);
                continue;
            }
            const cycle = this.resolver.findCycle(machine, resolved);
            if (cycle) {
                accept('error', cycle.length <= 2
                    ? `The state machine '${machine.name}' cannot import itself.`
                    : `Import cycle: ${cycle.join(' -> ')}. State machines cannot import each other.`, target);
                continue;
            }
            if (imported.name === machine.name) {
                accept('error', `The imported state machine has the same name as this state machine ('${machine.name}').`, target);
                continue;
            }
            const previous = byName.get(imported.name);
            if (previous !== undefined) {
                accept('error', `Duplicate state machine name '${imported.name}': it is also imported from '${previous}'.`, target);
                continue;
            }
            byName.set(imported.name, resolved.path);
            if (resolveTypeName(imported.name)) {
                accept('error', `The imported state machine '${imported.name}' has the name of a built-in type.`, target);
            }
        }
    }

    checkInstances(machine: ast.StateMachine, accept: ValidationAcceptor): void {
        const instances = instanceVariables(machine);
        if (instances.length === 0) {
            return;
        }
        const bindings = new Map<ast.VariableDeclaration, ast.State[]>();
        for (const state of allStates(machine)) {
            const instance = state.submachine?.ref;
            if (instance && isInstance(instance)) {
                bindings.set(instance, [...bindings.get(instance) ?? [], state]);
            }
        }
        const semantics = executionSemantics(machine);
        for (const instance of instances) {
            const states = bindings.get(instance) ?? [];
            const name = referableName(instance);
            if (states.length === 0) {
                accept('warning', `The submachine instance '${name}' is not bound to a state ('state S : ${name}'); it never runs.`, { node: instance, property: 'name' });
            }
            for (const state of states.slice(1)) {
                accept('error', `The submachine instance '${name}' is already bound to the state '${states[0].name}'. An instance can be bound to one state only.`,
                    { node: state, property: 'submachine' });
            }
            const submachine = instanceMachine(instance)!;
            const other = executionSemantics(submachine);
            for (const key of ['mode', 'order'] as const) {
                if (other[key] !== semantics[key]) {
                    accept('warning', `The state machine '${submachine.name}' uses ${other[key]}, but its instance '${name}' is executed with ${semantics[key]} of '${machine.name}'.`,
                        { node: instance, property: 'type' });
                }
            }
        }
    }

    checkSubmachineState(state: ast.State, accept: ValidationAcceptor): void {
        const reference = state.submachine;
        if (!reference) {
            return;
        }
        const instance = reference.ref;
        if (!instance) {
            return; // linking error
        }
        if (!isInstance(instance)) {
            if (isUnresolvedInstance(instance, isKnownType)) {
                return; // the unresolved import is reported
            }
            accept('error', `'${reference.$refText}' is not a submachine instance: its type must be an imported state machine ('var ${instance.name} : Machine').`,
                { node: state, property: 'submachine' });
            return;
        }
        if (isComposite(state)) {
            accept('error', `The submachine state '${state.name}' cannot have sub states or regions: its sub states are the states of '${reference.$refText}'.`,
                { node: state, property: 'name' });
        }
    }
}

function allStates(machine: ast.StateMachine): ast.State[] {
    const result: ast.State[] = [];
    const visit = (container: ast.StateMachine | ast.State | ast.Region) => {
        for (const vertex of container.vertices) {
            if (ast.isState(vertex)) {
                result.push(vertex);
                visit(vertex);
                vertex.regions.forEach(visit);
            }
        }
    };
    visit(machine);
    return result;
}
