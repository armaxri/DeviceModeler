# C++ integration (design note)

Status: the **C++ header analyzer** (`packages/language/src/cpp-header/`) is implemented and
tested. The language integration (grammar, scoping, type system, interpreter, generators) is the
next step; this note describes the analyzer, the supported C++ subset and the proposed integration.

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

Operations stay callbacks: functions and classes with methods in the headers are **not** used.
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
| enums | `enum`, `enum class`, `enum struct`, anonymous, `typedef enum { } Name;`, fixed underlying type (`: std::uint8_t`), explicit values as constant expressions, attributes on enumerators |
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
(`#if CONFIG_USE_CAN`) is analyzed with the macro undefined, unless it is passed in `defines`.
The integration should allow configuring defines (e.g. in the generator configuration).

### 3.2 Constant expressions

Supported: integer, floating, character (`'a'`, `u8'a'`, `L'a'`, escapes), string (adjacent
literals concatenated), `true`/`false` literals; unary `+ - ! ~`; binary `* / % + - << >> < <= > >=
== != & ^ | && ||` (also `and`, `or`, `not`, …); `?:`; `static_cast<T>(x)`, `(T)x`, `T(x)`, `T{x}`;
`sizeof(T)` / `alignof(T)` for scalar types and arrays of them; `std::numeric_limits<T>::max()`,
`min()`, `lowest()`, `epsilon()`; names of constants and enumerators (earlier ones in the same enum,
constants of other headers); macros.

The semantics are those of C++: integers carry their type (width, signedness), the integral
promotions and usual arithmetic conversions apply and results wrap around (`0u - 1` is
`4294967295`, `(0u - 1) / 2` is `2147483647`, `1 << 31` is `-2147483648`); integer literal types
follow the suffix and value rules; division truncates toward zero. Division by zero, shift counts
out of range, function calls, `nullptr`, member access and arithmetic on scoped enums without a
cast are errors (they are not constant expressions or not supported). Implicit conversions of
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

## 4. Proposed language integration

### 4.1 Syntax

- **Import**: `import "motor_types.h"` in the header of the state machine (after `namespace`,
  before the annotations), several allowed. Paths are relative to the model file, then to include
  directories of the generator configuration (`includeDirs`). Quoted `#include`s of an imported
  header are **not** imported transitively for name lookup, but they are analyzed so that constants
  used by the imported header can be evaluated (`CppHeader.includes`).
- **C++ names use `::`** and are always written fully qualified from the global namespace, e.g.
  `motor::Mode`, `motor::Mode::Fast`, `motor::kMaxSpeed`, `::HAL_OK` or `HAL_OK` for global names.
  `::` does not clash with the `.`-qualified vertex names of HSM. A grammar rule
  `CppName: ID ('::' ID)*` for type references and element references; `TypeReference` becomes
  `name=CppName` (built-in type names stay `ID`).
- **Types**: `var mode : motor::Mode`, `in event moved : motor::Position`,
  `operation f(p : motor::Position) : motor::Rpm`.
- **Values**: enumerators `motor::Mode::Fast` (unscoped ones also `motor::kStall`), constants
  `motor::kMaxSpeed`, struct constants `motor::kParkPosition`.
- **Member access**: `pos.x`, `valueof(moveTo).x`, nested `cfg.timing.periodMs`; assignment to
  members `target.x = 5` (the grammar needs a postfix `.` member access and an assignable
  left-hand side of the form `variable(.member)*`).
- **Struct literals** (optional, later): `motor::Position{1, 2, 3}` or construction via constants
  and member assignment only in a first version.

### 4.2 Scoping and linking

`HsmScopeProvider` resolves `CppName`s via a `CppTypeIndex` per document (built from the imported
headers, cached per header content, invalidated on change; the language server should watch the
header files). `lookup(name)` gives the declaration: enum / record / alias for types, enumerator
/ constant for values. Go-to-definition uses `fileName` + `nameRange`, hover uses `doc` and
`describeCppType`, completion after `motor::` uses `members('motor')`.

### 4.3 Type system

`HsmType` becomes a union of the built-in names and imported types. Proposed mapping of
`CppResolvedType`:

| C++ | HSM | notes |
| --- | --- | --- |
| `integer` | `integer` (with `bits`/`signed` kept for range checks and wrap-around) | assignments of out-of-range literals can be warned |
| `real` | `real` | `float` rounds to 32 bit in the simulator (`Math.fround`) |
| `boolean` | `boolean` | |
| `string` | `string` | `const char*` constants only readable |
| `enum` | new kind `enum` (identity = `cppName`) | only `==`/`!=` (and `<`… for unscoped); `as integer` converts; unscoped enums may convert implicitly to `integer` |
| `struct` | new kind `struct` (identity = `cppName`) | assignable as a whole (same type), `==` not defined (C++ has no default `operator==` before C++20) |
| `array` | not in the first version | fields of array type are visible but not accessible |
| `unsupported` | error at the use site with `reason` | only when the type is used |

Casts: `x as motor::Mode` (integer -> enum) for unscoped and scoped enums.

### 4.4 Simulator

- Enum values are `bigint` (the enumerator value, as in C++); the interpreter keeps the enum type
  of variables for display (`motor::Mode::Fast` instead of `10`) via `enumerators`.
- Struct values are objects with one entry per field (`CppValue` of `defaultValue(type)` as
  initial value: default member initializers, zero otherwise), copied on assignment.
- Integers of imported integer types should wrap to their width on assignment
  (`BigInt.asIntN/asUintN(bits, v)`), like the generated C++ code does.
- Constants are read from `CppTypeIndex.constant(...)`; values that cannot be evaluated are
  errors at the use site (the diagnostic of the analyzer explains why).
- Scenarios / host values: enums as enumerator name or number, structs as JSON objects.

### 4.5 C++ generator

- `#include "motor_types.h"` (the import path as written, or relative to the include directories)
  in the generated header, before the class.
- Types are emitted with `cppName` (fully qualified, e.g. `motor::Mode`, `std::int32_t`); aliases
  may be emitted with their own qualified name to keep the user's spelling (`motor::Rpm`).
- Enumerators and constants are emitted by their qualified name (`motor::Mode::Fast`,
  `motor::kMaxSpeed`), not by value, so the generated code follows changes of the header.
- Member access maps 1:1 (`pos.x`); event values of struct type are passed as `const T&`.
- Arithmetic of imported integer types in guards: the generator keeps using `sc::integer` for
  HSM `integer` arithmetic and converts on assignment (`static_cast<std::uint8_t>(…)`), which is
  exactly the wrap-around the simulator implements.
- The C generator can support imported C headers the same way (enums, structs, typedefs), but not
  namespaces or `enum class`.
