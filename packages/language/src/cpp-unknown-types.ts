import { AstUtils, CstUtils, isLeafCstNode, type LeafCstNode, type URI } from 'langium';
import type { Range } from 'vscode-languageserver-types';
import * as ast from './generated/ast.js';
import type { CppTypeIndex } from './cpp-header/type-index.js';
import { availableHeaders, loadHeaderClosure, type CppHeaderStore } from './cpp-headers.js';
import { isClassMember, isHsmTypeReference } from './class-members.js';
import { cppImports, machineType, resolvedImports } from './imports.js';

/**
 * Unknown C++ types in the C++ class sections (see docs/language.md#c-class-sections).
 *
 * The types of class members are passed to the generated C++ code as written, so any C++ type can be
 * declared. A type name that is not declared in the imported headers gets no highlighting, hover,
 * completion or navigation and the generated code only compiles if other includes declare it, so the
 * validator warns about it ({@link unknownCppTypes}) and the quick fix imports the header that
 * declares it ({@link headersDeclaring}). A name is known if it is
 * - a fundamental type (`unsigned int`), an HSM type or type alias, a `<cstdint>` / `<cstddef>` typedef
 *   (`uint8_t`, `std::size_t`) or a library type of the tool (`std::string`, `std::string_view`, `std::array`),
 * - declared in an imported header or a header it includes: a definition, a type alias, a forward
 *   declaration (`class Driver;`) or a template (`template <typename T> class Buffer`), also relative to the
 *   namespace of the model,
 * - a `std::` name whose standard header (a small built-in map: `std::vector` → `<vector>`,
 *   `std::unique_ptr` → `<memory>`, …) is imported (`import "<vector>"`) or included by an imported header;
 *   other `std::` names are accepted if any system header is imported or included (they cannot be verified),
 * - any name if a header that cannot be analysed is imported or included: a system header that is not a
 *   standard header (`import "<QString>"`) or a header that was not found; unqualified names also if a
 *   header of the C library declaring types is included (`<cstdio>`: `FILE`; not `<cstdint>`).
 */

/** The standard header declaring a `std::` name (the name after `std::`). */
export const STD_HEADER_OF: Readonly<Record<string, string>> = {
    vector: '<vector>', string: '<string>', wstring: '<string>', u16string: '<string>', u32string: '<string>', basic_string: '<string>',
    string_view: '<string_view>', array: '<array>', map: '<map>', multimap: '<map>', set: '<set>', multiset: '<set>',
    unordered_map: '<unordered_map>', unordered_multimap: '<unordered_map>', unordered_set: '<unordered_set>', unordered_multiset: '<unordered_set>',
    list: '<list>', forward_list: '<forward_list>', deque: '<deque>', queue: '<queue>', priority_queue: '<queue>', stack: '<stack>',
    pair: '<utility>', tuple: '<tuple>', unique_ptr: '<memory>', shared_ptr: '<memory>', weak_ptr: '<memory>',
    optional: '<optional>', variant: '<variant>', any: '<any>', function: '<functional>', reference_wrapper: '<functional>',
    bitset: '<bitset>', atomic: '<atomic>', mutex: '<mutex>', recursive_mutex: '<mutex>', condition_variable: '<condition_variable>',
    thread: '<thread>', chrono: '<chrono>', complex: '<complex>', span: '<span>', initializer_list: '<initializer_list>',
    istream: '<istream>', ostream: '<ostream>', iostream: '<iostream>', stringstream: '<sstream>', ostringstream: '<sstream>',
    istringstream: '<sstream>', ifstream: '<fstream>', ofstream: '<fstream>', fstream: '<fstream>', valarray: '<valarray>',
    regex: '<regex>', exception: '<exception>', runtime_error: '<stdexcept>', logic_error: '<stdexcept>', FILE: '<cstdio>',
    nullptr_t: '<cstddef>', max_align_t: '<cstddef>', time_t: '<ctime>', tm: '<ctime>', div_t: '<cstdlib>', ldiv_t: '<cstdlib>'
};

/** `std::` names the tool knows without import (types of the model, `<cstdint>` typedefs are known by the index). */
const KNOWN_STD_NAMES: ReadonlySet<string> = new Set(['string', 'string_view', 'byte', 'array']);

/** Headers of the C library (`<cstdio>`, `<stdio.h>`): they declare global names. */
const C_LIBRARY = ['assert', 'ctype', 'errno', 'fenv', 'float', 'inttypes', 'iso646', 'limits', 'locale', 'math', 'setjmp', 'signal',
    'stdalign', 'stdarg', 'stdbool', 'stddef', 'stdint', 'stdio', 'stdlib', 'string', 'tgmath', 'time', 'uchar', 'wchar', 'wctype'];
const C_LIBRARY_HEADERS: ReadonlySet<string> = new Set(C_LIBRARY.flatMap(name => [`<c${name}>`, `<${name}.h>`]));
/** Headers of the C library declaring global types other than the integer typedefs (`FILE`, `time_t`, `va_list`). */
const C_TYPE_HEADERS: ReadonlySet<string> = new Set(['stdio', 'time', 'stdlib', 'stdarg', 'setjmp', 'signal', 'wchar', 'wctype', 'locale', 'fenv', 'stddef', 'uchar', 'math']
    .flatMap(name => [`<c${name}>`, `<${name}.h>`]));

/** The headers of the C++ standard library (they only declare `std::` names, apart from the C library). */
const STANDARD_HEADERS: ReadonlySet<string> = new Set([
    ...C_LIBRARY_HEADERS, ...Object.values(STD_HEADER_OF),
    ...['algorithm', 'bit', 'charconv', 'codecvt', 'compare', 'concepts', 'coroutine', 'execution', 'filesystem', 'format', 'future',
        'iomanip', 'ios', 'iosfwd', 'iterator', 'limits', 'memory_resource', 'new', 'numbers', 'numeric', 'random', 'ranges', 'ratio',
        'scoped_allocator', 'semaphore', 'shared_mutex', 'source_location', 'stop_token', 'streambuf', 'syncstream', 'system_error',
        'type_traits', 'typeindex', 'typeinfo', 'version', 'barrier', 'latch', 'expected', 'print', 'stacktrace', 'spanstream',
        'mdspan', 'flat_map', 'flat_set', 'generator', 'cstddef', 'cstdint'].map(name => `<${name}>`)
]);

/** A (qualified) name in a type of a class member (`EpicProject::Driver` in `const EpicProject::Driver&`). */
export interface CppTypeNameOccurrence {
    /** The name as written without white space (`EpicProject::Driver`, `::Color`). */
    readonly text: string;
    /** The identifiers of the name. */
    readonly segments: readonly LeafCstNode[];
    /** Whether the name contains `.` (a qualified HSM name like `Interface.Alias`). */
    readonly dotted: boolean;
    /** Whether it is the first name of the type (the type itself, not a template argument). */
    readonly first: boolean;
    readonly range: Range;
}

/** The (qualified) names in a type reference, in text order (template arguments included). */
export function cppTypeNames(reference: ast.TypeReference): CppTypeNameOccurrence[] {
    const root = reference.$cstNode;
    if (!root) {
        return [];
    }
    const leaves = CstUtils.streamCst(root).filter((n): n is LeafCstNode => isLeafCstNode(n) && !n.hidden).toArray();
    const result: CppTypeNameOccurrence[] = [];
    let i = 0;
    while (i < leaves.length) {
        const start = i;
        const global = leaves[i].text === '::' && leaves[i + 1]?.tokenType.name === 'ID';
        if (global) {
            i++;
        }
        if (leaves[i]?.tokenType.name !== 'ID') {
            i = start + 1;
            continue;
        }
        const segments = [leaves[i++]];
        let dotted = false;
        while ((leaves[i]?.text === '::' || leaves[i]?.text === '.') && leaves[i + 1]?.tokenType.name === 'ID') {
            dotted ||= leaves[i].text === '.';
            segments.push(leaves[i + 1]);
            i += 2;
        }
        const text = leaves.slice(start, i).map(l => l.text).join('');
        result.push({
            text, segments, dotted, first: result.length === 0,
            range: { start: leaves[start].range.start, end: segments[segments.length - 1].range.end }
        });
    }
    return result;
}

/** An unknown C++ type name in a type of a class member. */
export interface UnknownCppTypeName {
    readonly name: CppTypeNameOccurrence;
    /** The range of the unknown part: from the first segment that is not declared (`Driver` in `EpicProject::Driver`). */
    readonly range: Range;
    /** For `std::` names: the standard header declaring it (`<vector>`), if known. */
    readonly standardHeader?: string;
    /** Whether it is a `std::` name. */
    readonly std: boolean;
}

interface NameContext {
    readonly index: CppTypeIndex;
    /** Namespace scopes of the model, innermost first (`a::b`, `a`). */
    readonly namespaces: readonly string[];
    /** Standard headers imported or included by the imported headers (`<vector>`). */
    readonly standardHeaders: ReadonlySet<string>;
    /** Whether a header that cannot be analysed is imported or included (names cannot be verified). */
    readonly unverifiable: boolean;
    readonly otherTypes: ReadonlySet<string>;
}

const contexts = new WeakMap<ast.StateMachine, { index: CppTypeIndex, context: NameContext }>();

function nameContext(machine: ast.StateMachine): NameContext {
    const info = cppImports(machine);
    const cached = contexts.get(machine);
    if (cached && cached.index === info.index) {
        return cached.context;
    }
    const standardHeaders = new Set<string>();
    let unverifiable = false;
    const addSystem = (header: string) => {
        if (STANDARD_HEADERS.has(header)) {
            standardHeaders.add(header);
        } else {
            unverifiable = true;
        }
    };
    for (const resolved of resolvedImports(machine)) {
        if (resolved.kind === 'system') {
            addSystem(resolved.path.trim());
        }
    }
    const loaded = info.headers.map(h => h.uri.toString());
    const isLoaded = (path: string) => loaded.some(uri => uri.endsWith(`/${path.replace(/\\/g, '/').replace(/^\.\//, '')}`));
    const otherTypes = new Set<string>();
    for (const { header } of info.headers) {
        for (const include of header.includes) {
            if (isLoaded(include.path)) {
                continue;
            }
            if (include.system) {
                addSystem(`<${include.path}>`);
            } else {
                unverifiable = true; // an include of a header that was not found
            }
        }
        for (const other of header.otherTypes ?? []) {
            otherTypes.add(other.qualifiedName);
        }
    }
    const parts = (machine.namespace ?? '').split(/::|\./).filter(p => p);
    const namespaces = parts.map((_, i) => parts.slice(0, parts.length - i).join('::'));
    const context = { index: info.index, namespaces, standardHeaders, unverifiable, otherTypes };
    contexts.set(machine, { index: info.index, context });
    return context;
}

/** Whether a (qualified) name without leading `::` is declared in the headers, also relative to the namespaces of the model. */
function isDeclared(context: NameContext, text: string, global: boolean): boolean {
    const scopes = global ? [''] : [...context.namespaces, ''];
    for (const scope of scopes) {
        const declaration = context.index.lookup(text, scope || undefined);
        if (declaration && declaration.kind !== 'namespace') {
            return true;
        }
        if (context.otherTypes.has(scope ? `${scope}::${text}` : text)) {
            return true;
        }
    }
    return false;
}

/** Whether a name is a namespace or a type of the headers (a qualifier of a longer name). */
function isScopeName(context: NameContext, text: string, global: boolean): boolean {
    const scopes = global ? [''] : [...context.namespaces, ''];
    return scopes.some(scope => context.index.lookupAll(text, scope || undefined).length > 0 || context.otherTypes.has(scope ? `${scope}::${text}` : text));
}

/**
 * The unknown C++ type names of a type of a class member (empty for other type references and if a
 * header import of the model was not found: that is reported at the import).
 */
export function unknownCppTypes(reference: ast.TypeReference): UnknownCppTypeName[] {
    const machine = AstUtils.getContainerOfType(reference, ast.isStateMachine);
    if (!machine || !isClassMember(reference)) {
        return [];
    }
    if (resolvedImports(machine).some(i => i.kind === 'header' && !i.header?.found)) {
        return [];
    }
    const names = cppTypeNames(reference);
    if (names.length === 0 || (isHsmTypeReference(reference) || machineType(reference))) {
        return [];
    }
    const context = nameContext(machine);
    const result: UnknownCppTypeName[] = [];
    for (const name of names) {
        if (name.dotted) {
            continue;
        }
        const global = name.text.startsWith('::');
        const bare = global ? name.text.substring(2) : name.text;
        const parts = bare.split('::');
        if (isDeclared(context, bare, global)) {
            continue;
        }
        const resolved = context.index.resolveType(name.text);
        if (resolved && resolved.kind !== 'unsupported') {
            continue; // fundamental types, <cstdint> typedefs, std::string
        }
        const std = parts[0] === 'std' && parts.length > 1;
        let standardHeader: string | undefined;
        if (std) {
            if (KNOWN_STD_NAMES.has(parts[1])) {
                continue;
            }
            standardHeader = STD_HEADER_OF[parts[1]];
            if (standardHeader ? context.standardHeaders.has(standardHeader) : context.standardHeaders.size > 0 || context.unverifiable) {
                continue;
            }
        } else if (context.unverifiable || (parts.length === 1 && [...context.standardHeaders].some(h => C_TYPE_HEADERS.has(h)))) {
            continue;
        }
        // the first segment that is not declared (`std` counts as declared)
        let first = 0;
        while (first < parts.length - 1 && ((first === 0 && std) || isScopeName(context, parts.slice(0, first + 1).join('::'), global))) {
            first++;
        }
        result.push({ name, range: { start: name.segments[first].range.start, end: name.range.end }, standardHeader, std });
    }
    return result;
}

/** Escapes a string for a regular expression. */
function escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The import paths of the headers that declare a (qualified) C++ type name: headers in the directory of
 * the model and in the include paths ({@link availableHeaders}) which are not imported yet. Headers that
 * define the type themselves come first, then headers that declare it in an included header or only
 * forward declare it.
 */
export function headersDeclaring(store: CppHeaderStore, documentUri: URI, name: string, namespace?: string): string[] {
    const bare = name.replace(/^::/, '');
    const simple = bare.substring(bare.lastIndexOf(':') + 1);
    const word = new RegExp(`\\b${escape(simple)}\\b`);
    const settings = store.settingsFor(documentUri);
    const parts = (namespace ?? '').split(/::|\./).filter(p => p);
    const scopes = name.startsWith('::') ? [''] : [...parts.map((_, i) => parts.slice(0, parts.length - i).join('::')), ''];
    const found: Array<{ importPath: string, rank: number }> = [];
    for (const candidate of availableHeaders(store, documentUri, settings)) {
        const text = store.get(candidate.uri)?.text;
        if (!text || !word.test(text)) {
            continue;
        }
        const headers = loadHeaderClosure(store, candidate.uri, settings);
        if (headers.length === 0) {
            continue;
        }
        const index = store.index(headers, settings);
        let rank: number | undefined;
        for (const scope of scopes) {
            const declaration = index.lookup(bare, scope || undefined);
            if (declaration && declaration.kind !== 'namespace') {
                rank = declaration.fileName === candidate.uri.toString() ? 0 : 1;
                break;
            }
            const qualified = scope ? `${scope}::${bare}` : bare;
            const other = headers.flatMap(h => (h.header.otherTypes ?? []).filter(o => o.qualifiedName === qualified).map(o => ({ o, own: h.uri.toString() === candidate.uri.toString() })))[0];
            if (other) {
                rank = other.o.kind === 'template' && other.own ? 0 : 2;
                break;
            }
        }
        if (rank !== undefined) {
            found.push({ importPath: candidate.importPath, rank });
        }
    }
    return found.sort((a, b) => a.rank - b.rank || a.importPath.split('/').length - b.importPath.split('/').length || a.importPath.localeCompare(b.importPath))
        .map(f => f.importPath);
}

/** The code of the diagnostic of an unknown C++ type (its `data` is {@link UnknownCppTypeData}). */
export const UNKNOWN_CPP_TYPE = 'unknown-cpp-type';

/** The data of the diagnostic of an unknown C++ type: the path to import (quick fix), if one was found. */
export interface UnknownCppTypeData {
    readonly name: string;
    readonly importPath?: string;
}

/** The message and data of the diagnostic of an unknown C++ type. */
export function unknownCppTypeDiagnostic(unknown: UnknownCppTypeName, store: CppHeaderStore | undefined, documentUri: URI | undefined): { message: string, data: UnknownCppTypeData } {
    const name = unknown.name.text;
    const consequence = 'the type is passed to the generated C++ code as written, which only compiles if other includes declare it.';
    if (unknown.std) {
        const header = unknown.standardHeader;
        return {
            message: header
                ? `Unknown type '${name}': its standard header is not imported. Import it (import "${header}"); ${consequence}`
                : `Unknown type '${name}': no standard header is imported. Import the header that declares it (import "<header>"); ${consequence}`,
            data: { name, ...(header ? { importPath: header } : {}) }
        };
    }
    const machine = AstUtils.getContainerOfType(unknown.name.segments[0].astNode, ast.isStateMachine);
    const importPath = store && documentUri ? headersDeclaring(store, documentUri, name, machine?.namespace)[0] : undefined;
    return {
        message: importPath
            ? `Unknown type '${name}': it is not declared in the imported headers. Import its header (import "${importPath}") for highlighting, hover, completion and navigation; ${consequence}`
            : `Unknown type '${name}': it is not declared in the imported headers. Import its header for highlighting, hover, completion and navigation; ${consequence}`,
        data: { name, ...(importPath ? { importPath } : {}) }
    };
}
