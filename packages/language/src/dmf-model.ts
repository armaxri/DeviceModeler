import { AstUtils, type AstNode } from 'langium';
import * as ast from './generated/ast.js';

/**
 * Helpers for the AST of structure files (`.dmf`): instances, threads, ports and annotations of
 * structures. Pure functions over the AST, used by the validator, the route analysis (dmf-routes.ts)
 * and the diagram.
 */

/** The structure (or system) whose body contains the node. */
export function enclosingStructure(node: AstNode | undefined): ast.Structure | undefined {
    return node ? AstUtils.getContainerOfType(node, ast.isStructure) : undefined;
}

/** All instances of a structure: those declared directly in its body and those declared in its threads, in text order. */
export function structureInstances(structure: ast.Structure): ast.ComponentInstance[] {
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

/** Whether the component type is a composite (structure or system). */
export function isCompositeType(type: ast.ComponentType | undefined): type is ast.Structure {
    return ast.isStructure(type);
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
    const structure = enclosingStructure(instance);
    for (const thread of structure?.threads ?? []) {
        if (!result.includes(thread) && thread.members.some(m => m.instance?.ref === instance)) {
            result.push(thread);
        }
    }
    return result;
}

/**
 * The thread of an instance in its structure, `undefined` for an instance outside of any thread
 * (a passive instance: it runs in the threads of its callers, or for a composite, its parts run in
 * their own threads, see docs/structure-language.md).
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

type Annotated = { readonly annotations: readonly ast.DmfAnnotation[] };

/** The first annotation with the given name. */
export function dmfAnnotation(node: Annotated, name: string): ast.DmfAnnotation | undefined {
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
    const priority = argumentNumber(dmfAnnotation(thread, 'priority')?.arguments[0]);
    const stack = argumentNumber(dmfAnnotation(thread, 'stack')?.arguments[0]);
    const periodArgument = dmfAnnotation(thread, 'period')?.arguments[0];
    const periodValue = argumentNumber(periodArgument);
    const factor = periodArgument?.unit ? DURATION_UNITS[periodArgument.unit] : undefined;
    return {
        priority, stack,
        periodNs: periodValue !== undefined && factor !== undefined ? periodValue * factor : undefined,
        period: periodValue !== undefined ? `${periodArgument!.number}${periodArgument!.unit ? ` ${periodArgument!.unit}` : ''}` : undefined
    };
}
