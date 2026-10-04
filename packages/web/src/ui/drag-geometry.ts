/**
 * The geometry of the splitter between the text editor and the diagram (pure functions, tested in
 * packages/vscode/test/unit/drag-geometry.test.ts; DOM part: `bindSplitter` in app.ts).
 *
 * The page puts the two panes side by side (the splitter is a vertical bar, dragging changes the width of the
 * editor) or, in narrow windows (`@media (max-width: 900px)`, e.g. an IDE editor tab or the *Text and Diagram*
 * view of the JetBrains plugin), on top of each other (the splitter is a horizontal bar, dragging changes the
 * height of the editor).
 */

/** Smallest size of the text editor (px) and of the diagram (px) along the axis of the splitter. */
export const SPLIT_MIN_EDITOR = { columns: 180, rows: 80 } as const;
export const SPLIT_MIN_DIAGRAM = { columns: 300, rows: 120 } as const;

export type SplitAxis = 'columns' | 'rows';

export interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** The axis the splitter resizes: a bar wider than high lies between two rows. */
export function splitAxis(splitter: { width: number; height: number }): SplitAxis {
    return splitter.width > splitter.height ? 'rows' : 'columns';
}

/** The size of the text editor (px) for the pointer at (x, y) in the main area `bounds`. */
export function editorSizeAt(axis: SplitAxis, bounds: Box, x: number, y: number): number {
    const position = axis === 'columns' ? x - bounds.left : y - bounds.top;
    const total = axis === 'columns' ? bounds.width : bounds.height;
    const max = Math.max(total - SPLIT_MIN_DIAGRAM[axis], SPLIT_MIN_EDITOR[axis]);
    return Math.round(Math.min(Math.max(position, SPLIT_MIN_EDITOR[axis]), max));
}
