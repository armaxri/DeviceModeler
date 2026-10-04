import { describe, expect, it } from 'vitest';
import { SPLIT_MIN_DIAGRAM, SPLIT_MIN_EDITOR, editorSizeAt, splitAxis } from '@hsm-web/ui/drag-geometry.js';

// the splitter between the text editor and the diagram of the web app (DOM part: bindSplitter in app.ts)
describe('splitAxis', () => {
    it('resizes the columns when the panes are side by side (vertical bar)', () => {
        expect(splitAxis({ width: 5, height: 760 })).toBe('columns');
    });

    it('resizes the rows when the panes are on top of each other (horizontal bar, narrow windows)', () => {
        expect(splitAxis({ width: 856, height: 5 })).toBe('rows');
    });
});

describe('editorSizeAt', () => {
    const bounds = { left: 0, top: 80, width: 856, height: 760 };

    it('takes the horizontal position for the columns', () => {
        expect(editorSizeAt('columns', bounds, 400, 500)).toBe(400);
        expect(editorSizeAt('columns', { ...bounds, left: 100 }, 400, 500)).toBe(300);
    });

    it('takes the vertical position for the rows', () => {
        expect(editorSizeAt('rows', bounds, 400, 500)).toBe(420);
    });

    it('keeps a minimum size of editor and diagram', () => {
        expect(editorSizeAt('columns', bounds, 10, 0)).toBe(SPLIT_MIN_EDITOR.columns);
        expect(editorSizeAt('columns', bounds, 850, 0)).toBe(856 - SPLIT_MIN_DIAGRAM.columns);
        expect(editorSizeAt('rows', bounds, 0, 90)).toBe(SPLIT_MIN_EDITOR.rows);
        expect(editorSizeAt('rows', bounds, 0, 835)).toBe(760 - SPLIT_MIN_DIAGRAM.rows);
    });

    it('prefers the editor minimum when there is too little room for both', () => {
        expect(editorSizeAt('rows', { ...bounds, height: 150 }, 0, 200)).toBe(SPLIT_MIN_EDITOR.rows);
    });
});
