import { describe, expect, it } from 'vitest';
import { canApplyEdit, toRangeEdits } from '../../src/extension/logic/edits.js';

/** `TextDocument.positionAt` of a text. */
function positionAt(text: string) {
    return (offset: number) => {
        const before = text.slice(0, offset).split('\n');
        return { line: before.length - 1, character: before[before.length - 1].length };
    };
}

describe('toRangeEdits', () => {
    const text = 'statemachine A {\n    state X\n}\n';

    it('converts offset edits into range edits sorted by offset', () => {
        const edits = toRangeEdits([
            { offset: text.indexOf('}'), length: 0, text: '    state Y\n' },
            { offset: text.indexOf('X'), length: 1, text: 'Idle' }
        ], text.length, positionAt(text));
        expect(edits).toEqual([
            { start: { line: 1, character: 10 }, end: { line: 1, character: 11 }, text: 'Idle' },
            { start: { line: 2, character: 0 }, end: { line: 2, character: 0 }, text: '    state Y\n' }
        ]);
    });

    it('accepts an insertion at the end of the text', () => {
        expect(toRangeEdits([{ offset: text.length, length: 0, text: 'x' }], text.length, positionAt(text))).toHaveLength(1);
    });

    it('rejects edits outside of the text and overlapping edits', () => {
        expect(() => toRangeEdits([{ offset: text.length, length: 1, text: '' }], text.length, positionAt(text))).toThrow(/outside/);
        expect(() => toRangeEdits([{ offset: -1, length: 0, text: '' }], text.length, positionAt(text))).toThrow(/outside/);
        expect(() => toRangeEdits([{ offset: 0, length: 5, text: '' }, { offset: 3, length: 1, text: '' }], text.length, positionAt(text))).toThrow(/Overlapping/);
    });

    it('applies edits only to the document version they were computed for', () => {
        expect(canApplyEdit(3, 3)).toBe(true);
        expect(canApplyEdit(3, 4)).toBe(false);
    });
});
