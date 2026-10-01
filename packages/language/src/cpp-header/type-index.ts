import {
    convertScalar, DEFAULT_DATA_MODEL, evaluateExpression, EvaluationError, integerFits, toCppValue, zeroValue,
    type EvalValue, type EvaluationContext
} from './evaluator.js';
import { LineMap, tokenize } from './lexer.js';
import { forEachCppDeclaration, parseCppHeader } from './parser.js';
import { qualifiedNameText, SyntaxError, TokenCursor } from './syntax.js';
import type {
    CppAlias, CppConstant, CppDataModel, CppDeclaration, CppDiagnostic, CppDiagnosticSeverity, CppEnum, CppEnumerator,
    CppEnumType, CppExpressionNode, CppHeader, CppIntegerType, CppParseOptions, CppQualifiedName, CppRange, CppRecord,
    CppResolvedEnumerator, CppResolvedField, CppResolvedType, CppStructType, CppStructValue, CppTypeName, CppTypeRef,
    CppValue
} from './model.js';

/** Options of {@link CppTypeIndex}. */
export interface CppTypeIndexOptions {
    /** Widths of `long`, pointers / `size_t` and the signedness of `char` (default: LP64, signed `char`). */
    readonly dataModel?: Partial<CppDataModel>;
}

/** The type and value of a constant or enumerator. */
export interface CppConstantInfo {
    readonly declaration: CppConstant | CppEnumerator;
    /** The type of the constant (for enumerators: the enum type). */
    readonly type: CppResolvedType;
    /** The value; `undefined` if it cannot be computed (see `error`). */
    readonly value?: CppValue;
    readonly error?: string;
}

/** Result of {@link CppTypeIndex.evaluate}. */
export type CppEvaluationResult =
    | { readonly value: CppValue; readonly type: CppResolvedType; readonly error?: undefined }
    | { readonly error: string; readonly value?: undefined; readonly type?: undefined };

/** Declarations that denote types. */
export type CppTypeDeclaration = CppEnum | CppRecord | CppAlias;

interface Scope {
    /** Qualified name (`''` for the global namespace). */
    readonly qualifiedName: string;
    readonly kind: 'namespace' | 'record' | 'enum';
    /** The enclosing scope used for unqualified lookup. */
    readonly parent?: Scope;
    readonly symbols: Map<string, CppDeclaration[]>;
    /** Inline namespaces (their members are visible in this scope). */
    readonly inlineNamespaces: Scope[];
    /** `using namespace` directives of this scope. */
    readonly usingDirectives: CppQualifiedName[];
    /** `using enum` declarations of this scope (C++20): the enumerators are members of the scope. */
    readonly usingEnums: CppQualifiedName[];
    readonly declaration?: CppRecord | CppEnum;
}

interface EnumState {
    readonly type: CppEnumType;
    readonly values: Map<CppEnumerator, bigint>;
    done: boolean;
}

const INTEGER_NAMES: Record<string, string> = {
    '8,true': 'signed char', '8,false': 'unsigned char', '16,true': 'short', '16,false': 'unsigned short',
    '32,true': 'int', '32,false': 'unsigned int', '64,true': 'long long', '64,false': 'unsigned long long',
    '128,true': '__int128', '128,false': 'unsigned __int128'
};

function integer(cppName: string, bits: number, signed: boolean, character?: boolean): CppIntegerType {
    return { kind: 'integer', cppName, bits: bits as CppIntegerType['bits'], signed, ...(character ? { character } : {}) };
}

function unsupported(cppName: string, reason: string): CppResolvedType {
    return { kind: 'unsupported', cppName, reason };
}

/** Fixed width and other integer typedefs of `<cstdint>` / `<cstddef>` (with or without `std::`). */
function libraryIntegerTypes(model: CppDataModel): Record<string, [number, boolean]> {
    const types: Record<string, [number, boolean]> = {
        intmax_t: [64, true], uintmax_t: [64, false],
        size_t: [model.pointerBits, false], ssize_t: [model.pointerBits, true], ptrdiff_t: [model.pointerBits, true],
        intptr_t: [model.pointerBits, true], uintptr_t: [model.pointerBits, false]
    };
    for (const bits of [8, 16, 32, 64]) {
        for (const prefix of ['', '_least', '_fast']) {
            types[`int${prefix}${bits}_t`] = [bits, true];
            types[`uint${prefix}${bits}_t`] = [bits, false];
        }
    }
    return types;
}

/**
 * Index over the declarations of several C++ headers: name lookup (with C++ scoping rules for the
 * supported subset), resolution of type references and aliases to canonical types, classification
 * of types for the state machine language and evaluation of constants and enumerator values.
 *
 * Everything is resolved lazily and memoized; results are deterministic (they depend only on the
 * headers and their order). Resolution problems are reported by {@link CppTypeIndex.diagnostics}.
 *
 * Name lookup:
 * - unqualified names are looked up from the given scope outwards (class scopes include base
 *   classes; `using namespace` directives and inline namespaces are followed),
 * - qualified names (`motor::Mode::Fast`, `::motor::kMax`) are looked up member by member; a type
 *   alias of an enum or class can be used as qualifier,
 * - enumerators of unscoped enums are also visible in the enclosing scope, members of anonymous
 *   namespaces in the enclosing namespace, members of inline namespaces in the enclosing namespace.
 */
export class CppTypeIndex {
    readonly headers: readonly CppHeader[];
    readonly dataModel: CppDataModel;

    private readonly global: Scope = CppTypeIndex.scope('', 'namespace');
    private readonly namespaceScopes = new Map<string, Scope>([['', this.global]]);
    private readonly scopesByName = new Map<string, Scope>([['', this.global]]);
    /** The scope in which a declaration is declared. */
    private readonly declarationScopes = new Map<CppDeclaration, Scope>();
    /** The scope of a record or enum (its members). */
    private readonly ownScopes = new Map<CppRecord | CppEnum, Scope>();
    private readonly enumOf = new Map<CppEnumerator, CppEnum>();
    private readonly libraryIntegers: Record<string, [number, boolean]>;

    private readonly enums = new Map<CppEnum, EnumState>();
    private readonly records = new Map<CppRecord, CppResolvedType>();
    private readonly aliases = new Map<CppAlias, CppResolvedType>();
    private readonly aliasesInProgress = new Set<CppAlias>();
    private readonly constants = new Map<CppConstant, CppConstantInfo>();
    private readonly constantsInProgress = new Set<CppConstant>();
    private readonly directivesInProgress = new Set<CppQualifiedName>();
    private readonly resolutionDiagnostics = new Map<string, CppDiagnostic>();
    private resolvedAll = false;

    constructor(headers: readonly CppHeader[], options: CppTypeIndexOptions = {}) {
        this.headers = headers;
        this.dataModel = { ...DEFAULT_DATA_MODEL, ...options.dataModel };
        this.libraryIntegers = libraryIntegerTypes(this.dataModel);
        for (const header of headers) {
            this.addDeclarations(header.declarations, this.global);
        }
    }

    /** Parses the given headers and creates an index over them. */
    static fromSources(sources: ReadonlyArray<{ readonly fileName: string, readonly text: string }>,
        options: CppParseOptions & CppTypeIndexOptions = {}): CppTypeIndex {
        return new CppTypeIndex(sources.map(source => parseCppHeader(source.text, source.fileName, options)), options);
    }

    private static scope(qualifiedName: string, kind: Scope['kind'], parent?: Scope, declaration?: CppRecord | CppEnum): Scope {
        return { qualifiedName, kind, parent, symbols: new Map(), inlineNamespaces: [], usingDirectives: [], usingEnums: [], declaration };
    }

    // -----------------------------------------------------------------------------------------
    // building
    // -----------------------------------------------------------------------------------------

    private addSymbol(scope: Scope, name: string, declaration: CppDeclaration): void {
        if (!name) {
            return;
        }
        let list = scope.symbols.get(name);
        if (!list) {
            list = [];
            scope.symbols.set(name, list);
        }
        if (!list.includes(declaration)) {
            if (declaration.kind === 'enum') {
                // opaque declarations (`enum class E : int;`) and the definition denote the same enum: the definition is used
                const other = list.findIndex(d => d.kind === 'enum');
                if (other >= 0 && declaration.opaque) {
                    return;
                }
                if (other >= 0 && (list[other] as CppEnum).opaque) {
                    list[other] = declaration;
                    return;
                }
            }
            const duplicate = list.find(other => other.kind === declaration.kind && other.kind !== 'namespace' && other.fileName !== declaration.fileName);
            if (duplicate) {
                this.report('warning', `'${declaration.qualifiedName}' is also declared in ${duplicate.fileName}; the first declaration is used`, declaration.fileName, declaration.nameRange);
            }
            list.push(declaration);
        }
    }

    private addDeclarations(declarations: readonly CppDeclaration[], scope: Scope): void {
        for (const declaration of declarations) {
            this.declarationScopes.set(declaration, scope);
            switch (declaration.kind) {
                case 'namespace': {
                    if (declaration.anonymous) {
                        this.addDeclarations(declaration.members, scope);
                        break;
                    }
                    this.addSymbol(scope, declaration.name, declaration);
                    let namespace = this.namespaceScopes.get(declaration.qualifiedName);
                    if (!namespace) {
                        namespace = CppTypeIndex.scope(declaration.qualifiedName, 'namespace', scope);
                        this.namespaceScopes.set(declaration.qualifiedName, namespace);
                        this.scopesByName.set(declaration.qualifiedName, namespace);
                    }
                    if (declaration.inline && !scope.inlineNamespaces.includes(namespace)) {
                        scope.inlineNamespaces.push(namespace);
                    }
                    this.addDeclarations(declaration.members, namespace);
                    break;
                }
                case 'usingDirective':
                    (declaration.enum ? scope.usingEnums : scope.usingDirectives).push(declaration.target);
                    break;
                case 'enum': {
                    // out-of-line definition of a nested enum (`enum class Outer::E : int { … };`): member of `Outer`
                    const enclosing = this.enclosingScopeOf(declaration, scope);
                    this.declarationScopes.set(declaration, enclosing);
                    this.addSymbol(enclosing, declaration.anonymous ? '' : declaration.name, declaration);
                    const own = CppTypeIndex.scope(declaration.qualifiedName, 'enum', enclosing, declaration);
                    this.ownScopes.set(declaration, own);
                    const known = this.scopesByName.get(declaration.qualifiedName);
                    if (!declaration.anonymous && (!known || (known.declaration?.kind === 'enum' && known.declaration.opaque && !declaration.opaque))) {
                        this.scopesByName.set(declaration.qualifiedName, own);
                    }
                    for (const enumerator of declaration.enumerators) {
                        this.declarationScopes.set(enumerator, own);
                        this.enumOf.set(enumerator, declaration);
                        this.addSymbol(own, enumerator.name, enumerator);
                        if (!declaration.scoped) {
                            this.addSymbol(enclosing, enumerator.name, enumerator);
                        }
                    }
                    break;
                }
                case 'record': {
                    this.addSymbol(scope, declaration.anonymous ? '' : declaration.name, declaration);
                    const own = CppTypeIndex.scope(declaration.qualifiedName, 'record', scope, declaration);
                    this.ownScopes.set(declaration, own);
                    if (!declaration.anonymous && !this.scopesByName.has(declaration.qualifiedName)) {
                        this.scopesByName.set(declaration.qualifiedName, own);
                    }
                    for (const field of declaration.fields) {
                        this.declarationScopes.set(field, own);
                    }
                    this.addDeclarations(declaration.members, own);
                    break;
                }
                case 'field':
                    break;
                default:
                    this.addSymbol(scope, declaration.name, declaration);
            }
        }
    }

    /**
     * The scope a declaration with a qualified name belongs to: for `enum class Outer::E {…}` the
     * scope of `Outer` (if it is known), otherwise the scope it is written in.
     */
    private enclosingScopeOf(declaration: CppDeclaration, scope: Scope): Scope {
        const separator = declaration.qualifiedName.lastIndexOf('::');
        const prefix = separator >= 0 ? declaration.qualifiedName.slice(0, separator) : '';
        return prefix === scope.qualifiedName || declaration.name === '' ? scope : this.scopesByName.get(prefix) ?? scope;
    }

    private report(severity: CppDiagnosticSeverity, message: string, fileName: string, range: CppRange): void {
        const key = `${fileName}:${range.start.line}:${range.start.character}:${message}`;
        if (!this.resolutionDiagnostics.has(key)) {
            this.resolutionDiagnostics.set(key, { severity, message, fileName, range });
        }
    }

    // -----------------------------------------------------------------------------------------
    // lookup
    // -----------------------------------------------------------------------------------------

    private scopeNamed(scope: string | undefined): Scope {
        return this.scopesByName.get(scope ?? '') ?? this.global;
    }

    /** Parses a (qualified) name like `motor::Mode::Fast` or `::std::numeric_limits<int>`. */
    private static parseName(name: string): CppQualifiedName | undefined {
        const tokens = tokenize(name, 0, false).tokens;
        const cursor = new TokenCursor(tokens, new LineMap(name));
        try {
            const parsed = cursor.parseQualifiedName('always');
            return cursor.atEnd() ? parsed : undefined;
        } catch (error) {
            if (error instanceof SyntaxError) {
                return undefined;
            }
            throw error;
        }
    }

    /**
     * All declarations found for a (qualified) name from the given scope (qualified name of a
     * namespace, class or enum; default: global namespace), in declaration order. Several results
     * are possible, e.g. for a namespace declared in several headers or `typedef struct X {…} X;`.
     */
    lookupAll(name: string | CppQualifiedName, scope?: string): CppDeclaration[] {
        const parsed = typeof name === 'string' ? CppTypeIndex.parseName(name) : name;
        return parsed ? this.lookupIn(parsed, this.scopeNamed(scope)) : [];
    }

    /**
     * The declaration of a (qualified) name, e.g. `motor::Mode`, `motor::Mode::Fast`,
     * `motor::kMaxSpeed`, or `Mode` from scope `motor`. Prefers type and value declarations
     * over namespaces. `undefined` if the name is not declared in the indexed headers.
     */
    lookup(name: string | CppQualifiedName, scope?: string): CppDeclaration | undefined {
        const all = this.lookupAll(name, scope);
        return all.find(d => d.kind !== 'namespace') ?? all[0];
    }

    private lookupIn(name: CppQualifiedName, from: Scope, exclude?: ReadonlySet<CppDeclaration>): CppDeclaration[] {
        if (name.parts.length === 0) {
            return [];
        }
        const filter = (list: CppDeclaration[]) => exclude ? list.filter(d => !exclude.has(d)) : list;
        let candidates = filter(name.global ? this.findIn(this.global, name.parts[0].name) : this.findUnqualified(from, name.parts[0].name, exclude));
        for (const part of name.parts.slice(1)) {
            const container = candidates.map(c => this.memberScope(c)).find(s => s !== undefined);
            if (!container) {
                return [];
            }
            candidates = filter(this.findIn(container, part.name));
        }
        return candidates;
    }

    private findUnqualified(from: Scope, name: string, exclude?: ReadonlySet<CppDeclaration>): CppDeclaration[] {
        for (let scope: Scope | undefined = from; scope; scope = scope.parent) {
            const found = this.findIn(scope, name).filter(d => !exclude?.has(d));
            if (found.length > 0) {
                return found;
            }
        }
        return [];
    }

    /** Members named `name` of a scope, including inline namespaces, using directives and base classes. */
    private findIn(scope: Scope, name: string, visited = new Set<Scope>()): CppDeclaration[] {
        if (visited.has(scope)) {
            return [];
        }
        visited.add(scope);
        const own = scope.symbols.get(name);
        if (own && own.length > 0) {
            return own;
        }
        const found: CppDeclaration[] = [];
        for (const enumScope of this.usingEnumScopes(scope)) {
            found.push(...(enumScope.symbols.get(name) ?? []));
        }
        for (const inline of scope.inlineNamespaces) {
            found.push(...this.findIn(inline, name, visited));
        }
        if (found.length === 0) {
            for (const directive of scope.usingDirectives) {
                if (this.directivesInProgress.has(directive)) {
                    continue;
                }
                this.directivesInProgress.add(directive);
                try {
                    const target = this.lookupIn(directive, scope).map(d => this.memberScope(d)).find(s => s?.kind === 'namespace');
                    if (target) {
                        found.push(...this.findIn(target, name, visited));
                    }
                } finally {
                    this.directivesInProgress.delete(directive);
                }
            }
        }
        if (found.length === 0 && scope.kind === 'record' && scope.declaration?.kind === 'record') {
            for (const base of scope.declaration.bases) {
                const baseType = this.resolveTypeRefIn(base.type, scope.parent ?? this.global);
                if (baseType.kind === 'struct') {
                    const baseScope = this.ownScopes.get(baseType.declaration);
                    if (baseScope) {
                        found.push(...this.findIn(baseScope, name, visited));
                    }
                }
            }
        }
        return found;
    }

    /** The scopes of the enums named by the `using enum` declarations of a scope. */
    private usingEnumScopes(scope: Scope): Scope[] {
        const result: Scope[] = [];
        for (const target of scope.usingEnums) {
            if (this.directivesInProgress.has(target)) {
                continue;
            }
            this.directivesInProgress.add(target);
            try {
                const enumScope = this.lookupIn(target, scope).map(d => this.memberScope(d)).find(s => s?.kind === 'enum');
                if (enumScope) {
                    result.push(enumScope);
                }
            } finally {
                this.directivesInProgress.delete(target);
            }
        }
        return result;
    }

    /** The scope of the members of a namespace, class, enum or of the type an alias denotes. */
    private memberScope(declaration: CppDeclaration, depth = 0): Scope | undefined {
        switch (declaration.kind) {
            case 'namespace':
                return this.namespaceScopes.get(declaration.qualifiedName);
            case 'namespaceAlias': {
                if (depth > 16) {
                    return undefined;
                }
                const target = this.lookupIn(declaration.target, this.declarationScopes.get(declaration) ?? this.global);
                return target.map(d => this.memberScope(d, depth + 1)).find(s => s !== undefined);
            }
            case 'enum':
            case 'record':
                return this.ownScopes.get(declaration);
            case 'alias': {
                const type = this.typeOf(declaration);
                return type.kind === 'enum' || type.kind === 'struct' ? this.ownScopes.get(type.declaration) : undefined;
            }
            default:
                return undefined;
        }
    }

    /**
     * The declarations directly in a namespace (merged over all headers, including inline and
     * anonymous namespaces), class (nested types, static constants) or enum (enumerators), e.g. for
     * code completion after `motor::`.
     */
    members(scope: string): CppDeclaration[] {
        const target = this.scopesByName.get(scope);
        if (!target) {
            return [];
        }
        const result = new Set<CppDeclaration>();
        const collect = (s: Scope) => {
            for (const list of s.symbols.values()) {
                list.forEach(d => result.add(d));
            }
            for (const enumScope of this.usingEnumScopes(s)) {
                enumScope.symbols.forEach(list => list.forEach(d => result.add(d)));
            }
            s.inlineNamespaces.forEach(collect);
        };
        collect(target);
        return [...result];
    }

    /** The qualified name of the scope in which a declaration is declared (`''` for the global namespace). */
    scopeOf(declaration: CppDeclaration): string {
        return this.declarationScopes.get(declaration)?.qualifiedName ?? declaration.scope;
    }

    /** All declarations of all headers (depth first, in header and declaration order). */
    allDeclarations(): CppDeclaration[] {
        const result: CppDeclaration[] = [];
        for (const header of this.headers) {
            forEachCppDeclaration(header.declarations, d => result.push(d));
        }
        return result;
    }

    // -----------------------------------------------------------------------------------------
    // types
    // -----------------------------------------------------------------------------------------

    /**
     * Resolves a type given as C++ text (`motor::Mode`, `uint8_t`, `unsigned int`, `std::string`,
     * `const char*`, `std::array<int, 3>`) in the given scope. Returns `undefined` if the text is
     * not a type or names an unknown type, and an `unsupported` type for known but unsupported
     * types (pointers, unions, …).
     */
    resolveType(type: string, scope?: string): CppResolvedType | undefined {
        const tokens = tokenize(type, 0, false).tokens;
        const cursor = new TokenCursor(tokens, new LineMap(type));
        let ref: CppTypeRef;
        try {
            ref = cursor.parseTypeId();
            if (!cursor.atEnd()) {
                return undefined;
            }
        } catch (error) {
            if (error instanceof SyntaxError) {
                return undefined;
            }
            throw error;
        }
        const resolved = this.resolveTypeRef(ref, scope);
        const unknown = resolved.kind === 'unsupported' && resolved.reason === `unknown type '${resolved.cppName}'`
            && ref.name.kind === 'named' && this.lookupIn(ref.name.name, this.scopeNamed(scope)).length === 0;
        return unknown ? undefined : resolved;
    }

    /** Resolves a type reference of a declaration (use {@link scopeOf} of the declaration as scope). */
    resolveTypeRef(ref: CppTypeRef, scope?: string): CppResolvedType {
        return this.resolveTypeRefIn(ref, this.scopeNamed(scope));
    }

    /** The type denoted by an enum, class or alias declaration (aliases are resolved). */
    typeOf(declaration: CppTypeDeclaration): CppResolvedType {
        switch (declaration.kind) {
            case 'enum':
                return this.resolveEnum(declaration).type;
            case 'record':
                return this.resolveRecord(declaration);
            case 'alias':
                return this.resolveAlias(declaration);
        }
    }

    private resolveTypeRefIn(ref: CppTypeRef, scope: Scope, exclude?: ReadonlySet<CppDeclaration>): CppResolvedType {
        if (ref.functionPointer) {
            return unsupported(ref.spelling, 'function pointer');
        }
        if (ref.reference) {
            return unsupported(ref.spelling, 'reference type');
        }
        let type = this.resolveTypeName(ref.name, scope, exclude);
        if (ref.pointer > 0) {
            if (ref.pointer === 1 && ref.const && type.kind === 'integer' && type.character && type.bits === 8) {
                type = { kind: 'string', cppName: 'const char*' };
            } else {
                return unsupported(ref.spelling, 'pointer type');
            }
        }
        for (let i = ref.arrayDimensions.length - 1; i >= 0; i--) {
            const dimension = ref.arrayDimensions[i];
            const length = dimension ? this.evaluateLength(dimension.node, scope, ref) : undefined;
            type = {
                kind: 'array', cppName: `${type.cppName}[${length ?? dimension?.text ?? ''}]`, element: type,
                ...(length !== undefined ? { length } : {})
            };
        }
        return type;
    }

    private evaluateLength(node: CppExpressionNode, scope: Scope, ref?: CppTypeRef): number | undefined {
        try {
            const value = this.evaluateNode(node, scope);
            if (value.kind === 'integer' && value.value >= 0n) {
                return Number(value.value);
            }
            throw new EvaluationError('the size must be a non-negative integer', node.range);
        } catch (error) {
            if (!(error instanceof EvaluationError)) {
                throw error;
            }
            const declaration = this.declarationWith(ref);
            if (declaration) {
                this.report('warning', `cannot evaluate the array size of '${declaration.qualifiedName}': ${error.message}`, declaration.fileName, error.range ?? node.range);
            }
            return undefined;
        }
    }

    /** Finds the declaration that owns a type reference (for diagnostics). */
    private declarationWith(ref: CppTypeRef | undefined): CppDeclaration | undefined {
        if (!ref) {
            return undefined;
        }
        this.typeRefOwners ??= this.buildTypeRefOwners();
        return this.typeRefOwners.get(ref);
    }

    private typeRefOwners: Map<CppTypeRef, CppDeclaration> | undefined;

    private buildTypeRefOwners(): Map<CppTypeRef, CppDeclaration> {
        const owners = new Map<CppTypeRef, CppDeclaration>();
        for (const declaration of this.allDeclarations()) {
            if (declaration.kind === 'field' || declaration.kind === 'alias' || declaration.kind === 'constant') {
                owners.set(declaration.type, declaration);
            }
        }
        return owners;
    }

    private resolveTypeName(name: CppTypeName, scope: Scope, exclude?: ReadonlySet<CppDeclaration>): CppResolvedType {
        switch (name.kind) {
            case 'fundamental':
                return this.fundamental(name.name);
            case 'declared':
                return name.declaration.kind === 'enum' ? this.resolveEnum(name.declaration).type : this.resolveRecord(name.declaration);
            case 'other':
                return unsupported(name.text, name.text === 'auto' ? 'deduced type (auto)' : `'${name.text}' is not supported`);
            case 'named':
                return this.resolveNamedType(name.name, scope, exclude);
        }
    }

    private fundamental(name: string): CppResolvedType {
        const model = this.dataModel;
        switch (name) {
            case 'bool': return { kind: 'boolean', cppName: 'bool' };
            case 'char': return integer('char', 8, model.charSigned, true);
            case 'signed char': return integer(name, 8, true);
            case 'unsigned char': return integer(name, 8, false);
            case 'short': return integer(name, 16, true);
            case 'unsigned short': return integer(name, 16, false);
            case 'int': return integer(name, 32, true);
            case 'unsigned int': return integer(name, 32, false);
            case 'long': return integer(name, model.longBits, true);
            case 'unsigned long': return integer(name, model.longBits, false);
            case 'long long': return integer(name, 64, true);
            case 'unsigned long long': return integer(name, 64, false);
            case '__int128': return integer(name, 128, true);
            case 'unsigned __int128': return integer(name, 128, false);
            case 'wchar_t': return integer(name, 32, true, true);
            case 'char8_t': return integer(name, 8, false, true);
            case 'char16_t': return integer(name, 16, false, true);
            case 'char32_t': return integer(name, 32, false, true);
            case 'float': return { kind: 'real', cppName: name, bits: 32 };
            case 'double':
            case 'long double': return { kind: 'real', cppName: name, bits: 64 };
            default: return unsupported(name, name === 'void' ? 'void' : `unsupported type '${name}'`);
        }
    }

    private resolveNamedType(name: CppQualifiedName, scope: Scope, exclude?: ReadonlySet<CppDeclaration>): CppResolvedType {
        const text = qualifiedNameText(name);
        const found = this.lookupIn(name, scope, exclude);
        const declaration = found.find(d => d.kind === 'enum' || d.kind === 'record' || (d.kind === 'alias' && !this.aliasesInProgress.has(d)));
        if (declaration) {
            return this.typeOf(declaration as CppTypeDeclaration);
        }
        const library = this.libraryType(name, scope);
        if (library) {
            return library;
        }
        if (found.length > 0) {
            return unsupported(text, found.some(d => d.kind === 'alias') ? `recursive alias '${text}'` : `'${text}' is not a type`);
        }
        return unsupported(text, `unknown type '${text}'`);
    }

    /** Types of the standard library known to the analyzer. */
    private libraryType(name: CppQualifiedName, scope: Scope): CppResolvedType | undefined {
        const parts = name.parts.map(p => p.name);
        const std = parts.length === 2 && parts[0] === 'std';
        const simple = parts[parts.length - 1];
        const text = qualifiedNameText(name).replace(/^::/, '');
        if ((parts.length === 1 || std) && this.libraryIntegers[simple] && !name.parts[name.parts.length - 1].templateArguments) {
            const [bits, signed] = this.libraryIntegers[simple];
            return integer(text, bits, signed);
        }
        if (!std) {
            return undefined;
        }
        const args = name.parts[1].templateArguments;
        switch (simple) {
            case 'string':
            case 'string_view':
                return { kind: 'string', cppName: text };
            case 'byte':
                return integer(text, 8, false);
            case 'array': {
                const [elementArg, lengthArg] = args ?? [];
                if (!elementArg || !lengthArg) {
                    return unsupported(text, 'std::array needs two template arguments');
                }
                const element = elementArg.type ? this.resolveTypeRefIn(elementArg.type, scope)
                    : unsupported(elementArg.text, `unknown type '${elementArg.text}'`);
                const length = lengthArg.expression ? this.evaluateLength(lengthArg.expression.node, scope) : undefined;
                return { kind: 'array', cppName: text, element, ...(length !== undefined ? { length } : {}) };
            }
            default:
                return unsupported(text, `unsupported library type '${text}'`);
        }
    }

    private resolveAlias(alias: CppAlias): CppResolvedType {
        const known = this.aliases.get(alias);
        if (known) {
            return known;
        }
        if (this.aliasesInProgress.has(alias)) {
            return unsupported(alias.qualifiedName, `recursive alias '${alias.qualifiedName}'`);
        }
        this.aliasesInProgress.add(alias);
        let type: CppResolvedType;
        try {
            type = this.resolveTypeRefIn(alias.type, this.declarationScopes.get(alias) ?? this.global, new Set([alias]));
        } finally {
            this.aliasesInProgress.delete(alias);
        }
        this.aliases.set(alias, type);
        return type;
    }

    private resolveEnum(declaration: CppEnum): EnumState {
        const known = this.enums.get(declaration);
        if (known) {
            return known;
        }
        if (declaration.opaque) {
            // an opaque declaration denotes the enum of the definition (if there is one)
            const definition = this.lookupAll(`::${declaration.qualifiedName}`).find(d => d.kind === 'enum' && !d.opaque);
            if (definition) {
                const state = this.resolveEnum(definition as CppEnum);
                this.enums.set(declaration, state);
                return state;
            }
        }
        const scope = this.ownScopes.get(declaration) ?? this.global;
        const outer = this.declarationScopes.get(declaration) ?? this.global;
        let underlying: CppIntegerType = integer('int', 32, true);
        let fixed = false;
        if (declaration.underlyingType) {
            const type = this.resolveTypeRefIn(declaration.underlyingType, outer);
            if (type.kind === 'integer') {
                underlying = type;
                fixed = true;
            } else if (type.kind === 'boolean') {
                underlying = integer('bool', 8, false);
                fixed = true;
            } else {
                this.report('error', `the underlying type '${declaration.underlyingType.spelling}' of enum '${declaration.qualifiedName}' is not an integer type${type.kind === 'unsupported' ? ` (${type.reason})` : ''}`,
                    declaration.fileName, declaration.underlyingType.range);
            }
        } else if (declaration.scoped) {
            fixed = true;
        }
        const enumerators: CppResolvedEnumerator[] = [];
        const type: CppEnumType = {
            kind: 'enum', cppName: declaration.qualifiedName, declaration, scoped: declaration.scoped, underlying, enumerators
        };
        const state: EnumState = { type, values: new Map(), done: false };
        this.enums.set(declaration, state);
        let next = 0n;
        for (const enumerator of declaration.enumerators) {
            let value = next;
            let valid = true;
            if (enumerator.initializer) {
                try {
                    const evaluated = this.evaluateNode(enumerator.initializer.node, scope);
                    if (evaluated.kind !== 'integer' && evaluated.kind !== 'boolean') {
                        throw new EvaluationError(`the value must be an integer, not a ${evaluated.kind}`, enumerator.initializer.range);
                    }
                    value = evaluated.kind === 'boolean' ? (evaluated.value ? 1n : 0n) : evaluated.value;
                    if (fixed && !integerFits(value, underlying.bits, underlying.signed)) {
                        this.report('error', `the value ${value} of enumerator '${enumerator.qualifiedName}' does not fit into the underlying type '${underlying.cppName}'`,
                            enumerator.fileName, enumerator.initializer.range);
                    }
                } catch (error) {
                    if (!(error instanceof EvaluationError)) {
                        throw error;
                    }
                    valid = false;
                    this.report('error', `cannot evaluate the value of enumerator '${enumerator.qualifiedName}': ${error.message}`,
                        enumerator.fileName, error.range ?? enumerator.initializer.range);
                }
            } else if (fixed && !integerFits(value, underlying.bits, underlying.signed)) {
                this.report('error', `the value ${value} of enumerator '${enumerator.qualifiedName}' does not fit into the underlying type '${underlying.cppName}'`,
                    enumerator.fileName, enumerator.nameRange);
            }
            if (fixed) {
                value = underlying.signed ? BigInt.asIntN(underlying.bits, value) : BigInt.asUintN(underlying.bits, value);
            }
            state.values.set(enumerator, value);
            enumerators.push({ name: enumerator.name, qualifiedName: enumerator.qualifiedName, value, valid, declaration: enumerator });
            next = value + 1n;
        }
        if (!fixed) {
            const values = enumerators.map(e => e.value);
            const fits = (bits: number, signed: boolean) => values.every(v => integerFits(v, bits, signed));
            const deduced = fits(32, true) ? integer('int', 32, true) : fits(32, false) ? integer('unsigned int', 32, false)
                : fits(64, true) ? integer('long long', 64, true) : integer('unsigned long long', 64, false);
            (type as { underlying: CppIntegerType }).underlying = deduced;
        }
        state.done = true;
        return state;
    }

    private resolveRecord(declaration: CppRecord): CppResolvedType {
        const known = this.records.get(declaration);
        if (known) {
            return known;
        }
        if (declaration.key === 'union') {
            const type = unsupported(declaration.qualifiedName, 'union');
            this.records.set(declaration, type);
            return type;
        }
        const fields: CppResolvedField[] = [];
        const type: CppStructType = { kind: 'struct', cppName: declaration.qualifiedName, declaration, fields, aggregate: false };
        this.records.set(declaration, type);
        const scope = this.ownScopes.get(declaration) ?? this.global;
        const outer = this.declarationScopes.get(declaration) ?? this.global;
        let aggregate = !declaration.hasUserConstructors && !declaration.hasVirtualFunctions;
        for (const base of declaration.bases) {
            const baseType = this.resolveTypeRefIn(base.type, outer);
            if (base.access !== 'public' || base.virtual) {
                aggregate = false;
                continue;
            }
            if (baseType.kind === 'struct') {
                aggregate &&= baseType.aggregate;
                fields.push(...baseType.fields.map(f => ({ ...f, inheritedFrom: f.inheritedFrom ?? baseType.cppName })));
            } else {
                aggregate = false;
            }
        }
        const locals = new Map<string, EvalValue>();
        for (const field of declaration.fields) {
            if (field.access !== 'public') {
                aggregate = false;
                continue;
            }
            const fieldType = this.resolveTypeRefIn(field.type, scope);
            let bitWidth: number | undefined;
            if (field.bitWidth) {
                bitWidth = this.evaluateLength(field.bitWidth.node, scope, field.type);
            }
            let defaultValue: CppValue | undefined;
            if (field.initializer && fieldType.kind !== 'unsupported') {
                try {
                    defaultValue = this.convertValue(field.initializer.node, fieldType, scope, field, locals);
                } catch (error) {
                    if (!(error instanceof EvaluationError)) {
                        throw error;
                    }
                    this.report('warning', `cannot evaluate the default value of '${field.qualifiedName}': ${error.message}`, field.fileName, error.range ?? field.initializer.range);
                }
            }
            if (defaultValue !== undefined && field.name) {
                try {
                    locals.set(field.name, this.toEvalValue(defaultValue, fieldType, field.nameRange));
                } catch (error) {
                    if (!(error instanceof EvaluationError)) {
                        throw error;
                    }
                }
            }
            fields.push({
                name: field.name, type: fieldType, declaration: field,
                ...(bitWidth !== undefined ? { bitWidth } : {}), ...(defaultValue !== undefined ? { defaultValue } : {})
            });
        }
        (type as { aggregate: boolean }).aggregate = aggregate;
        return type;
    }

    // -----------------------------------------------------------------------------------------
    // values
    // -----------------------------------------------------------------------------------------

    /**
     * The type and value of a constant or enumerator given by name (e.g. `motor::kMaxSpeed`,
     * `motor::Mode::Fast`) or declaration. `undefined` if the name is not a constant or enumerator.
     */
    constant(nameOrDeclaration: string | CppConstant | CppEnumerator, scope?: string): CppConstantInfo | undefined {
        let declaration: CppDeclaration | undefined = typeof nameOrDeclaration === 'string'
            ? this.lookupAll(nameOrDeclaration, scope).find(d => d.kind === 'constant' || d.kind === 'enumerator' || d.kind === 'alias')
            : nameOrDeclaration;
        if (declaration?.kind === 'alias' && declaration.syntax === 'usingDeclaration' && declaration.type.name.kind === 'named') {
            declaration = this.lookupIn(declaration.type.name.name, this.declarationScopes.get(declaration) ?? this.global)
                .find(d => d.kind === 'constant' || d.kind === 'enumerator');
        }
        if (declaration?.kind === 'constant') {
            return this.constantInfo(declaration);
        }
        if (declaration?.kind === 'enumerator') {
            const enumDeclaration = this.enumOf.get(declaration);
            if (!enumDeclaration) {
                return undefined;
            }
            const state = this.resolveEnum(enumDeclaration);
            const resolved = state.type.enumerators.find(e => e.declaration === declaration);
            return {
                declaration, type: state.type, value: resolved?.value,
                ...(resolved && !resolved.valid ? { error: 'the value cannot be evaluated' } : {})
            };
        }
        return undefined;
    }

    private constantInfo(declaration: CppConstant): CppConstantInfo {
        const known = this.constants.get(declaration);
        if (known) {
            return known;
        }
        const scope = this.declarationScopes.get(declaration) ?? this.global;
        if (this.constantsInProgress.has(declaration)) {
            throw new EvaluationError(`'${declaration.qualifiedName}' depends on itself`, declaration.nameRange);
        }
        this.constantsInProgress.add(declaration);
        let info: CppConstantInfo;
        try {
            info = this.computeConstant(declaration, scope);
        } finally {
            this.constantsInProgress.delete(declaration);
        }
        this.constants.set(declaration, info);
        return info;
    }

    private computeConstant(declaration: CppConstant, scope: Scope): CppConstantInfo {
        let type = this.resolveTypeRefIn(declaration.type, scope);
        const initializer = declaration.initializer;
        if (!initializer) {
            return { declaration, type, error: 'the constant has no initializer in the header' };
        }
        const auto = declaration.type.name.kind === 'other' && declaration.type.name.text === 'auto' && declaration.type.pointer === 0;
        const charArray = type.kind === 'array' && type.element.kind === 'integer' && type.element.character === true;
        if (type.kind === 'unsupported' && !auto && !charArray) {
            // constants of unsupported types (pointers, unknown types, …) are not evaluated
            return { declaration, type, error: `the type is not supported (${type.reason})` };
        }
        try {
            // `constexpr char kName[] = "…";` is a string constant
            if (type.kind === 'array' && type.element.kind === 'integer' && type.element.character && type.element.bits === 8
                && declaration.type.arrayDimensions.length === 1) {
                const node = initializer.node.kind === 'initializerList' && initializer.node.elements.length === 1 ? initializer.node.elements[0].value : initializer.node;
                if (node.kind === 'string') {
                    return { declaration, type: { kind: 'string', cppName: 'const char*' }, value: node.value };
                }
            }
            if (auto) {
                const value = this.evaluateNode(initializer.node, scope);
                type = this.typeOfValue(value);
                return { declaration, type, value: toCppValue(value) };
            }
            const value = this.convertValue(initializer.node, type, scope, declaration);
            return { declaration, type, value };
        } catch (error) {
            if (!(error instanceof EvaluationError)) {
                throw error;
            }
            this.report('warning', `cannot evaluate the constant '${declaration.qualifiedName}': ${error.message}`, declaration.fileName, error.range ?? initializer.range);
            return { declaration, type, error: error.message };
        }
    }

    /** The type of an evaluated scalar value. */
    private typeOfValue(value: EvalValue): CppResolvedType {
        switch (value.kind) {
            case 'integer':
                if (value.enumType) {
                    return value.enumType;
                }
                return integer(value.character && value.bits === 8 ? 'char' : INTEGER_NAMES[`${value.bits},${value.signed}`] ?? 'long long', value.bits, value.signed, value.character);
            case 'real':
                return { kind: 'real', cppName: value.bits === 32 ? 'float' : 'double', bits: value.bits };
            case 'boolean':
                return { kind: 'boolean', cppName: 'bool' };
            case 'string':
                return { kind: 'string', cppName: 'const char*' };
        }
    }

    /**
     * Converts an initializer to a value of the given type (aggregate initialization for structs
     * and arrays, implicit conversion for scalars).
     */
    private convertValue(node: CppExpressionNode, type: CppResolvedType, scope: Scope, owner: CppDeclaration, locals?: ReadonlyMap<string, EvalValue>): CppValue {
        if (type.kind === 'struct' || type.kind === 'array') {
            if (node.kind === 'name') {
                const constant = this.lookupIn(node.name, scope).find(d => d.kind === 'constant') as CppConstant | undefined;
                if (constant) {
                    const info = this.constantInfo(constant);
                    if (info.value !== undefined && info.type === type) {
                        return info.value;
                    }
                }
                throw new EvaluationError(`'${qualifiedNameText(node.name)}' is not a constant of type '${type.cppName}'`, node.range);
            }
            let elements: readonly { designator?: string, value: CppExpressionNode }[];
            if (node.kind === 'initializerList') {
                elements = node.elements;
            } else if (node.kind === 'call' && node.braces && node.callee.kind === 'name') {
                elements = node.arguments.map(value => ({ value }));
            } else {
                throw new EvaluationError(`an initializer list is expected for '${type.cppName}'`, node.range);
            }
            if (type.kind === 'array') {
                // std::array<T, N> x{{…}}
                if (elements.length === 1 && elements[0].value.kind === 'initializerList'
                    && type.element.kind !== 'struct' && type.element.kind !== 'array') {
                    elements = elements[0].value.elements;
                }
                const length = type.length ?? elements.length;
                if (elements.length > length) {
                    throw new EvaluationError(`too many initializers for '${type.cppName}'`, node.range);
                }
                const values: CppValue[] = [];
                for (let i = 0; i < length; i++) {
                    const element = elements[i];
                    values.push(element ? this.convertValue(element.value, type.element, scope, owner, locals) : this.requireDefault(type.element, node.range));
                }
                return values;
            }
            const fields = type.fields;
            const assigned = new Map<string, CppValue>();
            let position = 0;
            for (const element of elements) {
                let index = position;
                if (element.designator) {
                    index = fields.findIndex(f => f.name === element.designator);
                    if (index < 0) {
                        throw new EvaluationError(`'${type.cppName}' has no field '${element.designator}'`, element.value.range);
                    }
                }
                const field = fields[index];
                if (!field) {
                    throw new EvaluationError(`too many initializers for '${type.cppName}'`, element.value.range);
                }
                assigned.set(field.name, this.convertValue(element.value, field.type, scope, owner, locals));
                position = index + 1;
            }
            const value: Record<string, CppValue> = {};
            for (const field of fields) {
                value[field.name] = assigned.get(field.name) ?? field.defaultValue ?? this.requireDefault(field.type, node.range);
            }
            return value as CppStructValue;
        }
        const evaluated = node.kind === 'initializerList' && node.elements.length === 0
            ? zeroValue(type, node.range)
            : this.evaluateNode(node, scope, locals);
        const converted = convertScalar(evaluated, type, false, node.range);
        if (converted.warning) {
            this.report('warning', `${owner.qualifiedName}: ${converted.warning}`, owner.fileName, node.range);
        }
        return toCppValue(converted.value);
    }

    private requireDefault(type: CppResolvedType, range: CppRange): CppValue {
        const value = this.defaultValue(type);
        if (value === undefined) {
            throw new EvaluationError(`'${type.cppName}' has no default value${type.kind === 'unsupported' ? ` (${type.reason})` : ''}`, range);
        }
        return value;
    }

    /**
     * The value of `T{}` (value initialization using default member initializers): `0n`, `0`, `false`,
     * `''`, the value `0n` for enums, structs and arrays field / element wise. `undefined` for
     * unsupported types.
     */
    defaultValue(type: CppResolvedType): CppValue | undefined {
        switch (type.kind) {
            case 'integer':
            case 'enum':
                return 0n;
            case 'real':
                return 0;
            case 'boolean':
                return false;
            case 'string':
                return '';
            case 'array': {
                if (type.length === undefined) {
                    return [];
                }
                const element = this.defaultValue(type.element);
                return element === undefined ? undefined : Array.from({ length: type.length }, () => element);
            }
            case 'struct': {
                const value: Record<string, CppValue> = {};
                for (const field of type.fields) {
                    const fieldValue = field.defaultValue ?? this.defaultValue(field.type);
                    if (fieldValue === undefined) {
                        return undefined;
                    }
                    value[field.name] = fieldValue;
                }
                return value;
            }
            default:
                return undefined;
        }
    }

    /**
     * Evaluates a C++ constant expression (e.g. `motor::kMaxSpeed * 2`, `motor::Mode::Fast`) in the
     * given scope. The type of the result is the C++ type of the expression.
     */
    evaluate(expression: string, scope?: string): CppEvaluationResult {
        const tokens = tokenize(expression, 0, false).tokens;
        const cursor = new TokenCursor(tokens, new LineMap(expression));
        const parsed = cursor.parseExpressionSpan(0, tokens.length - 1);
        if (parsed.node.kind === 'unsupported') {
            return { error: `cannot parse '${expression}'` };
        }
        const target = this.scopeNamed(scope);
        try {
            if (parsed.node.kind === 'name') {
                const constant = this.lookupIn(parsed.node.name, target).find(d => d.kind === 'constant') as CppConstant | undefined;
                if (constant) {
                    const info = this.constantInfo(constant);
                    return info.value !== undefined ? { value: info.value, type: info.type } : { error: info.error ?? 'no value' };
                }
            }
            const value = this.evaluateNode(parsed.node, target);
            return { value: toCppValue(value), type: this.typeOfValue(value) };
        } catch (error) {
            if (error instanceof EvaluationError) {
                return { error: error.message };
            }
            throw error;
        }
    }

    /**
     * Evaluates an expression in a scope; `locals` are the values of the preceding data members
     * (for default member initializers like `int b = a * 2;`).
     */
    private evaluateNode(node: CppExpressionNode, scope: Scope, locals?: ReadonlyMap<string, EvalValue>): EvalValue {
        const context: EvaluationContext = {
            dataModel: this.dataModel,
            resolveValue: (name, range) => {
                const local = !name.global && name.parts.length === 1 ? locals?.get(name.parts[0].name) : undefined;
                return local ?? this.valueOfName(name, range, scope);
            },
            resolveType: ref => this.resolveTypeRefIn(ref, scope),
            resolveTypeName: name => {
                const type = this.resolveNamedType(name, scope);
                return type.kind === 'unsupported' && (type.reason.startsWith('unknown type') || type.reason.endsWith('is not a type')) ? undefined : type;
            }
        };
        return evaluateExpression(node, context);
    }

    private valueOfName(name: CppQualifiedName, range: CppRange, scope: Scope): EvalValue {
        const text = qualifiedNameText(name);
        const found = this.lookupIn(name, scope);
        for (const declaration of found) {
            switch (declaration.kind) {
                case 'enumerator': {
                    const enumDeclaration = this.enumOf.get(declaration)!;
                    const state = this.resolveEnum(enumDeclaration);
                    const value = state.values.get(declaration);
                    if (value === undefined) {
                        throw new EvaluationError(`'${text}' is used before its definition`, range);
                    }
                    if (!state.done) {
                        // inside the enum body: the enumerator has the fixed underlying type or `int` (a
                        // larger type if the value does not fit)
                        if (enumDeclaration.underlyingType || enumDeclaration.scoped) {
                            return { kind: 'integer', value, bits: state.type.underlying.bits, signed: state.type.underlying.signed };
                        }
                        const [bits, signed] = integerFits(value, 32, true) ? [32, true] : integerFits(value, 64, true) ? [64, true] : [64, false];
                        return { kind: 'integer', value, bits, signed };
                    }
                    const underlying = state.type.underlying;
                    return { kind: 'integer', value, bits: underlying.bits, signed: underlying.signed, enumType: state.type };
                }
                case 'constant': {
                    const info = this.constantInfo(declaration);
                    if (info.value === undefined) {
                        throw new EvaluationError(`the value of '${text}' is unknown${info.error ? ` (${info.error})` : ''}`, range);
                    }
                    return this.toEvalValue(info.value, info.type, range);
                }
                case 'alias':
                    if (declaration.syntax === 'usingDeclaration' && declaration.type.name.kind === 'named') {
                        return this.valueOfName(declaration.type.name.name, range, this.declarationScopes.get(declaration) ?? this.global);
                    }
                    break;
            }
        }
        if (found.length > 0) {
            throw new EvaluationError(`'${text}' is not a constant`, range);
        }
        throw new EvaluationError(`unknown name '${text}'`, range);
    }

    private toEvalValue(value: CppValue, type: CppResolvedType, range: CppRange): EvalValue {
        switch (type.kind) {
            case 'integer':
                return { kind: 'integer', value: value as bigint, bits: type.bits, signed: type.signed, character: type.character };
            case 'enum':
                return { kind: 'integer', value: value as bigint, bits: type.underlying.bits, signed: type.underlying.signed, enumType: type };
            case 'real':
                return { kind: 'real', value: value as number, bits: type.bits };
            case 'boolean':
                return { kind: 'boolean', value: value as boolean };
            case 'string':
                return { kind: 'string', value: value as string };
            default:
                throw new EvaluationError(`a value of type '${type.cppName}' cannot be used in this expression`, range);
        }
    }

    // -----------------------------------------------------------------------------------------
    // diagnostics
    // -----------------------------------------------------------------------------------------

    /** Resolves all declarations of all headers (to collect all diagnostics). */
    resolveAll(): void {
        if (this.resolvedAll) {
            return;
        }
        this.resolvedAll = true;
        for (const declaration of this.allDeclarations()) {
            switch (declaration.kind) {
                case 'enum':
                case 'record':
                case 'alias':
                    this.typeOf(declaration);
                    break;
                case 'constant':
                    this.constantInfo(declaration);
                    break;
            }
        }
    }

    /**
     * The diagnostics of parsing and of the resolution of all declarations (enumerator values that
     * cannot be evaluated, constants, array sizes, duplicate declarations, …), sorted by header
     * and position.
     */
    get diagnostics(): CppDiagnostic[] {
        this.resolveAll();
        const order = new Map(this.headers.map((h, i) => [h.fileName, i]));
        return [...this.headers.flatMap(h => h.diagnostics), ...this.resolutionDiagnostics.values()].sort((a, b) =>
            (order.get(a.fileName) ?? 0) - (order.get(b.fileName) ?? 0)
            || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
    }
}
