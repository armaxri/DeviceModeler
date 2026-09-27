import type { OffsetEdit } from '../../common/protocol.js';

export interface Position {
    line: number;
    character: number;
}

export interface RangeEdit<P extends Position = Position> {
    start: P;
    end: P;
    text: string;
}

/**
 * Converts the offset based edits of the webview into range based edits of a text document.
 * `positionAt` converts an offset of the current document text (`TextDocument.positionAt`).
 * Throws if an edit is outside of the text or if edits overlap. The result is sorted by offset.
 */
export function toRangeEdits<P extends Position>(edits: readonly OffsetEdit[], textLength: number, positionAt: (offset: number) => P): Array<RangeEdit<P>> {
    const sorted = [...edits].sort((a, b) => a.offset - b.offset);
    let lastEnd = -1;
    for (const edit of sorted) {
        if (!Number.isInteger(edit.offset) || !Number.isInteger(edit.length) || edit.offset < 0 || edit.length < 0 || edit.offset + edit.length > textLength) {
            throw new Error(`Text edit outside of the document (offset ${edit.offset}, length ${edit.length}).`);
        }
        if (edit.offset < lastEnd) {
            throw new Error('Overlapping text edits.');
        }
        lastEnd = edit.offset + edit.length;
    }
    return sorted.map(edit => ({ start: positionAt(edit.offset), end: positionAt(edit.offset + edit.length), text: edit.text }));
}

/**
 * Whether an edit computed by the webview for document version `editVersion` can be applied to the
 * document: only if the document has not been changed in the meantime.
 */
export function canApplyEdit(editVersion: number, documentVersion: number): boolean {
    return editVersion === documentVersion;
}
