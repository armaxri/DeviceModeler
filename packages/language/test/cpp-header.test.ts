import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
    CppTypeIndex, cppHeaderReport, describeCppType, forEachCppDeclaration, parseCppHeader,
    type CppConstant, type CppDeclaration, type CppEnum, type CppEnumType, type CppHeader, type CppRecord,
    type CppResolvedType, type CppStructType
} from '../src/cpp-header/index.js';

const FIXTURES = path.resolve(__dirname, 'cpp-header');

function fixture(name: string): { fileName: string, text: string } {
    return { fileName: name, text: fs.readFileSync(path.join(FIXTURES, name), 'utf-8') };
}

/** Index over one header given as text (diagnostics are checked to be empty unless `allowDiagnostics`). */
function index(text: string, options: { allowDiagnostics?: boolean, longBits?: 32 | 64 } = {}): CppTypeIndex {
    const result = CppTypeIndex.fromSources([{ fileName: 'test.h', text }], options.longBits ? { dataModel: { longBits: options.longBits } } : {});
    if (!options.allowDiagnostics) {
        expect(result.diagnostics.map(d => `${d.range.start.line + 1}: ${d.message}`)).toEqual([]);
    }
    return result;
}

function all(header: CppHeader): CppDeclaration[] {
    const result: CppDeclaration[] = [];
    forEachCppDeclaration(header.declarations, d => result.push(d));
    return result;
}

function names(header: CppHeader): string[] {
    return all(header).map(d => `${d.kind} ${d.qualifiedName}`);
}

/** The value of a constant or enumerator (throws if it has none). */
function value(idx: CppTypeIndex, name: string): unknown {
    const info = idx.constant(name);
    expect(info, name).toBeDefined();
    expect(info!.error, name).toBeUndefined();
    return info!.value;
}

function enumType(idx: CppTypeIndex, name: string): CppEnumType {
    const type = idx.resolveType(name);
    expect(type?.kind, name).toBe('enum');
    return type as CppEnumType;
}

function structType(idx: CppTypeIndex, name: string): CppStructType {
    const type = idx.resolveType(name);
    expect(type?.kind, name).toBe('struct');
    return type as CppStructType;
}

function enumerators(idx: CppTypeIndex, name: string): Record<string, bigint> {
    return Object.fromEntries(enumType(idx, name).enumerators.map(e => [e.name, e.value]));
}

function evaluate(expression: string, prelude = ''): unknown {
    const result = index(prelude, { allowDiagnostics: true }).evaluate(expression);
    if (result.error !== undefined) {
        throw new Error(result.error);
    }
    return result.value;
}

describe('tokenizer and preprocessor', () => {
    test('comments, strings, raw strings and digit separators do not confuse the parser', () => {
        const idx = index(`
            // enum Commented { A };
            /* enum Block { B }; */
            constexpr const char* kUrl = "http://example.com/*not a comment*/";
            constexpr const char* kRaw = R"x(raw "string" with ); and })x";
            constexpr int kBig = 1'000'000;
            constexpr char kQuote = '\\'';
            enum Real { C };
        `);
        expect(idx.lookup('Commented')).toBeUndefined();
        expect(idx.lookup('Block')).toBeUndefined();
        expect(value(idx, 'kUrl')).toBe('http://example.com/*not a comment*/');
        expect(value(idx, 'kRaw')).toBe('raw "string" with ); and }');
        expect(value(idx, 'kBig')).toBe(1_000_000n);
        expect(value(idx, 'kQuote')).toBe(39n);
        expect(idx.lookup('Real')?.kind).toBe('enum');
    });

    test('documentation comments are attached to declarations, members and enumerators', () => {
        const header = parseCppHeader(`
            /// Line doc
            /// second line
            enum class A { X, ///< trailing X
                /** leading Y */ Y, Z //!< trailing Z
            };
            /**
             * Block doc.
             * @brief Details.
             */
            struct S {
                int a; ///< field a
                //! field b
                int b;
            };
            // not a doc comment
            using T = int;
            /*! Qt style */
            constexpr int kX = 1;
            /**< not attached */
        `, 'doc.h');
        const docs = Object.fromEntries(all(header).map(d => [d.qualifiedName, d.doc]));
        expect(docs['A']).toBe('Line doc\nsecond line');
        expect(docs['A::X']).toBe('trailing X');
        expect(docs['A::Y']).toBe('leading Y');
        expect(docs['A::Z']).toBe('trailing Z');
        expect(docs['S']).toBe('Block doc.\nDetails.');
        expect(docs['S::a']).toBe('field a');
        expect(docs['S::b']).toBe('field b');
        expect(docs['T']).toBeUndefined();
        expect(docs['kX']).toBe('Qt style');
    });

    test('conditional compilation: #if 0, #ifdef, #ifndef, #elif, #else, defined(), include guards', () => {
        const header = parseCppHeader(`
            #ifndef GUARD_H
            #define GUARD_H
            #define FEATURE 2
            #if 0
            enum Never { N };
            #endif
            #ifdef __cplusplus
            enum Cpp { C };
            #else
            enum NotCpp { NC };
            #endif
            #if FEATURE == 1
            enum One { O };
            #elif FEATURE == 2 && defined(GUARD_H) && !defined(UNDEFINED_MACRO)
            enum Two { T };
            #else
            enum Other { X };
            #endif
            #if UNDEFINED_MACRO
            enum Undefined { U };
            #endif
            #if __cplusplus >= 201103L && __has_include(<optional>)
            enum HasInclude { H };
            #elif __cplusplus >= 201103L
            enum Modern { M };
            #endif
            #endif
        `, 'guard.h');
        expect(names(header).filter(n => n.startsWith('enum '))).toEqual(['enum Cpp', 'enum Two', 'enum Modern']);
        expect(header.diagnostics).toEqual([]);
        expect(header.macros.map(m => m.name)).toEqual(['GUARD_H', 'FEATURE']);
    });

    test('predefined macros can be given as options', () => {
        const text = `
            #if defined(USE_CAN) && CAN_CHANNELS > 1
            enum Can { A };
            #else
            enum NoCan { B };
            #endif
        `;
        expect(names(parseCppHeader(text, 'a.h'))).toEqual(['enum NoCan', 'enumerator NoCan::B']);
        expect(names(parseCppHeader(text, 'a.h', { defines: { USE_CAN: '', CAN_CHANNELS: '2' } }))).toEqual(['enum Can', 'enumerator Can::A']);
    });

    test('object-like and function-like macros are expanded', () => {
        const idx = index(`
            #define SIZE 8
            #define TWICE(x) ((x) * 2)
            #define BIT(n) (1u << (n))
            #define CONCAT(a, b) a ## b
            #define NAME(x) #x
            #define FIRST(first, ...) first
            #define EMPTY
            EMPTY constexpr int kSize = TWICE(SIZE);
            enum Flags { FlagA = BIT(0), FlagB = BIT(SIZE - 1), CONCAT(Flag, C) = 3 };
            constexpr const char* kName = NAME(motor);
            constexpr int kFirst = FIRST(1, 2, 3);
            #undef SIZE
            constexpr int SIZE = 5;
        `);
        expect(value(idx, 'kSize')).toBe(16n);
        expect(enumerators(idx, 'Flags')).toEqual({ FlagA: 1n, FlagB: 128n, FlagC: 3n });
        expect(value(idx, 'kName')).toBe('motor');
        expect(value(idx, 'kFirst')).toBe(1n);
        expect(value(idx, 'SIZE')).toBe(5n);
        // the expression text shows the macro use, not its expansion
        const flagB = idx.lookup('FlagB');
        expect(flagB?.kind === 'enumerator' && flagB.initializer?.text).toBe('BIT(SIZE - 1)');
    });

    test('includes are recorded', () => {
        const header = parseCppHeader('#include <cstdint>\n#include "motor/types.h"\n#if 0\n#include "never.h"\n#endif\n', 'a.h');
        expect(header.includes.map(i => [i.path, i.system, i.range.start.line])).toEqual([['cstdint', true, 0], ['motor/types.h', false, 1]]);
    });

    test('preprocessor problems are diagnosed', () => {
        const header = parseCppHeader('#if FOO(1)\nenum A { X };\n#endif\n#ifdef BAR\n#error unsupported\n#endif\n#error not supported\n#if 1\n', 'p.h');
        expect(header.diagnostics.map(d => `${d.range.start.line + 1} ${d.severity}: ${d.message}`)).toEqual([
            '1 warning: cannot evaluate \'#if FOO(1)\' (\'FOO\' is not a defined function-like macro); the condition is treated as false',
            '7 warning: #error not supported',
            '8 error: unterminated #if'
        ]);
    });
});

describe('parser', () => {
    test('namespaces: nested, a::b, inline, anonymous, aliases, using directives', () => {
        const header = parseCppHeader(`
            namespace a {
                namespace b { enum E { X }; }
                inline namespace v1 { struct S { int i; }; }
                namespace { constexpr int kHidden = 1; }
            }
            namespace a::b::c { using T = int; }
            namespace short_name = a::b;
            using namespace a;
        `, 'ns.h');
        expect(names(header)).toEqual([
            'namespace a', 'namespace a::b', 'enum a::b::E', 'enumerator a::b::E::X', 'namespace a::v1', 'record a::v1::S',
            'field a::v1::S::i', 'namespace a', 'constant a::kHidden', 'namespace a', 'namespace a::b', 'namespace a::b::c',
            'alias a::b::c::T', 'namespaceAlias short_name', 'usingDirective '
        ]);
        const v1 = all(header).find(d => d.qualifiedName === 'a::v1');
        expect(v1?.kind === 'namespace' && v1.inline).toBe(true);
    });

    test('enums: scoped, underlying type, anonymous, typedef, forward declarations', () => {
        const header = parseCppHeader(`
            enum class A : unsigned char { X = 1, Y };
            enum struct B { Z };
            enum C { C1, C2 = 5, C3, };
            enum : long { Anonymous = 7 };
            typedef enum { T1, T2 } TypedefEnum;
            enum class Forward : int;
            enum class [[deprecated]] WithAttribute { W [[deprecated]] = 2 };
        `, 'e.h');
        const enums = all(header).filter((d): d is CppEnum => d.kind === 'enum');
        expect(enums.map(e => [e.qualifiedName, e.scoped, e.underlyingType?.spelling, e.enumerators.map(x => x.name).join(',')])).toEqual([
            ['A', true, 'unsigned char', 'X,Y'],
            ['B', true, undefined, 'Z'],
            ['C', false, undefined, 'C1,C2,C3'],
            ['(anonymous)', false, 'long', 'Anonymous'],
            ['TypedefEnum', false, undefined, 'T1,T2'],
            ['WithAttribute', true, undefined, 'W']
        ]);
        // enumerators of anonymous enums belong to the enclosing scope
        expect(enums[3].enumerators[0].qualifiedName).toBe('Anonymous');
        expect(header.diagnostics).toEqual([]);
    });

    test('structs and classes: fields, access, bit-fields, arrays, nested types, static constants, methods', () => {
        const header = parseCppHeader(`
            struct Base { int base = 1; };
            class Widget : public Base, private Other {
                int hiddenByDefault;
            public:
                Widget() : hiddenByDefault(0), nested{1} {}
                explicit Widget(int x);
                virtual ~Widget();
                Widget& operator=(const Widget&) = default;
                operator int() const { return 0; }
                void method() const noexcept;
                auto trailing() -> int { return 1; }
                static constexpr int kCount = 3;
                static const unsigned kLimit = 10u;
                static int notConstant;
                unsigned flag : 1, other : 3;
                char name[16];
                int matrix[2][kCount];
                const char* text = "t";
                struct Nested { int n; } nested;
                enum class Kind { K1 } kind = Kind::K1;
                using Id = unsigned;
                Id id;
                mutable int cache;
                friend class Friend;
                template <typename T> T get() const { return T{}; }
                union { int i; float f; };
            protected:
                int prot;
            };
        `, 's.h');
        const widget = all(header).find((d): d is CppRecord => d.kind === 'record' && d.name === 'Widget')!;
        expect(widget.key).toBe('class');
        expect(widget.bases.map(b => [b.access, b.type.spelling])).toEqual([['public', 'Base'], ['private', 'Other']]);
        expect(widget.hasUserConstructors).toBe(true);
        expect(widget.hasVirtualFunctions).toBe(true);
        expect(widget.hasMemberFunctions).toBe(true);
        expect(widget.fields.map(f => `${f.access} ${f.type.spelling} ${f.name}${f.bitWidth ? ':' + f.bitWidth.text : ''}${f.initializer ? '=' + f.initializer.text : ''}`)).toEqual([
            'private int hiddenByDefault',
            'public unsigned int flag:1',
            'public unsigned int other:3',
            'public char[16] name',
            'public int[2][kCount] matrix',
            'public const char* text="t"',
            'public Widget::Nested nested',
            'public Widget::Kind kind=Kind::K1',
            'public Id id',
            'public int cache',
            'public Widget::(anonymous) ',
            'protected int prot'
        ]);
        expect(widget.members.map(m => `${m.kind} ${m.name}`)).toEqual([
            'constant kCount', 'constant kLimit', 'record Nested', 'enum Kind', 'alias Id', 'record '
        ]);
        expect(header.diagnostics).toEqual([]);
    });

    test('typedef and using aliases, including C idioms and function pointers', () => {
        const header = parseCppHeader(`
            typedef unsigned long long u64, *pu64;
            typedef struct Point { int x, y; } Point, *PointPtr;
            typedef struct { int a; } Anonymous;
            typedef void (*Callback)(int);
            typedef int Array[4];
            using Handler = void (*)(int, int);
            using U8 = std::uint8_t;
            using std::string;
        `, 'a.h');
        const aliases = all(header).filter(d => d.kind === 'alias');
        expect(aliases.map(a => a.kind === 'alias' && `${a.name}=${a.type.spelling}${a.type.functionPointer ? ' (fp)' : ''} [${a.syntax}]`)).toEqual([
            'u64=unsigned long long [typedef]',
            'pu64=unsigned long long* [typedef]',
            'Point=Point [typedef]',
            'PointPtr=Point* [typedef]',
            'Anonymous=Anonymous [typedef]',
            'Callback=void(*)(…) (fp) [typedef]',
            'Array=int[4] [typedef]',
            'Handler=void(*)(…) (fp) [using]',
            'U8=std::uint8_t [using]',
            'string=std::string [usingDeclaration]'
        ]);
    });

    test('constants: constexpr, const, static, extern; non-const variables and functions are skipped', () => {
        const header = parseCppHeader(`
            constexpr int a = 1;
            const int b = 2;
            static const int c = 3;
            static constexpr int d{4};
            inline constexpr int e = 5;
            extern const int f;
            const int g(7);
            int notConst = 8;
            static int alsoNotConst;
            const char* notConstPointer = "x";
            const char* const constPointer = "y";
            int function(int x);
            constexpr int constexprFunction(int x) { return x; }
            const int& reference();
            int x = 1, y = 2;
            constexpr int m = 1, n = m + 1;
        `, 'c.h');
        const constants = all(header).filter((d): d is CppConstant => d.kind === 'constant');
        expect(constants.map(c => `${c.name}${c.initializer ? '=' + c.initializer.text : ''}`)).toEqual([
            'a=1', 'b=2', 'c=3', 'd={4}', 'e=5', 'f', 'g=7', 'constPointer="y"', 'm=1', 'n=m + 1'
        ]);
        expect(constants.map(c => [c.constexpr, c.static, c.inline, c.extern].map(Number).join(''))).toEqual([
            '1000', '0000', '0100', '1100', '1010', '0001', '0000', '0000', '1000', '1000'
        ]);
    });

    test('templates, functions, operators, lambdas, static_assert, friends, attributes and macros are skipped', () => {
        const header = parseCppHeader(`
            #define DECLARE_THING(x) struct x##Thing
            #define API __attribute__((visibility("default")))
            template <typename T, int N = (3 > 2)>
            class Container { T items[N]; public: T get() { return items[0]; } };
            template <> class Container<int, 1> { int x; };
            template <template <typename> class Tpl> struct Meta { enum { value = 1 }; };
            template <typename T> using Vec = std::vector<T>;
            template <typename T> constexpr T kPi = T(3.14);
            API int exported(int a, int b = [] { return 1; }());
            inline int body(int x) { if (x > 0) { return x; } else { return -x; } }
            auto lambda = [](int x) { return x * 2; };
            static_assert(sizeof(int) == 4, "int");
            Q_OBJECT
            SOME_MACRO(arg)
            [[nodiscard]] alignas(16) int aligned();
            __declspec(dllexport) void win();
            struct After { int value; };
            int operator+(const After&, const After&);
            namespace detail { template <typename T> struct Impl; }
            enum class Last { A };
        `, 't.h');
        expect(names(header).filter(n => !n.startsWith('field') && !n.startsWith('enumerator'))).toEqual([
            'record After', 'namespace detail', 'enum Last'
        ]);
        expect(header.diagnostics).toEqual([]);
    });

    test('garbage is skipped without losing the following declarations', () => {
        const header = parseCppHeader(`
            @@@ garbage $$$ ;
            struct Broken { int a };
            }
            enum class Good { A };
            int x = (1 + ;
            enum Bad { B = , C };
            struct AlsoGood { int b; };
        `, 'g.h');
        expect(names(header).filter(n => n.startsWith('enum') || n.startsWith('record'))).toEqual([
            'record Broken', 'enum Good', 'enumerator Good::A', 'enum Bad', 'enumerator Bad::B', 'enumerator Bad::C', 'record AlsoGood'
        ]);
        expect(header.diagnostics.length).toBeGreaterThan(0);
    });

    test('unterminated constructs are diagnosed with locations', () => {
        const header = parseCppHeader('namespace a {\nenum class E { A, B\n', 'u.h');
        expect(header.diagnostics.map(d => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`)).toEqual([
            '1:13 missing \'}\' of namespace a',
            '2:14 missing \'}\' of enum E'
        ]);
        expect(names(header)).toEqual(['namespace a', 'enum a::E', 'enumerator a::E::A', 'enumerator a::E::B']);
        const unterminated = parseCppHeader('/* open comment\nenum A {};', 'c.h');
        expect(unterminated.diagnostics.map(d => d.message)).toEqual(['unterminated comment']);
    });

    test('source locations point to the names', () => {
        const text = 'namespace motor {\n  enum class Mode { Off, On };\n  struct Pos { int x; };\n}\n';
        const header = parseCppHeader(text, 'loc.h');
        const lines = text.split('\n');
        for (const d of all(header)) {
            const { start, end } = d.nameRange;
            expect(lines[start.line].slice(start.character, end.character), d.qualifiedName).toBe(d.name);
            expect(d.fileName).toBe('loc.h');
        }
    });
});

describe('constant expression evaluation', () => {
    test('integer arithmetic follows C++ (types, promotions, wrap around, truncation)', () => {
        expect(evaluate('1 + 2 * 3')).toBe(7n);
        expect(evaluate('7 / 2')).toBe(3n);
        expect(evaluate('-7 / 2')).toBe(-3n);
        expect(evaluate('-7 % 3')).toBe(-1n);
        expect(evaluate('0u - 1')).toBe(4294967295n);
        expect(evaluate('(0u - 1) / 2')).toBe(2147483647n);
        expect(evaluate('~0u')).toBe(4294967295n);
        expect(evaluate('~0')).toBe(-1n);
        expect(evaluate('-1 < 0u')).toBe(false);
        expect(evaluate('-1 < 0')).toBe(true);
        expect(evaluate('1 << 31')).toBe(-2147483648n);
        expect(evaluate('1u << 31')).toBe(2147483648n);
        expect(evaluate('1ULL << 63')).toBe(9223372036854775808n);
        expect(evaluate('0x7fffffff + 1')).toBe(-2147483648n);
        expect(evaluate('2147483648')).toBe(2147483648n);
        expect(evaluate('0xFF & 0x0F | 0x30 ^ 0x01')).toBe(0x3fn);
        expect(evaluate('-16 >> 2')).toBe(-4n);
        expect(evaluate('0b1010 + 010 + 0x10')).toBe(34n);
        expect(evaluate('true + true')).toBe(2n);
    });

    test('logical, relational and conditional operators', () => {
        expect(evaluate('1 < 2 && 2 < 3')).toBe(true);
        expect(evaluate('1 > 2 || !(3 == 3)')).toBe(false);
        expect(evaluate('1 ? 10 : 20')).toBe(10n);
        expect(evaluate('0 ? 1 / 0 : 5')).toBe(5n);
        expect(evaluate('false && 1 / 0')).toBe(false);
        expect(evaluate('1 not_eq 2 and not false')).toBe(true);
    });

    test('floating point, characters and strings', () => {
        expect(evaluate('1.5 * 2')).toBe(3);
        expect(evaluate('1 / 4.0')).toBe(0.25);
        expect(evaluate('1e3 + .5')).toBe(1000.5);
        expect(evaluate('0.1f')).toBe(Math.fround(0.1));
        expect(evaluate('0x1.8p1')).toBe(3);
        expect(evaluate("'A' + 1")).toBe(66n);
        expect(evaluate("'\\n'")).toBe(10n);
        expect(evaluate("'\\x41'")).toBe(65n);
        expect(evaluate("u'\\u00e4'")).toBe(228n);
        expect(evaluate('"abc" "def"')).toBe('abcdef');
    });

    test('casts, sizeof and numeric_limits', () => {
        expect(evaluate('static_cast<std::uint8_t>(300)')).toBe(44n);
        expect(evaluate('(unsigned char)-1')).toBe(255n);
        expect(evaluate('int(2.9)')).toBe(2n);
        expect(evaluate('static_cast<int>(-2.9)')).toBe(-2n);
        expect(evaluate('double(1) / 2')).toBe(0.5);
        expect(evaluate('bool(5)')).toBe(true);
        expect(evaluate('std::uint16_t{7} + 1')).toBe(8n);
        expect(evaluate('sizeof(std::uint32_t) + sizeof(double) + sizeof(char)')).toBe(13n);
        expect(evaluate('std::numeric_limits<std::uint16_t>::max()')).toBe(65535n);
        expect(evaluate('std::numeric_limits<int>::min()')).toBe(-2147483648n);
        expect(evaluate('std::numeric_limits<std::int64_t>::max()')).toBe(9223372036854775807n);
        expect(evaluate('std::numeric_limits<float>::max()')).toBe(3.4028234663852886e38);
    });

    test('names: constants, enumerators, scoped enums', () => {
        const prelude = `
            namespace n {
                constexpr int kA = 3;
                enum class Mode : std::uint8_t { Off, On };
                enum Plain { P1 = 4 };
                constexpr Mode kDefault = Mode::On;
            }
        `;
        expect(evaluate('n::kA * 2', prelude)).toBe(6n);
        expect(evaluate('n::Mode::On', prelude)).toBe(1n);
        expect(evaluate('n::P1 + 1', prelude)).toBe(5n);
        expect(evaluate('n::Plain::P1', prelude)).toBe(4n);
        expect(evaluate('static_cast<int>(n::Mode::On) + 1', prelude)).toBe(2n);
        expect(evaluate('n::kDefault == n::Mode::On', prelude)).toBe(true);
        expect(() => evaluate('n::Mode::On + 1', prelude)).toThrow("operator '+' cannot be applied to a value of the scoped enum 'n::Mode' without a cast");
    });

    test('errors: not constant, division by zero, shifts, unknown names', () => {
        expect(() => evaluate('1 / 0')).toThrow('division by zero');
        expect(() => evaluate('1 % 0')).toThrow('remainder by zero');
        expect(() => evaluate('1 << 32')).toThrow('shift count 32 is out of range for a 32 bit value');
        expect(() => evaluate('1 << -1')).toThrow('out of range');
        expect(() => evaluate('unknown + 1')).toThrow("unknown name 'unknown'");
        expect(() => evaluate('f(1)', 'int f(int);')).toThrow('function calls are not supported');
        expect(() => evaluate('99999999999999999999')).toThrow('too large');
        expect(() => evaluate('1 +')).toThrow("cannot parse '1 +'");
        expect(() => evaluate('nullptr')).toThrow('nullptr is not supported');
    });

    test('the data model determines the width of long', () => {
        const text = 'constexpr long kL = 0x7fffffffL; constexpr unsigned long kU = ~0ul; enum E : long { A = 1L << 40 };';
        expect(value(index(text), 'kU')).toBe(18446744073709551615n);
        const ilp32 = index(text, { allowDiagnostics: true, longBits: 32 });
        expect(value(ilp32, 'kU')).toBe(4294967295n);
        expect(ilp32.resolveType('long')).toEqual({ kind: 'integer', cppName: 'long', bits: 32, signed: true });
        expect(ilp32.diagnostics.map(d => d.message)).toEqual(['cannot evaluate the value of enumerator \'E::A\': shift count 40 is out of range for a 32 bit value']);
    });
});

describe('enum values', () => {
    test('implicit values, references to earlier enumerators and constants, char literals', () => {
        const idx = index(`
            constexpr int kBase = 100;
            enum E { A, B, C = 10, D, E1 = C + D, F = kBase, G, H = 'x', I = -1, J };
            enum class Flags : unsigned { None = 0, R = 1 << 0, W = 1 << 1, RW = R | W, All = ~0u };
        `);
        expect(enumerators(idx, 'E')).toEqual({ A: 0n, B: 1n, C: 10n, D: 11n, E1: 21n, F: 100n, G: 101n, H: 120n, I: -1n, J: 0n });
        expect(enumerators(idx, 'Flags')).toEqual({ None: 0n, R: 1n, W: 2n, RW: 3n, All: 4294967295n });
    });

    test('the underlying type is fixed or deduced from the values', () => {
        const idx = index(`
            enum class Scoped { A };
            enum Small { S = 1 };
            enum Large { L = 0x80000000 };
            enum Huge { N = -1, P = 0x80000000 };
            enum class Byte : std::uint8_t { B = 255 };
            enum class Wide : long long { W };
        `);
        expect(['Scoped', 'Small', 'Large', 'Huge', 'Byte', 'Wide'].map(name => enumType(idx, name).underlying.cppName))
            .toEqual(['int', 'int', 'unsigned int', 'long long', 'std::uint8_t', 'long long']);
    });

    test('values that cannot be evaluated or do not fit are diagnosed', () => {
        const idx = index(`
            enum class A : std::uint8_t {
                Ok = 1,
                TooLarge = 256,
                Unknown = UNDEFINED_CONSTANT,
                AfterUnknown,
                Call = compute(),
            };
        `, { allowDiagnostics: true });
        const type = enumType(idx, 'A');
        expect(type.enumerators.map(e => [e.name, e.value, e.valid])).toEqual([
            ['Ok', 1n, true], ['TooLarge', 0n, true], ['Unknown', 1n, false], ['AfterUnknown', 2n, true], ['Call', 3n, false]
        ]);
        expect(idx.diagnostics.map(d => `${d.severity} ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`)).toEqual([
            'error 4:28 the value 256 of enumerator \'A::TooLarge\' does not fit into the underlying type \'std::uint8_t\'',
            'error 5:27 cannot evaluate the value of enumerator \'A::Unknown\': unknown name \'UNDEFINED_CONSTANT\'',
            'error 7:24 cannot evaluate the value of enumerator \'A::Call\': function calls are not supported in constant expressions'
        ]);
    });
});

describe('type index', () => {
    const idx = CppTypeIndex.fromSources([fixture('motor_types.h'), fixture('controller.hpp'), fixture('legacy_c.h')]);

    test('the fixture headers have only the expected diagnostics', () => {
        expect(idx.diagnostics.map(d => `${d.fileName}:${d.range.start.line + 1}: ${d.severity}: ${d.message}`)).toEqual([
            'controller.hpp:101: warning: cannot evaluate the constant \'app::control::kNotConstant\': function calls are not supported in constant expressions'
        ]);
    });

    test('lookup of qualified and unqualified names', () => {
        expect(idx.lookup('motor::Mode')?.kind).toBe('enum');
        expect(idx.lookup('motor::Mode::Fast')?.kind).toBe('enumerator');
        expect(idx.lookup('::motor::kMaxSpeed')?.kind).toBe('constant');
        expect(idx.lookup('Mode', 'motor')?.qualifiedName).toBe('motor::Mode');
        expect(idx.lookup('Mode')).toBeUndefined();
        // unscoped enumerators are visible in the enclosing namespace and in the enum
        expect(idx.lookup('motor::kStall')?.qualifiedName).toBe('motor::ErrorFlags::kStall');
        expect(idx.lookup('motor::ErrorFlags::kStall')?.qualifiedName).toBe('motor::ErrorFlags::kStall');
        // scoped enumerators are not
        expect(idx.lookup('motor::Fast')).toBeUndefined();
        // nested classes and their members
        expect(idx.lookup('app::control::Config::State::Error')?.kind).toBe('enumerator');
        expect(idx.lookup('app::control::Controller::kQueueSize')?.kind).toBe('constant');
        // from a nested scope outwards
        expect(idx.lookup('kMaxSpeed', 'motor::Limits')?.qualifiedName).toBe('motor::kMaxSpeed');
        expect(idx.lookup('State', 'app::control::Config::Timing')?.qualifiedName).toBe('app::control::Config::State');
        // namespace alias, inline namespace, anonymous namespace
        expect(idx.lookup('app::control::m::Mode::Boost')?.qualifiedName).toBe('motor::Mode::Boost');
        expect(idx.lookup('app::control::Protocol')?.qualifiedName).toBe('app::control::v2::Protocol');
        expect(idx.lookup('app::control::v2::Protocol::Modbus')?.kind).toBe('enumerator');
        expect(idx.lookup('app::control::kHidden')?.kind).toBe('constant');
        // C declarations in extern "C" are in the enclosing namespace
        expect(idx.lookup('app::control::LED_BLINK')?.kind).toBe('enumerator');
        expect(idx.lookup('HAL_OK')?.kind).toBe('enumerator');
        // templates are not extracted
        expect(idx.lookup('app::control::RingBuffer')).toBeUndefined();
        expect(idx.lookupAll('motor').length).toBe(1);
        expect(idx.lookupAll('app::control').length).toBe(1);
    });

    test('using directives and aliases as qualifiers', () => {
        const other = index(`
            namespace lib { enum class Color { Red, Green }; constexpr int kLimit = 3; }
            namespace app {
                using namespace lib;
                using Colour = lib::Color;
                using lib::kLimit;
                constexpr Color kFavorite = Colour::Green;
                constexpr int kTwice = kLimit * 2;
            }
        `);
        expect(other.lookup('Color', 'app')?.qualifiedName).toBe('lib::Color');
        expect(other.lookup('app::Colour::Red')?.qualifiedName).toBe('lib::Color::Red');
        expect(value(other, 'app::kFavorite')).toBe(1n);
        expect(value(other, 'app::kTwice')).toBe(6n);
        expect(value(other, 'app::kLimit')).toBe(3n);
    });

    test('members of scopes (for completion)', () => {
        expect(idx.members('motor::Mode').map(d => d.name)).toEqual(['Off', 'Slow', 'Fast', 'Boost']);
        expect(idx.members('motor').map(d => d.name)).toContain('Position');
        expect(idx.members('app::control').map(d => d.name)).toEqual(expect.arrayContaining(['Config', 'Protocol', 'kHidden', 'v2']));
        expect(idx.members('motor::Limits').map(d => d.name)).toEqual(['kVersion']);
        expect(idx.members('unknown')).toEqual([]);
    });

    test('resolution of type names to canonical types', () => {
        const t = (name: string, scope?: string) => {
            const type = idx.resolveType(name, scope);
            return type ? describeCppType(type) : undefined;
        };
        expect(t('std::uint8_t')).toBe('integer (u8)');
        expect(t('uint64_t')).toBe('integer (u64)');
        expect(t('int_least16_t')).toBe('integer (i16)');
        expect(t('std::size_t')).toBe('integer (u64)');
        expect(t('unsigned')).toBe('integer (u32)');
        expect(t('long long int')).toBe('integer (i64)');
        expect(t('signed char')).toBe('integer (i8)');
        expect(t('char')).toBe('integer (i8, character)');
        expect(t('bool')).toBe('boolean');
        expect(t('float')).toBe('real (f32)');
        expect(t('double')).toBe('real (f64)');
        expect(t('std::string')).toBe('string');
        expect(t('std::string_view')).toBe('string');
        expect(t('const char*')).toBe('string');
        expect(t('char*')).toBe('unsupported (pointer type)');
        expect(t('int&')).toBe('unsupported (reference type)');
        expect(t('void')).toBe('unsupported (void)');
        expect(t('std::vector<int>')).toBe('unsupported (unsupported library type \'std::vector<int>\')');
        expect(t('std::array<motor::Rpm, 3>')).toBe('array of 3 integer (i32)');
        expect(t('motor::Rpm')).toBe('integer (i32)');
        expect(t('Rpm', 'motor')).toBe('integer (i32)');
        expect(t('motor::Celsius')).toBe('real (f32)');
        expect(t('motor::Mode')).toBe('enum motor::Mode');
        expect(t('motor::Position')).toBe('struct motor::Position');
        expect(t('HAL_Frame_t')).toBe('struct HAL_Frame');
        expect(t('HAL_Callback')).toBe('unsupported (function pointer)');
        expect(t('HAL_Buffer')).toBe('array of 16 integer (u8)');
        expect(t('app::control::IntBuffer')).toBe('unsupported (unknown type \'RingBuffer<int, 8>\')');
        expect(t('app::control::m::Mode')).toBe('enum motor::Mode');
        expect(t('NoSuchType')).toBeUndefined();
        expect(t('motor::kMaxSpeed')).toBe('unsupported (\'motor::kMaxSpeed\' is not a type)');
        expect(t('not a type ((')).toBeUndefined();
    });

    test('enums from the fixtures', () => {
        const mode = enumType(idx, 'motor::Mode');
        expect(mode).toMatchObject({ cppName: 'motor::Mode', scoped: true, underlying: { kind: 'integer', bits: 8, signed: false } });
        expect(mode.enumerators.map(e => [e.name, e.value, e.declaration.doc])).toEqual([
            ['Off', 0n, 'motor is switched off'], ['Slow', 1n, 'reduced speed'], ['Fast', 10n, 'full speed'], ['Boost', 11n, 'temporary overdrive']
        ]);
        expect(mode.declaration.doc).toBe('Operating mode of the motor.');
        expect(enumerators(idx, 'motor::ErrorFlags')).toEqual({ kNoError: 0n, kOverCurrent: 1n, kOverTemperature: 2n, kStall: 4n, kAnyError: 7n });
        expect(enumerators(idx, 'motor::Direction')).toEqual({ Forward: 70n, Backward: 66n });
        expect(enumerators(idx, 'HAL_StatusTypeDef')).toEqual({ HAL_OK: 0n, HAL_ERROR: 1n, HAL_BUSY: 2n, HAL_TIMEOUT: 3n });
        expect(enumerators(idx, 'app::control::led_state_t')).toEqual({ LED_OFF: 0n, LED_ON: 1n, LED_BLINK: 5n });
        expect(enumerators(idx, 'app::control::Config::State')).toEqual({ Idle: 0n, Running: 1n, Error: -1n });
    });

    test('structs: public fields with resolved types, bit-fields, arrays, defaults and nesting', () => {
        const position = structType(idx, 'motor::Position');
        expect(position.aggregate).toBe(true);
        expect(position.fields.map(f => [f.name, describeCppType(f.type), f.defaultValue, f.declaration.doc])).toEqual([
            ['x', 'integer (i32)', 0n, 'x coordinate'], ['y', 'integer (i32)', 0n, 'y coordinate'], ['z', 'integer (i32)', 0n, 'z coordinate']
        ]);
        const limits = structType(idx, 'motor::Limits');
        expect(limits.fields.map(f => [f.name, describeCppType(f.type), f.bitWidth, f.defaultValue])).toEqual([
            ['maxSpeed', 'integer (i32)', undefined, 6000n],
            ['maxTemperature', 'real (f32)', undefined, 85.5],
            ['home', 'struct motor::Position', undefined, { x: 1n, y: 2n, z: 3n }],
            ['startMode', 'enum motor::Mode', undefined, 0n],
            ['gains', 'array of 3 integer (u8)', undefined, [0n, 0n, 0n]],
            ['calibration', 'array of 2 integer (u16)', undefined, [10n, 20n]],
            ['enabled', 'boolean', 1, undefined],
            ['reserved', 'integer (u8)', 7, undefined]
        ]);
        expect(limits.aggregate).toBe(true);
        const config = structType(idx, 'app::control::Config');
        expect(config.fields.map(f => [f.name, describeCppType(f.type), f.defaultValue])).toEqual([
            ['mode', 'enum motor::Mode', 1n],
            ['targetSpeed', 'integer (i32)', 3000n],
            ['target', 'struct motor::Position', { x: 100n, y: -50n, z: 0n }],
            ['retries', 'integer (u8)', 3n],
            ['initialState', 'enum app::control::Config::State', 0n],
            ['timing', 'struct app::control::Config::Timing', undefined]
        ]);
        // default member initializers may use the preceding members
        const timing = structType(idx, 'app::control::Config::Timing');
        expect(timing.fields.map(f => f.defaultValue)).toEqual([10n, 1000n]);
        expect(idx.defaultValue(config)).toEqual({
            mode: 1n, targetSpeed: 3000n, target: { x: 100n, y: -50n, z: 0n }, retries: 3n, initialState: 0n,
            timing: { periodMs: 10n, timeoutMs: 1000n }
        });
        // classes with private data members and user constructors are not aggregates
        const controller = structType(idx, 'app::control::Controller');
        expect(controller.fields).toEqual([]);
        expect(controller.aggregate).toBe(false);
        // C structs with anonymous members, unions and pointers
        const frame = structType(idx, 'HAL_Frame_t');
        expect(frame.fields.map(f => [f.name, describeCppType(f.type)])).toEqual([
            ['id', 'integer (u8)'], ['length', 'integer (u16)'], ['version', 'struct HAL_Frame::(anonymous)'], ['payload', 'unsupported (union)']
        ]);
        const adc = structType(idx, 'HAL_ADC_Config');
        expect(adc.fields.map(f => [f.name, describeCppType(f.type)])).toEqual([
            ['Channel', 'integer (u32)'], ['Prescaler', 'integer (u32)'], ['Reg', 'unsupported (pointer type)'], ['Data', 'array of 4 integer (u8)']
        ]);
    });

    test('inherited fields', () => {
        const other = index(`
            struct Base { int a = 1; };
            struct Derived : Base { int b = 2; };
            struct Private : private Base { int c; };
            struct Derived2 : public Derived { static constexpr int kC = a_constant; int d; };
            constexpr int a_constant = 3;
        `, { allowDiagnostics: true });
        const derived = structType(other, 'Derived2');
        expect(derived.fields.map(f => [f.name, f.inheritedFrom])).toEqual([['a', 'Base'], ['b', 'Derived'], ['d', undefined]]);
        expect(derived.aggregate).toBe(true);
        expect(structType(other, 'Private').aggregate).toBe(false);
        expect(other.lookup('Derived2::a')).toBeUndefined();
    });

    test('constants from the fixtures', () => {
        const constants: Record<string, [string, unknown]> = {};
        for (const d of idx.allDeclarations()) {
            if (d.kind === 'constant') {
                const info = idx.constant(d)!;
                constants[d.qualifiedName] = [describeCppType(info.type), info.value];
            }
        }
        expect(constants).toEqual({
            'motor::kMaxSpeed': ['integer (i32)', 6000n],
            'motor::kMinSpeed': ['integer (i32)', -6000n],
            'motor::kMaxTemperature': ['real (f32)', 85.5],
            'motor::kGearRatio': ['real (f64)', 1 / 3],
            'motor::kHasEncoder': ['boolean', true],
            'motor::kName': ['string', 'motor'],
            'motor::kVendor': ['string', 'ACME'],
            'motor::kVersion': ['string', '1.2.3'],
            'motor::kAxes': ['integer (u64)', 3n],
            'motor::kDefaultMode': ['enum motor::Mode', 1n],
            'motor::kAllOnes': ['integer (u32)', 4294967295n],
            'motor::kMask': ['integer (u8)', 15n],
            'motor::Limits::kVersion': ['integer (i32)', 2n],
            'motor::kOrigin': ['struct motor::Position', { x: 0n, y: 0n, z: 0n }],
            'motor::kParkPosition': ['struct motor::Position', { x: 100n, y: -50n, z: 0n }],
            'motor::detail::kInternal': ['integer (i32)', 42n],
            'app::control::Controller::kQueueSize': ['integer (u32)', 16n],
            'app::control::kHidden': ['integer (i32)', 7n],
            'app::control::kDefaultProtocol': ['enum app::control::v2::Protocol', 2n],
            'app::control::kDerived': ['integer (i32)', 42n],
            'app::control::kNotConstant': ['integer (i32)', undefined],
            'hal_version': ['integer (i32)', 519n],
            'hal_magic': ['integer (u64)', 3735928559n],
            'hal_letter': ['integer (i8, character)', 120n]
        });
        expect(idx.constant('app::control::kNotConstant')?.error).toBe('function calls are not supported in constant expressions');
        expect(idx.constant('motor::Mode::Fast')).toMatchObject({ value: 10n, type: { kind: 'enum', cppName: 'motor::Mode' } });
        expect(idx.constant('motor::Mode')).toBeUndefined();
    });

    test('evaluation of expressions in the context of the headers', () => {
        expect(idx.evaluate('motor::kMaxSpeed * 2')).toMatchObject({ value: 12000n, type: { kind: 'integer', bits: 32, signed: true } });
        expect(idx.evaluate('kMaxSpeed + kMinSpeed', 'motor')).toMatchObject({ value: 0n });
        expect(idx.evaluate('motor::Mode::Fast')).toMatchObject({ value: 10n, type: { kind: 'enum', cppName: 'motor::Mode' } });
        expect(idx.evaluate('motor::kParkPosition')).toMatchObject({ value: { x: 100n, y: -50n, z: 0n } });
        expect(idx.evaluate('motor::kGearRatio * 3')).toMatchObject({ value: 1, type: { kind: 'real', bits: 64 } });
        expect(idx.evaluate('motor::kMaxSpeed > 100 && motor::kHasEncoder')).toMatchObject({ value: true, type: { kind: 'boolean' } });
        expect(idx.evaluate('motor::kUnknown')).toEqual({ error: "unknown name 'motor::kUnknown'" });
        expect(idx.evaluate('motor::Mode')).toEqual({ error: "'motor::Mode' is not a constant" });
    });

    test('struct and array constants with aggregate initialization', () => {
        const other = index(`
            struct P { int x; int y = 5; float f = 1.5f; };
            struct Line { P a; P b{1, 2}; };
            constexpr P kP1 = {1};
            constexpr P kP2{.y = 7};
            constexpr P kP3 = P{3, 4, 0.5f};
            constexpr Line kLine{{9, 9}};
            constexpr int kTable[] = {1, 2, 3};
            constexpr int kPadded[4] = {1};
            constexpr std::array<std::uint8_t, 3> kStdArray{{1, 2, 3}};
            constexpr P kCopy = kP1;
        `);
        expect(value(other, 'kP1')).toEqual({ x: 1n, y: 5n, f: 1.5 });
        expect(value(other, 'kP2')).toEqual({ x: 0n, y: 7n, f: 1.5 });
        expect(value(other, 'kP3')).toEqual({ x: 3n, y: 4n, f: 0.5 });
        expect(value(other, 'kLine')).toEqual({ a: { x: 9n, y: 9n, f: 1.5 }, b: { x: 1n, y: 2n, f: 1.5 } });
        expect(value(other, 'kTable')).toEqual([1n, 2n, 3n]);
        expect(value(other, 'kPadded')).toEqual([1n, 0n, 0n, 0n]);
        expect(value(other, 'kStdArray')).toEqual([1n, 2n, 3n]);
        expect(value(other, 'kCopy')).toEqual({ x: 1n, y: 5n, f: 1.5 });
    });

    test('implicit conversions of constants and their diagnostics', () => {
        const other = index(`
            constexpr std::uint8_t kWrapped = 300;
            constexpr int kTruncated = 2.7;
            constexpr double kWidened = 3;
            constexpr bool kFlag = 2;
            enum class Mode { A, B };
            constexpr Mode kMode = 1;
            constexpr int kModeValue = Mode::B;
        `, { allowDiagnostics: true });
        expect(other.constant('kWrapped')?.value).toBe(44n);
        expect(other.constant('kTruncated')?.value).toBe(2n);
        expect(other.constant('kWidened')?.value).toBe(3);
        expect(other.constant('kFlag')?.value).toBe(true);
        expect(other.constant('kMode')?.error).toBe("a integer cannot be implicitly converted to the enum 'Mode'");
        expect(other.constant('kModeValue')?.error).toBe("a value of the scoped enum 'Mode' cannot be implicitly converted to 'int'");
        expect(other.diagnostics.map(d => `${d.range.start.line + 1}: ${d.message}`)).toEqual([
            "2: kWrapped: value 300 does not fit into 'std::uint8_t' (converted to 44)",
            "3: kTruncated: conversion from floating point to 'int' truncates the value",
            "7: cannot evaluate the constant 'kMode': a integer cannot be implicitly converted to the enum 'Mode'",
            "8: cannot evaluate the constant 'kModeValue': a value of the scoped enum 'Mode' cannot be implicitly converted to 'int'"
        ]);
    });

    test('constants across headers and in dependency order', () => {
        const other = CppTypeIndex.fromSources([
            { fileName: 'b.h', text: '#include "a.h"\nnamespace cfg { constexpr int kDouble = kBase * 2; enum class E { X = kBase }; }' },
            { fileName: 'a.h', text: 'namespace cfg { constexpr int kBase = 21; }' }
        ]);
        expect(other.diagnostics).toEqual([]);
        expect(other.constant('cfg::kDouble')?.value).toBe(42n);
        expect(other.constant('cfg::E::X')?.value).toBe(21n);
        expect(other.lookupAll('cfg').map(d => d.fileName)).toEqual(['b.h', 'a.h']);
    });

    test('cycles and duplicates are diagnosed, not endless', () => {
        const other = CppTypeIndex.fromSources([
            { fileName: 'a.h', text: 'constexpr int kA = kB; constexpr int kB = kA; using T1 = T2; using T2 = T1; struct S { int x; };' },
            { fileName: 'b.h', text: 'struct S { int y; };' }
        ]);
        expect(other.constant('kA')?.value).toBeUndefined();
        expect(other.resolveType('T1')?.kind).toBe('unsupported');
        expect(structType(other, 'S').fields.map(f => f.name)).toEqual(['x']);
        expect(other.diagnostics.map(d => `${d.fileName}: ${d.message}`)).toEqual([
            "a.h: cannot evaluate the constant 'kB': 'kA' depends on itself",
            "a.h: cannot evaluate the constant 'kA': the value of 'kB' is unknown ('kA' depends on itself)",
            "b.h: 'S' is also declared in a.h; the first declaration is used"
        ]);
    });

    test('the report is JSON serializable', () => {
        const report = cppHeaderReport(idx) as { headers: Array<{ fileName: string, declarations: unknown[] }>, diagnostics: string[] };
        const json = JSON.stringify(report);
        expect(report.headers.map(h => h.fileName)).toEqual(['motor_types.h', 'controller.hpp', 'legacy_c.h']);
        expect(json).toContain('"qualifiedName":"motor::Mode"');
        expect(json).toContain('"enumerators":[{"name":"Off","value":0,"doc":"motor is switched off"}');
        expect(report.diagnostics).toHaveLength(1);
    });
});

describe('real-world headers', () => {
    /** Candidate headers of this machine; missing ones are skipped. */
    const REAL_HEADERS = [
        '/usr/include/stdint.h',
        '/usr/include/elf.h',
        '/usr/include/c++/13/limits',
        '/usr/include/c++/13/bits/ios_base.h',
        '/usr/include/c++/13/bits/stl_vector.h',
        '/usr/include/c++/13/bits/chrono.h',
        '/usr/include/c++/13/type_traits',
        '/usr/include/c++/13/bits/stl_algo.h',
        '/usr/include/c++/13/variant',
        path.resolve(__dirname, '../../../node_modules/node-addon-api/napi.h')
    ].filter(file => fs.existsSync(file));

    test.each(REAL_HEADERS)('%s: no crash, bounded time', file => {
        const text = fs.readFileSync(file, 'utf-8');
        const start = performance.now();
        const idx = CppTypeIndex.fromSources([{ fileName: file, text }]);
        const diagnostics = idx.diagnostics;
        idx.resolveAll();
        JSON.stringify(cppHeaderReport(idx));
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(5000);
        expect(diagnostics.every(d => d.range.start.line >= 0)).toBe(true);
    });

    const has = (file: string) => fs.existsSync(file);

    test.skipIf(!has('/usr/include/stdint.h'))('stdint.h: fixed width typedefs', () => {
        const idx = CppTypeIndex.fromSources([{ fileName: 'stdint.h', text: fs.readFileSync('/usr/include/stdint.h', 'utf-8') }]);
        expect(idx.resolveType('int_least8_t')).toMatchObject({ kind: 'integer', bits: 8, signed: true });
        expect(idx.resolveType('uint_least64_t')).toMatchObject({ kind: 'integer', bits: 64, signed: false });
    });

    test.skipIf(!has('/usr/include/elf.h'))('elf.h: C structs with typedef names', () => {
        const idx = CppTypeIndex.fromSources([{ fileName: 'elf.h', text: fs.readFileSync('/usr/include/elf.h', 'utf-8') }]);
        const ehdr = idx.resolveType('Elf32_Ehdr');
        expect(ehdr?.kind).toBe('struct');
        const fields = (ehdr as CppStructType).fields;
        expect(fields[0].name).toBe('e_ident');
        expect(fields[0].type.kind).toBe('array');
        expect(fields.length).toBe(14);
    });

    test.skipIf(!has('/usr/include/c++/13/bits/ios_base.h'))('ios_base.h: enums behind macros and nested class constants', () => {
        const idx = CppTypeIndex.fromSources([{ fileName: 'ios_base.h', text: fs.readFileSync('/usr/include/c++/13/bits/ios_base.h', 'utf-8') }]);
        expect(idx.resolveType('std::ios_base::fmtflags')?.kind).toBe('enum');
        expect(idx.constant('std::ios_base::hex')?.value).toBe(8n);
        expect(idx.constant('std::ios_base::basefield')?.value).toBe(74n);
        expect(idx.constant('std::_Ios_Iostate::_S_ios_iostate_max')?.value).toBe(2147483647n);
        expect(enumType(idx, 'std::io_errc').scoped).toBe(true);
    });

    test.skipIf(!has('/usr/include/c++/13/limits'))('<limits>: float_denorm_style and friends', () => {
        const idx = CppTypeIndex.fromSources([{ fileName: 'limits', text: fs.readFileSync('/usr/include/c++/13/limits', 'utf-8') }]);
        expect(enumerators(idx, 'std::float_round_style')).toMatchObject({ round_indeterminate: -1n, round_toward_zero: 0n });
    });

    const napi = path.resolve(__dirname, '../../../node_modules/node-addon-api/napi.h');
    test.skipIf(!has(napi))('napi.h: a large C++ wrapper library, with predefined macros', () => {
        const text = fs.readFileSync(napi, 'utf-8');
        const idx = CppTypeIndex.fromSources([{ fileName: 'napi.h', text }], { defines: { NAPI_VERSION: '8', NAPI_DISABLE_CPP_EXCEPTIONS: '' } });
        const classes = idx.allDeclarations().filter((d): d is CppRecord => d.kind === 'record');
        expect(classes.length).toBeGreaterThan(30);
        expect(idx.lookup('Napi::ThreadSafeFunction')?.kind).toBe('record');
        expect(idx.lookup('Napi::Object')?.kind).toBe('record');
        expect(idx.lookup('Napi::TypedArrayOf')).toBeUndefined();  // a template
        expect(idx.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    });

    test.skipIf(!has('/usr/include/c++/13/bits'))('all libstdc++ internal headers: no crash, bounded time', () => {
        const dir = '/usr/include/c++/13/bits';
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.h')).map(f => path.join(dir, f));
        const start = performance.now();
        let declarations = 0;
        for (const file of files) {
            const idx = CppTypeIndex.fromSources([{ fileName: file, text: fs.readFileSync(file, 'utf-8') }]);
            idx.resolveAll();
            declarations += idx.allDeclarations().length;
        }
        const elapsed = performance.now() - start;
        expect(files.length).toBeGreaterThan(50);
        expect(declarations).toBeGreaterThan(500);
        expect(elapsed).toBeLessThan(20000);
    });
});

describe('robustness', () => {
    test('random fragments of the fixtures never throw', () => {
        const text = fixture('controller.hpp').text + fixture('motor_types.h').text + fixture('legacy_c.h').text;
        let seed = 42;
        const random = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        for (let i = 0; i < 300; i++) {
            const start = Math.floor(random() * text.length);
            const end = start + Math.floor(random() * 2000);
            const idx = CppTypeIndex.fromSources([{ fileName: 'fragment.h', text: text.slice(start, end) }]);
            expect(() => idx.diagnostics).not.toThrow();
        }
    });

    test('deeply nested and pathological input terminates', () => {
        const nested = 'namespace a {'.repeat(200) + 'enum E { X };' + '}'.repeat(200);
        expect(CppTypeIndex.fromSources([{ fileName: 'n.h', text: nested }]).lookup('a::'.repeat(200) + 'E::X')?.kind).toBe('enumerator');
        const parens = 'constexpr int k = ' + '('.repeat(500) + '1' + ')'.repeat(500) + ';';
        expect(CppTypeIndex.fromSources([{ fileName: 'p.h', text: parens }]).constant('k')?.value).toBe(1n);
        const recursiveMacro = '#define A B\n#define B A\nconstexpr int A = 1;';
        expect(() => parseCppHeader(recursiveMacro, 'm.h')).not.toThrow();
        expect(() => parseCppHeader('}}}{{{((([[[', 'x.h')).not.toThrow();
        expect(() => parseCppHeader('', 'empty.h')).not.toThrow();
    });

    test('results are deterministic', () => {
        const sources = [fixture('motor_types.h'), fixture('controller.hpp'), fixture('legacy_c.h')];
        const a = JSON.stringify(cppHeaderReport(CppTypeIndex.fromSources(sources)));
        const b = JSON.stringify(cppHeaderReport(CppTypeIndex.fromSources(sources)));
        expect(a).toBe(b);
    });

    test('resolved types carry spellings usable in generated code', () => {
        const idx = CppTypeIndex.fromSources([fixture('motor_types.h')]);
        const cppNames = (type: CppResolvedType | undefined) => type?.cppName;
        expect(cppNames(idx.resolveType('motor::Mode'))).toBe('motor::Mode');
        expect(cppNames(idx.resolveType('motor::Rpm'))).toBe('std::int32_t');
        expect(cppNames(idx.resolveType('motor::Position'))).toBe('motor::Position');
    });
});
