import { describe, expect, it } from 'vitest';
import { collectImportedFiles, hsmImportPaths } from '../../src/extension/logic/imports.js';

describe('imported files of the webview', () => {
    it('finds the .hsm import paths of a text (not headers)', () => {
        expect(hsmImportPaths('statemachine A {\n    import "b.hsm"\n    import: "c.hsm" "types.h"\n    [*] -> S\n    state S\n}')).toEqual(['b.hsm', 'c.hsm']);
        expect(hsmImportPaths('statemachine A { import "b.hsm"')).toEqual(['b.hsm']);
    });

    it('collects the imported files transitively, relative to the importing file', async () => {
        const disk: Record<string, string> = {
            'file:///w/parts/motor.hsm': 'statemachine Motor {\n    import "gear.hsm"\n    [*] -> S\n    state S\n}',
            'file:///w/parts/gear.hsm': 'statemachine Gear {\n    import "motor.hsm"\n    [*] -> S\n    state S\n}'
        };
        const read = async (uri: string) => disk[uri];
        const files = await collectImportedFiles('file:///w/gate.hsm', 'statemachine Gate {\n    import "parts/motor.hsm"\n    import "missing.hsm"\n}', read);
        expect(Object.keys(files).sort()).toEqual(['file:///w/parts/gear.hsm', 'file:///w/parts/motor.hsm']);
    });
});
