import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HsmModelLoader, applyEdits, hasLayoutAnnotations, layoutFromModel, layoutStateMachine, layoutTextEdits, type TextEdit } from 'hsm-language';
import { LAYOUT_STATUS, LAYOUT_TEXT, layoutActionEdits, layoutControls, type LayoutAction } from '@hsm-web/layout-actions.js';

const loader = new HsmModelLoader();

const MODEL = `statemachine Lamp {
    @CycleBased(200)

    interface:
        in event toggle

    state Off
    state On
    initial -> Off
    Off -> On : toggle
    On -> Off : toggle
}
`;

/** A text document with an undo history: every applied edit list is one undo step (like the hosts). */
class Document {
    private readonly history: string[] = [];
    constructor(public text: string) {}
    apply(edits: readonly TextEdit[]): boolean {
        if (edits.length === 0) {
            return false;
        }
        this.history.push(this.text);
        this.text = applyEdits(this.text, [...edits]);
        return true;
    }
    undo(): void {
        this.text = this.history.pop() ?? this.text;
    }
}

/** Runs a layout action on the document like the diagram controller does. */
async function run(document: Document, action: LayoutAction): Promise<boolean> {
    const parsed = await loader.load(document.text);
    const auto = await layoutStateMachine(parsed.model, { direction: 'DOWN' });
    return document.apply(layoutActionEdits(action, parsed.model, document.text, auto.graph, 'DOWN'));
}

async function annotations(text: string) {
    return layoutFromModel((await loader.load(text)).model);
}

describe('layout controls (names and tooltips)', () => {
    it('without stored positions: "Store positions", no "Clear positions"', () => {
        const controls = layoutControls(false);
        expect(controls.mode.label).toBe('automatic');
        expect(controls.arrange.label).toBe('Store positions');
        expect(controls.clear.hidden).toBe(true);
        expect(controls.arrangeStatus).toBe(LAYOUT_STATUS.store);
    });

    it('with stored positions: "Re-arrange" and "Clear positions"', () => {
        const controls = layoutControls(true);
        expect(controls.mode.label).toBe('stored in model');
        expect(controls.arrange.label).toBe('Re-arrange');
        expect(controls.clear).toMatchObject({ label: 'Clear positions', hidden: false });
        expect(controls.arrangeStatus).toBe(LAYOUT_STATUS.rearrange);
    });

    it('tooltips say what happens to the model and how to undo it', () => {
        for (const control of [LAYOUT_TEXT.store, LAYOUT_TEXT.rearrange, LAYOUT_TEXT.clear]) {
            expect(control.title).toMatch(/layout annotations/);
            expect(control.title).toMatch(/Undo: Ctrl\+Z/);
        }
        expect(LAYOUT_TEXT.clear.title).toMatch(/^Remove all layout annotations/);
    });

    it('no control is named after "automatic layout" or "auto-arrange" any more', () => {
        const labels = Object.values(LAYOUT_TEXT).map((t: { label: string }) => t.label.toLowerCase());
        expect(labels).not.toContain('auto-arrange');
        expect(labels).not.toContain('automatic layout');
        expect(new Set(labels).size).toBe(labels.length);
    });

    it('the static toolbar of the web app matches the initial state of the controls', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../../../web/index.html'), 'utf-8');
        const controls = layoutControls(false);
        expect(html).toContain(`>${controls.arrange.label}</button>`);
        expect(html).toContain(`title="${controls.arrange.title}"`);
        expect(html).toContain(`>${controls.clear.label}</button>`);
        expect(html).toContain(`title="${controls.clear.title}"`);
        expect(html).toContain(`title="${controls.mode.title}"`);
        expect(html).toContain(`<span class="label-text">${LAYOUT_TEXT.direction.label}</span>`);
    });

    it('the VS Code commands use the same names', () => {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'));
        const titles = Object.fromEntries(pkg.contributes.commands.map((c: { command: string, title: string }) => [c.command, c.title]));
        expect(titles['hsm.autoArrange']).toMatch(/Re-arrange/);
        expect(titles['hsm.autoArrange']).toMatch(/Store Positions/);
        expect(titles['hsm.resetLayout']).toMatch(/Clear Stored Diagram Positions/);
    });
});

describe('layout actions (model text)', () => {
    it('Store positions writes layout annotations of all elements; undo removes them', async () => {
        const document = new Document(MODEL);
        expect(await run(document, 'arrange')).toBe(true);
        const layout = await annotations(document.text);
        expect(layout).toBeDefined();
        expect(document.text).toMatch(/@at\(/);
        expect(Object.keys(layout!.nodes).length).toBeGreaterThanOrEqual(3);
        // other annotations are kept
        expect(document.text).toContain('@CycleBased(200)');
        // a second time: nothing changes (no empty undo step)
        expect(await run(document, 'arrange')).toBe(false);
        document.undo();
        expect(document.text).toBe(MODEL);
    });

    it('Re-arrange replaces the stored positions and drops waypoints; undo restores them', async () => {
        const document = new Document(MODEL);
        await run(document, 'arrange');
        // move a state and add a waypoint, as dragging does
        const parsed = await loader.load(document.text);
        const layout = layoutFromModel(parsed.model)!;
        const [moved] = Object.keys(layout.nodes).filter(id => id.endsWith('On'));
        layout.nodes[moved] = { ...layout.nodes[moved], x: 999, y: 777 };
        const transitions = (await layoutStateMachine(parsed.model, { direction: 'DOWN' })).graph.edges;
        layout.edges[transitions[transitions.length - 1].id] = { bends: [{ x: 5, y: 6 }] };
        document.apply(layoutTextEdits(parsed.model, document.text, layout));
        const arranged = document.text;
        expect(arranged).toContain('@at(999, 777)');
        expect(arranged).toContain('@via(');

        expect(await run(document, 'arrange')).toBe(true);
        expect(hasLayoutAnnotations((await loader.load(document.text)).model)).toBe(true);
        expect(document.text).not.toContain('@at(999, 777)');
        expect(document.text).not.toContain('@via(');
        document.undo();
        expect(document.text).toBe(arranged);
    });

    it('Clear positions removes all layout annotations but keeps the others; undo restores them', async () => {
        const document = new Document(MODEL);
        await run(document, 'arrange');
        const arranged = document.text;
        expect(await run(document, 'clear')).toBe(true);
        expect(document.text).toBe(MODEL);
        expect(await annotations(document.text)).toBeUndefined();
        // nothing to clear
        expect(await run(document, 'clear')).toBe(false);
        document.undo();
        expect(document.text).toBe(arranged);
    });
});
