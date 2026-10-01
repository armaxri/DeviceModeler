import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { NodeFileSystem } from 'langium/node';
import { afterAll, describe, expect, test } from 'vitest';
import type { MarkupContent } from 'vscode-languageserver-types';
import { CppTypeIndex, type CppEnumType, type CppResolvedEnumerator } from '../src/cpp-header/index.js';
import { enumeratorHex, enumeratorListItem, enumeratorValueMarkdown, enumeratorValueText } from '../src/cpp-enums.js';
import { cppCompletionItems, cppContextCompletionItems, cppHover } from '../src/lsp/cpp-lsp.js';
import { generateCpp } from '../src/generator/cpp/index.js';
import { createHsmServices } from '../src/hsm-module.js';
import { installNodeHeaderSupport } from '../src/node/cpp-headers-node.js';
import { HsmTestWorkspace } from '../src/testing/index.js';
import { errors, parse } from './helpers.js';

/**
 * Enumerator values: the header analyzer computes them like a C++ compiler (implicit numbering,
 * literals, operators, references, underlying types), marks values it cannot compute as unknown
 * (relative to the unknown initializer) and the language server shows them (hover, completion).
 * The values of the fixture headers and the examples are checked by g++ / clang++ with
 * `static_assert`s generated from the analyzer's values; the errors by compiling invalid enums.
 */

const FIXTURE_DIRECTORY = path.resolve(__dirname, 'cpp-header');
const EXAMPLES_DIRECTORY = path.resolve(__dirname, '../../../examples');
const FIXTURE = fs.readFileSync(path.join(FIXTURE_DIRECTORY, 'enum-values.hpp'), 'utf-8');

function headerIndex(text: string, fileName = 'enum-values.hpp'): CppTypeIndex {
    return CppTypeIndex.fromSources([{ fileName, text }]);
}

function enumType(index: CppTypeIndex, name: string): CppEnumType {
    const type = index.resolveType(name);
    expect(type?.kind, name).toBe('enum');
    return type as CppEnumType;
}

function enumerator(index: CppTypeIndex, enumName: string, name: string): { type: CppEnumType, enumerator: CppResolvedEnumerator } {
    const type = enumType(index, enumName);
    const found = type.enumerators.find(e => e.name === name);
    expect(found, `${enumName}::${name}`).toBeDefined();
    return { type, enumerator: found! };
}

/** The values of an enum as `name: value` (unknown values as `?`). */
function values(index: CppTypeIndex, name: string): Record<string, bigint | string> {
    return Object.fromEntries(enumType(index, name).enumerators.map(e => [e.name, e.valid ? e.value : '?']));
}

function diagnostics(index: CppTypeIndex): string[] {
    return index.diagnostics.map(d => `${d.severity} ${d.range.start.line + 1}: ${d.message}`);
}

describe('enumerator values follow C++', () => {
    const index = headerIndex(FIXTURE);

    test('the fixture header has no diagnostics', () => {
        expect(diagnostics(index)).toEqual([]);
    });

    test('implicit numbering: first 0, then previous + 1 (also after explicit and negative values)', () => {
        expect(values(index, 'ev::Implicit')).toEqual({
            I0: 0n, I1: 1n, I2: 2n, I10: 10n, I11: 11n, I12: 12n, INeg: -2n, INeg1: -1n, INeg0: 0n, IZero: 0n, IOne: 1n
        });
        expect(enumType(index, 'ev::Implicit').enumerators.map(e => e.origin).join(' '))
            .toBe('implicit implicit implicit explicit implicit implicit explicit implicit implicit explicit implicit');
    });

    test('integer literals: decimal, hex, octal, binary, digit separators, suffixes, bool', () => {
        expect(values(index, 'ev::Literals')).toEqual({
            Dec: 42n, Hex: 42n, HexUpper: 255n, Oct: 8n, OctMax: 511n, Zero: 0n, Bin: 10n, BinUpper: 3n,
            Sep: 1000000n, SepHex: 65535n, SepBin: 240n,
            SufU: 7n, SufL: 8n, SufLL: 9n, SufUL: 10n, SufULL: 11n, SufLU: 12n, SufLLU: 13n,
            True: 1n, False: 0n
        });
    });

    test('character literals: escapes, hex / octal escapes, prefixes; implicit successor of a character', () => {
        expect(values(index, 'ev::Chars')).toEqual({
            CharA: 65n, CharNl: 10n, CharTab: 9n, CharHex: 65n, CharOct: 65n, CharNul: 0n, CharBackslash: 92n, CharQuote: 39n,
            CharU8: 97n, CharU16: 228n, CharU32: 128512n, CharWide: 122n, CharNext: 123n
        });
    });

    test('operators: precedence, associativity, truncating division, shifts, comparisons, logic, ?:', () => {
        expect(values(index, 'ev::Ops')).toEqual({
            Add: 7n, Paren: 9n, Sub: 5n, Div: 3n, DivNeg: -3n, DivNeg2: -3n, Mod: 1n, ModNeg: -1n, ModNeg2: 1n,
            Shl: 16n, Shr: 32n, ShrNeg: -4n, ShiftPrec: 8n, BitPrec: 3n, Compl: -1n, Not: 1n, NotNot: 1n, Neg: -3n, Plus: 4n,
            Lt: 1n, Ge: 0n, Eq: 1n, Ne: 0n, And: 2n, Or: 7n, Xor: 5n, LAnd: 0n, LOr: 1n, Tern: 20n, TernNested: 3n, CmpChain: 1n,
            UnsignedCmp: 0n, UnsignedDiv: 2147483647n
        });
    });

    test('references: earlier enumerators, other enums (qualified, casts), constants, macros, sizeof', () => {
        expect(values(index, 'ev::Refs')).toEqual({
            RA: 1n, RB: 2n, RMask: 3n, RLast: 3n, RCount: 4n, ROther: 9n, RCast: 10n, RPlain: 8n, RPlainQ: 14n,
            RConst: 101n, RConstU: 3n, RMacro: 65n, RFunc: 8n, RSize: 4n, RSizeE: 1n, RIn: 4n
        });
        // the initializer as written (macros not expanded)
        expect(enumerator(index, 'ev::Refs', 'RFunc').enumerator.expression).toBe('BIT(3)');
        expect(enumerator(index, 'ev::Refs', 'RMask').enumerator.expression).toBe('RA | RB');
    });

    test('fixed underlying types: unsigned, signed, 8 to 64 bits, std:: and global typedef names', () => {
        expect(values(index, 'ev::Flags')).toEqual({ None: 0n, Read: 1n, Write: 2n, Exec: 4n, All: 7n, Mask: 4294967295n, High: 2147483648n });
        expect(values(index, 'ev::Small')).toEqual({ Min: 0n, Max: 255n });
        expect(values(index, 'ev::Signed8')).toEqual({ Lo: -128n, Hi: 127n, MinusOne: -1n });
        expect(values(index, 'ev::Short')).toEqual({ S0: -300n, S1: -299n });
        expect(enumType(index, 'ev::Short').underlying.cppName).toBe('int16_t');
    });

    test('64 bit values are exact (BigInt, also beyond 2^53)', () => {
        expect(values(index, 'ev::Wide')).toEqual({
            Big: 18446744073709551615n, Top: 9223372036854775808n, Precise: 9007199254740993n, Next: 9007199254740992n, Next1: 9007199254740993n
        });
        expect(values(index, 'ev::WideSigned')).toEqual({ Min: -9223372036854775808n, Max: 9223372036854775807n });
    });

    test('without fixed underlying type: the type grows with the values; inside the body enumerators have the type of their initializer', () => {
        expect(values(index, 'ev::Unfixed')).toEqual({ U0: 4294967295n, U1: 4294967296n });
        expect(enumType(index, 'ev::Unfixed').underlying.bits).toBe(64);
        // IB0 is an `unsigned int` inside the body, so IB0 + 1 wraps around to 0
        expect(values(index, 'ev::InBody')).toEqual({ IB0: 4294967295n, IB1: 0n });
        expect(enumType(index, 'ev::InBody').underlying.cppName).toBe('unsigned int');
        expect(values(index, 'ev::c_flags_t')).toEqual({ C_A: 1n, C_B: 2n, C_AB: 3n });
    });
});

describe('values that cannot be computed are unknown, not guessed', () => {
    const source = `
        #define KNOWN 4
        int compute(int);
        constexpr int square(int x) { return x * x; }
        enum Unknown {
            Before,                 // 0
            Macro = FOO(3),         // unknown function-like macro
            AfterMacro,             // FOO(3) + 1
            AfterMacro2,            // FOO(3) + 2
            Known = KNOWN,          // known again
            AfterKnown,
            Call = compute(1),
            Constexpr = square(3),
            UsesUnknown = AfterMacro + 1,
            Size = sizeof(Known)
        };
        enum class Other { A = Unknown::AfterMacro2 * 2, B = static_cast<int>(Known) };
        constexpr int kFromUnknown = Macro + 1;
    `;
    const index = CppTypeIndex.fromSources([{ fileName: 'unknown.h', text: source }]);

    test('unknown values and their implicit successors are relative to the unknown initializer', () => {
        expect(values(index, 'Unknown')).toEqual({
            Before: 0n, Macro: '?', AfterMacro: '?', AfterMacro2: '?', Known: 4n, AfterKnown: 5n, Call: '?', Constexpr: '?', UsesUnknown: '?', Size: '?'
        });
        const type = enumType(index, 'Unknown');
        const reason = 'function calls are not supported in constant expressions';
        expect(type.enumerators[1].unknown).toEqual({ expression: 'FOO(3)', offset: 0n, reason });
        expect(type.enumerators[3].unknown).toEqual({ expression: 'FOO(3)', offset: 2n, reason });
        expect(type.enumerators[6].unknown?.reason).toBe('function calls are not supported in constant expressions');
        expect(type.enumerators[8].unknown?.reason).toBe("the value of 'AfterMacro' is unknown (it follows 'FOO(3)', whose value is unknown)");
        // the underlying type is deduced from the known values only
        expect(type.underlying.cppName).toBe('int');
    });

    test('values derived from unknown values are unknown too (other enums, constants)', () => {
        expect(values(index, 'Other')).toEqual({ A: '?', B: 4n });
        expect(index.constant('kFromUnknown')?.value).toBeUndefined();
        expect(index.constant('Macro')?.error).toBe('function calls are not supported in constant expressions');
        expect(index.constant('AfterMacro')?.error).toBe('the value cannot be evaluated');
    });

    test('they are diagnosed as errors of the header', () => {
        expect(diagnostics(index).filter(d => d.includes('Macro') || d.includes('Call'))).toEqual([
            "error 7: cannot evaluate the value of enumerator 'Unknown::Macro': function calls are not supported in constant expressions",
            "error 12: cannot evaluate the value of enumerator 'Unknown::Call': function calls are not supported in constant expressions",
            "error 14: cannot evaluate the value of enumerator 'Unknown::UsesUnknown': the value of 'AfterMacro' is unknown (it follows 'FOO(3)', whose value is unknown)",
            "error 17: cannot evaluate the value of enumerator 'Other::A': the value of 'Unknown::AfterMacro2' is unknown (it follows 'FOO(3)', whose value is unknown)",
            "warning 18: cannot evaluate the constant 'kFromUnknown': the value of 'Macro' is unknown (function calls are not supported in constant expressions)"
        ]);
    });

    test('display: "value unknown" with the relative expression', () => {
        const type = enumType(index, 'Unknown');
        expect(enumeratorValueText(type.enumerators[1], type)).toBe('unknown (FOO(3))');
        expect(enumeratorValueText(type.enumerators[2], type)).toBe('unknown (FOO(3) + 1)');
        expect(enumeratorValueMarkdown(type.enumerators[1], type)).toBe('value unknown: `FOO(3)` (function calls are not supported in constant expressions)');
        expect(enumeratorValueMarkdown(type.enumerators[3], type)).toBe('value unknown: `FOO(3) + 2` (implicit: `AfterMacro` + 1)');
        expect(enumeratorListItem(type.enumerators[2], type)).toBe('`AfterMacro`: value unknown (`FOO(3) + 1`)');
        expect(enumeratorHex(type.enumerators[2], type)).toBeUndefined();
    });
});

/** Enums that are ill-formed in C++: the analyzer reports an error (and the compilers reject them, see below). */
const INVALID: Array<[string, string, string]> = [
    // name, enum, expected diagnostic
    ['out of range of uint8_t', 'enum class E : std::uint8_t { A = 256 };', "the value 256 of enumerator 'E::A' does not fit into the underlying type 'std::uint8_t'"],
    ['implicit value out of range', 'enum class E : std::uint8_t { A = 255, B };', "the value 256 of enumerator 'E::B' does not fit into the underlying type 'std::uint8_t'"],
    ['negative value for an unsigned type', 'enum E : unsigned char { A = -1 };', "the value -1 of enumerator 'E::A' does not fit into the underlying type 'unsigned char'"],
    ['out of range of int8_t', 'enum class E : std::int8_t { A = 128 };', "the value 128 of enumerator 'E::A' does not fit into the underlying type 'std::int8_t'"],
    ['out of range of int (enum class)', 'enum class E { A = 2147483647, B };', "the value 2147483648 of enumerator 'E::B' does not fit into the underlying type 'int'"],
    ['bool underlying type', 'enum E : bool { A = 2 };', "the value 2 of enumerator 'E::A' does not fit into the underlying type 'bool'"],
    ['signed overflow', 'enum E { A = 2147483647 + 1 };', "cannot evaluate the value of enumerator 'E::A': signed integer overflow: 2147483648 does not fit into a 32 bit signed type"],
    ['scoped enum without cast', 'enum class S { X = 1 }; enum E { A = S::X };', "cannot evaluate the value of enumerator 'E::A': a value of the scoped enum 'S' needs a cast (e.g. 'static_cast<int>(…)')"],
    ['floating point value', 'enum E { A = 1.5 };', "cannot evaluate the value of enumerator 'E::A': the value must be an integer, not a floating point value"],
    ['division by zero', 'enum E { A = 1 / 0 };', "cannot evaluate the value of enumerator 'E::A': division by zero"],
    ['shift out of range', 'enum E { A = 1 << 32 };', "cannot evaluate the value of enumerator 'E::A': shift count 32 is out of range for a 32 bit value"]
];

describe('errors as in C++', () => {
    test.each(INVALID)('%s', (_name, declaration, message) => {
        const index = headerIndex(`#include <cstdint>\n${declaration}\n`, 'invalid.h');
        expect(index.diagnostics.map(d => d.message)).toEqual([message]);
    });

    test('a value out of range keeps the computed value and is shown with the error', () => {
        const index = headerIndex('enum class E : std::uint8_t { A = 255, B };');
        const { type, enumerator: b } = enumerator(index, 'E', 'B');
        expect(b.value).toBe(256n);
        expect(b.error).toBe("the value 256 does not fit into the underlying type 'std::uint8_t'");
        expect(enumeratorValueText(b, type)).toBe('256 (0x100, implicit, does not fit into std::uint8_t)');
        expect(enumeratorValueMarkdown(b, type)).toBe('value `256` (`0x100`) (implicit: `A` + 1): error in C++, the value does not fit into the underlying type `std::uint8_t`');
    });

    test('signed overflow is not a constant expression, unsigned arithmetic wraps around', () => {
        const index = headerIndex('enum E { A = 0u - 1, B = -2147483647 - 1, C = 0x7fffffffu + 1 };');
        expect(values(index, 'E')).toEqual({ A: 4294967295n, B: -2147483648n, C: 2147483648n });
        expect(headerIndex('enum E { A = -(-2147483647 - 1) };', 'x.h').diagnostics[0]?.message).toContain('signed integer overflow');
        expect(headerIndex('enum E { A = 65536 * 65536 };', 'x.h').diagnostics[0]?.message).toContain('signed integer overflow');
        expect(values(headerIndex('enum E { A = 65536LL * 65536 };'), 'E')).toEqual({ A: 4294967296n });
    });
});

describe('display of enumerator values', () => {
    const index = headerIndex(FIXTURE);
    const show = (enumName: string, name: string) => {
        const { type, enumerator: e } = enumerator(index, enumName, name);
        return { text: enumeratorValueText(e, type), markdown: enumeratorValueMarkdown(e, type), item: enumeratorListItem(e, type) };
    };

    test.each([
        // enum, enumerator, text, markdown, list item
        ['ev::Implicit', 'I0', '0 (implicit)', 'value `0` (implicit: first enumerator)', '`I0 = 0` (implicit)'],
        ['ev::Implicit', 'I11', '11 (0xB, implicit)', 'value `11` (`0xB`) (implicit: `I10` + 1)', '`I11 = 11` (`0xB`, implicit)'],
        ['ev::Implicit', 'INeg1', '-1 (implicit)', 'value `-1` (implicit: `INeg` + 1)', '`INeg1 = -1` (implicit)'],
        ['ev::Implicit', 'I10', '10 (0xA)', 'value `10` (`0xA`)', '`I10 = 10` (`0xA`)'],
        ['ev::Literals', 'Dec', '42 (0x2A)', 'value `42` (`0x2A`)', '`Dec = 42` (`0x2A`)'],
        ['ev::Literals', 'HexUpper', '255 (0xFF)', 'value `255` (`0xFF`)', '`HexUpper = 255` (`0xFF`)'],
        ['ev::Literals', 'Oct', '8', 'value `8` = `010`', '`Oct = 8` (from `010`)'],
        ['ev::Literals', 'Bin', '10 (0xA)', 'value `10` (`0xA`) = `0b1010`', '`Bin = 10` (`0xA`, from `0b1010`)'],
        ['ev::Chars', 'CharA', '65 (0x41)', "value `65` (`0x41`) = `'A'`", "`CharA = 65` (`0x41`, from `'A'`)"],
        ['ev::Refs', 'RMask', '3 (0x3)', 'value `3` (`0x3`) = `RA | RB`', '`RMask = 3` (`0x3`, from `RA | RB`)'],
        ['ev::Refs', 'RCount', '4 (implicit)', 'value `4` (implicit: `RLast` + 1)', '`RCount = 4` (implicit)'],
        ['ev::Refs', 'RFunc', '8', 'value `8` = `BIT(3)`', '`RFunc = 8` (from `BIT(3)`)'],
        ['ev::Ops', 'Compl', '-1 (0xFFFFFFFF)', 'value `-1` (`0xFFFFFFFF`) = `~0`', '`Compl = -1` (`0xFFFFFFFF`, from `~0`)'],
        ['ev::Ops', 'DivNeg', '-3', 'value `-3` = `-7 / 2`', '`DivNeg = -3` (from `-7 / 2`)'],
        ['ev::Flags', 'Mask', '4294967295 (0xFFFFFFFF)', 'value `4294967295` (`0xFFFFFFFF`) = `~0u`', '`Mask = 4294967295` (`0xFFFFFFFF`, from `~0u`)'],
        ['ev::Wide', 'Big', '18446744073709551615 (0xFFFFFFFFFFFFFFFF)', 'value `18446744073709551615` (`0xFFFFFFFFFFFFFFFF`) = `0xFFFFFFFFFFFFFFFFull`',
            '`Big = 18446744073709551615` (`0xFFFFFFFFFFFFFFFF`, from `0xFFFFFFFFFFFFFFFFull`)'],
        ['ev::Signed8', 'Lo', '-128', 'value `-128`', '`Lo = -128`']
    ])('%s::%s', (enumName, name, text, markdown, item) => {
        expect(show(enumName, name)).toEqual({ text, markdown, item });
    });
});

describe('hover and completion show the values', () => {
    const MODEL = `statemachine V {
    import "enum-values.hpp"
    interface:
        in event go
        var flags : ev::Flags = ev::Flags::All
        var ops : ev::Ops
        var wide : ev::Wide
        var n : integer = ev::RMask + ev::RCount
    [*] -> A
    state A
}`;
    async function document(text = MODEL, complete = true) {
        const parsed = await parse(text, { 'enum-values.hpp': FIXTURE });
        if (complete) {
            expect(errors(parsed)).toEqual([]);
        }
        return parsed.document;
    }

    test('hover of an enumerator: computed value, hex, derivation, enum', async () => {
        const doc = await document();
        const text = doc.textDocument.getText();
        const all = cppHover(doc, text.indexOf('Flags::All') + 'Flags::'.length)!;
        expect(all).toContain('```cpp\nev::Flags::All = 7\n```');
        expect(all).toContain('value `7` (`0x7`) = `Read | Write | Exec`');
        expect(all).toContain('enumerator of `enum class ev::Flags` (underlying type `std::uint32_t`)');
        const count = cppHover(doc, text.indexOf('ev::RCount') + 'ev::'.length)!;
        expect(count).toContain('```cpp\nev::Refs::RCount = 4\n```');
        expect(count).toContain('value `4` (implicit: `RLast` + 1)');
        const mask = cppHover(doc, text.indexOf('ev::RMask') + 'ev::'.length)!;
        expect(mask).toContain('value `3` (`0x3`) = `RA | RB`');
    });

    test('hover of an enum lists the enumerators with their values', async () => {
        const doc = await document();
        const text = doc.textDocument.getText();
        const flags = cppHover(doc, text.indexOf('ev::Flags =') + 'ev::'.length)!;
        expect(flags).toContain([
            '- `None = 0` (implicit)', '- `Read = 1` (from `BIT(0)`)', '- `Write = 2` (from `BIT(1)`)', '- `Exec = 4` (from `BIT(2)`)',
            '- `All = 7` (`0x7`, from `Read | Write | Exec`)', '- `Mask = 4294967295` (`0xFFFFFFFF`, from `~0u`)', '- `High = 2147483648` (`0x80000000`)'
        ].join('\n'));
        const wide = cppHover(doc, text.indexOf('ev::Wide') + 'ev::'.length)!;
        expect(wide).toContain('- `Precise = 9007199254740993` (`0x20000000000001`, from `9007199254740993ull`)');
    });

    test('completion after a qualifier: values in the detail, the label description and the documentation', async () => {
        const doc = await document();
        const text = doc.textDocument.getText();
        const items = cppCompletionItems(doc, text.indexOf('Flags::All') + 'Flags::'.length)!;
        const all = items.find(i => i.label === 'All')!;
        expect(all.detail).toBe('ev::Flags = 7 (0x7)');
        expect(all.labelDetails).toEqual({ description: '= 7 (0x7)' });
        expect((all.documentation as MarkupContent).value).toBe('value `7` (`0x7`) = `Read | Write | Exec`');
        expect(items.find(i => i.label === 'None')?.labelDetails?.description).toBe('= 0 (implicit)');
        expect(items.find(i => i.label === 'Mask')?.detail).toBe('ev::Flags = 4294967295 (0xFFFFFFFF)');
        const members = cppCompletionItems(doc, text.indexOf('ev::RMask') + 'ev::'.length)!;
        // the members of the namespace in an expression: unscoped enumerators with their values
        expect(members.find(i => i.label === 'RCount')?.detail).toBe('ev::Refs = 4 (implicit)');
        expect(members.find(i => i.label === 'Oct')?.detail).toBe('ev::Literals = 8');
        expect(members.find(i => i.label === 'Oct')?.labelDetails?.description).toBe('= 8');
        expect((members.find(i => i.label === 'Oct')?.documentation as MarkupContent).value).toBe('value `8` = `010`');
    });

    test('completion of the enumerators of the expected enum', async () => {
        const source = MODEL.replace('    [*] -> A', '    [*] -> A\n    A -> A : go [wide == |');
        const doc = await document(source.replace('|', ''), false);
        const items = cppContextCompletionItems(doc, source.indexOf('|'));
        expect(items.map(i => `${i.label} ${i.labelDetails?.description}`)).toEqual([
            'ev::Wide::Big = 18446744073709551615 (0xFFFFFFFFFFFFFFFF)', 'ev::Wide::Top = 9223372036854775808 (0x8000000000000000)',
            'ev::Wide::Precise = 9007199254740993 (0x20000000000001)', 'ev::Wide::Next = 9007199254740992 (0x20000000000000)',
            'ev::Wide::Next1 = 9007199254740993 (0x20000000000001, implicit)'
        ]);
        expect((items[4].documentation as MarkupContent).value).toBe('value `9007199254740993` (`0x20000000000001`) (implicit: `Next` + 1)');
    });

    test('unknown values: completion and hover say so instead of showing a number', async () => {
        const header = 'enum Codes { kFirst = VENDOR_CODE(1), kSecond };';
        const parsed = await parse('statemachine U {\n    import "codes.h"\n    interface:\n        var n : integer = ::kSecond\n    [*] -> A\n    state A\n}', { 'codes.h': header });
        const doc = parsed.document;
        const text = doc.textDocument.getText();
        const hover = cppHover(doc, text.indexOf('kSecond'))!;
        expect(hover).toContain('```cpp\nCodes::kSecond\n```');
        expect(hover).toContain('value unknown: `VENDOR_CODE(1) + 1` (implicit: `kFirst` + 1)');
        const items = cppCompletionItems(doc, text.indexOf('kSecond'))!;
        expect(items.find(i => i.label === 'kSecond')?.detail).toBe('Codes value unknown (VENDOR_CODE(1) + 1)');
        const enumHover = cppHover(doc, text.indexOf('::kSecond') + 2);
        expect(enumHover).toBeDefined();
    });
});

describe('the example examples/cpp-enum-values', () => {
    test('model and unit tests (the values are those of the compiler)', async () => {
        const services = createHsmServices(NodeFileSystem);
        installNodeHeaderSupport(services.shared);
        const directory = path.join(EXAMPLES_DIRECTORY, 'cpp-enum-values');
        const workspace = new HsmTestWorkspace(services);
        const documents = await workspace.load(['sensor.hsm', 'sensor.hsmtest'].map(name => ({
            uri: pathToFileURL(path.join(directory, name)).toString(),
            text: fs.readFileSync(path.join(directory, name), 'utf-8')
        })));
        for (const loaded of documents) {
            expect(loaded.diagnostics.filter(d => d.severity === 1).map(d => d.message), loaded.uri).toEqual([]);
        }
        const results = workspace.runDocuments(documents);
        expect(results.map(r => `${r.name}: ${r.status}`)).toEqual([
            'enumeratorValuesFollowTheCppRules: passed', 'measuresOnQuery: passed', 'reportsATimeout: passed'
        ]);
    });

    test('the header shows the numbering rules', () => {
        const index = headerIndex(fs.readFileSync(path.join(EXAMPLES_DIRECTORY, 'cpp-enum-values/sensor_codes.h'), 'utf-8'), 'sensor_codes.h');
        expect(index.diagnostics).toEqual([]);
        const list = (name: string) => {
            const type = enumType(index, name);
            return type.enumerators.map(e => enumeratorListItem(e, type));
        };
        expect(list('sensor::State')).toEqual([
            '`Off = 0` (implicit)', '`Booting = 1` (implicit)', '`Ready = 2` (implicit)', '`Measuring = 10` (`0xA`)',
            '`Calibrating = 11` (`0xB`, implicit)', '`Error = 240` (`0xF0`)', '`Fatal = 241` (`0xF1`, implicit)'
        ]);
        expect(list('sensor::Status')).toEqual([
            '`kNone = 0`', '`kPowered = 1` (from `SENSOR_BIT(0)`)', '`kCalibrated = 2` (from `SENSOR_BIT(1)`)',
            '`kOverTemperature = 16` (`0x10`, from `SENSOR_BIT(4)`)', '`kReady = 3` (`0x3`, from `kPowered | kCalibrated`)',
            '`kVendor = 2048` (`0x800`, from `SENSOR_VENDOR_BASE << 4`)', '`kAll = 65535` (`0xFFFF`)'
        ]);
        expect(list('sensor::Command')).toEqual([
            "`Start = 83` (`0x53`, from `'S'`)", "`Stop = 88` (`0x58`, from `'X'`)", "`Query = 63` (`0x3F`, from `'?'`)", "`Newline = 10` (`0xA`, from `'\\n'`)"
        ]);
        expect(list('sensor::Level')).toEqual([
            '`kMinLevel = -3`', '`kLow = -2` (implicit)', '`kNormal = -1` (implicit)', '`kZero = 0` (implicit)', '`kOctal = 8` (from `010`)',
            "`kMaxLevel = 25` (`0x19`, from `'z' - 'a'`)"
        ]);
        expect(list('sensor_result_t')).toEqual([
            '`SENSOR_OK = 0` (implicit)', '`SENSOR_TIMEOUT = -110`', '`SENSOR_BUSY = -109` (implicit)',
            '`SENSOR_LAST_ERROR = -109` (from `SENSOR_BUSY`)', '`SENSOR_RESULT_COUNT = 3`'
        ]);
    });
});

// ---------------------------------------------------------------------------------------------
// Cross-check with real compilers

const run = promisify(execFile);

function hasCompiler(command: string): boolean {
    try {
        return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
    } catch {
        return false;
    }
}

const COMPILERS = ['g++', 'clang++'].filter(hasCompiler);
const FLAGS = ['-std=c++20', '-fsyntax-only', '-Wno-multichar'];

/** A C++ integer literal for a value (`-9223372036854775808` as `(-9223372036854775807LL - 1)`). */
function literal(value: bigint): string {
    if (value === -(1n << 63n)) {
        return '(-9223372036854775807LL - 1)';
    }
    return value < 0n ? `${value}LL` : `${value}ULL`;
}

/**
 * `static_assert`s for every enumerator with a computed value of the headers (and for the size of
 * the enums), compiled together with the headers: the analyzer's values must be those of the compiler.
 */
function staticAsserts(index: CppTypeIndex): { lines: string[], count: number } {
    const lines: string[] = [];
    let count = 0;
    for (const declaration of index.allDeclarations()) {
        if (declaration.kind !== 'enum' || declaration.opaque) {
            continue;
        }
        const type = index.typeOf(declaration) as CppEnumType;
        if (declaration.name) {
            lines.push(`static_assert(sizeof(::${type.cppName}) == ${type.underlying.bits / 8}, "sizeof ${type.cppName}");`);
        }
        for (const e of type.enumerators) {
            if (!e.valid || e.error) {
                continue;
            }
            const cast = e.value < 0n ? 'long long' : 'unsigned long long';
            lines.push(`static_assert(static_cast<${cast}>(::${e.qualifiedName}) == ${literal(e.value)}, "${e.qualifiedName}");`);
            count++;
        }
    }
    return { lines, count };
}

describe.skipIf(COMPILERS.length === 0)('a C++ compiler computes the same values', () => {
    const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-enum-values-'));
    afterAll(() => fs.rmSync(workDirectory, { recursive: true, force: true }));

    test.each([
        ['test/cpp-header/enum-values.hpp', path.join(FIXTURE_DIRECTORY, 'enum-values.hpp')],
        ['test/cpp-header/enums.hpp', path.join(FIXTURE_DIRECTORY, 'enums.hpp')],
        ['examples/cpp-enum-values/sensor_codes.h', path.join(EXAMPLES_DIRECTORY, 'cpp-enum-values/sensor_codes.h')],
        ['examples/cpp-types/conveyor_types.h', path.join(EXAMPLES_DIRECTORY, 'cpp-types/conveyor_types.h')]
    ])('%s', async (name, file) => {
        const index = headerIndex(fs.readFileSync(file, 'utf-8'), path.basename(file));
        expect(index.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        const { lines, count } = staticAsserts(index);
        expect(count).toBeGreaterThan(5);
        const source = path.join(workDirectory, `${path.basename(file)}.check.cpp`);
        fs.writeFileSync(source, [`#include "${file}"`, ...lines, ''].join('\n'));
        for (const compiler of COMPILERS) {
            await run(compiler, [...FLAGS, source]).catch((error: { stderr?: string }) => {
                throw new Error(`${compiler} rejects the values of the analyzer for ${name}:\n${error.stderr}`);
            });
        }
    }, 60000);

    test('the generated class of the example compiles with the header', async () => {
        const directory = path.join(EXAMPLES_DIRECTORY, 'cpp-enum-values');
        const header = fs.readFileSync(path.join(directory, 'sensor_codes.h'), 'utf-8');
        const parsed = await parse(fs.readFileSync(path.join(directory, 'sensor.hsm'), 'utf-8'), { 'sensor_codes.h': header });
        expect(errors(parsed)).toEqual([]);
        const result = generateCpp(parsed.model);
        expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        const out = path.join(workDirectory, 'sensor');
        fs.mkdirSync(out, { recursive: true });
        for (const file of result.files) {
            fs.writeFileSync(path.join(out, file.path), file.content);
        }
        for (const compiler of COMPILERS) {
            await run(compiler, ['-std=c++17', '-Wall', '-Wextra', '-Wpedantic', '-Werror', '-Wconversion', '-fsyntax-only', `-I${directory}`, path.join(out, 'Sensor.cpp')])
                .catch((error: { stderr?: string }) => {
                    throw new Error(`${compiler}: ${error.stderr}`);
                });
        }
    }, 60000);

    test('the enums the analyzer reports as errors are rejected by the compilers', async () => {
        await Promise.all(INVALID.map(async ([name, declaration], i) => {
            const source = path.join(workDirectory, `invalid-${i}.cpp`);
            fs.writeFileSync(source, `#include <cstdint>\n${declaration}\n`);
            for (const compiler of COMPILERS) {
                const result = await run(compiler, [...FLAGS, source]).then(() => 'accepted', () => 'rejected');
                expect(result, `${compiler}: ${name}`).toBe('rejected');
            }
        }));
    }, 60000);
});
