import { describe, expect, test } from 'vitest';
import type { CodeAction, Diagnostic } from 'vscode-languageserver-types';
import { parse } from './helpers.js';
import { INCOMPLETE_CPP_TYPE, UNKNOWN_CPP_TYPE } from '../src/cpp-unknown-types.js';
import { DevmCodeActionProvider } from '../src/lsp/cpp-code-actions.js';
import { cppHover } from '../src/lsp/cpp-lsp.js';
import { cppLocations, type CppNavigationKind } from '../src/lsp/cpp-navigation.js';
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

    test('known names: declarations of the headers, forward declarations, templates, fundamental and <cstdint> types, model types', async () => {
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
        const actions = await new DevmCodeActionProvider().getCodeActions(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() },
            range: diagnostics[0]?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            context: { diagnostics }
        }) ?? [];
        return actions.map(action => {
            const edit = 'edit' in action ? Object.values(action.edit?.changes ?? {})[0] ?? [] : [];
            const document = TextDocument.create('memory:///m.devm', 'devm', 1, text);
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

describe('C++ types that are only forward-declared', () => {

    /** Forward declares the driver (with a documentation comment), defined in driver.h. */
    const FWD_H = '#pragma once\nnamespace app {\n/// The hardware driver.\nclass Driver;\n}';
    const FILES = { 'fwd.h': FWD_H, 'driver.h': DRIVER_H, 'config.h': CONFIG_H };

    async function incomplete(imports: string[], members: string[], files: Record<string, string> = FILES, namespace?: string) {
        const text = model(imports, members, namespace);
        const parsed = await parse(text, files);
        const lines = text.split('\n');
        return parsed.diagnostics.filter(d => d.code === INCOMPLETE_CPP_TYPE).map((d: Diagnostic) => ({
            severity: d.severity,
            text: lines[d.range.start.line].substring(d.range.start.character, d.range.end.character),
            message: d.message,
            data: d.data
        }));
    }

    test('a warning on the name with the location of the forward declaration and the header defining the type', async () => {
        const found = await incomplete(['fwd.h'], ['var driver : app::Driver&', 'operation attach(d : const app::Driver*) : bool', 'var all : std::array<app::Driver*, 2>']);
        expect(found).toHaveLength(3);
        expect(found[0]).toEqual({
            severity: 2, text: 'Driver', data: { name: 'app::Driver', importPath: 'driver.h' },
            message: '\'app::Driver\' is only forward-declared (fwd.h:4). Import the header that defines it (import "driver.h") for hover, completion and navigation.'
        });
        expect(found.map(f => f.text)).toEqual(['Driver', 'Driver', 'Driver']);
        // no unknown type and no error: validation and generation succeed
        const parsed = await parse(model(['fwd.h'], ['var driver : app::Driver&']), FILES);
        expect(parsed.diagnostics.filter(d => d.code === UNKNOWN_CPP_TYPE || d.severity === 1)).toEqual([]);
    });

    test('names relative to the namespace of the model; no header defines the type: no import in the message', async () => {
        const found = await incomplete(['dev.h'], ['var sensor : Sensor*'], { 'dev.h': 'namespace dev {\nstruct Sensor;\n}' }, 'dev.io');
        expect(found).toEqual([{
            severity: 2, text: 'Sensor', data: { name: 'dev::Sensor' },
            message: '\'dev::Sensor\' is only forward-declared (dev.h:2). Import the header that defines it for hover, completion and navigation.'
        }]);
    });

    test('no warning if a header defining the type is imported, directly or through an include', async () => {
        expect(await incomplete(['fwd.h', 'driver.h'], ['var driver : app::Driver&'])).toEqual([]);
        const all = { ...FILES, 'all.h': '#include "fwd.h"\n#include "driver.h"\n' };
        expect(await incomplete(['all.h'], ['var driver : app::Driver&'], all)).toEqual([]);
        // templates are not reported, nor names that cannot be verified
        expect(await incomplete(['t.h'], ['var b : app::Buffer<int>*'], { 't.h': 'namespace app { template <typename T> class Buffer; }' })).toEqual([]);
        expect(await incomplete(['fwd.h', '<QString>'], ['var driver : app::Driver&'])).toEqual([]);
    });

    test('quick fix: imports the header defining the type, not the one forward declaring it', async () => {
        const members = ['var driver : app::Driver&'];
        const text = model(['fwd.h'], members);
        const parsed = await parse(text, { ...FILES, 'other.h': '#include "fwd.h"\nnamespace x { struct Y {}; }' });
        const diagnostics = parsed.diagnostics.filter(d => d.code === INCOMPLETE_CPP_TYPE);
        const actions = await new DevmCodeActionProvider().getCodeActions(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() }, range: diagnostics[0].range, context: { diagnostics }
        }) ?? [];
        expect(actions.map(a => a.title)).toEqual(['Import "driver.h"']);
        const action = actions[0] as CodeAction;
        const edit = Object.values(action.edit?.changes ?? {})[0] ?? [];
        expect(TextDocument.applyEdits(TextDocument.create('memory:///m.devm', 'devm', 1, text), edit)).toBe(model(['fwd.h', 'driver.h'], members));
    });

    test('hover: the forward declaration, its location and documentation', async () => {
        const text = model(['fwd.h'], ['var driver : app::Driver&', 'var d2 : Driver*'], 'app');
        const parsed = await parse(text, FILES);
        expect(cppHover(parsed.document, text.indexOf('app::Driver') + 6)).toBe(
            '```cpp\nclass app::Driver\n```\n\nforward declaration in fwd.h:4 — the definition is not imported\n\nThe hardware driver.');
        expect(cppHover(parsed.document, text.indexOf('Driver*') + 1)).toContain('class app::Driver');
        // with the definition: the definition
        const defined = model(['fwd.h', 'driver.h'], ['var driver : app::Driver&']);
        expect(cppHover((await parse(defined, FILES)).document, defined.indexOf('app::Driver') + 6)).toContain('struct app::Driver');
    });

    test('navigation: the forward declaration; with the definition imported the definition first', async () => {
        const text = model(['fwd.h'], ['var driver : app::Driver&']);
        const document = (await parse(text, FILES)).document;
        const at = (doc: typeof document, offset: number, kind: CppNavigationKind) =>
            cppLocations(doc, offset, kind).map(l => `${l.uri.replace(/^.*\//, '')}:${l.selection.start.line + 1}:${l.selection.start.character}`);
        for (const kind of ['definition', 'declaration', 'typeDefinition'] as const) {
            expect(at(document, text.indexOf('app::Driver') + 6, kind)).toEqual(['fwd.h:4:6']);
        }
        const defined = model(['fwd.h', 'driver.h'], ['var driver : app::Driver&']);
        const definedDocument = (await parse(defined, FILES)).document;
        expect(at(definedDocument, defined.indexOf('app::Driver') + 6, 'definition')).toEqual(['driver.h:3:6']);
        expect(at(definedDocument, defined.indexOf('app::Driver') + 6, 'declaration')).toEqual(['driver.h:3:6', 'fwd.h:4:6']);
    });
});
