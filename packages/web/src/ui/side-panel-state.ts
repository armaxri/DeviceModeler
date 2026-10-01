/**
 * The persisted state of the side panel (side-panel.ts), free of DOM code so that it can be unit tested.
 */

/** The persisted state of the side panel. */
export interface SidePanelState {
    /** The whole panel is collapsed. */
    collapsed?: boolean;
    /** The width in pixels (undefined: the default width of the style sheet). */
    width?: number;
    /** The sections by key: `true` collapsed, `false` expanded (missing: the default of the section). */
    sections?: Record<string, boolean>;
}

export const SIDE_PANEL_MIN_WIDTH = 200;
export const SIDE_PANEL_MAX_WIDTH = 900;
/** The width the diagram keeps at least when the panel is resized. */
const MIN_DIAGRAM_WIDTH = 200;

/** The width within the limits: at least the minimal width, at most what leaves the diagram enough room. */
export function clampPanelWidth(width: number, available = Infinity): number {
    const max = Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(SIDE_PANEL_MAX_WIDTH, available - MIN_DIAGRAM_WIDTH));
    return Math.round(Math.min(max, Math.max(SIDE_PANEL_MIN_WIDTH, width)));
}

/** A valid state from stored data (anything): unknown and invalid entries are dropped. */
export function normalizePanelState(raw: unknown): SidePanelState {
    const state: SidePanelState = {};
    if (!raw || typeof raw !== 'object') {
        return state;
    }
    const value = raw as Record<string, unknown>;
    if (typeof value.collapsed === 'boolean') {
        state.collapsed = value.collapsed;
    }
    if (typeof value.width === 'number' && Number.isFinite(value.width)) {
        state.width = clampPanelWidth(value.width);
    }
    if (value.sections && typeof value.sections === 'object') {
        const sections = Object.entries(value.sections as Record<string, unknown>).filter((e): e is [string, boolean] => typeof e[1] === 'boolean');
        if (sections.length > 0) {
            state.sections = Object.fromEntries(sections);
        }
    }
    return state;
}

/** Whether a section is collapsed: its stored state, otherwise its default. */
export function isSectionCollapsed(state: SidePanelState, key: string, collapsedByDefault = false): boolean {
    return state.sections?.[key] ?? collapsedByDefault;
}

/** The state with a section collapsed or expanded. */
export function withSection(state: SidePanelState, key: string, collapsed: boolean): SidePanelState {
    return { ...state, sections: { ...state.sections, [key]: collapsed } };
}
