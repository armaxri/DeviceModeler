import type { CppEnumType, CppResolvedEnumerator } from './cpp-header/model.js';
import type { CppTypeIndex } from './cpp-header/type-index.js';

/**
 * Helpers for the enums of imported C/C++ headers: how enumerators are written in models and
 * messages for misspelled enumerators. Used by validation (linking errors, unknown C++ names) and
 * the language server (completion, hover).
 *
 * In models, C++ values are written fully qualified with `::` (see docs/cpp-integration.md §4.1):
 * - enumerators of an `enum class` / `enum struct` with the enum name: `motor::Mode::Fast`,
 * - enumerators of unscoped enums like in C/C++ code in the enclosing scope: `motor::kJam`, and in the
 *   global namespace with the leading `::` (`::RED`); the enum name is also accepted (`::Color::RED`).
 */

/** The model spelling of a qualified C++ name used as value: names of the global namespace get the leading `::`. */
export function cppValueName(qualifiedName: string): string {
    return qualifiedName.includes('::') ? qualifiedName : `::${qualifiedName}`;
}

/**
 * The spelling of an enumerator in models (see above): `motor::Mode::Fast` for an `enum class`,
 * `motor::kJam` / `::RED` for an unscoped enum (`motor::Fault::kJam` if the short name is hidden).
 */
export function enumeratorSpelling(type: CppEnumType, enumerator: CppResolvedEnumerator, index: CppTypeIndex): string {
    const qualified = cppValueName(enumerator.qualifiedName);
    if (type.scoped) {
        return qualified;
    }
    const enumName = type.declaration.qualifiedName;
    const separator = enumName.lastIndexOf('::');
    const short = separator >= 0 ? `${enumName.slice(0, separator)}::${enumerator.name}` : `::${enumerator.name}`;
    return index.lookup(short) === enumerator.declaration ? short : qualified;
}

/**
 * Detail for an unknown qualified C++ name whose qualifier is an enum (`motor::Mode::Fsat`):
 * the enumerators of the enum. `undefined` if the qualifier is not an enum.
 */
export function unknownEnumeratorDetail(name: string, index: CppTypeIndex): string | undefined {
    const compact = name.replace(/\s+/g, '');
    const separator = compact.lastIndexOf('::');
    if (separator <= 0) {
        return undefined;
    }
    const qualifier = compact.slice(0, separator);
    const member = compact.slice(separator + 2);
    let type;
    try {
        type = index.resolveType(qualifier);
    } catch {
        return undefined;
    }
    if (type?.kind !== 'enum') {
        return undefined;
    }
    if (type.enumerators.length === 0) {
        return `'${qualifier}' is declared without enumerators (opaque declaration '${type.declaration.scoped ? 'enum class' : 'enum'} ${type.cppName} : ${type.underlying.cppName};'); its values are written 'n as ${qualifier}'.`;
    }
    const names = type.enumerators.map(e => e.name);
    const similar = names.filter(n => n.toLowerCase() === member.toLowerCase());
    return `'${qualifier}' has no enumerator '${member}'${similar.length > 0 ? ` (did you mean '${qualifier}::${similar[0]}'?)` : ''} (enumerators: ${names.join(', ')}).`;
}

/**
 * The model spellings of the enumerators (and constants) of the imported headers whose simple name
 * is `name`, e.g. `['motor::Mode::Fast']` for `Fast`, `['::RED']` for `RED` (at most 5).
 */
export function cppValueSuggestions(name: string, index: CppTypeIndex): string[] {
    const result: string[] = [];
    for (const declaration of index.allDeclarations()) {
        if (declaration.kind === 'enum' && !declaration.opaque) {
            const type = index.typeOf(declaration);
            if (type.kind === 'enum') {
                for (const enumerator of type.enumerators) {
                    if (enumerator.name === name) {
                        result.push(enumeratorSpelling(type, enumerator, index));
                    }
                }
            }
        } else if (declaration.kind === 'constant' && declaration.name === name) {
            result.push(cppValueName(declaration.qualifiedName));
        }
    }
    return [...new Set(result)].slice(0, 5);
}

/**
 * The enumerator of an enum written as text by hosts and scenarios: the simple name (`Fast`), the
 * qualified name (`motor::Mode::Fast`, also with a leading `::`) or, for unscoped enums, the name in
 * the enclosing scope (`motor::kJam`, `::RED`).
 */
export function findEnumerator(type: CppEnumType, text: string): CppResolvedEnumerator | undefined {
    const name = text.trim().replace(/\s+/g, '').replace(/^::/, '');
    const enumName = type.cppName;
    const simple = name.startsWith(`${enumName}::`) ? name.slice(enumName.length + 2) : name;
    const separator = enumName.lastIndexOf('::');
    const outer = separator >= 0 ? `${enumName.slice(0, separator)}::` : '';
    return type.enumerators.find(e => e.name === simple || e.qualifiedName === name)
        ?? (type.scoped || !outer ? undefined : type.enumerators.find(e => `${outer}${e.name}` === name));
}

// ---------------------------------------------------------------------------------------------
// Display of enumerator values (hover, completion, enum listings, value editors). The values are
// computed by the header analyzer like a C++ compiler does (cpp-header/type-index.ts, resolveEnum).

/** Whether an initializer uses bit operations or a hex / binary literal (a flag-like value). */
function flagLike(expression: string | undefined): boolean {
    return expression !== undefined && /\||&|\^|~|<<|>>|\b0[xXbB]/.test(expression.replace(/&&|\|\|/g, ''));
}

/**
 * The hexadecimal spelling of an enumerator value (`0xFF`) for values greater than 9 and for flag-like
 * values (initializers with bit operations, hex or binary literals); negative flag-like values in the
 * two's complement of the underlying type (`~0` → `0xFFFFFFFF`). `undefined` if no hex is shown.
 */
export function enumeratorHex(enumerator: CppResolvedEnumerator, type: CppEnumType): string | undefined {
    if (enumerator.unknown) {
        return undefined;
    }
    const value = enumerator.value;
    const flags = flagLike(enumerator.expression);
    if (value > 9n || (flags && value >= 0n)) {
        return `0x${value.toString(16).toUpperCase()}`;
    }
    if (flags && value < 0n) {
        return `0x${BigInt.asUintN(type.underlying.bits, value).toString(16).toUpperCase()}`;
    }
    return undefined;
}

/** The initializer of an enumerator if it says more than the value (not just the decimal or hex literal of the value). */
function derivation(enumerator: CppResolvedEnumerator, hex: string | undefined): string | undefined {
    const expression = enumerator.expression;
    if (expression === undefined) {
        return undefined;
    }
    const plain = expression.replace(/\s+/g, '');
    return plain === enumerator.value.toString() || (hex !== undefined && plain.toLowerCase() === hex.toLowerCase()) ? undefined : expression;
}

/** The relative spelling of an unknown value: `FOO(3)`, `FOO(3) + 2`. */
function unknownExpression(unknown: NonNullable<CppResolvedEnumerator['unknown']>): string {
    return unknown.offset === 0n ? unknown.expression : `${unknown.expression} + ${unknown.offset}`;
}

/**
 * The value of an enumerator as short text (completion details, value editors): `5`, `255 (0xFF)`,
 * `6 (implicit)`, `unknown (FOO(3) + 1)`, `256 (0x100, does not fit into std::uint8_t)`.
 */
export function enumeratorValueText(enumerator: CppResolvedEnumerator, type: CppEnumType): string {
    if (enumerator.unknown) {
        return `unknown (${unknownExpression(enumerator.unknown)})`;
    }
    const notes = [enumeratorHex(enumerator, type), enumerator.origin === 'implicit' ? 'implicit' : undefined,
        enumerator.error ? `does not fit into ${type.underlying.cppName}` : undefined].filter(n => n);
    return `${enumerator.value}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
}

/**
 * The value of an enumerator as Markdown for hovers and completion documentation, e.g.
 * - ``value `3` (`0x3`) = `A | B` ``
 * - ``value `6` (implicit: `Five` + 1)``, ``value `0` (implicit: first enumerator)``
 * - ``value unknown: `FOO(3)` (unknown name 'FOO')``, ``value unknown: `FOO(3) + 1` (implicit: `X` + 1)``
 * - ``value `256` (`0x100`): error in C++, the value does not fit into the underlying type `std::uint8_t` ``
 */
export function enumeratorValueMarkdown(enumerator: CppResolvedEnumerator, type: CppEnumType): string {
    const position = type.enumerators.indexOf(enumerator);
    const previous = position > 0 ? type.enumerators[position - 1] : undefined;
    if (enumerator.unknown) {
        const unknown = enumerator.unknown;
        return `value unknown: \`${unknownExpression(unknown)}\` (${unknown.offset === 0n ? unknown.reason : `implicit: \`${previous?.name}\` + 1`})`;
    }
    const hex = enumeratorHex(enumerator, type);
    let text = `value \`${enumerator.value}\`${hex ? ` (\`${hex}\`)` : ''}`;
    if (enumerator.origin === 'implicit') {
        text += previous ? ` (implicit: \`${previous.name}\` + 1)` : ' (implicit: first enumerator)';
    } else {
        const expression = derivation(enumerator, hex);
        if (expression !== undefined) {
            text += ` = \`${expression}\``;
        }
    }
    if (enumerator.error) {
        text += `: error in C++, the value does not fit into the underlying type \`${type.underlying.cppName}\``;
    }
    return text;
}

/**
 * One enumerator in the listing of an enum (hover of the enum): name and computed value with hex,
 * origin and derivation, e.g. `` `Green = 2` ``, `` `Red = 0` (implicit) ``, `` `Hex = 255` (`0xFF`) ``,
 * `` `Mask = 3` (`0x3`, from `A | B`) ``, `` `X`: value unknown (`FOO(3)`) ``, `` `Y`: value unknown (`FOO(3) + 1`) ``.
 */
export function enumeratorListItem(enumerator: CppResolvedEnumerator, type: CppEnumType): string {
    if (enumerator.unknown) {
        return `\`${enumerator.name}\`: value unknown (\`${unknownExpression(enumerator.unknown)}\`)`;
    }
    const hex = enumeratorHex(enumerator, type);
    const expression = enumerator.origin === 'explicit' ? derivation(enumerator, hex) : undefined;
    const notes = [
        hex ? `\`${hex}\`` : undefined,
        enumerator.origin === 'implicit' ? 'implicit' : undefined,
        expression !== undefined ? `from \`${expression}\`` : undefined,
        enumerator.error ? `error: does not fit into \`${type.underlying.cppName}\`` : undefined
    ].filter(n => n);
    return `\`${enumerator.name} = ${enumerator.value}\`${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
}
