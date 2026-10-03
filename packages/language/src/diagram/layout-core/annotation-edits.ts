/**
 * Minimal text edits which make the layout annotations of a model equal to a layout, independent of
 * the language: the language specific part (layout-annotations.ts for state machines,
 * ibd-layout-annotations.ts for structure files) describes for every element of the diagram an
 * {@link AnnotationSlot} – the annotations written at one place in the text and the layout annotations
 * that should be there – and {@link annotationSlotEdits} computes the edits:
 *
 * - values of existing layout annotations are replaced in place (only if they differ),
 * - new annotations are appended to the last annotation of the slot (separated by a space), or take the
 *   place of a removed one, or are inserted by the slot (on a line of their own before the element, or in
 *   front of it on the same line, see {@link insertAnnotations}),
 * - layout annotations which are not wanted are removed, with the white space separating them from the
 *   rest of the line, or with their line if nothing else remains on it.
 *
 * Applying the edits and computing them again yields no edits (numbers are written as integers).
 */
import type { TextEdit } from '../../edit/model-edits.js';

/** An argument of a layout annotation: a number (written as an integer), a string (quoted) or a name. */
export type LayoutArgument = number | string | { readonly name: string };

/** A layout annotation an element should have. */
export interface WantedAnnotation {
    name: string;
    /** Identifies the annotation among those of the slot (default: the name; e.g. `port:cmd` for `@port(cmd, …)`). */
    key?: string;
    args: readonly LayoutArgument[];
}

/** An annotation written in the text. */
export interface WrittenAnnotation {
    name: string;
    /** See {@link WantedAnnotation.key} (default: the name). */
    key?: string;
    /** Whether it is a layout annotation managed by the slot (other annotations are never changed). */
    layout: boolean;
    /** The arguments, undefined if they cannot be read (the annotation is rewritten). */
    args?: readonly LayoutArgument[];
    offset: number;
    end: number;
}

/** The annotations written at one place of the text (e.g. in front of an element) and the layout annotations wanted there. */
export interface AnnotationSlot {
    /** All annotations of the slot (layout and other annotations). */
    written: readonly WrittenAnnotation[];
    wanted: readonly WantedAnnotation[];
    /** Inserts the annotations (text, separated by spaces) if the slot has no annotation yet. */
    insert(annotations: string): TextEdit;
}

/** Numbers are written as integers. */
export function roundCoordinate(value: number): number {
    const rounded = Math.round(value);
    return Object.is(rounded, -0) ? 0 : rounded;
}

function argumentText(argument: LayoutArgument): string {
    if (typeof argument === 'number') {
        return String(roundCoordinate(argument));
    }
    return typeof argument === 'string' ? `"${argument}"` : argument.name;
}

/** The text of an annotation: `@at(10, 20)`, `@regions("vertical")`, `@port(cmd, left, 40)`. */
export function annotationText(annotation: WantedAnnotation): string {
    return `@${annotation.name}(${annotation.args.map(argumentText).join(', ')})`;
}

function sameArguments(written: readonly LayoutArgument[] | undefined, wanted: readonly LayoutArgument[]): boolean {
    if (!written || written.length !== wanted.length) {
        return false;
    }
    return written.every((value, i) => {
        const other = wanted[i];
        if (typeof other === 'number') {
            return typeof value === 'number' && value === roundCoordinate(other);
        }
        if (typeof other === 'string') {
            return value === other;
        }
        return typeof value === 'object' && value.name === other.name;
    });
}

/** The edits making the layout annotations of the slots equal to the wanted ones (sorted, see the module comment). */
export function annotationSlotEdits(text: string, slots: readonly AnnotationSlot[]): TextEdit[] {
    const edits: TextEdit[] = [];
    const deletions: Array<{ offset: number, end: number }> = [];
    for (const slot of slots) {
        const kept: WrittenAnnotation[] = [];
        const removed: WrittenAnnotation[] = [];
        const missing = new Map(slot.wanted.map(w => [w.key ?? w.name, w]));
        for (const annotation of slot.written.filter(a => a.layout)) {
            const wanted = missing.get(annotation.key ?? annotation.name);
            if (!wanted || wanted.name !== annotation.name) {
                removed.push(annotation);
                continue;
            }
            missing.delete(annotation.key ?? annotation.name);
            kept.push(annotation);
            if (!sameArguments(annotation.args, wanted.args)) {
                edits.push({ offset: annotation.offset, length: annotation.end - annotation.offset, text: annotationText(wanted) });
            }
        }
        const added = [...missing.values()].map(annotationText).join(' ');
        const others = slot.written.filter(a => !a.layout);
        const anchor = [...kept, ...others].sort((a, b) => a.end - b.end).pop();
        if (added && anchor) {
            edits.push({ offset: anchor.end, length: 0, text: ` ${added}` });
        } else if (added && removed.length > 0) {
            // the new annotations take the place of the first removed one
            const first = removed.sort((a, b) => a.offset - b.offset).shift()!;
            edits.push({ offset: first.offset, length: first.end - first.offset, text: added });
        } else if (added) {
            edits.push(slot.insert(added));
        }
        deletions.push(...removed.map(a => ({ offset: a.offset, end: a.end })));
    }
    edits.push(...annotationDeletionEdits(text, deletions, edits));
    return mergeInsertions(edits);
}

/**
 * Inserts annotations in front of the text at `offset` (an element without annotations): with
 * `ownLine`, on a line of their own (with the indentation of the element) if the element starts a line;
 * otherwise in front of it on the same line.
 */
export function insertAnnotations(offset: number, text: string, annotations: string, ownLine = true): TextEdit {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const indent = text.substring(lineStart, offset);
    if (ownLine && indent.trim() === '') {
        return { offset, length: 0, text: `${annotations}\n${indent}` };
    }
    return { offset, length: 0, text: `${annotations} ` };
}

/**
 * Edits removing annotations: with the white space separating them from the rest of the line, or the
 * whole line if nothing else remains on it. `others` are the other edits of the same change (lines they
 * touch are kept).
 */
export function annotationDeletionEdits(text: string, deletions: ReadonlyArray<{ offset: number, end: number }>, others: readonly TextEdit[] = []): TextEdit[] {
    const byLine = new Map<number, Array<{ offset: number, end: number }>>();
    for (const deletion of deletions) {
        const lineStart = text.lastIndexOf('\n', deletion.offset - 1) + 1;
        byLine.set(lineStart, [...(byLine.get(lineStart) ?? []), deletion]);
    }
    const result: TextEdit[] = [];
    for (const [lineStart, ranges] of byLine) {
        const newline = text.indexOf('\n', lineStart);
        const lineEnd = newline < 0 ? text.length : newline;
        const touched = others.some(e => e.offset >= lineStart && e.offset <= lineEnd);
        let rest = text.substring(lineStart, lineEnd);
        for (const range of [...ranges].sort((a, b) => b.offset - a.offset)) {
            rest = rest.substring(0, range.offset - lineStart) + rest.substring(range.end - lineStart);
        }
        if (!touched && rest.trim() === '') {
            result.push({ offset: lineStart, length: (newline < 0 ? text.length : newline + 1) - lineStart, text: '' });
            continue;
        }
        // neighboring annotations (separated by white space only) are removed together
        const merged: Array<{ offset: number, end: number }> = [];
        for (const range of [...ranges].sort((a, b) => a.offset - b.offset)) {
            const last = merged[merged.length - 1];
            if (last && text.substring(last.end, range.offset).trim() === '' && !others.some(e => e.offset > last.end && e.offset < range.offset)) {
                last.end = range.end;
            } else {
                merged.push({ ...range });
            }
        }
        for (const range of merged) {
            // the annotations and the white space after them (before them at the end of the line)
            let end = range.end;
            while (end < lineEnd && /[ \t]/.test(text[end])) {
                end++;
            }
            let start = range.offset;
            if (end === lineEnd) {
                end = range.end;
                while (start > lineStart && /[ \t]/.test(text[start - 1])) {
                    start--;
                }
                if (others.some(e => e.offset >= start && e.offset <= range.offset)) {
                    start = range.offset;
                }
            } else if (others.some(e => e.offset > range.end && e.offset <= end)) {
                end = range.end;
            }
            result.push({ offset: start, length: end - start, text: '' });
        }
    }
    return result;
}

/** Sorts the edits; insertions at the same offset are combined (in the order they were created). */
export function mergeInsertions(edits: readonly TextEdit[]): TextEdit[] {
    const sorted = edits.map((edit, index) => ({ edit, index }))
        .sort((a, b) => a.edit.offset - b.edit.offset || a.edit.length - b.edit.length || a.index - b.index)
        .map(e => e.edit);
    const result: TextEdit[] = [];
    for (const edit of sorted) {
        const last = result[result.length - 1];
        if (last && last.length === 0 && edit.length === 0 && last.offset === edit.offset) {
            result[result.length - 1] = { ...last, text: last.text + edit.text };
        } else {
            result.push(edit);
        }
    }
    return result;
}
