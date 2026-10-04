import { describe, expect, test } from 'vitest';
import type { Diagnostic } from 'vscode-languageserver-types';
import { parse } from './helpers.js';
import { UNKNOWN_CPP_TYPE } from '../src/cpp-unknown-types.js';
import { HsmCodeActionProvider } from '../src/lsp/cpp-code-actions.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

const CONFIG_H = 'namespace app {\nstruct Config { unsigned int retries = 2; };\n}';
const DRIVER_H = '#include "config.h"\nnamespace app {\nclass Driver { public: void on(); };\n}';

/** A model with the given imports and private members. */
function model(imports: string[], members: string[], namespace?: string): string {
    return [
        'statemachine M {',
        ...(namespace ? [`    namespace ${namespace}`] : []),
        ...imports.map(i => `    import "${i}"`),
        '    private:',
        ...members.map(m => `        ${m}`),
        '    [*] -> A',
        '    state A',
        '}'
    ].join('\n');
}

async function unknownTypes(imports: string[], members: string[], files: Record<string, string> = {}, namespace?: string) {
    const text = model(imports, members, namespace);
    const parsed = await parse(text, { 'config.h': CONFIG_H, 'driver.h': DRIVER_H, ...files });
    const lines = text.split('\n');
    return parsed.diagnostics.filter(d => d.code === UNKNOWN_CPP_TYPE).map((d: Diagnostic) => ({
        severity: d.severity,
        text: lines[d.range.start.line].substring(d.range.start.character, d.range.end.character),
        message: d.message,
        data: d.data
    }));
}

describe('unknown C++ types of class sections', () => {

    test('a class that is not declared in the imported headers: a warning on the unknown segment with the header to import', async () => {
        const found = await unknownTypes(['config.h'], ['var driver : app::Driver&', 'operation attach(d : const app::Driver*) : bool']);
        expect(found).toHaveLength(2);
        expect(found[0]).toMatchObject({ severity: 2, text: 'Driver', data: { name: 'app::Driver', importPath: 'driver.h' } });
        expect(found[0].message).toBe("Unknown type 'app::Driver': it is not declared in the imported headers. Import its header (import \"driver.h\") for highlighting, "
            + 'hover, completion and navigation; the type is passed to the generated C++ code as written, which only compiles if other includes declare it.');
        expect(found[1]).toMatchObject({ text: 'Driver' });
    });

    test('an unknown namespace: the whole name; no header declares it: no import in the message', async () => {
        const found = await unknownTypes(['config.h'], ['var x : hal::Pin', 'var y : ::Nope', 'var z : Unknown']);
        expect(found.map(f => f.text)).toEqual(['hal::Pin', 'Nope', 'Unknown']);
        expect(found[0].message).toContain('Import its header for highlighting');
        expect(found[0].data).toEqual({ name: 'hal::Pin' });
    });

    test('template arguments, return and parameter types are checked', async () => {
        const found = await unknownTypes(['config.h', '<vector>', '<map>'], [
            'var v : std::vector<app::Driver*>',
            'var m : std::map<int, std::vector<Foo>>',
            'operation f(c : const app::Config&) : app::Missing'
        ]);
        expect(found.map(f => f.text)).toEqual(['Driver', 'Foo', 'Missing']);
    });

    test('known names: declarations of the headers, forward declarations, templates, fundamental and <cstdint> types, HSM types', async () => {
        const header = 'namespace app {\nclass Driver;\ntemplate <typename T> class Buffer { T t; };\nusing Id = unsigned;\nstruct Config {};\n}';
        const found = await unknownTypes(['app.h'], [
            'var driver : app::Driver&',
            'var buffer : app::Buffer<int>',
            'var id : app::Id',
            'var config : const app::Config&',
            'var n : unsigned long',
            'var u : uint8_t',
            'var w : std::uint32_t',
            'var s : std::size_t',
            'var t : std::string',
            'var a : std::array<int, 3>',
            'var i : integer',
            'var c : const char*'
        ], { 'app.h': header });
        expect(found).toEqual([]);
    });

    test('names relative to the namespace of the model', async () => {
        const found = await unknownTypes(['config.h'], ['var c : Config'], {}, 'app');
        expect(found).toEqual([]);
    });

    test('std:: names: accepted with their standard header, else a warning with the system import', async () => {
        expect(await unknownTypes(['<vector>', '<memory>'], ['var v : std::vector<int>', 'var p : std::unique_ptr<int>'])).toEqual([]);
        const found = await unknownTypes(['<vector>'], ['var m : std::map<int, int>', 'var o : std::optional<int>']);
        expect(found).toMatchObject([
            { text: 'map', data: { name: 'std::map', importPath: '<map>' } },
            { text: 'optional', data: { name: 'std::optional', importPath: '<optional>' } }
        ]);
        expect(found[0].message).toContain('its standard header is not imported. Import it (import "<map>")');
        // std:: names of the map: also accepted if an imported header includes the standard header
        const header = '#include <map>\nnamespace app { struct Config {}; }';
        expect(await unknownTypes(['app.h'], ['var m : std::map<int, int>'], { 'app.h': header })).toEqual([]);
    });

    test('unknown std:: names: accepted if a system header is imported, else a warning without import', async () => {
        expect(await unknownTypes(['<vector>'], ['var x : std::exotic_thing'])).toEqual([]);
        const found = await unknownTypes([], ['var x : std::exotic_thing']);
        expect(found).toMatchObject([{ text: 'exotic_thing', data: { name: 'std::exotic_thing' } }]);
        expect(found[0].message).toContain('no standard header is imported');
    });

    test('names that cannot be verified: other system headers, headers that were not found', async () => {
        expect(await unknownTypes(['<QString>'], ['var s : QString', 'var d : app::Driver*'])).toEqual([]);
        const header = '#include "missing.h"\nnamespace app { struct Config {}; }';
        expect(await unknownTypes(['app.h'], ['var d : app::Driver*'], { 'app.h': header })).toEqual([]);
        // a header import that was not found is reported at the import
        expect(await unknownTypes(['nowhere.h'], ['var d : app::Driver*'])).toEqual([]);
        // unqualified names of the C library (<cstdint> only declares the integer typedefs)
        expect(await unknownTypes(['<cstdio>'], ['var f : FILE*'])).toEqual([]);
        expect(await unknownTypes(['<cstdint>'], ['var f : FILE*'])).toMatchObject([{ text: 'FILE' }]);
    });

    test('types outside the class sections are not checked here', async () => {
        const text = 'statemachine M {\n    import "config.h"\n    interface:\n        var x : integer\n    [*] -> A\n    state A\n}';
        const parsed = await parse(text, { 'config.h': CONFIG_H });
        expect(parsed.diagnostics.filter(d => d.code === UNKNOWN_CPP_TYPE)).toEqual([]);
    });
});

describe('quick fix of unknown C++ types', () => {

    async function quickFixes(text: string, files: Record<string, string>) {
        const parsed = await parse(text, files);
        const diagnostics = parsed.diagnostics.filter(d => d.code === UNKNOWN_CPP_TYPE);
        const actions = await new HsmCodeActionProvider().getCodeActions(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() },
            range: diagnostics[0]?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            context: { diagnostics }
        }) ?? [];
        return actions.map(action => {
            const edit = 'edit' in action ? Object.values(action.edit?.changes ?? {})[0] ?? [] : [];
            const document = TextDocument.create('memory:///m.hsm', 'hsm', 1, text);
            return { title: action.title, kind: 'kind' in action ? action.kind : undefined, result: TextDocument.applyEdits(document, edit) };
        });
    }

    test('imports the header declaring the type after the last import', async () => {
        const members = ['var driver : app::Driver&', 'var v : std::vector<app::Driver*>'];
        const fixes = await quickFixes(model(['config.h', '<vector>'], members), { 'config.h': CONFIG_H, 'driver.h': DRIVER_H });
        expect(fixes).toHaveLength(1);
        expect(fixes[0].title).toBe('Import "driver.h"');
        expect(fixes[0].kind).toBe('quickfix');
        expect(fixes[0].result).toBe(model(['config.h', '<vector>', 'driver.h'], members));
        // the fixed model has no unknown types
        expect(await unknownTypes(['config.h', '<vector>', 'driver.h'], members)).toEqual([]);
    });

    test('imports the standard header of a std:: name; without imports after the namespace or the opening brace', async () => {
        const withNamespace = model([], ['var v : std::vector<int>'], 'app');
        expect((await quickFixes(withNamespace, {}))[0].result).toBe(withNamespace.replace('namespace app', 'namespace app\n    import "<vector>"'));
        const plain = model([], ['var v : std::vector<int>']);
        expect((await quickFixes(plain, {}))[0].result).toBe(plain.replace('statemachine M {', 'statemachine M {\n    import "<vector>"'));
    });

    test('a header in a subdirectory: the path relative to the model; headers defining the type come first', async () => {
        const fixes = await quickFixes(model(['config.h'], ['var motor : hw::Motor*']), {
            'config.h': CONFIG_H, 'hal/motor.h': 'namespace hw { class Motor {}; }', 'all.h': '#include "hal/motor.h"\nnamespace other { struct X {}; }'
        });
        expect(fixes.map(f => f.title)).toEqual(['Import "hal/motor.h"']);
    });

    test('no quick fix if no header declares the type', async () => {
        expect(await quickFixes(model(['config.h'], ['var x : hal::Pin']), { 'config.h': CONFIG_H })).toEqual([]);
    });
});
