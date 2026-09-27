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

    it('collects imported C/C++ headers and the headers they include (relative to the including file, then in the include paths)', async () => {
        const disk: Record<string, string> = {
            'file:///w/types.h': '#include "base/errors.h"\n#include <motor/limits.h>\n#include <cstdint>\nnamespace app { enum class Mode { A }; }',
            'file:///w/base/errors.h': 'namespace base { enum class Error { None }; }',
            'file:///inc/motor/limits.h': 'namespace motor { constexpr int kMax = 1; }',
            'file:///inc/shared.h': 'namespace shared {}'
        };
        const read = async (uri: string) => disk[uri];
        const files = await collectImportedFiles('file:///w/valve.hsm', 'statemachine Valve {\n    import "types.h" "shared.h"\n}', read, 100,
            { includePaths: ['file:///inc'] });
        expect(Object.keys(files).sort()).toEqual(['file:///inc/motor/limits.h', 'file:///inc/shared.h', 'file:///w/base/errors.h', 'file:///w/types.h']);
    });
});
