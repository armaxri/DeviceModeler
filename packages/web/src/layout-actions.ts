import { captureLayout, layoutTextEdits, type DiagramGraph, type LayoutDirection, type ManualLayout, type StateMachine, type TextEdit } from 'hsm-language';

/*
 * The layout controls of the diagram (manual layout, experimental; docs/editor.md): one source for the
 * names, tooltips and status messages, shared by the toolbar of the web app (and the desktop / Eclipse
 * hosts which reuse it) and the toolbar of the VS Code webview. DOM-free, so that it can be unit tested.
 *
 * There is no layout mode switch: the positions are either computed automatically (the model has no
 * layout annotations) or stored in the model (layout annotations `@at`, `@via`, ...). Two actions:
 *
 * - `arrange`: arranges all elements automatically and stores the positions in the model. Without
 *   stored positions this changes nothing in the diagram, it only writes the annotations ("Store
 *   positions"); with stored positions it replaces them with a fresh automatic arrangement
 *   ("Re-arrange", waypoints, sizes and label offsets are dropped).
 * - `clear`: removes all layout annotations from the model ("Clear positions"): the diagram is arranged
 *   automatically again and follows every change of the model.
 *
 * Both are a single text edit, undone with the undo of the text (Ctrl+Z).
 */

export type LayoutAction = 'arrange' | 'clear';

export interface ControlText {
    label: string;
    title: string;
}

/** The text of the layout controls (labels and tooltips). */
export const LAYOUT_TEXT = {
    /** The direction select (its label in the web app toolbar). */
    direction: {
        label: 'Direction',
        title: 'Direction of the automatic arrangement (used for the whole diagram while no positions are stored, '
            + 'otherwise for new elements and for Re-arrange; stored positions are kept)'
    },
    /** Indicator of the current state: positions computed automatically. */
    automatic: {
        label: 'automatic',
        title: 'Positions: automatic – the diagram is arranged automatically and follows every change of the model. '
            + 'Dragging a state stores the positions in the model as layout annotations (@at, @via, …).'
    },
    /** Indicator of the current state: positions stored in the model. */
    stored: {
        label: 'stored in model',
        title: 'Positions: stored in the model as layout annotations (@at, @via, …) – elements keep their positions, '
            + 'new elements are placed automatically. Clear positions returns to the automatic arrangement.'
    },
    /** `arrange` without stored positions. */
    store: {
        label: 'Store positions',
        title: 'Store the current automatic arrangement in the model as layout annotations (@at …), so that it can be '
            + 'adjusted by hand (dragging a state does this as well). Undo: Ctrl+Z'
    },
    /** `arrange` with stored positions. */
    rearrange: {
        label: 'Re-arrange',
        title: 'Arrange all elements automatically again and store the new positions in the model: replaces the '
            + 'layout annotations (waypoints, sizes and label positions are dropped). Undo: Ctrl+Z'
    },
    /** `clear`. */
    clear: {
        label: 'Clear positions',
        title: 'Remove all layout annotations (positions, waypoints, sizes) from the model: the diagram is arranged '
            + 'automatically again and follows every change of the model. Undo: Ctrl+Z'
    }
} as const satisfies Record<string, ControlText>;

/** The name of the indicator ("Positions: automatic"). */
export const POSITIONS_LABEL = 'Positions:';

/** The status messages after an action which changed the model. */
export const LAYOUT_STATUS = {
    store: 'Positions stored in the model (layout annotations) – drag states to adjust them; Ctrl+Z undoes.',
    rearrange: 'Re-arranged – the new positions are stored in the model; Ctrl+Z restores the previous ones.',
    clear: 'Stored positions removed from the model – the diagram is arranged automatically; Ctrl+Z restores them.'
} as const;

/** The state of the layout controls of the toolbar. */
export interface LayoutControlsState {
    /** The indicator of the current state ("Positions: automatic" / "Positions: stored in model"). */
    mode: ControlText;
    /** The `arrange` button: "Store positions" or "Re-arrange". */
    arrange: ControlText;
    /** The `clear` button (hidden without stored positions: there is nothing to clear). */
    clear: ControlText & { hidden: boolean };
    /** The status message after the `arrange` action. */
    arrangeStatus: string;
}

/** The labels, tooltips and visibility of the layout controls; `stored`: the model has layout annotations. */
export function layoutControls(stored: boolean): LayoutControlsState {
    return {
        mode: stored ? LAYOUT_TEXT.stored : LAYOUT_TEXT.automatic,
        arrange: stored ? LAYOUT_TEXT.rearrange : LAYOUT_TEXT.store,
        clear: { ...LAYOUT_TEXT.clear, hidden: !stored },
        arrangeStatus: stored ? LAYOUT_STATUS.rearrange : LAYOUT_STATUS.store
    };
}

/**
 * The layout written by an action: `arrange` the automatic layout (`auto`: the graph of the automatic
 * layout of the model) with all nodes pinned, `clear` none.
 */
export function layoutOfAction(action: LayoutAction, auto: DiagramGraph, direction: LayoutDirection): ManualLayout | undefined {
    return action === 'arrange' ? captureLayout(auto, direction) : undefined;
}

/** The text edits of an action (one undoable step; empty if the model does not change). */
export function layoutActionEdits(action: LayoutAction, machine: StateMachine, text: string, auto: DiagramGraph, direction: LayoutDirection): TextEdit[] {
    return layoutTextEdits(machine, text, layoutOfAction(action, auto, direction));
}
