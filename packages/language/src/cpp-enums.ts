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
