import { describe, expect, it } from 'vitest';
import {
    clampPanelWidth, isSectionCollapsed, normalizePanelState, withSection, SIDE_PANEL_MAX_WIDTH, SIDE_PANEL_MIN_WIDTH
} from '@devm-web/ui/side-panel-state.js';

// the state logic of the side panel shared by the web app and the diagram webview
describe('side panel state', () => {

    it('drops invalid stored data', () => {
        expect(normalizePanelState(undefined)).toEqual({});
        expect(normalizePanelState('collapsed')).toEqual({});
        expect(normalizePanelState({ collapsed: 'yes', width: 'wide', sections: { help: 1, actions: true }, other: 1 }))
            .toEqual({ sections: { actions: true } });
        expect(normalizePanelState({ collapsed: true, width: 320, sections: {} })).toEqual({ collapsed: true, width: 320 });
        expect(normalizePanelState({ width: Number.NaN })).toEqual({});
    });

    it('keeps the width within the limits', () => {
        expect(normalizePanelState({ width: 10 }).width).toBe(SIDE_PANEL_MIN_WIDTH);
        expect(normalizePanelState({ width: 5000 }).width).toBe(SIDE_PANEL_MAX_WIDTH);
        expect(clampPanelWidth(300.4)).toBe(300);
        // the diagram keeps 200 px
        expect(clampPanelWidth(700, 800)).toBe(600);
        // but the panel never gets narrower than its minimal width
        expect(clampPanelWidth(700, 300)).toBe(SIDE_PANEL_MIN_WIDTH);
    });

    it('uses the default of a section until it was toggled', () => {
        let state = normalizePanelState({});
        expect(isSectionCollapsed(state, 'help')).toBe(false);
        expect(isSectionCollapsed(state, 'help', true)).toBe(true);
        state = withSection(state, 'help', true);
        expect(isSectionCollapsed(state, 'help')).toBe(true);
        state = withSection(state, 'help', false);
        expect(isSectionCollapsed(state, 'help', true)).toBe(false);
        expect(withSection({ collapsed: true, width: 300 }, 'actions', true)).toEqual({ collapsed: true, width: 300, sections: { actions: true } });
    });
});
