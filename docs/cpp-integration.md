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

Operations stay callbacks: functions and classes with methods in the headers are **not** used.
The simulator understands the imported types and constants; the C++ generator `#include`s the
headers and uses the types directly.

## 2. The analyzer

Pure TypeScript without Node dependencies (it runs in the web app and in the VS Code extension,
which bundle the language package). Exported from `devm-language`:

| file | content |
| --- | --- |
| `model.ts` | all public types (syntactic model, resolved model, diagnostics, options) |
| `lexer.ts` | tokenizer (comments, doc comments, raw strings, digit separators, directives) |
| `preprocessor.ts` | `#if`/`#ifdef`/… evaluation, `#define` expansion, `#include` recording |
| `syntax.ts` | token cursor, parsers for names, type-ids and constant expressions |
| `parser.ts` | tolerant declaration parser: `parseCppHeader` |
| `evaluator.ts` | constant expression evaluation with C++ integer semantics |
| `type-index.ts` | `CppTypeIndex`: lookup, type resolution, classification, constant values |
| `report.ts` | JSON report (`devm cpp-header`), `describeCppType` |

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
function cppHeaderReport(index: CppTypeIndex): unknown;          // JSON of `devm cpp-header`
```

Values use the representation of the HSM interpreter (`simulation/values.ts`): integers (and enum
values, i.e. the numeric value of the enumerator) are `bigint`, reals are `number`. Structs are
plain objects in field order, arrays are arrays.

Positions are 0-based like LSP ranges; every declaration has `fileName`, `range` and `nameRange`
for go-to-definition, and `doc` for hovers.

### 2.2 Debugging

```
devm cpp-header motor_types.h controller.hpp
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
(`#if CONFIG_USE_CAN`) is analyzed with the macro undefined, unless it is passed in `defines`
(`headers.defines` of `devm.gen.json`, `-D`, `devm.headers.defines`, see §4.7).

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

## 4. Language integration (implemented)

### 4.1 Syntax

- **Import**: `import "motor_types.h"` (several paths, also `import: "a.h" "b.devm"`) at the beginning of the
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
| `enum` | `CppHsmType` enum | `==` / `!=` between values of the same enum; **unscoped** enums are promoted to `integer` in arithmetic, bitwise and relational operators and assignable to `integer` / `real`; `enum class` values are not; `as` converts integer ↔ enum (and enum → other enum) |
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
  their default, unknown members are errors), array → array. `getValue(name)` / `getVariableType(name)` give
  the runtime values and types (for UIs). Canonical text (`formatValue`): `motor::Mode::Fast`,
  `motor::Mode(7)`, `{x: 1, y: 2}`, `[1, 2]`.
- Element access outside the bounds is a runtime error (`Index 3 is out of bounds 0..2`).

### 4.5 C++ generator

- `#include "…"` of the imported headers in the generated header (after `sc_statemachine.h`). The path is the
  import path if the header was found in an include directory or the output directory is the model's
  directory; otherwise the path relative to the output directory (`devm generate` computes it,
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
  member-wise comparison of struct expectations. The 14 `s10-cpp-*` scenarios are compiled with g++ (and
  checked with clang++) one by one (their headers may declare the same names).
- The **C generator** reports `C++ header types are not supported by the C generator` for any header import or
  C++ type (also `uint8_t`); its conformance test skips exactly `CPP_TYPE_SCENARIOS` (`test/helpers.ts`).
  (C headers for the C generator would be possible for C enums / structs / typedefs, not implemented.)

### 4.6 Tools

- Hover (`cppHover` in `lsp/cpp-lsp.ts`, used by the language server and the web editor): the declaration
  (`enum class motor::Mode` with its enumerators, `constexpr std::int32_t motor::kMaxSpeed = 6000`, struct
  members with types), the documentation comment and the location in the header; also for each segment of a
  qualified name (`motor` → namespace), for struct members in names and member accesses and for header import
  paths.
- Go to definition (`cppDefinition`): into the header (`fileName` + `nameRange` of the declaration); the
  import path opens the header.
- Completion (`HsmCompletionProvider`, both languages): after `ns::` the members of the namespace / class /
  enum, after `::` the global names, after `var.` the members of a struct variable; otherwise Langium's
  completion.
- Semantic highlighting (VS Code): C++ types, enumerators and constants.
- The definitions box of the diagram lists the imports.

### 4.7 Hosts and settings

**Decision:** the settings of the analysis are a `headers` block of the generator configuration
`devm.gen.json` (one configuration file per project, already used by the CLI, CMake and VS Code; a separate
`hsm.config.json` would have duplicated the lookup):

```json
"headers": {
    "includePaths": ["include", "../common/include"],
    "defines": { "USE_CAN": "1", "NDEBUG": "" },
    "dataModel": { "longBits": 32, "pointerBits": 32, "charSigned": false }
}
```

Relative include paths are relative to the configuration file. For a model, the **nearest** `devm.gen.json` /
`*.devm.gen.json` with a `headers` block in its directory or a parent directory applies (CLI, language server,
VS Code webview; `devm generate --config` uses the given configuration for its models). Global settings are
combined with it: their include paths come after those of the configuration, their defines and data model
override it.

| host | headers | settings |
| --- | --- | --- |
| CLI (`devm validate`, `simulate`, `test`, `generate`, `layout`, `render`, `doc`) | read from disk (`installNodeHeaderSupport` in `src/node/cpp-headers-node.ts`: synchronous reader) | `devm.gen.json`; `-I <dir>`, `-D NAME[=VALUE]`, `--data-model lp64`/`llp64`/`ilp32`; `devm generate --list-inputs` lists the imported headers (CMake dependencies); CMake `INCLUDE_DIRS` / `DEFINES` |
| API (`HsmModelLoader`, `HsmTestWorkspace`) | `files` / `readFile` (async, loaded before the build by `loadImports`, also the includes), header files given to `HsmTestWorkspace.load` | `HsmModelLoaderOptions.cppHeaders`, `cppHeaderStore(shared).settings` / `settingsProvider` |
| VS Code language server | read from disk; the `**/*` file watcher of Langium invalidates changed headers and `devm.gen.json` files; importing models are relinked and validated again | `devm.gen.json`; settings `devm.headers.includePaths` (relative to the workspace folder, `${workspaceFolder}`), `devm.headers.defines`, `devm.headers.dataModel` |
| VS Code diagram webview | the extension sends the header texts (and their includes) with the imported `.devm` files (`collectImportedFiles`) | the extension sends the effective settings (`headers` of the `text` message) |
| Web app | the virtual file list: headers of the examples and headers opened with *Open…* (`.h`, `.hpp`, …; added to the list, not edited) | – |

Unsaved changes of a header open in VS Code are not seen (headers are read from disk).

### 4.8 Limitations

- No struct literals, no `==` of structs (also with a user-defined `operator==`), no whole-array assignment
  of C arrays, no pointers / references / unions / templates other than `std::array` / functions / methods.
- Enum values without enumerator are shown as `motor::Mode(7)`; an enum with several enumerators of the same
  value shows the first one.
- `uint64_t` values above `INT64_MAX` are stored correctly but converted to `sc::integer` (wrapping) in
  arithmetic, like in the generated code; host values are JS numbers (exact up to 2^53).
- The C generator does not support header types; the C++ generator does not support submachine instances
  (independent of headers).
- The web editor cannot open or navigate into headers (hover works).
