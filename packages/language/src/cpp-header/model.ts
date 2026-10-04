/**
 * Data model of the C++ header analyzer.
 *
 * Two layers:
 * - the **syntactic model** ({@link CppHeader} with its {@link CppDeclaration} tree), produced by
 *   `parseCppHeader` for a single header. It contains what is written in the header: type references
 *   ({@link CppTypeRef}) and initializer expressions ({@link CppExpression}) are not resolved.
 * - the **resolved model** ({@link CppResolvedType}, {@link CppValue}), computed by `CppTypeIndex`
 *   which combines several headers, resolves names across headers, follows aliases and evaluates
 *   constant expressions.
 *
 * Positions are 0-based (like LSP / Langium ranges) so they can be used for diagnostics and
 * go-to-definition without conversion.
 *
 * @module
 */

/** A 0-based position in a header (line and UTF-16 column, like an LSP `Position`). */
export interface CppPosition {
    readonly line: number;
    readonly character: number;
}

/** A 0-based range in a header (like an LSP `Range`; `end` is exclusive). */
export interface CppRange {
    readonly start: CppPosition;
    readonly end: CppPosition;
}

export type CppDiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * A problem found while parsing a header or resolving its declarations. Only problems that matter
 * for the extracted model are reported (e.g. an enumerator whose value cannot be computed); the
 * skipped C++ constructs (functions, templates, class methods, …) are not diagnosed.
 */
export interface CppDiagnostic {
    readonly severity: CppDiagnosticSeverity;
    readonly message: string;
    readonly fileName: string;
    readonly range: CppRange;
}

// ---------------------------------------------------------------------------------------------
// Names, types and expressions as written
// ---------------------------------------------------------------------------------------------

/** One component of a (qualified) name, e.g. `numeric_limits<int>` in `std::numeric_limits<int>::max`. */
export interface CppNamePart {
    readonly name: string;
    readonly templateArguments?: readonly CppTemplateArgument[];
}

/** A possibly qualified name as written, e.g. `::motor::Mode`. */
export interface CppQualifiedName {
    /** Whether the name starts with `::`. */
    readonly global: boolean;
    readonly parts: readonly CppNamePart[];
}

/** A template argument: a type (`uint8_t`) or an expression (`4`). A plain name may be either. */
export interface CppTemplateArgument {
    readonly text: string;
    readonly type?: CppTypeRef;
    readonly expression?: CppExpression;
}

/**
 * The type name of a {@link CppTypeRef}:
 * - `fundamental`: a built-in type with its canonical spelling (`int`, `unsigned int`, `long long`,
 *   `signed char`, `char`, `bool`, `float`, `double`, `long double`, `void`, `wchar_t`, `char8_t`,
 *   `char16_t`, `char32_t`, `__int128`, `unsigned __int128`),
 * - `named`: a (qualified) name like `uint8_t`, `motor::Mode` or `std::array<int, 4>`,
 * - `declared`: an enum or class defined inline in the declaration (`typedef struct { … } Point;`,
 *   `struct { int a; } member;`),
 * - `other`: something that cannot be analyzed (`auto`, `decltype(…)`, …).
 */
export type CppTypeName =
    | { readonly kind: 'fundamental'; readonly name: string }
    | { readonly kind: 'named'; readonly name: CppQualifiedName }
    | { readonly kind: 'declared'; readonly declaration: CppEnum | CppRecord }
    | { readonly kind: 'other'; readonly text: string };

/** A type as written in a declaration (declaration specifiers plus declarator). */
export interface CppTypeRef {
    /** Normalized spelling, e.g. `const std::array<uint8_t, 4>`, `const char*`, `int[3]`. */
    readonly spelling: string;
    readonly name: CppTypeName;
    readonly const: boolean;
    readonly volatile: boolean;
    /** Number of pointer levels (`*`). */
    readonly pointer: number;
    /** `&` or `&&` declarator. */
    readonly reference?: 'lvalue' | 'rvalue';
    /** Array dimensions, outermost first; `undefined` for `[]`. */
    readonly arrayDimensions: readonly (CppExpression | undefined)[];
    /** The declarator is a function pointer (or function) type. */
    readonly functionPointer: boolean;
    readonly range: CppRange;
}

/** An expression as written (initializer, enumerator value, array size, bit-field width). */
export interface CppExpression {
    /** The source text (normalized whitespace). */
    readonly text: string;
    readonly range: CppRange;
    readonly node: CppExpressionNode;
}

export type CppBinaryOperator =
    | '*' | '/' | '%' | '+' | '-' | '<<' | '>>' | '<' | '<=' | '>' | '>=' | '==' | '!='
    | '&' | '^' | '|' | '&&' | '||';

export type CppUnaryOperator = '+' | '-' | '!' | '~';

/** Abstract syntax of a constant expression. */
export type CppExpressionNode = { readonly range: CppRange } & (
    /** Integer or floating literal, e.g. `0x10u`, `1'000`, `2.5f`. */
    | { readonly kind: 'number'; readonly text: string }
    /** Character literal; `prefix` is `''`, `u8`, `u`, `U` or `L`. */
    | { readonly kind: 'char'; readonly prefix: string; readonly codes: readonly number[] }
    /** String literal (adjacent literals are concatenated). */
    | { readonly kind: 'string'; readonly value: string }
    | { readonly kind: 'boolean'; readonly value: boolean }
    | { readonly kind: 'nullptr' }
    | { readonly kind: 'name'; readonly name: CppQualifiedName }
    | { readonly kind: 'unary'; readonly operator: CppUnaryOperator; readonly operand: CppExpressionNode }
    | { readonly kind: 'binary'; readonly operator: CppBinaryOperator; readonly left: CppExpressionNode; readonly right: CppExpressionNode }
    | { readonly kind: 'conditional'; readonly condition: CppExpressionNode; readonly whenTrue: CppExpressionNode; readonly whenFalse: CppExpressionNode }
    /** `static_cast<T>(x)`, `(T)x`, `int(x)`, `T{x}` (for built-in type keywords). */
    | { readonly kind: 'cast'; readonly type: CppTypeRef; readonly operand: CppExpressionNode }
    /** A call `f(a, b)` / `T{a}`: a functional cast if `callee` names a type, otherwise not evaluable. */
    | { readonly kind: 'call'; readonly callee: CppExpressionNode; readonly arguments: readonly CppExpressionNode[]; readonly braces: boolean }
    | { readonly kind: 'sizeof'; readonly operator: 'sizeof' | 'alignof'; readonly type?: CppTypeRef; readonly operand?: CppExpressionNode }
    /** Braced initializer list `{1, 2}` / `{.x = 1, .y = 2}`. */
    | { readonly kind: 'initializerList'; readonly elements: readonly CppInitializerElement[] }
    | { readonly kind: 'member'; readonly object: CppExpressionNode; readonly member: string }
    /** A construct the expression parser does not understand (the text is kept). */
    | { readonly kind: 'unsupported'; readonly text: string }
);

export interface CppInitializerElement {
    /** Designator of `.x = 1` (C++20 designated initializer). */
    readonly designator?: string;
    readonly value: CppExpressionNode;
}

// ---------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------

/** Properties common to all declarations. */
export interface CppDeclarationBase {
    /** The simple name (`''` for anonymous namespaces, enums and classes). */
    readonly name: string;
    /**
     * The fully qualified name without leading `::`, e.g. `motor::Mode::Fast`. Anonymous namespaces are
     * not part of qualified names (their members are visible in the enclosing namespace); anonymous
     * classes and enums get `<scope>::(anonymous)`.
     */
    readonly qualifiedName: string;
    /** Qualified name of the enclosing namespace, class or enum (`''` for the global namespace). */
    readonly scope: string;
    readonly fileName: string;
    /** Range of the whole declaration. */
    readonly range: CppRange;
    /** Range of the name (for go-to-definition); the keyword for anonymous entities. */
    readonly nameRange: CppRange;
    /** Documentation comment (`///`, `//!`, `/** … *\/`, `/*! … *\/`, trailing `///<`), without comment markers. */
    readonly doc?: string;
}

export interface CppNamespace extends CppDeclarationBase {
    readonly kind: 'namespace';
    readonly inline: boolean;
    readonly anonymous: boolean;
    readonly members: readonly CppDeclaration[];
}

/** `namespace short = long::name;` */
export interface CppNamespaceAlias extends CppDeclarationBase {
    readonly kind: 'namespaceAlias';
    readonly target: CppQualifiedName;
}

/** `using namespace x::y;` or (`enum: true`) the C++20 `using enum E;` (its name is `''`). */
export interface CppUsingDirective extends CppDeclarationBase {
    readonly kind: 'usingDirective';
    readonly target: CppQualifiedName;
    /** `using enum E;`: the enumerators of `E` are members of the scope. */
    readonly enum?: boolean;
}

export interface CppEnum extends CppDeclarationBase {
    readonly kind: 'enum';
    /** `enum class` / `enum struct`. */
    readonly scoped: boolean;
    readonly anonymous: boolean;
    /** The fixed underlying type (`enum class E : uint8_t`). */
    readonly underlyingType?: CppTypeRef;
    /**
     * An opaque declaration without enumerator list (`enum class E : int;`). The index prefers the
     * definition of the enum if one exists.
     */
    readonly opaque?: boolean;
    readonly enumerators: readonly CppEnumerator[];
}

export interface CppEnumerator extends CppDeclarationBase {
    readonly kind: 'enumerator';
    readonly initializer?: CppExpression;
}

export type CppAccess = 'public' | 'protected' | 'private';

export interface CppBaseSpecifier {
    readonly access: CppAccess;
    readonly virtual: boolean;
    readonly type: CppTypeRef;
}

/** A `struct`, `class` or `union` definition (forward declarations are not recorded). */
export interface CppRecord extends CppDeclarationBase {
    readonly kind: 'record';
    readonly key: 'struct' | 'class' | 'union';
    readonly anonymous: boolean;
    readonly final: boolean;
    readonly bases: readonly CppBaseSpecifier[];
    /** Non-static data members in declaration order (all access levels). */
    readonly fields: readonly CppField[];
    /** Nested enums, classes, aliases and static constants. */
    readonly members: readonly CppDeclaration[];
    /** Whether the class declares a constructor that is not `= default` / `= delete`. */
    readonly hasUserConstructors: boolean;
    /** Whether the class declares virtual functions (or a virtual destructor). */
    readonly hasVirtualFunctions: boolean;
    /** Whether the class declares member functions (methods, operators, constructors). */
    readonly hasMemberFunctions: boolean;
}

/** A non-static data member. */
export interface CppField extends CppDeclarationBase {
    readonly kind: 'field';
    readonly type: CppTypeRef;
    readonly access: CppAccess;
    /** Bit-field width (`uint8_t flag : 1;`). */
    readonly bitWidth?: CppExpression;
    /** Default member initializer (`= 5` or `{5}`; braces are kept as initializer list). */
    readonly initializer?: CppExpression;
}

/**
 * `typedef T Name;`, `using Name = T;` or a using-declaration `using ns::Name;` (syntax
 * `usingDeclaration`, which may also name a constant or enumerator: its `type` is then a named type
 * whose name is the target).
 */
export interface CppAlias extends CppDeclarationBase {
    readonly kind: 'alias';
    readonly type: CppTypeRef;
    readonly syntax: 'typedef' | 'using' | 'usingDeclaration';
}

/**
 * A constant: a `constexpr` or `const` variable at namespace scope or a `static constexpr` /
 * `static const` data member (non-const variables are not recorded).
 */
export interface CppConstant extends CppDeclarationBase {
    readonly kind: 'constant';
    readonly type: CppTypeRef;
    readonly initializer?: CppExpression;
    readonly constexpr: boolean;
    readonly static: boolean;
    readonly inline: boolean;
    readonly extern: boolean;
    /** Access of a static member (`undefined` at namespace scope). */
    readonly access?: CppAccess;
}

export type CppDeclaration =
    | CppNamespace | CppNamespaceAlias | CppUsingDirective | CppEnum | CppEnumerator | CppRecord
    | CppField | CppAlias | CppConstant;

/** `#include "x.h"` / `#include <x>` (only includes in active preprocessor branches). */
export interface CppInclude {
    readonly path: string;
    readonly system: boolean;
    readonly range: CppRange;
}

/** A `#define` of the header (used for `#if` evaluation and expanded in the header). */
export interface CppMacro {
    readonly name: string;
    /** Parameter names of a function-like macro (`undefined` for object-like macros). */
    readonly parameters?: readonly string[];
    readonly body: string;
    readonly range: CppRange;
}

/**
 * A type name declared by a header that the index does not model: a forward declaration of a class
 * (`class Driver;`) or a class / alias template (`template <typename T> class Buffer {…};`). Such names
 * are valid C++ types of the C++ class sections (references, pointers, template arguments).
 */
export interface CppOtherTypeName {
    readonly kind: 'forward' | 'template';
    /** Qualified name, e.g. `app::Driver`. */
    readonly qualifiedName: string;
    readonly range: CppRange;
}

/** The syntactic model of one header. */
export interface CppHeader {
    readonly fileName: string;
    /** Top-level declarations (namespaces contain their members). */
    readonly declarations: readonly CppDeclaration[];
    /** Forward declared classes and templates (not part of {@link declarations}). */
    readonly otherTypes?: readonly CppOtherTypeName[];
    readonly includes: readonly CppInclude[];
    readonly macros: readonly CppMacro[];
    readonly diagnostics: readonly CppDiagnostic[];
}

/** Options of `parseCppHeader` (and of the evaluation in `CppTypeIndex`). */
export interface CppParseOptions {
    /**
     * Predefined object-like macros for the evaluation of `#if` / `#ifdef` and for expansion
     * (value `''` for a macro without value). `__cplusplus` is predefined as `201703L`, as well as
     * `__CHAR_BIT__`, `__INT_MAX__` and a few other data model independent GCC / Clang macros.
     */
    readonly defines?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------------------------
// Resolved model
// ---------------------------------------------------------------------------------------------

/** Width of `long` / `size_t` etc. used by `CppTypeIndex` (default: LP64, i.e. 64-bit `long`). */
export interface CppDataModel {
    /** Bits of `long` / `unsigned long` (32 on Windows and 32-bit targets like ARM Cortex-M). */
    readonly longBits: 32 | 64;
    /** Bits of pointers, `size_t`, `ptrdiff_t`, `intptr_t`. */
    readonly pointerBits: 32 | 64;
    /** Whether plain `char` is signed. */
    readonly charSigned: boolean;
}

/** Integer type (fundamental, fixed-width `<cstdint>` type, character type). */
export interface CppIntegerType {
    readonly kind: 'integer';
    /** Canonical C++ spelling, e.g. `std::uint8_t`, `unsigned int`, `char`. */
    readonly cppName: string;
    readonly bits: 8 | 16 | 32 | 64 | 128;
    readonly signed: boolean;
    /** Character types (`char`, `wchar_t`, `char8_t`, `char16_t`, `char32_t`). */
    readonly character?: boolean;
}

export interface CppRealType {
    readonly kind: 'real';
    /** `float`, `double` or `long double`. */
    readonly cppName: string;
    /** 32 for `float`, 64 for `double` and `long double` (evaluated as double). */
    readonly bits: 32 | 64;
}

export interface CppBooleanType {
    readonly kind: 'boolean';
    readonly cppName: 'bool';
}

/** `std::string`, `std::string_view`, `const char*` (and `const char[]` constants). */
export interface CppStringType {
    readonly kind: 'string';
    readonly cppName: string;
}

export interface CppResolvedEnumerator {
    readonly name: string;
    readonly qualifiedName: string;
    /**
     * The value computed like a C++ compiler does. For enumerators whose value cannot be computed
     * (`valid: false`) this is only a placeholder (the previous value + 1, or 0) that keeps the
     * values of the enum distinct in the simulation; it must not be displayed (see `unknown`).
     */
    readonly value: bigint;
    /** Whether the value could be computed. */
    readonly valid: boolean;
    /** `explicit`: the enumerator has an initializer (`A = 5`); `implicit`: previous value + 1, or 0 for the first. */
    readonly origin: 'explicit' | 'implicit';
    /** The initializer as written in the header (`A | B`, `FLAG(3)`), for explicit values. */
    readonly expression?: string;
    /**
     * Values that cannot be computed (`valid: false`): the initializer that cannot be evaluated (of
     * this or the last explicit enumerator), the distance to it (`FOO(3)` + 2 for the second implicit
     * successor of `X = FOO(3)`) and the reason.
     */
    readonly unknown?: { readonly expression: string; readonly offset: bigint; readonly reason: string };
    /**
     * An error of the value in C++ (the program is ill-formed), e.g. a value that does not fit into
     * the fixed underlying type (`enum class E : uint8_t { A = 256 }`). `value` is the computed value.
     */
    readonly error?: string;
    readonly declaration: CppEnumerator;
}

export interface CppEnumType {
    readonly kind: 'enum';
    /** Qualified name (the spelling for generated code). */
    readonly cppName: string;
    readonly declaration: CppEnum;
    readonly scoped: boolean;
    /** The fixed underlying type, or the type deduced from the values (`int` if all values fit). */
    readonly underlying: CppIntegerType;
    readonly enumerators: readonly CppResolvedEnumerator[];
}

export interface CppResolvedField {
    readonly name: string;
    readonly type: CppResolvedType;
    readonly declaration: CppField;
    /** Qualified name of the base class declaring the field (inherited public fields). */
    readonly inheritedFrom?: string;
    readonly bitWidth?: number;
    /** The value of the default member initializer (`undefined` if there is none or it cannot be evaluated). */
    readonly defaultValue?: CppValue;
}

export interface CppStructType {
    readonly kind: 'struct';
    /** Qualified name (the spelling for generated code). */
    readonly cppName: string;
    readonly declaration: CppRecord;
    /** Public non-static data members, inherited ones (of resolvable public bases) first. */
    readonly fields: readonly CppResolvedField[];
    /**
     * Whether the type is an aggregate (no user constructors, no virtual functions, no non-public
     * data members, public bases only): it can be initialized with `T{…}` in generated code.
     */
    readonly aggregate: boolean;
}

export interface CppArrayType {
    readonly kind: 'array';
    /** Spelling, e.g. `std::array<uint8_t, 4>` or `uint8_t[4]`. */
    readonly cppName: string;
    readonly element: CppResolvedType;
    /** Length (`undefined` for `T[]` or a length that cannot be evaluated). */
    readonly length?: number;
}

export interface CppUnsupportedType {
    readonly kind: 'unsupported';
    readonly cppName: string;
    /** Why the type cannot be used, e.g. `pointer type`, `unknown type 'Foo'`, `union`. */
    readonly reason: string;
}

/** A C++ type classified for the state machine language. Aliases are always resolved. */
export type CppResolvedType =
    | CppIntegerType | CppRealType | CppBooleanType | CppStringType | CppEnumType | CppStructType
    | CppArrayType | CppUnsupportedType;

/** Value of a struct constant / default: field name -> value, in field order. */
export interface CppStructValue {
    readonly [field: string]: CppValue;
}

/**
 * A constant value. Like the runtime values of the HSM interpreter, integers (and enum values,
 * i.e. the enumerator's numeric value) are `bigint` and reals are `number`; structs are plain
 * objects and arrays are arrays.
 */
export type CppValue = bigint | number | boolean | string | readonly CppValue[] | CppStructValue;
