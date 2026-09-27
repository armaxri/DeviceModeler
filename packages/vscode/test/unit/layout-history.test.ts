import { describe, expect, it } from 'vitest';
import { createManualLayout } from 'hsm-language';
import { LayoutHistory, textKey } from '@hsm-web/diagram/manual-layout-support.js';

/*
 * The combined text / layout undo of the diagram webview: VS Code documents have no version id that
 * returns to earlier values on undo, so text states are identified by `textKey` (a hash of the text).
 */

const layout = (x: number) => ({ ...createManualLayout(), nodes: { A: { x, y: 0 } } });

describe('textKey', () => {
    it('identifies equal texts and distinguishes different ones', () => {
        expect(textKey('statemachine A {}')).toBe(textKey('statemachine A {}'));
        expect(textKey('statemachine A {}')).not.toBe(textKey('statemachine B {}'));
        expect(textKey('')).toBe('0:811c9dc5');
    });
});

describe('LayoutHistory with text keys', () => {
    const v1 = textKey('v1');
    const v2 = textKey('v2');

    it('undoes a layout-only change while the text is unchanged, then leaves the undo to the text', () => {
        const history = new LayoutHistory();
        history.push({ before: undefined, after: layout(1), textKey: v1, linked: false });
        // the text was edited afterwards: undo belongs to the text editor
        expect(history.layoutUndo(v2)).toBeUndefined();
        // after the text edit was undone (same text again), the layout change is next
        expect(history.layoutUndo(v1)?.after).toEqual(layout(1));
        expect(history.layoutUndo(v1)).toBeUndefined();
        expect(history.layoutRedo(v1)?.after).toEqual(layout(1));
    });

    it('undoes / redoes layout changes of a diagram edit together with the text', () => {
        const history = new LayoutHistory();
        // a rename in the diagram: text v1 -> v2, the layout keys follow (linked)
        history.push({ before: layout(1), after: layout(2), textKey: v2, linked: true });
        // Ctrl+Z in the diagram: not a layout-only change, the text is undone by VS Code ...
        expect(history.layoutUndo(v2)).toBeUndefined();
        // ... and the text change (undo from v2) takes the layout along
        expect(history.textUndone(v2)?.before).toEqual(layout(1));
        expect(history.textRedone(v2)?.after).toEqual(layout(2));
    });

    it('drops the redo stack on a new text edit', () => {
        const history = new LayoutHistory();
        history.push({ before: undefined, after: layout(1), textKey: v1, linked: false });
        history.layoutUndo(v1);
        history.textEdited();
        expect(history.layoutRedo(v1)).toBeUndefined();
    });
});
