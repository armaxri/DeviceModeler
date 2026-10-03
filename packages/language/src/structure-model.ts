import { AstUtils, type AstNode } from 'langium';
import * as ast from './generated/ast.js';

/**
 * Helpers for the AST of structure files (`.devm`): instances, threads, ports and annotations of
 * structures. Pure functions over the AST, used by the validator, the route analysis (structure-routes.ts)
 * and the diagram.
 */

/** The subsystem or system whose body contains the node. */
export function enclosingComposite(node: AstNode | undefined): ast.CompositeType | undefined {
    return node ? AstUtils.getContainerOfType(node, ast.isCompositeType) : undefined;
}

/**
 * Why a system has no ports: it is the closed, complete top level of a product. Its environment (a remote
 * control, a display, …) is modeled as parts of the system; a composite with boundary ports is a subsystem.
 */
export function systemPortsMessage(system: string): string {
    return `'${system}' is a system: the closed top level has no ports – model the environment (e.g. the remote control) `
        + `as parts of the system, or declare it as 'subsystem ${system}'.`;
}

/** All instances of a composite: those declared directly in its body and those declared in its threads, in text order. */
export function compositeInstances(structure: ast.CompositeType): ast.ComponentInstance[] {
    const result: ast.ComponentInstance[] = [];
    for (const node of AstUtils.streamContents(structure)) {
        if (ast.isComponentInstance(node)) {
            result.push(node);
        } else if (ast.isThread(node)) {
            result.push(...node.instances);
        }
    }
    return result;
}

/** The component type of an instance (`undefined` if the reference cannot be resolved). */
export function instanceType(instance: ast.ComponentInstance | undefined): ast.ComponentType | undefined {
    return instance?.type?.ref;
}

/**
 * The threads an instance is assigned to: the thread declaring it and the threads naming it
 * (`thread T { door }`). More than one is an error (reported by the validator).
 */
export function threadsOf(instance: ast.ComponentInstance): ast.Thread[] {
    const result: ast.Thread[] = [];
    if (ast.isThread(instance.$container)) {
        result.push(instance.$container);
    }
    const structure = enclosingComposite(instance);
    for (const thread of structure?.threads ?? []) {
        if (!result.includes(thread) && thread.members.some(m => m.instance?.ref === instance)) {
            result.push(thread);
        }
    }
    return result;
}

/**
 * The thread of an instance in its subsystem or system, `undefined` for an instance outside of any
 * thread: an instance of a subsystem (its parts run in the threads of the subsystem) or a component
 * instance not assigned to a thread (an error, see docs/structure-language.md#threads).
 */
export function threadOf(instance: ast.ComponentInstance): ast.Thread | undefined {
    return threadsOf(instance)[0];
}

/** The instances of a thread: declared in it and assigned to it by name. */
export function threadInstances(thread: ast.Thread): ast.ComponentInstance[] {
    const result = [...thread.instances];
    for (const member of thread.members) {
        const instance = member.instance?.ref;
        if (instance && !result.includes(instance)) {
            result.push(instance);
        }
    }
    return result;
}

/** The text of a port reference: `door.cmd` or `diag`. */
export function portReferenceText(reference: ast.PortReference): string {
    const port = reference.port?.$refText ?? '?';
    return reference.instance ? `${reference.instance.$refText}.${port}` : port;
}

// ---------------------------------------------------------------------------------------------
// Annotations

type Annotated = { readonly annotations: readonly ast.StructureAnnotation[] };

/** The first annotation with the given name. */
export function structureAnnotation(node: Annotated, name: string): ast.StructureAnnotation | undefined {
    return node.annotations.find(a => a.name === name);
}

/** The value of a numeric annotation argument. */
export function argumentNumber(argument: ast.AnnotationArgument | undefined): number | undefined {
    if (argument?.number === undefined) {
        return undefined;
    }
    const text = argument.number;
    const negative = text.startsWith('-');
    const digits = negative ? text.slice(1) : text;
    const value = /^0[xX]/.test(digits) ? parseInt(digits, 16) : Number(digits);
    return negative ? -value : value;
}

/** Durations of `@period(10 ms)`: the factor of the unit to nanoseconds. */
export const DURATION_UNITS: Readonly<Record<string, number>> = { s: 1e9, ms: 1e6, us: 1e3, ns: 1 };

/** The settings of a thread from its annotations (`@priority(5) @period(10 ms) @stack(4096)`). */
export interface ThreadSettings {
    readonly priority?: number;
    /** The period in nanoseconds. */
    readonly periodNs?: number;
    /** The period as written: `10 ms`. */
    readonly period?: string;
    /** The stack size in bytes. */
    readonly stack?: number;
}

export function threadSettings(thread: ast.Thread): ThreadSettings {
    const priority = argumentNumber(structureAnnotation(thread, 'priority')?.arguments[0]);
    const stack = argumentNumber(structureAnnotation(thread, 'stack')?.arguments[0]);
    const periodArgument = structureAnnotation(thread, 'period')?.arguments[0];
    const periodValue = argumentNumber(periodArgument);
    const factor = periodArgument?.unit ? DURATION_UNITS[periodArgument.unit] : undefined;
    return {
        priority, stack,
        periodNs: periodValue !== undefined && factor !== undefined ? periodValue * factor : undefined,
        period: periodValue !== undefined ? `${periodArgument!.number}${periodArgument!.unit ? ` ${periodArgument!.unit}` : ''}` : undefined
    };
}
