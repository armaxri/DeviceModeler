# C++ integration

Status: **implemented**. The C++ header analyzer (`packages/language/src/cpp-header/`) and the language
integration (grammar, linking, type system, validation, interpreter, unit tests, scenarios, C++ generator,
language server, web app, VS Code webview) are done. This note describes the analyzer, the supported C++
subset and the integration with the decisions taken (§4); the user documentation is in the
[language documentation](language.md#cc-header-imports), the semantics in [semantics.md §10](semantics.md).

## 1. Goal

State machine models import C++ headers of the application and use the **types and constants**
declared there, both in the definition section and in expressions:

```
statemachine MotorControl {
    namespace app.control
    import "motor_types.h"

    interface:
        in event setMode : motor::Mode
        in event moveTo : motor::Position
        var mode : motor::Mode = motor::Mode::Off
        var target : motor::Position = motor::kParkPosition
        var speed : motor::Rpm = 0
        operation driveTo(pos : motor::Position) : boolean

    [*] -> Idle
    state Idle
    state Moving
    Idle -> Moving : moveTo [valueof(moveTo).x <= motor::kMaxSpeed] / target = valueof(moveTo)
    Moving -> Idle : setMode [valueof(setMode) == motor::Mode::Off]
}
```

Operations stay callbacks: functions and classes with methods in the headers are **not** used. (Member
functions and data members of the generated class itself are declared in the model, in the
[C++ class sections](language.md#c-class-sections) `public:` / `protected:` / `private:`.)
The simulator understands the imported types and constants; the C++ generator `#include`s the
headers and uses the types directly.

## 2. The analyzer

Pure TypeScript without Node dependencies (it runs in the web app and in the VS Code extension,
which bundle the language package). Exported from `hsm-language`:

| file | content |
| --- | --- |
| `model.ts` | all public types (syntactic model, resolved model, diagnostics, options) |
| `lexer.ts` | tokenizer (comments, doc comments, raw strings, digit separators, directives) |
| `preprocessor.ts` | `#if`/`#ifdef`/… evaluation, `#define` expansion, `#include` recording |
| `syntax.ts` | token cursor, parsers for names, type-ids and constant expressions |
| `parser.ts` | tolerant declaration parser: `parseCppHeader` |
| `evaluator.ts` | constant expression evaluation with C++ integer semantics |
| `type-index.ts` | `CppTypeIndex`: lookup, type resolution, classification, constant values |
| `report.ts` | JSON report (`hsm cpp-header`), `describeCppType` |

### 2.1 API

```ts
// one header -> syntactic model (never throws)
function parseCppHeader(text: string, fileName: string, options?: CppParseOptions): CppHeader;
interface CppParseOptions { defines?: Record<string, string> }        // predefined macros
interface CppHeader {
    fileName: string;
    declarations: CppDeclaration[];      // tree: namespaces contain their members
    includes: CppInclude[];              // { path, system, range } of active #includes
    macros: CppMacro[];                  // #defines of the header
    diagnostics: CppDiagnostic[];        // { severity, message, fileName, range }
}
type CppDeclaration = CppNamespace | CppNamespaceAlias | CppUsingDirective | CppEnum | CppEnumerator
    | CppRecord | CppField | CppAlias | CppConstant;
// common: name, qualifiedName ('motor::Mode::Fast'), scope, fileName, range, nameRange, doc?
function forEachCppDeclaration(declarations, action): void;

// several headers -> resolved model (lazy, memoized, deterministic)
class CppTypeIndex {
    constructor(headers: CppHeader[], options?: { dataModel?: Partial<CppDataModel> });
    static fromSources(sources: { fileName, text }[], options?: CppParseOptions & CppTypeIndexOptions): CppTypeIndex;
    readonly headers: CppHeader[];
    readonly dataModel: CppDataModel;           // { longBits: 64, pointerBits: 64, charSigned: true }
    lookup(name: string | CppQualifiedName, scope?: string): CppDeclaration | undefined;
    lookupAll(name: string | CppQualifiedName, scope?: string): CppDeclaration[];
    members(scope: string): CppDeclaration[];  // completion after 'motor::'
    scopeOf(declaration: CppDeclaration): string;
    allDeclarations(): CppDeclaration[];
    resolveType(type: string, scope?: string): CppResolvedType | undefined;   // 'motor::Mode', 'uint8_t', 'const char*'
    resolveTypeRef(ref: CppTypeRef, scope?: string): CppResolvedType;
    typeOf(declaration: CppEnum | CppRecord | CppAlias): CppResolvedType;
    constant(nameOrDeclaration: string | CppConstant | CppEnumerator, scope?: string): CppConstantInfo | undefined;
    evaluate(expression: string, scope?: string): CppEvaluationResult;       // 'motor::kMaxSpeed * 2'
    defaultValue(type: CppResolvedType): CppValue | undefined;                // value of T{}
    resolveAll(): void;
    readonly diagnostics: CppDiagnostic[];     // parse + resolution diagnostics of all headers
}
interface CppConstantInfo { declaration; type: CppResolvedType; value?: CppValue; error?: string }

type CppResolvedType =
    | { kind: 'integer', cppName, bits: 8 | 16 | 32 | 64 | 128, signed, character? }
    | { kind: 'real', cppName, bits: 32 | 64 }
    | { kind: 'boolean', cppName: 'bool' }
    | { kind: 'string', cppName }                               // std::string, std::string_view, const char*
    | { kind: 'enum', cppName, declaration, scoped, underlying: CppIntegerType, enumerators: { name, qualifiedName, value: bigint, valid, declaration }[] }
    | { kind: 'struct', cppName, declaration, fields: { name, type, declaration, inheritedFrom?, bitWidth?, defaultValue? }[], aggregate }
    | { kind: 'array', cppName, element, length? }              // T[N], std::array<T, N>
    | { kind: 'unsupported', cppName, reason };                 // pointers, unions, unknown types, ...

type CppValue = bigint | number | boolean | string | readonly CppValue[] | { [field: string]: CppValue };

function describeCppType(type: CppResolvedType): string;       // 'integer (u8)', 'enum motor::Mode', ...
function cppHeaderReport(index: CppTypeIndex): unknown;          // JSON of `hsm cpp-header`
```

Values use the representation of the HSM interpreter (`simulation/values.ts`): integers (and enum
values, i.e. the numeric value of the enumerator) are `bigint`, reals are `number`. Structs are
plain objects in field order, arrays are arrays.

Positions are 0-based like LSP ranges; every declaration has `fileName`, `range` and `nameRange`
for go-to-definition, and `doc` for hovers.

### 2.2 Debugging

```
hsm cpp-header motor_types.h controller.hpp
```

prints the extracted and resolved model (declarations with resolved types, enumerator values,
constant values, includes, macros, diagnostics) as JSON.

## 3. Supported C++ subset

Headers of C++11 to C++20 (and C headers). Everything outside the subset is **skipped** without
diagnostics; parsing continues after the skipped construct.

| construct | support |
| --- | --- |
| comments | `//`, `/* */`; doc comments `///`, `//!`, `/** */`, `/*! */` before, `///<`, `//!<`, `/**<` after an entity (Doxygen `@brief` is removed) |
| preprocessor | `#if`, `#ifdef`, `#ifndef`, `#elif`, `#elifdef`, `#elifndef`, `#else`, `#endif` are evaluated (see 3.1); `#define`/`#undef` (object-like and function-like, `#`, `##`, `__VA_ARGS__`, `__VA_OPT__`) are expanded; `#include` is recorded; `#pragma`, `#error` (warning), `#line` |
| namespaces | `namespace a { }`, `namespace a::b { }`, `inline namespace`, anonymous namespaces, `namespace x = a::b;`, `using namespace a;` |
| `extern "C" { }` | contents belong to the enclosing namespace |
| enums | `enum`, `enum class`, `enum struct`, anonymous, `typedef enum { } Name;`, `typedef enum Tag { } Name;`, fixed underlying type (`: std::uint8_t`), explicit values as constant expressions, attributes on enums and enumerators, enums in namespaces and classes, opaque declarations `enum class E : int;` (merged with the definition), out-of-line definitions of nested enums `enum class Outer::E : int { };`, C++20 `using enum E;` (see §3.4) |
| classes | `struct`, `class` (and `union`, classified as unsupported) with data members (all access levels recorded, public ones used), bit-fields, arrays, default member initializers (`= x`, `{x}`), nested classes / enums / aliases, `static constexpr` / `static const` members, base classes, anonymous `struct { } member;`, C idiom `typedef struct { } Name;` |
| aliases | `typedef` (also several declarators, pointer / array / function pointer declarators), `using X = T;`, using-declarations `using ns::X;` |
| constants | `constexpr`, `const`, `static const(expr)`, `inline constexpr`, `extern const` (no value), initializers `= x`, `{x}`, `(x)`; `auto`; aggregate initialization of structs and arrays (positional and designated `.x = 1`), `constexpr char k[] = "…"` |
| types | fundamental types (all spellings, e.g. `unsigned long long int`, `__int128`), `<cstdint>` / `<cstddef>` typedefs with or without `std::` (`int32_t`, `uint_least8_t`, `size_t`, …), `bool`, `float`, `double`, `long double`, `char`, `char8/16/32_t`, `wchar_t`, `std::string`, `std::string_view`, `const char*`, `std::array<T, N>`, `std::byte` |
| skipped | functions (declarations and definitions), methods, constructors, operators, conversion functions, templates (classes, functions, aliases, variables, specializations), `static_assert`, `friend`, lambdas, attributes `[[…]]`, `__attribute__((…))`, `__declspec(…)`, `alignas(…)`, `asm`, concepts, modules, non-const variables, macro invocations on their own line (`Q_OBJECT`, `DECLARE_X(y)`), unknown all-caps macros used as specifiers (`API_EXPORT int f();`, `namespace std _GLIBCXX_VISIBILITY(default) {`) |

### 3.1 Preprocessor

Headers are analyzed one by one; macros of included headers are unknown. Conditions are evaluated
with the macros defined so far in the header, the predefined macros (`__cplusplus` = `201703L`,
`__CHAR_BIT__`, `__INT_MAX__`, `__SIZEOF_INT__`, … – no compiler identification macros like
`__GNUC__`) and `CppParseOptions.defines`. Undefined identifiers are `0` (as in C++),
`__has_include(…)`, `__has_cpp_attribute(…)` etc. are `0`. A condition that cannot be evaluated
(e.g. an undefined function-like macro) is reported as a warning and treated as false.

Consequence: a header whose declarations depend on configuration macros defined in other headers
(`#if CONFIG_USE_CAN`) is analyzed with the macro undefined, unless it is passed in `defines`
(`headers.defines` of `hsm.gen.json`, `-D`, `hsm.headers.defines`, see §4.7).

### 3.2 Constant expressions

Supported: integer, floating, character (`'a'`, `u8'a'`, `L'a'`, escapes), string (adjacent
literals concatenated), `true`/`false` literals; unary `+ - ! ~`; binary `* / % + - << >> < <= > >=
== != & ^ | && ||` (also `and`, `or`, `not`, …); `?:`; `static_cast<T>(x)`, `(T)x`, `T(x)`, `T{x}`;
`sizeof(T)` / `alignof(T)` for scalar types and arrays of them; `std::numeric_limits<T>::max()`,
`min()`, `lowest()`, `epsilon()`; names of constants and enumerators (earlier ones in the same enum,
constants of other headers); macros.

The semantics are those of C++: integers carry their type (width, signedness), the integral
promotions and usual arithmetic conversions apply and unsigned results wrap around (`0u - 1` is
`4294967295`, `(0u - 1) / 2` is `2147483647`); shifts follow C++20 (`1 << 31` is `-2147483648`,
`-16 >> 2` is `-4`); integer literal types follow the suffix and value rules; division truncates
toward zero (`-7 / 2` is `-3`, `-7 % 2` is `-1`). Division by zero, signed overflow
(`2147483647 + 1`), shift counts out of range, function calls, `nullptr`, member access and
arithmetic on scoped enums without a cast are errors (they are not constant expressions or not
supported). Implicit conversions of
constants and default member initializers wrap with a warning if the value changes. Default member
initializers may use the preceding members (`int b = a * 2;`).

The widths of `long`, `size_t` etc. depend on the target: `CppTypeIndex` uses LP64 by default
(64-bit `long`, as on Linux x86-64 / AArch64), `dataModel: { longBits: 32, pointerBits: 32 }` for
32-bit targets like ARM Cortex-M. `int_fastN_t` are assumed to have N bits. `int` is 32 bit.

### 3.3 Limitations

- No template instantiation: `RingBuffer<int, 8>` or template aliases are `unsupported (unknown type)`.
  `std::array` is the only supported template.
- No overload resolution, no `constexpr` function evaluation (`square(3)` is not evaluated).
- Headers are independent: macros of one header do not affect another; the index merges all
  namespaces. Duplicate definitions (same qualified name in two headers) are reported, the first wins.
- Unions, pointers (except `const char*`), references, function pointers, `auto` members, `void`,
  standard containers other than `std::string` / `std::string_view` / `std::array` are
  `unsupported` (with a reason).
- Out-of-line definitions of static members (`const int X::k = 5;` in a header) are not linked to
  the declaration.
- Header-local macros that expand to declarations across several lines are expanded, but macros
  producing unbalanced braces may confuse the parser (it recovers at the next declaration).
- `sizeof` of classes is unknown (layout and padding are not computed).

### 3.4 Enums

| form | example | type in models | enumerators in models |
| --- | --- | --- | --- |
| unscoped | `enum Color { Red, Green = 2, Blue };` | `Color` | `::Red`, `::Color::Red` (`ns::Red`, `ns::Color::Red` in a namespace) |
| scoped | `enum class Mode { Off, On };`, `enum struct …` | `Mode` | `Mode::Off` |
| fixed underlying type | `enum class Key : std::uint8_t { … };`, `enum Flags : int { … };` | `Key` | as above |
| C style | `typedef enum { LED_OFF, LED_ON } led_t;`, `typedef enum tag { … } name_t;` | `led_t`, `name_t` (also `tag`) | `::LED_OFF` (`led_t::LED_OFF` is accepted too) |
| in a namespace | `namespace app::io { enum class Level { Low }; }` | `app::io::Level` | `app::io::Level::Low` |
| in a class | `struct Sensor { enum State { Idle }; enum class Kind { T }; };` | `Sensor::State`, `Sensor::Kind` | `Sensor::Idle`, `Sensor::Kind::T` |
| opaque | `enum class Handle : std::uint32_t;` | `Handle` | no enumerators (values by cast: `7 as Handle`); a later definition (also in another header, also `enum class Outer::E : int { … }` out of line) provides them |
| anonymous | `enum { kSize = 8 };` | – | `::kSize` (an `integer`-like value) |
| `using enum` (C++20) | `namespace app { using enum ::Color; }` | – | also `app::Red` |

Values: explicit values are constant expressions (negative, hex, character literals `'a'`, earlier
enumerators `kExpr = kHex << 1 | 1`, enumerators of other enums with casts, macros); without value
the previous value + 1 (see §3.5). The values must fit into the fixed underlying type (error otherwise); without
fixed type the underlying type is deduced from the values (`int`, `unsigned int`, `long long`, …).
Comments and doc comments (`///`, `/** */` before, `///<` after an enumerator), `#if` branches, attributes
(`[[deprecated]]`, `__attribute__`) and a trailing comma inside the enumerator list are handled.

### 3.5 Enumerator values

The analyzer computes the value of every enumerator like a C++ compiler (`resolveEnum` in
`cpp-header/type-index.ts` with the constant expressions of §3.2). The tests check the values against
g++ and clang++ with `static_assert`s generated from the analyzer's values (`test/cpp-enum-values.test.ts`).
Example: [`examples/cpp-enum-values`](../examples/cpp-enum-values) (`sensor_codes.h`, a model and its
unit tests).

| rule | example | values |
| --- | --- | --- |
| implicit numbering: the first enumerator is 0, every other one the previous value + 1 (also after explicit and negative values) | `enum E { A, B, C = 10, D, X = -2, Y };` | 0, 1, 10, 11, -2, -1 |
| integer literals: decimal, hex, **octal** (leading `0`), binary, digit separators, suffixes | `010`, `0x1F`, `0b101`, `1'000`, `7u`, `8ull` | 8, 31, 5, 1000, 7, 8 |
| character literals (escapes, prefixes), `true` / `false` | `'A'`, `'\n'`, `'\x41'`, `'\0'`, `u8'a'`, `L'z'` | 65, 10, 65, 0, 97, 122 |
| operators with C++ precedence; `/` and `%` truncate toward zero | `1 << 2 + 1`, `1 \| 2 ^ 3 & 4`, `-7 / 2`, `-7 % 3`, `~0` | 8, 3, -3, -1, -1 |
| earlier enumerators, enumerators of other enums (qualified, with casts), constants, macros, `sizeof` of types | `C = A \| B`, `static_cast<int>(Other::V)`, `(int)x`, `kBase + 1`, `BIT(3)`, `sizeof(std::uint32_t)` | |
| unsigned arithmetic wraps around, signed overflow is an error | `enum class F : std::uint32_t { M = ~0u };` | 4294967295 |
| before the closing brace an enumerator has the type of its initializer | `enum { A = 0u - 1, B = A + 1 };` | 4294967295, 0 (`A` is an `unsigned int`) |
| 64-bit values are exact (`bigint`) | `enum class W : std::uint64_t { Big = ~0ull };` | 18446744073709551615 |

**Errors** as in C++ (the header would not compile): a value that does not fit into the fixed underlying
type (`enum class E : std::uint8_t { A = 255, B };` – `B` is 256; narrowing is ill-formed, also for `bool`),
signed overflow, division by zero, a floating point value, a value of a scoped enum without cast. Such an
enumerator keeps the computed value and is shown with the error (`CppResolvedEnumerator.error`).

**Unknown values**: a value that cannot be computed (an unknown macro `FOO(3)`, a function call, a
`constexpr` function, `sizeof` of an expression or a class, …) is **not guessed**: the enumerator is
marked as unknown (`valid: false`, `unknown: { expression, offset, reason }` of `CppResolvedEnumerator`),
the header import shows the error, and the implicit successors are unknown **relative** to it
(`FOO(3) + 1`, `FOO(3) + 2`); values computed from unknown ones (`B = A + 1`, constants) are unknown too.
In the simulation such enumerators get distinct placeholder values (which are never displayed).

**Display** (`enumeratorValueText`, `enumeratorValueMarkdown`, `enumeratorListItem` in `cpp-enums.ts`):
the value in decimal; in hexadecimal too for values greater than 9 and for flag-like initializers (bit
operators, hex or binary literals; negative ones in the two's complement of the underlying type); the
initializer if the value is derived from it; whether the value is implicit.

- Hover of an enumerator: the signature `sensor::Status::kReady = 3`, then ``value `3` (`0x3`) = `kPowered | kCalibrated` ``,
  ``value `11` (`0xB`) (implicit: `Measuring` + 1)`` or ``value unknown: `FOO(3) + 1` (implicit: `X` + 1)``.
- Hover of an enum: one line per enumerator, e.g. ``- `kReady = 3` (`0x3`, from `kPowered | kCalibrated`)``,
  ``- `kOctal = 8` (from `010`)``, ``- `Calibrating = 11` (`0xB`, implicit)``, ``- `Y`: value unknown (`FOO(3) + 1`)``.
- Completion: the detail `sensor::State = 11 (0xB, implicit)`, the label description `= 11 (0xB, implicit)`
  and, as documentation, the value sentence of the hover followed by the doc comment.
- The value editor of the web simulator (tooltip of the enumerators) and `hsm cpp-header` (`implicit`,
  `expression`, `unknown`, `error` of the enumerators).

Not supported (the value is unknown): `constexpr` functions and other function calls, macros that are not
defined in the header itself (or passed in `defines`, §3.1), `sizeof` of classes and expressions, templates
(`std::underlying_type_t<E>`), `std::numeric_limits` of enums. The data model decides the width of `long`
and `size_t` (§3.2); `char` is signed.

## 4. Language integration (implemented)

### 4.1 Syntax

- **Import**: `import "motor_types.h"` (several paths, also `import: "a.h" "b.hsm"`) at the beginning of the
  state machine body, like the imports of state machines. Headers are searched relative to the model, then
  in the include paths (§4.7). The headers they include (`#include "x.h"` relative to the including header,
  then in the include paths; `#include <x.h>` in the include paths; not found: ignored, e.g. `<cstdint>`) are
  analyzed too and **their declarations are visible** – as in C++, includes are transitive.
- **C++ names use `::`** and are written fully qualified from the global namespace:
  - types (grammar `TypeReference: name=TypeReferenceName`, `TypeReferenceName: '::'? ID (('.' | '::') ID)*`):
    `motor::Mode`, `::Color` or `Color` for the global namespace, `std::uint16_t`, `uint8_t`;
  - values (grammar `CppReference: name=CppName`, `CppName: '::' ID ('::' ID)* | ID '::' ID ('::' ID)*`, a
    primary expression): enumerators `motor::Mode::Fast` (of unscoped enums also `motor::kStall`), constants
    `motor::kMaxSpeed`, static members `motor::Limits::kVersion`. **Decision:** names of the global namespace
    need the leading `::` in expressions (`::HAL_OK`) – a plain identifier is an HSM declaration; the
    linking error of an unresolved all-caps / `k…` name suggests `::NAME`.
  - `::` does not clash with the `.`-qualified names of HSM (`Iface.x`, `motor.start`, `Active.Playing`).
- **Member and element access**: a postfix `AccessExpression` (`receiver.member`, `receiver[index]`) after
  primary expressions: `valueof(e).x`, `measure().y`, `motor::kHome.x`, `a[i]`, `cfg.gains[1]`.
  **Decision:** after a name, `pos.x.y` is still parsed as the (`.`-qualified) name of the `ElementReference`
  (so `Iface.x` and `motor.speed` keep working unchanged); the linker (`memberAwareCandidate` in
  `hsm-linker.ts`, also used by the test language) resolves the **longest prefix that names a variable**
  when the whole name does not resolve and records the rest as member path (`referenceMembers(ref)` in
  `cpp-types.ts`). Consumers (type system, validator, interpreter, generators, hover) treat an element
  reference with members like a chain of member accesses. Unknown members are errors of the validator
  (`'motor::Position' has no member 'q' (members: x, y, z)`), a member path on an instance says which
  interface member is missing.
- **Assignments** to members and elements: `target.x = 5`, `cfg.timing.retries -= 1`, `pos.x++`,
  `buffer[i] = v` (the test language: `p.z = 3`, `a[0] = 1`).
- **Casts**: `n as motor::Mode`, `mode as integer`, `x as uint8_t` (wraps).
- **Not implemented**: struct literals (`motor::Position{1, 2}`) – values are built from constants, event
  values, operation results and member assignments.

### 4.2 Resolution and linking

- `HsmImportResolver.resolveHeader` finds the header in the `CppHeaderStore` of the services
  (`cpp-headers.ts`: texts by URI, a synchronous `reader`, the settings, caches of parsed headers and
  indexes) and loads it with its includes (`loadHeaderClosure`). `ResolvedImport.header` is
  `{ found, searched, headers }`; the resolver registers one `CppTypeIndex` per state machine
  (`cppImports(machine)`, cached by the versions of the header texts and the settings). Without header
  imports an empty index is used (it knows the fundamental and `<cstdint>` types).
- **Test documents** use the imports of the tested state machine (`contextMachine(node)`).
- Type references are resolved in this order: built-in type, HSM alias, imported state machine, C++ type
  (`cppTypeOfReference`). **Decision:** the `<cstdint>` / `<cstddef>` typedefs are always known (no import
  needed); C++ keywords of fundamental types (`int`, `long`, `double`, `bool`, `char`, …) are **not** type
  names of models (the error lists the HSM types; use `integer` / `real` / `int32_t`).
- Validation of imports: a missing header is an error at the import path (with the searched locations and a
  hint to the include path settings); errors of the analysis of the header (and its includes) are errors at
  the import with the location (`motor_types.h:12:5: …`, at most 5), warnings are summarized as one info.
  Errors of C++ names are not reported while a header import is unresolved.
- `HsmDocumentBuilder.shouldRelink` relinks a machine when a header it uses changed (`headersChanged`: the
  version of a header text or of the settings differs from the one the index was built with) or a header
  import is unresolved.

### 4.3 Type system

`HsmType` is `BuiltinTypeName | 'null' | 'instance' | 'error' | CppHsmType` where `CppHsmType` is
`{ kind: 'enum' | 'struct' | 'array', cppName, resolved, index }` (identity: kind and qualified C++ name,
compare with `sameType`). Mapping of `CppResolvedType` (`hsmTypeOfCpp`):

| C++ | HSM | decisions |
| --- | --- | --- |
| `integer` (≤ 64 bits) | `integer` | the width is the **storage type** of places (variables, members, elements, event values, parameters: `storageOfTarget` / `storageOfTypeReference` in `cpp-storage.ts`); assignments of constants out of range are **warnings** (`The value 300 is out of the range of uint8_t (0..255) of 'small'; it is converted to 44.`); 128-bit integers are unsupported |
| `real` | `real` | `float` places round to single precision |
| `boolean` | `boolean` | |
| `string` | `string` | only `std::string` can be the type of a place; `const char*` / `std::string_view` constants are readable (a type reference to them is an error) |
| `enum` | `CppHsmType` enum | `==` / `!=` and `<` `<=` `>` `>=` between values of the same enum (also of an `enum class`, ordered by value as in C++); **unscoped** enums are promoted to `integer` in arithmetic, bitwise and relational operators with other types and assignable to `integer` / `real`; `enum class` values are not; nothing converts implicitly to an enum (`integer`, another enum: error, as in C++); `as` converts integer ↔ enum (and enum → other enum) |
| `struct` | `CppHsmType` struct | members by name (public data members, inherited ones included); assignable as a whole (same type); **no `==`** (C++ aggregates have none before C++20; user-defined operators are not analyzed) |
| `array` | `CppHsmType` array | element access `a[i]` (index: integer or unscoped enum; constant indices out of bounds are errors); `std::array` values are assignable as a whole, C arrays are not; no `==`; arrays of unknown length are unsupported |
| `unsupported` | error where used | `The C++ type 'Foo' cannot be used: 'Foo' is not supported (union)` |

Event payloads, operation parameters and return values may use all these types.

### 4.4 Interpreter

- Runtime values (`simulation/values.ts`): `EnumValue { type, value: bigint }`, `StructValue { type, fields }`,
  `ArrayValue { type, elements }` – immutable, so an assignment to a member creates a new struct value and
  values are never shared between variables. `RuntimeType` adds the C++ integer / `float` storage types to
  the built-in types: `convert` / `fromHost` wrap integers to the width (`BigInt.asIntN/asUintN`) and round
  `float`s (`Math.fround`); arithmetic stays 64-bit (`int64`), exactly what the generated C++ does with
  `sc::integer` arithmetic and conversions on assignment.
- Defaults: `T{}` from `CppTypeIndex.defaultValue` (`fromCppValue` converts analyzer values), constants from
  `CppTypeIndex.constant`.
- Host values (API, callbacks, scenarios, simulation panels): enum → qualified enumerator name (a number if
  the value has no enumerator); input also the simple name or a number. Struct → object (missing members get
  their default, unknown members are errors), array → array. Enumerators of unscoped enums are also accepted
  in the spelling of models (`"motor::kJam"`, `"::RED"`). `getValue(name)` / `getVariableType(name)` give
  the runtime values and types (for UIs). Canonical text (`formatValue`): `motor::Mode::Fast`,
  `motor::Mode(7)`, `{x: 1, y: 2}`, `[1, 2]`.
- Element access outside the bounds is a runtime error (`Index 3 is out of bounds 0..2`).

### 4.5 C++ generator

- `#include "…"` of the imported headers in the generated header (after `sc_statemachine.h`). The path is the
  import path if the header was found in an include directory or the output directory is the model's
  directory; otherwise the path relative to the output directory (`hsm generate` computes it,
  `CppGeneratorOptions.headerInclude` customizes it).
- Declarations use the C++ spelling of the model (`motor::Rpm`, `::Color`; `<cstdint>` typedefs as
  `std::uint8_t`): members, getters / setters (structs and arrays by `const T&`), event values and observables,
  callback signatures. Enum / struct defaults `T{}`.
- Expressions: enumerators and constants by their qualified names, member access 1:1, element access through
  a generated `check_index` (reports `sc::ErrorKind::IndexOutOfBounds`, a new error kind), unscoped enum
  operands `static_cast<sc::integer>(…)`, casts `static_cast<motor::Mode>(…)`; arithmetic in `sc::integer`,
  stores into narrower places with `static_cast<std::uint8_t>(…)` (`-Wconversion` clean) – the wrap-around the
  interpreter implements.
- Scenario harness: `format` overloads for the enums, structs and arrays of the model (canonical text without
  white space), literals of enum values and structs (`[] { motor::Position v{}; v.x = 1; return v; }()`),
  member-wise comparison of struct expectations. The 17 `s10-cpp-*` scenarios are compiled with g++ (and
  checked with clang++) one by one (their headers may declare the same names).
- The **C generator** reports `C++ header types are not supported by the C generator` for any header import or
  C++ type (also `uint8_t`); its conformance test skips exactly `CPP_TYPE_SCENARIOS` (`test/helpers.ts`).
  (C headers for the C generator would be possible for C enums / structs / typedefs, not implemented.)

### 4.6 Tools

- Hover (`cppHover` in `lsp/cpp-lsp.ts`, used by the language server and the web editor): the declaration
  (`enum class motor::Mode` with its enumerators, `constexpr std::int32_t motor::kMaxSpeed = 6000`, struct
  members with types), the documentation comment (as written, Doxygen commands rendered like the doc comments
  of models, see [rendering.md](rendering.md#model-documentation)) and the location in the header; also for each segment of a
  qualified name (`motor` → namespace), for struct members in names and member accesses and for header import
  paths.
- Navigation (`cppLocations` in `lsp/cpp-navigation.ts`; the VS Code language server registers definition,
  declaration, type definition and document link providers): into the header (`fileName` – the URI of the
  header, also of headers found through `#include`s and include paths – plus `nameRange` of the
  declaration). The origin of a link is the segment of the qualified name at the position, so `app`,
  `Mode` and `Fast` of `app::Mode::Fast` lead to the namespace, the enum and the enumerator (and VS Code
  underlines only that segment on `Ctrl`/`Cmd`+hover); struct members in names and member accesses lead
  to the fields, the variable name of `cfg.limits.low` to the variable.
  - *Go to Definition* (`F12`, `Ctrl`/`Cmd`+Click, Peek): the definition – the enum definition rather than
    an opaque declaration, the target of a using-declaration (`using hw::Channel;`), the first block of a
    namespace; the import path opens the header.
  - *Go to Declaration*: all declarations, the definition first (opaque enum declarations, all blocks of a
    namespace, using-declarations and their target).
  - *Go to Type Definition*: from a constant, enumerator or struct member to its enum or struct (for aliases
    of built-in types: the alias); from a variable, event, parameter, operation or type alias of the model
    (declaration or reference) to its C++ type.
  - Document links on header (and model) import paths.
  - Name ranges: the name of a using-declaration is its last segment, an anonymous enum / struct named by
    `typedef` (`typedef enum { … } color_t;`) has the range of the typedef name. Declarations produced by
    macro expansions have the range of the macro invocation. Forward declarations of classes are not
    recorded (the definition is the only target).
- Completion (`HsmCompletionProvider`, both languages, the VS Code language server and the web app): after
  `ns::` the members of the namespace / class / enum (in type positions – `var x : `, `in event e : `,
  parameters, return types, `alias`, `x as ` – only namespaces and types, in expressions values and scopes;
  enumerators in declaration order with their values), after `::` the global names, after `var.` the members of
  a struct variable. Where a value of an enum is expected, the enumerators of that enum are proposed first,
  written as in models (`motor::Mode::Fast`, `::LED_ON`): after `x == ` / `x != ` / `x = ` (also `<` …, `x`
  a variable or `valueof(e)`), `var m : motor::Mode = `, `raise e : `, in arguments of operation calls and
  after `mock op returns (`; they are added to Langium's completion (typing `Fa` finds `motor::Mode::Fast`).
  Completion items show the documentation comments of the header like the hover (Doxygen commands rendered).
  In type positions without qualifier the global C++ types and namespaces and the `<cstdint>` typedefs are
  proposed.
- Messages: an unknown enumerator lists the enumerators of the enum (`'motor::Mode' has no enumerator 'Fsat'
  (enumerators: Off, Slow, Fast)`); an unqualified enumerator name suggests the qualified one (`Could not
  resolve reference to Declaration named 'Fast'. (Did you mean 'motor::Mode::Fast'? …)`).
- Hover of enumerators shows the computed value (also hexadecimal, its derivation, implicit or unknown, see
  §3.5), the enum and its underlying type; hover of enums the enumerators with their values, the underlying
  type, whether the enum is unscoped or an opaque declaration.
- Semantic highlighting (VS Code): C++ types (enum types as enums), enumerators and constants.
- The definitions box of the diagram lists the imports.

### 4.7 Hosts and settings

**Decision:** the settings of the analysis are a `headers` block of the generator configuration
`hsm.gen.json` (one configuration file per project, already used by the CLI, CMake and VS Code; a separate
`hsm.config.json` would have duplicated the lookup):

```json
"headers": {
    "includePaths": ["include", "../common/include"],
    "defines": { "USE_CAN": "1", "NDEBUG": "" },
    "dataModel": { "longBits": 32, "pointerBits": 32, "charSigned": false }
}
```

Relative include paths are relative to the configuration file. For a model, the **nearest** `hsm.gen.json` /
`*.hsm.gen.json` with a `headers` block in its directory or a parent directory applies (CLI, language server,
VS Code webview; `hsm generate --config` uses the given configuration for its models). Global settings are
combined with it: their include paths come after those of the configuration, their defines and data model
override it.

| host | headers | settings |
| --- | --- | --- |
| CLI (`hsm validate`, `simulate`, `test`, `generate`, `layout`, `render`, `doc`) | read from disk (`installNodeHeaderSupport` in `src/node/cpp-headers-node.ts`: synchronous reader) | `hsm.gen.json`; `-I <dir>`, `-D NAME[=VALUE]`, `--data-model lp64`/`llp64`/`ilp32`; `hsm generate --list-inputs` lists the imported headers (CMake dependencies); CMake `INCLUDE_DIRS` / `DEFINES` |
| API (`HsmModelLoader`, `HsmTestWorkspace`) | `files` / `readFile` (async, loaded before the build by `loadImports`, also the includes), header files given to `HsmTestWorkspace.load` | `HsmModelLoaderOptions.cppHeaders`, `cppHeaderStore(shared).settings` / `settingsProvider` |
| VS Code language server | read from disk; the `**/*` file watcher of Langium invalidates changed headers and `hsm.gen.json` files; importing models are relinked and validated again | `hsm.gen.json`; settings `hsm.headers.includePaths` (relative to the workspace folder, `${workspaceFolder}`), `hsm.headers.defines`, `hsm.headers.dataModel` |
| VS Code diagram webview | the extension sends the header texts (and their includes) with the imported `.hsm` files (`collectImportedFiles`) | the extension sends the effective settings (`headers` of the `text` message) |
| Web app | the virtual file list: headers of the examples and headers opened with *Open…* (`.h`, `.hpp`, …; added to the list, not edited) | – |

Unsaved changes of a header open in VS Code are not seen (headers are read from disk).

### 4.8 Limitations

- No struct literals, no `==` of structs (also with a user-defined `operator==`), no whole-array assignment
  of C arrays, no pointers / references / unions / templates other than `std::array` / functions / methods.
- Enum values without enumerator are shown as `motor::Mode(7)`; an enum with several enumerators of the same
  value shows the first one. Values of unscoped enums are shown with the enum name (`Color::Red`,
  `led_t::LED_ON`), which is also valid C++11.
- The C generator does not support C enums of headers yet (it rejects all header imports): it would need the
  C spelling of the types (`enum tag` without typedef) and enumerators, C casts instead of `static_cast` and
  formatting in its scenario harness.
- `using enum` and opaque enums in headers require a compiler that supports them for the generated code
  (`using enum`: C++20; the analyzer accepts them regardless of `__cplusplus`).
- `uint64_t` values above `INT64_MAX` are stored correctly but converted to `sc::integer` (wrapping) in
  arithmetic, like in the generated code; host values are JS numbers (exact up to 2^53).
- The C generator does not support header types; the C++ generator does not support submachine instances
  (independent of headers).
- The web editor cannot open or navigate into headers (hover works); navigation is a feature of the VS
  Code language server (`packages/vscode/src/server/hsm-lsp.ts`).
