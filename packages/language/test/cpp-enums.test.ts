import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { CppTypeIndex, cppHeaderReport, parseCppHeader, type CppEnum, type CppEnumType } from '../src/cpp-header/index.js';
import { cppValueSuggestions, enumeratorSpelling, findEnumerator, unknownEnumeratorDetail } from '../src/cpp-enums.js';
import { cppCompletionItems, cppContextCompletionItems, cppDefinition, cppHover, isTypePosition } from '../src/lsp/cpp-lsp.js';
import { StatechartInterpreter } from '../src/simulation/index.js';
import { HsmTestWorkspace } from '../src/testing/index.js';
import { errors, loader, parse } from './helpers.js';

/**
 * C/C++ enums in headers and models: the forms of enum declarations, their use in models (types,
 * enumerators, type checking, simulation), completion and hover. Generated C++ code for these forms
 * is compiled by the scenario `s10-cpp-enum-forms` (test/cpp-generator.test.ts).
 */

const ENUMS = fs.readFileSync(path.resolve(__dirname, 'cpp-header/enums.hpp'), 'utf-8');

function enumIndex(text = ENUMS, defines?: Record<string, string>): CppTypeIndex {
    return CppTypeIndex.fromSources([{ fileName: 'enums.hpp', text }], defines ? { defines } : {});
}

function enumType(index: CppTypeIndex, name: string): CppEnumType {
    const type = index.resolveType(name);
    expect(type?.kind, name).toBe('enum');
    return type as CppEnumType;
}

function values(type: CppEnumType): Record<string, number> {
    return Object.fromEntries(type.enumerators.map(e => [e.name, Number(e.value)]));
}

describe('C++ enums: header analysis', () => {
    test('the header has no diagnostics', () => {
        expect(enumIndex().diagnostics).toEqual([]);
    });

    test.each([
        // name, scoped, underlying, enumerators
        ['Color', false, 'int', { Red: 0, Green: 2, Blue: 3 }],
        ['Mode', true, 'int', { Off: 0, On: 1 }],
        ['Key', true, 'std::uint8_t', { Enter: 10, Space: 32, A: 97 }],
        ['Flags', false, 'int', { kNone: 0, kLow: -5, kNext: -4, kHex: 255, kExpr: 511, kMacro: 16 }],
        ['led_state_t', false, 'int', { LED_OFF: 1, LED_ON: 2 }],
        ['motor_dir_t', false, 'int', { DIR_LEFT: 0, DIR_RIGHT: 1 }],
        ['motor_dir_tag', false, 'int', { DIR_LEFT: 0, DIR_RIGHT: 1 }],
        ['app::io::Level', true, 'std::int8_t', { Low: -1, Mid: 0, High: 1 }],
        ['app::Sensor::State', false, 'int', { Idle: 0, Busy: 1 }],
        ['app::Sensor::Kind', true, 'std::uint16_t', { Temperature: 100, Pressure: 101 }],
        ['app::Sensor::Unit', true, 'std::uint8_t', { Celsius: 0, Bar: 1 }],
        ['app::Handle', true, 'std::uint32_t', {}],
        ['app::Phase', true, 'int', { Init: 0, Run: 1 }],
        ['Attributed', true, 'int', { First: 0, Second: 3, Third: 4 }],
        ['Derived', true, 'long', { Value: 4 }]
    ] as const)('%s', (name, scoped, underlying, enumerators) => {
        const type = enumType(enumIndex(), name);
        expect(type.scoped).toBe(scoped);
        expect(type.underlying.cppName).toBe(underlying);
        expect(values(type)).toEqual(enumerators);
    });

    test('documentation comments of enums and enumerators', () => {
        const index = enumIndex();
        expect(index.lookup('Color')!.doc).toContain('Colors of the status LED');
        expect(index.lookup('Color::Blue')!.doc).toBe('blue light');
        expect(index.lookup('kLow')!.doc).toBe('negative');
        expect(index.lookup('app::Sensor::Kind')!.doc).toBe('Scoped enum in a class.');
    });

    test('enumerators of unscoped enums are members of the enclosing scope, those of enum classes are not', () => {
        const index = enumIndex();
        expect(index.lookup('Red')?.qualifiedName).toBe('Color::Red');
        expect(index.lookup('Color::Red')?.qualifiedName).toBe('Color::Red');
        expect(index.lookup('LED_ON')?.qualifiedName).toBe('led_state_t::LED_ON');
        expect(index.lookup('led_state_t::LED_ON')?.qualifiedName).toBe('led_state_t::LED_ON');
        expect(index.lookup('motor_dir_t::DIR_RIGHT')?.qualifiedName).toBe('motor_dir_tag::DIR_RIGHT');
        expect(index.lookup('app::Sensor::Busy')?.qualifiedName).toBe('app::Sensor::State::Busy');
        expect(index.lookup('Off')).toBeUndefined();
        expect(index.lookup('app::Sensor::Pressure')).toBeUndefined();
        expect(index.lookup('app::Sensor::Kind::Pressure')?.kind).toBe('enumerator');
    });

    test('opaque declarations: the definition is used, without definition the enum has no enumerators', () => {
        const header = parseCppHeader(ENUMS, 'enums.hpp');
        const opaque: CppEnum[] = [];
        const collect = (declarations: readonly unknown[]) => {
            for (const d of declarations as Array<{ kind: string, opaque?: boolean, members?: unknown[] }>) {
                if (d.kind === 'enum' && d.opaque) {
                    opaque.push(d as unknown as CppEnum);
                }
                collect(d.members ?? []);
            }
        };
        collect(header.declarations);
        expect(opaque.map(e => e.qualifiedName)).toEqual(['app::Sensor::Unit', 'app::Handle', 'app::Phase']);
        const index = enumIndex();
        // the opaque declaration denotes the definition
        expect(index.typeOf(opaque[0])).toBe(index.resolveType('app::Sensor::Unit'));
        expect(index.lookup('app::Sensor::Unit')).not.toBe(opaque[0]);
        expect(index.lookup('app::Phase::Run')?.kind).toBe('enumerator');
        expect(index.typeOf(opaque[1])).toMatchObject({ kind: 'enum', enumerators: [] });
        // an opaque declaration in another header is no duplicate
        const twoHeaders = CppTypeIndex.fromSources([
            { fileName: 'fwd.h', text: 'namespace app { enum class Phase : int; }' },
            { fileName: 'enums.hpp', text: ENUMS }
        ]);
        expect(twoHeaders.diagnostics).toEqual([]);
        expect(values(enumType(twoHeaders, 'app::Phase'))).toEqual({ Init: 0, Run: 1 });
        // an unscoped enum without fixed underlying type cannot be declared opaque: it is an elaborated type specifier
        expect(CppTypeIndex.fromSources([{ fileName: 'x.h', text: 'enum E;' }]).resolveType('E')).toBeUndefined();
    });

    test('C++20 using enum makes the enumerators members of the scope', () => {
        const index = enumIndex();
        expect(index.lookup('app::Blue')?.qualifiedName).toBe('Color::Blue');
        expect(index.constant('app::Green')?.value).toBe(2n);
        expect(index.members('app').map(d => d.name)).toEqual(expect.arrayContaining(['Red', 'Green', 'Blue']));
        const nested = enumIndex('enum class E { A, B };\nstruct S { using enum E; };');
        expect(nested.lookup('S::B')?.qualifiedName).toBe('E::B');
    });

    test('preprocessor branches, attributes and trailing commas inside enums', () => {
        expect(values(enumType(enumIndex(ENUMS.replace('#define FLAG_BASE 0x10', '#define FLAG_BASE 4')), 'Attributed')))
            .toEqual({ First: 0, Wrong: 1, Third: 2 });
    });

    test('the report marks opaque declarations and using enum', () => {
        const report = JSON.stringify(cppHeaderReport(enumIndex()));
        expect(report).toContain('"opaque":true');
        expect(report).toContain('"kind":"usingEnum"');
    });
});

describe('C++ enums: spelling and messages', () => {
    test('enumerators are written qualified in models', () => {
        const index = enumIndex();
        const spell = (type: string) => enumType(index, type).enumerators.map(e => enumeratorSpelling(enumType(index, type), e, index));
        expect(spell('Color')).toEqual(['::Red', '::Green', '::Blue']);
        expect(spell('Mode')).toEqual(['Mode::Off', 'Mode::On']);
        expect(spell('led_state_t')).toEqual(['::LED_OFF', '::LED_ON']);
        expect(spell('app::Sensor::State')).toEqual(['app::Sensor::Idle', 'app::Sensor::Busy']);
        expect(spell('app::io::Level')).toEqual(['app::io::Level::Low', 'app::io::Level::Mid', 'app::io::Level::High']);
    });

    test('host values name enumerators in all spellings', () => {
        const index = enumIndex();
        const state = enumType(index, 'app::Sensor::State');
        for (const text of ['Busy', 'app::Sensor::State::Busy', '::app::Sensor::State::Busy', 'app::Sensor::Busy']) {
            expect(findEnumerator(state, text)?.name, text).toBe('Busy');
        }
        expect(findEnumerator(enumType(index, 'Color'), '::Blue')?.name).toBe('Blue');
        expect(findEnumerator(enumType(index, 'app::io::Level'), 'app::io::High')).toBeUndefined();
    });

    test('unknown enumerators list the enumerators of the enum', () => {
        const index = enumIndex();
        expect(unknownEnumeratorDetail('app::io::Level::Hihg', index)).toBe("'app::io::Level' has no enumerator 'Hihg' (enumerators: Low, Mid, High).");
        expect(unknownEnumeratorDetail('Mode::off', index)).toBe("'Mode' has no enumerator 'off' (did you mean 'Mode::Off'?) (enumerators: Off, On).");
        expect(unknownEnumeratorDetail('app::Handle::X', index)).toContain('declared without enumerators');
        expect(unknownEnumeratorDetail('app::Nope::X', index)).toBeUndefined();
        expect(cppValueSuggestions('High', index)).toEqual(['app::io::Level::High']);
        expect(cppValueSuggestions('LED_ON', index)).toEqual(['::LED_ON']);
    });
});

const MODEL = `statemachine M {
    import "enums.hpp"
    interface:
        in event pick : Color
        in event setLevel : app::io::Level
        out event changed : app::Sensor::Kind
        var color : Color = ::Green
        var mode : Mode = Mode::Off
        var key : Key
        var led : led_state_t = ::LED_OFF
        var dir : motor_dir_t = motor_dir_t::DIR_LEFT
        var level : app::io::Level
        var sensor : app::Sensor::State = app::Sensor::Idle
        var unit : app::Sensor::Unit
        var phase : app::Phase = app::Phase::Init
        var hnd : app::Handle
        var n : integer
        var ok : boolean
        operation setUnit(u : app::Sensor::Unit, k : app::Sensor::Kind) : Mode
    [*] -> A
    state A
    state B
    A -> B : pick [valueof(pick) == ::Blue || valueof(pick) == Color::Red] / color = valueof(pick); n = color + ::kHex; mode = setUnit(app::Sensor::Unit::Bar, app::Sensor::Kind::Pressure)
    B -> A : setLevel [valueof(setLevel) >= app::io::Level::Mid] / level = valueof(setLevel); ok = level > app::io::Level::Low && phase < app::Phase::Run; hnd = 3 as app::Handle; n = app::Blue; raise changed : app::Sensor::Kind::Temperature
}`;

describe('C++ enums: models', () => {
    test('all forms can be used as types and values', async () => {
        const parsed = await parse(MODEL, { 'enums.hpp': ENUMS });
        expect(parsed.hasSyntaxErrors).toBe(false);
        expect(errors(parsed)).toEqual([]);
    });

    test('type checking follows C++', async () => {
        const parsed = await parse(`statemachine M {
    import "enums.hpp"
    interface:
        var color : Color
        var mode : Mode
        var level : app::io::Level
        var n : integer
        var ok : boolean
    [*] -> A
    state A
    A -> A : oncycle / mode = 1; mode = ::Red; color = 1; color = Mode::On; n = color; n = mode; ok = mode == ::Red; ok = color == 2; ok = mode < level; ok = color < ::Blue; n = mode + 1; color = ::Red | ::Blue; mode = Mode::Of; level = app::io::Level::Hihg; mode = Off; color = n as Color; mode = color as Mode
}`, { 'enums.hpp': ENUMS });
        expect(errors(parsed)).toEqual([
            "Could not resolve reference to Declaration named 'Off'. (Did you mean 'Mode::Off'? Enumerators and constants of imported C++ headers are written qualified with '::'.)",
            "Type mismatch: a value of type integer cannot be assigned to 'mode' of type Mode.",
            "Type mismatch: a value of type Color cannot be assigned to 'mode' of type Mode.",
            "Type mismatch: a value of type integer cannot be assigned to 'color' of type Color.",
            "Type mismatch: a value of type Mode cannot be assigned to 'color' of type Color.",
            "Type mismatch: a value of type Mode cannot be assigned to 'n' of type integer.",
            'Cannot compare a value of type Mode with a value of type Color.',
            "The operator '<' requires numeric operands, but the left operand is of type Mode.",
            "The operator '<' requires numeric operands, but the right operand is of type app::io::Level.",
            "The operator '+' requires numeric (or string) operands, but the left operand is of type Mode.",
            "Type mismatch: a value of type integer cannot be assigned to 'color' of type Color.",
            "'Mode' has no enumerator 'Of' (enumerators: Off, On).",
            "'app::io::Level' has no enumerator 'Hihg' (enumerators: Low, Mid, High)."
        ]);
    });

    test('simulation: values, comparisons and enumerator names', async () => {
        const parsed = await parse(MODEL, { 'enums.hpp': ENUMS });
        const interpreter = new StatechartInterpreter(parsed.model, { operations: { setUnit: () => 'Mode::On' } });
        interpreter.enter();
        expect(interpreter.getVariable('color')).toBe('Color::Green');
        expect(interpreter.getVariable('led')).toBe('led_state_t::LED_OFF');
        expect(interpreter.getVariable('sensor')).toBe('app::Sensor::State::Idle');
        expect(interpreter.getVariable('hnd')).toBe(0);
        interpreter.raise('pick', '::Blue');
        interpreter.runCycle();
        expect(interpreter.getVariable('color')).toBe('Color::Blue');
        expect(interpreter.getVariable('n')).toBe(258);
        expect(interpreter.getVariable('mode')).toBe('Mode::On');
        interpreter.raise('setLevel', 'High');
        interpreter.runCycle();
        expect(interpreter.getVariable('level')).toBe('app::io::Level::High');
        expect(interpreter.getVariable('ok')).toBe(true);
        expect(interpreter.getVariable('hnd')).toBe(3);
        expect(interpreter.getVariable('n')).toBe(3);
        interpreter.setVariable('sensor', 'app::Sensor::Busy');
        expect(interpreter.getVariable('sensor')).toBe('app::Sensor::State::Busy');
    });
});

describe('C++ enums: unit tests', () => {
    test('asserts, raised values and mocked operations with enum values', async () => {
        const workspace = new HsmTestWorkspace();
        const documents = await workspace.load([
            { uri: 'memory:///enums/enums.hpp', text: ENUMS },
            { uri: 'memory:///enums/m.hsm', text: MODEL },
            {
                uri: 'memory:///enums/m.hsmtest', text: `testclass EnumTest for statemachine M {
    @Test
    operation levels() {
        enter
        assert color == ::Green && sensor == app::Sensor::Idle
        mock setUnit returns (Mode::On)
        raise pick : Color::Blue
        proceed 1 cycle
        assert active(B)
        assert mode == Mode::On && n == 258
        assert called setUnit with (app::Sensor::Unit::Bar, app::Sensor::Kind::Pressure)
        var l : app::io::Level = app::io::Level::High
        raise setLevel : l
        proceed 1 cycle
        assert level == app::io::Level::High && level > app::io::Level::Mid
        assert changed
        assert valueof(changed) == app::Sensor::Kind::Temperature
    }
}`
            }
        ]);
        for (const loaded of documents) {
            expect(loaded.diagnostics.filter(d => d.severity === 1).map(d => d.message), loaded.uri).toEqual([]);
        }
        const results = workspace.runDocuments(documents);
        expect(results.map(r => [r.name, r.status, r.message])).toEqual([['levels', 'passed', undefined]]);
    });
});

describe('C++ enums: language server', () => {
    async function document(text: string) {
        return (await parse(text, { 'enums.hpp': ENUMS })).document;
    }

    function labels(items: Array<{ label: string }> | undefined): string[] {
        return (items ?? []).map(item => item.label);
    }

    test('type positions', () => {
        expect(isTypePosition('    var mode : ')).toBe(true);
        expect(isTypePosition('    in event pick : ')).toBe(true);
        expect(isTypePosition('    operation f(a : integer, b : ')).toBe(true);
        expect(isTypePosition('    operation f(a : integer) : ')).toBe(true);
        expect(isTypePosition('    alias Speed : ')).toBe(true);
        expect(isTypePosition('x = n as ')).toBe(true);
        expect(isTypePosition('    var mode : Mode = ')).toBe(false);
        expect(isTypePosition('A -> B : pick [')).toBe(false);
        expect(isTypePosition('/ raise changed : ')).toBe(false);
    });

    test('after a qualifier: types in type positions, values in expressions; enumerators in declaration order', async () => {
        const doc = await document(MODEL);
        const text = doc.textDocument.getText();
        const typeAt = text.indexOf('app::Sensor::State') + 'app::Sensor::'.length;
        expect(labels(cppCompletionItems(doc, typeAt))).toEqual(expect.arrayContaining(['State', 'Kind', 'Unit']));
        expect(labels(cppCompletionItems(doc, typeAt))).not.toContain('Busy');
        const valueAt = text.indexOf('app::Sensor::Idle') + 'app::Sensor::'.length;
        expect(labels(cppCompletionItems(doc, valueAt))).toEqual(expect.arrayContaining(['State', 'Kind', 'Idle', 'Busy']));
        const levelAt = text.indexOf('app::io::Level::Mid') + 'app::io::Level::'.length;
        const level = cppCompletionItems(doc, levelAt)!;
        expect(level.map(i => i.label).sort((a, b) => level.find(i => i.label === a)!.sortText!.localeCompare(level.find(i => i.label === b)!.sortText!)))
            .toEqual(['Low', 'Mid', 'High']);
        expect(level[0].detail).toBe('app::io::Level = -1');
        const globalAt = text.indexOf('::Green') + 2;
        expect(labels(cppCompletionItems(doc, globalAt))).toEqual(expect.arrayContaining(['Red', 'Green', 'Color', 'app', 'LED_ON']));
    });

    async function contextItems(source: string, marker = '|') {
        const at = source.indexOf(marker);
        const doc = await document(source.replace(marker, ''));
        return { doc, at, items: cppContextCompletionItems(doc, at) };
    }

    test('enumerators of the expected enum type', async () => {
        const model = (line: string) => MODEL.replace('    [*] -> A', `    [*] -> A\n    ${line}`);
        const cases: Array<[string, string[]]> = [
            ['A -> A : pick [color == |', ['::Red', '::Green', '::Blue']],
            ['A -> A : pick [valueof(setLevel) != |', ['app::io::Level::Low', 'app::io::Level::Mid', 'app::io::Level::High']],
            ['A -> A : pick / mode = |', ['Mode::Off', 'Mode::On']],
            ['A -> A : pick / raise changed : |', ['app::Sensor::Kind::Temperature', 'app::Sensor::Kind::Pressure']],
            ['A -> A : pick / setUnit(|', ['app::Sensor::Unit::Celsius', 'app::Sensor::Unit::Bar']],
            ['A -> A : pick / setUnit(app::Sensor::Unit::Bar, |', ['app::Sensor::Kind::Temperature', 'app::Sensor::Kind::Pressure']],
            ['A -> A : pick [sensor != |', ['app::Sensor::Idle', 'app::Sensor::Busy']],
            ['A -> A : pick [led == |', ['::LED_OFF', '::LED_ON']],
            ['A -> A : pick [n == |', []]
        ];
        for (const [line, expected] of cases) {
            const { items } = await contextItems(model(line));
            expect(labels(items), line).toEqual(expected);
        }
        const declaration = await contextItems(MODEL.replace('var n : integer', 'var other : app::io::Level = |'));
        expect(labels(declaration.items)).toEqual(['app::io::Level::Low', 'app::io::Level::Mid', 'app::io::Level::High']);
    });

    test('a typed prefix is replaced', async () => {
        const source = MODEL.replace('    [*] -> A', '    [*] -> A\n    A -> A : pick [color == ::Gr|');
        const { doc, at, items } = await contextItems(source);
        const green = items.find(i => i.label === '::Green')!;
        expect(green.textEdit).toBeDefined();
        const range = (green.textEdit as { range: { start: { line: number, character: number } } }).range;
        expect(doc.textDocument.offsetAt(range.start)).toBe(at - '::Gr'.length);
        expect(green.detail).toBe('Color = 2');
        const short = await contextItems(MODEL.replace('    [*] -> A', '    [*] -> A\n    A -> A : pick [level == Hi|'));
        expect(short.items.find(i => i.label === 'app::io::Level::High')?.filterText).toBe('High');
    });

    test('C++ types of the global namespace in type positions', async () => {
        const { items } = await contextItems(MODEL.replace('var n : integer', 'var other : |'));
        expect(labels(items)).toEqual(expect.arrayContaining(['Color', 'Mode', 'Key', 'led_state_t', 'motor_dir_t', 'app', 'uint8_t']));
        expect(labels(items)).not.toContain('Red');
    });

    test('the completion provider adds the enumerators to the default proposals', async () => {
        const source = MODEL.replace('    [*] -> A', '    [*] -> A\n    A -> A : pick [mode == |');
        const at = source.indexOf('|');
        const doc = await document(source.replace('|', ''));
        const list = await loader.services.Hsm.lsp.CompletionProvider!.getCompletion(doc, {
            textDocument: { uri: doc.uri.toString() }, position: doc.textDocument.positionAt(at)
        });
        expect(labels(list?.items).slice(0, 2)).toEqual(['Mode::Off', 'Mode::On']);
        expect(list?.items.length).toBeGreaterThan(2);
    });

    test('hover and go to definition of enums and enumerators', async () => {
        const doc = await document(MODEL);
        const text = doc.textDocument.getText();
        const level = cppHover(doc, text.indexOf('app::io::Level::Mid') + 'app::io::Level::'.length)!;
        expect(level).toContain('app::io::Level::Mid = 0');
        expect(level).toContain('enumerator of `enum class app::io::Level` (underlying type `std::int8_t`)');
        const hex = cppHover(doc, text.indexOf('::kHex') + 3)!;
        expect(hex).toContain('Flags::kHex = 255');
        expect(hex).toContain('(0xFF)');
        const color = cppHover(doc, text.indexOf('var color : Color') + 'var color : '.length + 1)!;
        expect(color).toContain('enum Color');
        expect(color).toContain('`Red = 0`, `Green = 2`, `Blue = 3`');
        expect(color).toContain('unscoped: the enumerators are also members of the global namespace');
        expect(color).toContain('Colors of the status LED');
        const handle = cppHover(doc, text.indexOf('app::Handle') + 'app::'.length)!;
        expect(handle).toContain('enum class app::Handle : std::uint32_t;');
        expect(handle).toContain('opaque declaration');
        const location = cppDefinition(doc, text.indexOf('app::Sensor::Idle') + 'app::Sensor::'.length)!;
        expect(location.uri).toMatch(/enums\.hpp$/);
        expect(ENUMS.split('\n')[location.selection.start.line]).toContain('enum State { Idle, Busy };');
        const usingEnum = cppDefinition(doc, text.indexOf('app::Blue') + 'app::'.length)!;
        expect(ENUMS.split('\n')[usingEnum.selection.start.line]).toContain('enum Color { Red, Green = 2, Blue');
    });
});
