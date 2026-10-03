import { describe, expect, it } from 'vitest';
import { collectImportedFiles, dmfReferencedPaths, hsmImportPaths } from '../../src/extension/logic/imports.js';

describe('imported files of the webview', () => {
    it('finds the .devm import paths of a text (not headers)', () => {
        expect(hsmImportPaths('statemachine A {\n    import "b.devm"\n    import: "c.devm" "types.h"\n    [*] -> S\n    state S\n}')).toEqual(['b.devm', 'c.devm']);
        expect(hsmImportPaths('statemachine A { import "b.devm"')).toEqual(['b.devm']);
    });

    it('collects the imported files transitively, relative to the importing file', async () => {
        const disk: Record<string, string> = {
            'file:///w/parts/motor.devm': 'statemachine Motor {\n    import "gear.devm"\n    [*] -> S\n    state S\n}',
            'file:///w/parts/gear.devm': 'statemachine Gear {\n    import "motor.devm"\n    [*] -> S\n    state S\n}'
        };
        const read = async (uri: string) => disk[uri];
        const files = await collectImportedFiles('file:///w/gate.devm', 'statemachine Gate {\n    import "parts/motor.devm"\n    import "missing.devm"\n}', read);
        expect(Object.keys(files).sort()).toEqual(['file:///w/parts/gear.devm', 'file:///w/parts/motor.devm']);
    });

    it('collects imported C/C++ headers and the headers they include (relative to the including file, then in the include paths)', async () => {
        const disk: Record<string, string> = {
            'file:///w/types.h': '#include "base/errors.h"\n#include <motor/limits.h>\n#include <cstdint>\nnamespace app { enum class Mode { A }; }',
            'file:///w/base/errors.h': 'namespace base { enum class Error { None }; }',
            'file:///inc/motor/limits.h': 'namespace motor { constexpr int kMax = 1; }',
            'file:///inc/shared.h': 'namespace shared {}'
        };
        const read = async (uri: string) => disk[uri];
        const files = await collectImportedFiles('file:///w/valve.devm', 'statemachine Valve {\n    import "types.h" "shared.h"\n}', read, 100,
            { includePaths: ['file:///inc'] });
        expect(Object.keys(files).sort()).toEqual(['file:///inc/motor/limits.h', 'file:///inc/shared.h', 'file:///w/base/errors.h', 'file:///w/types.h']);
    });

    it('finds the files a structure file refers to: imports and the state machines of behaviors', () => {
        const text = 'import "types.devm" "door_types.h"\nimport "lamp.devm"\ncomponent Door {\n    behavior "door.devm"\n}\ncomponent Lamp {\n    behavior Lamp\n}\n';
        expect(dmfReferencedPaths(text)).toEqual({ models: ['types.devm', 'lamp.devm', 'door.devm'], headers: ['door_types.h'] });
        expect(dmfReferencedPaths('system {')).toEqual({ models: [], headers: [] });
    });

    it('collects the files of a structure file transitively: structure files, state machines and their headers', async () => {
        const disk: Record<string, string> = {
            'file:///w/types.devm': 'struct Position { x : real }',
            'file:///w/door.devm': 'statemachine Door {\n    import "door_types.h"\n    [*] -> S\n    state S\n}',
            'file:///w/door_types.h': 'namespace door { enum class Mode { A }; }'
        };
        const read = async (uri: string) => disk[uri];
        const files = await collectImportedFiles('file:///w/system.devm', 'import "types.devm"\ncomponent Door {\n    behavior "door.devm"\n}\n', read);
        expect(Object.keys(files).sort()).toEqual(['file:///w/door.devm', 'file:///w/door_types.h', 'file:///w/types.devm']);
    });
});
