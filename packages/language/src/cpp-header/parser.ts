import { LineMap, tokenize, type Token } from './lexer.js';
import { preprocess } from './preprocessor.js';
import { KEYWORDS, makeTypeRef, SyntaxError, TokenCursor } from './syntax.js';
import type {
    CppAccess, CppAlias, CppBaseSpecifier, CppConstant, CppDeclaration, CppDiagnostic, CppDiagnosticSeverity, CppEnum,
    CppEnumerator, CppExpression, CppField, CppHeader, CppNamespace, CppNamespaceAlias, CppUsingDirective, CppParseOptions, CppQualifiedName, CppRange,
    CppRecord, CppTypeName, CppTypeRef
} from './model.js';

/**
 * Parses a C++ header into its syntactic model.
 *
 * The parser is tolerant: it extracts namespaces, enums, classes / structs / unions with their data
 * members, type aliases and constants, and skips everything else (functions and their bodies,
 * templates, methods, operators, `static_assert`, `friend`, …) without diagnostics. It never throws;
 * constructs that matter but cannot be parsed (e.g. a broken enum) are reported as diagnostics and
 * skipped. Preprocessor conditionals are evaluated (see `preprocessor.ts`), so the model reflects
 * the active branches for the given `defines`.
 *
 * @param text the content of the header
 * @param fileName the name used in the model, diagnostics and locations
 */
export function parseCppHeader(text: string, fileName: string, options: CppParseOptions = {}): CppHeader {
    const lines = new LineMap(text);
    const lexed = tokenize(text);
    const diagnostics: CppDiagnostic[] = [];
    for (const problem of lexed.problems) {
        diagnostics.push({ severity: 'error', message: problem.message, fileName, range: lines.range(problem.offset, problem.end) });
    }
    const preprocessed = preprocess(lexed.tokens, lines, options);
    for (const problem of preprocessed.problems) {
        diagnostics.push({ severity: problem.severity, message: problem.message, fileName, range: lines.range(problem.offset, problem.end) });
    }
    const parser = new DeclarationParser(preprocessed.tokens, lines, fileName);
    const declarations = parser.parseTranslationUnit();
    diagnostics.push(...parser.diagnostics);
    diagnostics.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
    return { fileName, declarations, includes: preprocessed.includes, macros: preprocessed.macros, diagnostics };
}

/** Calls `action` for every declaration of the tree (depth first, in declaration order). */
export function forEachCppDeclaration(declarations: readonly CppDeclaration[], action: (declaration: CppDeclaration) => void): void {
    for (const declaration of declarations) {
        action(declaration);
        switch (declaration.kind) {
            case 'namespace':
                forEachCppDeclaration(declaration.members, action);
                break;
            case 'enum':
                forEachCppDeclaration(declaration.enumerators, action);
                break;
            case 'record':
                forEachCppDeclaration(declaration.fields, action);
                forEachCppDeclaration(declaration.members, action);
                break;
        }
    }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface RecordContext {
    readonly record: Mutable<CppRecord>;
    readonly fields: CppField[];
    access: CppAccess;
}

const STORAGE_SPECIFIERS = new Set([
    'typedef', 'static', 'extern', 'inline', 'constexpr', 'consteval', 'constinit', 'thread_local', 'mutable', 'virtual',
    'explicit', 'friend', 'register', '__inline__', '__thread', '_Thread_local', '_Noreturn', 'export'
]);

const MACRO_NAME = /^[A-Z_][A-Z0-9_]*$/;

function anonymousName(scope: string): string {
    return scope ? `${scope}::(anonymous)` : '(anonymous)';
}

class DeclarationParser extends TokenCursor {
    readonly diagnostics: CppDiagnostic[] = [];
    private scope = '';
    private output: CppDeclaration[] = [];
    private recordContext: RecordContext | undefined;
    /** Documentation comment of the current declaration (for class / enum specifiers). */
    private declarationDoc: string | undefined;
    /** Whether the current declaration is relevant (a failure to parse it is reported). */
    private relevant = false;

    constructor(tokens: Token[], lines: LineMap, private readonly fileName: string) {
        super(tokens, lines);
    }

    parseTranslationUnit(): CppDeclaration[] {
        const declarations: CppDeclaration[] = [];
        this.parseDeclarations(declarations, undefined, true);
        return declarations;
    }

    private report(severity: CppDiagnosticSeverity, message: string, range: CppRange): void {
        this.diagnostics.push({ severity, message, fileName: this.fileName, range });
    }

    private qualify(name: string): string {
        return this.scope ? `${this.scope}::${name}` : name;
    }

    /** Parses declarations until `}` (not consumed) or the end of input. */
    private parseDeclarations(out: CppDeclaration[], record: RecordContext | undefined, topLevel = false): void {
        const savedOutput = this.output;
        const savedRecord = this.recordContext;
        this.output = out;
        this.recordContext = record;
        try {
            while (!this.atEnd()) {
                if (this.at('}')) {
                    if (topLevel) {
                        this.report('warning', 'unexpected \'}\'', this.range(this.peek(), this.peek()));
                        this.next();
                        continue;
                    }
                    return;
                }
                const start = this.index;
                const startToken = this.peek();
                const scope = this.scope;
                this.relevant = false;
                try {
                    this.parseDeclaration();
                } catch (error) {
                    if (!(error instanceof SyntaxError)) {
                        throw error;
                    }
                    this.scope = scope;
                    this.output = out;
                    this.recordContext = record;
                    if (this.relevant) {
                        this.report('warning', `declaration skipped: ${error.message}`, this.range(startToken, error.token));
                    }
                    this.reset({ pos: start, splits: 0 });
                    this.skipDeclaration(false);
                }
                if (this.index === start) {
                    this.next();
                }
            }
        } finally {
            this.output = savedOutput;
            this.recordContext = savedRecord;
        }
    }

    private parseDeclaration(): void {
        this.skipAttributes();
        const token = this.peek();
        if (this.accept(';')) {
            return;
        }
        const record = this.recordContext;
        switch (token.text) {
            case 'namespace':
                this.parseNamespace(false);
                return;
            case 'inline':
                if (this.at('namespace', 1)) {
                    this.next();
                    this.parseNamespace(true);
                    return;
                }
                break;
            case 'export':
                if (this.at('namespace', 1) || this.at('{', 1)) {
                    this.next();
                    if (this.at('{')) {
                        this.parseLinkageBlock();
                    }
                    return;
                }
                break;
            case 'using':
                this.parseUsing();
                return;
            case 'template':
                this.skipTemplate();
                return;
            case 'static_assert':
            case '_Static_assert':
            case 'friend':
            case 'asm':
            case '__asm__':
            case 'concept':
            case 'module':
            case 'import':
                this.skipDeclaration(false);
                return;
            case 'extern':
                if (this.peek(1).kind === 'string') {
                    this.next();
                    this.next();
                    if (this.at('{')) {
                        this.parseLinkageBlock();
                    } else {
                        this.parseDeclaration();
                    }
                    return;
                }
                break;
            case 'public':
            case 'protected':
            case 'private':
                if (this.at(':', 1)) {
                    this.next();
                    this.next();
                    if (record) {
                        record.access = token.text as CppAccess;
                    }
                    return;
                }
                break;
        }
        if (token.kind !== 'identifier' && token.text !== '::' && token.text !== '~') {
            this.skipDeclaration(false);
            return;
        }
        if (this.skipMacroInvocation()) {
            return;
        }
        if (record && this.skipSpecialMember(record)) {
            return;
        }
        this.parseSimpleDeclaration();
    }

    /** `{ … }` of `extern "C" { … }` / `export { … }`: the declarations belong to the current scope. */
    private parseLinkageBlock(): void {
        const open = this.expect('{');
        this.parseDeclarations(this.output, this.recordContext);
        if (!this.accept('}')) {
            this.report('error', 'missing \'}\'', this.range(open, open));
        }
    }

    /**
     * Skips a macro invocation at the start of a declaration, e.g. `Q_OBJECT`, `__BEGIN_DECLS`,
     * `DECLARE_SOMETHING(x)` on a line of its own (an all-caps name that is not followed by the rest
     * of a declaration on the same line).
     */
    private skipMacroInvocation(): boolean {
        const token = this.peek();
        if (token.kind !== 'identifier' || !MACRO_NAME.test(token.text) || KEYWORDS.has(token.text) || token.text.length < 2) {
            return false;
        }
        let ahead = 1;
        if (this.at('(', 1)) {
            // find the closing parenthesis
            let depth = 0;
            for (; ; ahead++) {
                const t = this.peek(ahead);
                if (t.kind === 'eof') {
                    return false;
                }
                if (t.text === '(') {
                    depth++;
                } else if (t.text === ')' && --depth === 0) {
                    ahead++;
                    break;
                }
            }
        }
        const next = this.peek(ahead);
        if (next.kind === 'eof' || next.text === '}') {
            for (let i = 0; i < ahead; i++) {
                this.next();
            }
            return true;
        }
        if (!next.lineStart || [';', '{', ':', '=', ',', ')', '[', '::', '*', '&', '&&', '<', 'const', 'noexcept', 'override', 'final', '->'].includes(next.text)) {
            return false;
        }
        for (let i = 0; i < ahead; i++) {
            this.next();
        }
        return true;
    }

    /** Skips constructors, destructors and operators of a class (recording their existence). */
    private skipSpecialMember(context: RecordContext): boolean {
        let k = 0;
        let isVirtual = false;
        while (['explicit', 'virtual', 'inline', 'constexpr', 'consteval', 'static', 'friend', 'template'].includes(this.peek(k).text)) {
            isVirtual ||= this.peek(k).text === 'virtual';
            if (this.peek(k).text === 'explicit' && this.at('(', k + 1)) {
                k += 1;
                // explicit(bool)
                let depth = 0;
                do {
                    if (this.peek(k).text === '(') {
                        depth++;
                    } else if (this.peek(k).text === ')') {
                        depth--;
                    }
                    k++;
                } while (depth > 0 && this.peek(k).kind !== 'eof');
                continue;
            }
            k++;
        }
        const token = this.peek(k);
        const name = context.record.name;
        const constructor = token.text === name && name !== '' && this.at('(', k + 1);
        const destructor = token.text === '~';
        const operator = token.text === 'operator';
        if (!constructor && !destructor && !operator) {
            return false;
        }
        const record = context.record;
        record.hasMemberFunctions = true;
        if (isVirtual) {
            record.hasVirtualFunctions = true;
        }
        const start = this.index;
        this.skipDeclaration(false);
        if (constructor) {
            const text = this.textBetween(start, this.index);
            if (!/=\s*(default|delete)\s*;$/.test(text)) {
                record.hasUserConstructors = true;
            }
        }
        return true;
    }

    // -----------------------------------------------------------------------------------------
    // skipping
    // -----------------------------------------------------------------------------------------

    /**
     * Skips a declaration that is not analyzed: up to and including `;` at nesting depth 0, or up to
     * the end of a function body / class body. Stops before a `}` that closes the enclosing scope.
     */
    private skipDeclaration(sawParenthesis: boolean): void {
        let parenthesis = sawParenthesis;
        let assignment = false;
        let constructorInitializers = false;
        while (!this.atEnd()) {
            const token = this.peek();
            if (token.kind === 'punctuator') {
                switch (token.text) {
                    case ';':
                        this.next();
                        return;
                    case '}':
                        return;
                    case '(':
                    case '[':
                        parenthesis ||= token.text === '(';
                        this.skipBalanced();
                        continue;
                    case '{': {
                        const previous = this.previous();
                        const initializer = constructorInitializers && (previous.kind === 'identifier' || previous.text === '>');
                        this.skipBalanced();
                        if (this.accept(';')) {
                            return;
                        }
                        if (parenthesis && !assignment && !initializer) {
                            return;
                        }
                        continue;
                    }
                    case '=':
                        assignment = true;
                        break;
                    case ':':
                        if (parenthesis && !assignment && this.previous().text === ')') {
                            constructorInitializers = true;
                        }
                        break;
                }
            }
            this.next();
        }
    }

    /** Skips `template <…>` and the templated declaration. */
    private skipTemplate(): void {
        this.expect('template');
        if (this.at('<')) {
            let depth = 0;
            while (!this.atEnd()) {
                const token = this.peek();
                if (token.text === '(' || token.text === '[' || token.text === '{') {
                    this.skipBalanced();
                    continue;
                }
                this.next();
                if (token.text === '<') {
                    depth++;
                } else if (token.text === '>') {
                    depth--;
                } else if (token.text === '>>') {
                    depth -= 2;
                } else if (token.text === ';' || token.text === '}') {
                    return;
                }
                if (depth <= 0) {
                    break;
                }
            }
        }
        if (this.at('template')) {
            this.skipTemplate();
            return;
        }
        this.skipDeclaration(false);
    }

    // -----------------------------------------------------------------------------------------
    // namespaces and using
    // -----------------------------------------------------------------------------------------

    private parseNamespace(inline: boolean): void {
        const keyword = this.expect('namespace');
        const doc = keyword.doc ?? this.previous().doc;
        this.skipAttributes();
        if (this.atIdentifier() && this.at('=', 1)) {
            const nameToken = this.next();
            this.next();
            const target = this.parseQualifiedName('always');
            this.expect(';');
            this.output.push(this.base<CppNamespaceAlias>({
                kind: 'namespaceAlias', name: nameToken.text, qualifiedName: this.qualify(nameToken.text), target
            }, keyword, nameToken, doc));
            return;
        }
        const names: Array<{ token: Token, inline: boolean }> = [];
        let nextInline = inline;
        while (this.atIdentifier()) {
            names.push({ token: this.next(), inline: nextInline });
            nextInline = false;
            this.skipAttributes();
            if (this.accept('::')) {
                nextInline = this.accept('inline');
                continue;
            }
            break;
        }
        this.skipAttributes();
        // `namespace std _GLIBCXX_VISIBILITY(default) {`
        this.skipTrailingMacros();
        const open = this.expect('{');
        const outer = this.scope;
        const members: CppDeclaration[] = [];
        const created: Array<Mutable<CppNamespace>> = [];
        let container = this.output;
        if (names.length === 0) {
            const namespace = this.base<Mutable<CppNamespace>>({
                kind: 'namespace', name: '', qualifiedName: this.scope, inline, anonymous: true, members
            }, keyword, keyword, doc);
            container.push(namespace);
            created.push(namespace);
        } else {
            for (const [index, { token, inline: isInline }] of names.entries()) {
                this.scope = this.qualify(token.text);
                const namespace = this.base<Mutable<CppNamespace>>({
                    kind: 'namespace', name: token.text, qualifiedName: this.scope, inline: isInline, anonymous: false,
                    members: index === names.length - 1 ? members : []
                }, keyword, token, doc);
                container.push(namespace);
                created.push(namespace);
                container = namespace.members as CppDeclaration[];
            }
        }
        try {
            this.parseDeclarations(members, undefined);
        } finally {
            this.scope = outer;
        }
        if (!this.accept('}')) {
            this.report('error', `missing '}' of namespace ${names.map(n => n.token.text).join('::')}`, this.range(open, open));
        }
        const range = this.range(keyword);
        for (const namespace of created) {
            namespace.range = range;
        }
    }

    private parseUsing(): void {
        const keyword = this.expect('using');
        const doc = keyword.doc;
        if (this.accept('namespace')) {
            const target = this.parseQualifiedName('always');
            this.expect(';');
            this.output.push(this.base<CppUsingDirective>({ kind: 'usingDirective', name: '', qualifiedName: this.scope, target }, keyword, keyword, doc));
            return;
        }
        if (this.at('enum')) {
            this.skipDeclaration(false);
            return;
        }
        if (this.atIdentifier() && (this.at('=', 1) || (this.at('[', 1) && this.at('[', 2)))) {
            this.relevant = true;
            const nameToken = this.next();
            this.skipAttributes();
            this.expect('=');
            const type = this.parseTypeId();
            const trailing = this.trailingDocs(this.index, this.index);
            this.expect(';');
            const alias = this.base<CppAlias>({
                kind: 'alias', name: nameToken.text, qualifiedName: this.qualify(nameToken.text), type, syntax: 'using'
            }, keyword, nameToken, doc ?? trailing);
            this.nameAnonymous(type.name, alias);
            this.output.push(alias);
            return;
        }
        // using-declaration
        const start = this.peek();
        const target = this.parseQualifiedName('always');
        if (!this.accept(';')) {
            this.skipDeclaration(false);
            return;
        }
        if (this.recordContext || target.parts.length < 2) {
            return;
        }
        const name = target.parts[target.parts.length - 1].name;
        const range = this.range(start);
        const type = makeTypeRef({ name: { kind: 'named', name: target }, const: false, volatile: false }, 0, undefined, [], false, range);
        this.output.push(this.base<CppAlias>({
            kind: 'alias', name, qualifiedName: this.qualify(name), type, syntax: 'usingDeclaration'
        }, keyword, this.previous(), doc));
    }

    // -----------------------------------------------------------------------------------------
    // simple declarations
    // -----------------------------------------------------------------------------------------

    private parseSimpleDeclaration(): void {
        const startToken = this.peek();
        const doc = startToken.doc;
        this.declarationDoc = doc;
        const flags = new Set<string>();
        const specifiers = this.parseTypeSpecifiers(token => {
            if (STORAGE_SPECIFIERS.has(token.text)) {
                flags.add(token.text === '__inline__' ? 'inline' : token.text);
                if (token.text === 'typedef' || token.text === 'constexpr') {
                    this.relevant = true;
                }
                this.next();
                return true;
            }
            return false;
        });
        this.declarationDoc = undefined;
        const record = this.recordContext;
        const declared = specifiers.name.kind === 'declared' ? specifiers.name.declaration : undefined;
        if (flags.has('friend')) {
            this.skipDeclaration(false);
            return;
        }
        if (this.accept(';')) {
            if (declared?.kind === 'record' && declared.anonymous && record) {
                // anonymous union / struct member
                record.fields.push(this.base<CppField>({
                    kind: 'field', name: '', qualifiedName: declared.qualifiedName, type: makeTypeRef(specifiers, 0, undefined, [], false, declared.range),
                    access: record.access, static: false
                }, startToken, startToken, doc));
            }
            return;
        }
        let first = true;
        let declaratorStart = this.index;
        for (;;) {
            const declarator = this.parseDeclarator(specifiers.const || flags.has('constexpr'));
            if (declarator.isFunction && !flags.has('typedef')) {
                if (record) {
                    record.record.hasMemberFunctions = true;
                    if (flags.has('virtual')) {
                        record.record.hasVirtualFunctions = true;
                    }
                }
                this.skipDeclaration(true);
                return;
            }
            if (declarator.isFunction) {
                this.skipBalanced();
            }
            const nameToken = declarator.nameToken ?? startToken;
            let bitWidth: CppExpression | undefined;
            let initializer: CppExpression | undefined;
            if (record && !flags.has('static') && !flags.has('typedef') && this.at(':')) {
                this.next();
                bitWidth = this.parseInitializerSpan(true);
            }
            if (this.accept('=')) {
                initializer = this.parseInitializerSpan(false);
            } else if (this.at('{')) {
                const end = this.findClosing(this.index);
                initializer = this.parseExpressionSpan(this.index, end + 1);
                this.pos = end + 1;
            } else if (this.at('(') && declarator.directInitializer) {
                const end = this.findClosing(this.index);
                initializer = this.parseExpressionSpan(this.index + 1, end);
                this.pos = end + 1;
            }
            this.skipAttributes();
            this.skipTrailingMacros();
            const terminator = this.peek();
            if (!this.at(',') && !this.at(';')) {
                throw new SyntaxError(`expected ';' but found '${terminator.text || 'end of input'}'`, terminator);
            }
            const trailing = this.trailingDocs(declaratorStart, this.index);
            const declarationDoc = (first ? doc : undefined) ?? trailing ?? doc;
            const type = makeTypeRef(specifiers, declarator.pointer, declarator.reference, declarator.arrayDimensions, declarator.functionPointer || declarator.isFunction, this.range(startToken, this.previous()));
            const name = declarator.name;
            if (name !== undefined && !declarator.qualified) {
                const common = { name, qualifiedName: this.qualify(name) };
                if (flags.has('typedef')) {
                    const alias = this.base<CppAlias>({ kind: 'alias', ...common, type, syntax: 'typedef' }, startToken, nameToken, declarationDoc);
                    if (first) {
                        this.nameAnonymous(specifiers.name, alias);
                    }
                    this.output.push(alias);
                } else if (record && !flags.has('static')) {
                    this.relevant = true;
                    record.fields.push(this.base<CppField>({
                        kind: 'field', ...common, type, access: record.access, bitWidth, initializer, static: false
                    }, startToken, nameToken, declarationDoc));
                } else if (flags.has('constexpr') || (declarator.pointer > 0 ? declarator.pointerConst : specifiers.const)) {
                    this.relevant = true;
                    this.output.push(this.base<CppConstant>({
                        kind: 'constant', ...common, type, initializer, constexpr: flags.has('constexpr'), static: flags.has('static'),
                        inline: flags.has('inline'), extern: flags.has('extern'), access: record?.access
                    }, startToken, nameToken, declarationDoc));
                }
            }
            first = false;
            if (this.accept(';')) {
                return;
            }
            this.expect(',');
            declaratorStart = this.index;
        }
    }

    /** Gives an anonymous class / enum defined in a typedef the name of the typedef (C idiom). */
    private nameAnonymous(typeName: CppTypeName, alias: CppAlias): void {
        const declared = typeName.kind === 'declared' ? typeName.declaration : undefined;
        if (!declared?.anonymous || declared.name !== '') {
            return;
        }
        const oldName = declared.qualifiedName;
        const rename = (value: string) => value === oldName ? alias.qualifiedName
            : value.startsWith(oldName + '::') ? alias.qualifiedName + value.slice(oldName.length) : value;
        const renamed = declared as Mutable<CppEnum | CppRecord>;
        renamed.name = alias.name;
        const type = alias.type as Mutable<CppTypeRef>;
        type.spelling = type.spelling.replace(oldName, alias.qualifiedName);
        forEach(declared, declaration => {
            const d = declaration as Mutable<CppDeclaration>;
            d.qualifiedName = rename(d.qualifiedName);
            d.scope = rename(d.scope);
        });

        function forEach(declaration: CppDeclaration, action: (d: CppDeclaration) => void): void {
            action(declaration);
            if (declaration.kind === 'enum') {
                declaration.enumerators.forEach(e => action(e));
            } else if (declaration.kind === 'record') {
                declaration.fields.forEach(f => action(f));
                declaration.members.forEach(m => forEach(m, action));
            }
        }
    }

    /**
     * Parses an initializer (or bit-field width) up to `,` or `;` (or `{` / `=` for a bit-field) at
     * nesting depth 0.
     */
    private parseInitializerSpan(bitField: boolean): CppExpression {
        const start = this.index;
        while (!this.atEnd()) {
            const token = this.peek();
            if (token.kind === 'punctuator') {
                if (token.text === ',' || token.text === ';' || token.text === '}') {
                    break;
                }
                if (bitField && (token.text === '=' || token.text === '{')) {
                    break;
                }
                if (token.text === '(' || token.text === '[' || token.text === '{') {
                    this.skipBalanced();
                    continue;
                }
            }
            this.next();
        }
        if (this.index === start) {
            throw new SyntaxError(`expected an expression but found '${this.peek().text || 'end of input'}'`, this.peek());
        }
        return this.parseExpressionSpan(start, this.index);
    }

    /** Trailing documentation comments (`///<`) of the tokens `start` to `end` (inclusive) that are not used yet. */
    private trailingDocs(start: number, end: number): string | undefined {
        const docs: string[] = [];
        for (let i = Math.max(0, start); i <= end && i < this.tokens.length; i++) {
            const doc = this.tokens[i].trailingDoc;
            if (doc && !this.consumedTrailing.has(this.tokens[i])) {
                docs.push(doc);
                this.consumedTrailing.add(this.tokens[i]);
            }
        }
        return docs.length > 0 ? docs.join('\n') : undefined;
    }

    private readonly consumedTrailing = new Set<Token>();

    private parseDeclarator(constant: boolean): {
        name?: string, nameToken?: Token, qualified: boolean, pointer: number, pointerConst: boolean,
        reference?: 'lvalue' | 'rvalue', arrayDimensions: (CppExpression | undefined)[], functionPointer: boolean,
        isFunction: boolean, directInitializer: boolean
    } {
        let pointer = 0;
        let pointerConst = false;
        let reference: 'lvalue' | 'rvalue' | undefined;
        for (;;) {
            this.skipAttributes();
            if (this.accept('*')) {
                pointer++;
                pointerConst = false;
            } else if (this.at('&') || this.at('&&')) {
                reference = this.next().text === '&' ? 'lvalue' : 'rvalue';
            } else if (this.at('const') || this.at('volatile')) {
                pointerConst ||= this.next().text === 'const';
            } else if (this.atMacroLike() && (this.atIdentifier(1) || this.at('*', 1) || this.at('&', 1) || this.at('(', 1) && this.at('*', 2))) {
                // `const T * PNG_RESTRICT p`, `struct x __user *p`
                this.next();
            } else if (this.atIdentifier() && this.at('::', 1) && this.lookAheadMemberPointer()) {
                this.parseQualifiedName('always');
                this.expect('::');
                this.expect('*');
                pointer++;
            } else {
                break;
            }
        }
        if (this.at('(') && (this.at('*', 1) || this.at('&', 1) || this.at('^', 1) || (this.atIdentifier(1) && this.at('::', 2))
            || (this.atIdentifier(1) && this.at(')', 2) && this.at('(', 3)) || (this.atMacroLike(1) && (this.at('*', 2) || this.at('&', 2))))) {
            // nested declarator: function pointer `(*name)(…)`, `(CALLCONV *name)(…)`, pointer to array
            // `(*name)[N]` or function type `(name)(…)`
            this.next();
            if (this.atMacroLike() && (this.at('*', 1) || this.at('&', 1))) {
                this.next();
            }
            const inner = this.parseDeclarator(false);
            this.expect(')');
            let functionPointer = inner.functionPointer;
            if (this.at('(')) {
                this.skipBalanced();
                functionPointer = true;
            }
            this.skipTrailingFunctionQualifiers();
            const arrayDimensions: (CppExpression | undefined)[] = [];
            while (this.at('[')) {
                arrayDimensions.push(this.parseArrayDimension());
            }
            return {
                ...inner, pointer: pointer + inner.pointer, reference: reference ?? inner.reference, functionPointer,
                arrayDimensions: [...inner.arrayDimensions, ...arrayDimensions], pointerConst: inner.pointerConst
            };
        }
        let name: string | undefined;
        let nameToken: Token | undefined;
        let qualified = false;
        let isFunction = false;
        if (this.atName() || this.at('operator') || (this.at('~') && this.atIdentifier(1))) {
            nameToken = this.peek().text === '::' ? this.peek(1) : this.peek();
            const qualifiedName: CppQualifiedName = this.at('operator') ? { global: false, parts: [{ name: this.next().text }] } : this.parseQualifiedName();
            qualified = qualifiedName.parts.length > 1 || qualifiedName.global;
            name = qualifiedName.parts[qualifiedName.parts.length - 1].name;
            nameToken = this.previous().text === name ? this.previous() : nameToken;
            if (name === 'operator') {
                // operator symbol, conversion type or `()`
                if (this.at('(') && this.at(')', 1)) {
                    this.next();
                    this.next();
                }
                while (!this.atEnd() && !this.at('(') && !this.at(';')) {
                    this.next();
                }
                isFunction = true;
            }
        }
        this.skipAttributes();
        let directInitializer = false;
        if (this.at('(')) {
            const next = this.peek(1);
            if (constant && (next.kind === 'number' || next.kind === 'char' || next.kind === 'string' || next.text === '-')) {
                directInitializer = true;
            } else {
                isFunction = true;
            }
        }
        const arrayDimensions: (CppExpression | undefined)[] = [];
        if (!isFunction) {
            while (this.at('[')) {
                arrayDimensions.push(this.parseArrayDimension());
            }
        }
        return { name, nameToken, qualified, pointer, pointerConst, reference, arrayDimensions, functionPointer: false, isFunction, directInitializer };
    }

    /** Whether the token looks like a macro (all caps or `__reserved`), not a keyword. */
    private atMacroLike(ahead = 0): boolean {
        const token = this.peek(ahead);
        return token.kind === 'identifier' && !KEYWORDS.has(token.text)
            && ((token.text.length >= 2 && MACRO_NAME.test(token.text)) || /^__\w+$/.test(token.text));
    }

    /** Skips macros after a declarator or enumerator, e.g. `x DEPRECATED;`, `A GLIB_AVAILABLE_IN_2_66 = 1`. */
    private skipTrailingMacros(): void {
        while (this.atMacroLike()) {
            this.next();
            if (this.at('(')) {
                this.skipBalanced();
            }
        }
    }

    /** Whether `Name::*` (pointer to member) follows. */
    private lookAheadMemberPointer(): boolean {
        let k = 0;
        while (this.peek(k).kind === 'identifier' && this.peek(k + 1).text === '::') {
            if (this.peek(k + 2).text === '*') {
                return true;
            }
            k += 2;
        }
        return false;
    }

    private skipTrailingFunctionQualifiers(): void {
        while (this.at('const') || this.at('volatile') || this.at('noexcept') || this.at('&') || this.at('&&')) {
            this.next();
            if (this.at('(')) {
                this.skipBalanced();
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // class and enum specifiers
    // -----------------------------------------------------------------------------------------

    protected override parseClassOrEnumSpecifier(): CppTypeName {
        const keyword = this.next();
        const doc = keyword.doc ?? this.declarationDoc;
        this.relevant = true;
        const isEnum = keyword.text === 'enum';
        let scoped = false;
        if (isEnum && (this.at('class') || this.at('struct'))) {
            this.next();
            scoped = true;
        }
        this.skipAttributes();
        let name: CppQualifiedName | undefined;
        let nameToken: Token | undefined;
        if (this.atName()) {
            name = this.parseQualifiedName('always');
            nameToken = this.previous();
            this.skipAttributes();
            // `struct EXPORT_MACRO Name {`: the last name before `{` / `:` / `final` is the class name
            while (this.atIdentifier() && !this.at('final') && (this.at('{', 1) || (this.at(':', 1)) || this.at('final', 1))) {
                name = this.parseQualifiedName('always');
                nameToken = this.previous();
                this.skipAttributes();
            }
        }
        const final = !isEnum && (this.accept('final') || this.accept('sealed'));
        if (isEnum) {
            let underlyingType: CppTypeRef | undefined;
            if (this.at(':')) {
                this.next();
                underlyingType = this.parseTypeId();
            }
            if (!this.at('{')) {
                if (!name) {
                    throw new SyntaxError('expected an enum name or \'{\'', this.peek());
                }
                return { kind: 'named', name };
            }
            return { kind: 'declared', declaration: this.parseEnumBody(keyword, name, nameToken, scoped, underlyingType, doc) };
        }
        const bases: CppBaseSpecifier[] = [];
        if (this.at(':')) {
            this.next();
            for (;;) {
                this.skipAttributes();
                let access: CppAccess = keyword.text === 'class' ? 'private' : 'public';
                let isVirtual = false;
                while (this.at('public') || this.at('protected') || this.at('private') || this.at('virtual')) {
                    const t = this.next().text;
                    if (t === 'virtual') {
                        isVirtual = true;
                    } else {
                        access = t as CppAccess;
                    }
                }
                const type = this.parseTypeId();
                this.accept('...');
                bases.push({ access, virtual: isVirtual, type });
                if (!this.accept(',')) {
                    break;
                }
            }
        }
        if (!this.at('{')) {
            if (!name) {
                throw new SyntaxError('expected a class name or \'{\'', this.peek());
            }
            return { kind: 'named', name };
        }
        return { kind: 'declared', declaration: this.parseRecordBody(keyword, name, nameToken, final, bases, doc) };
    }

    private declarationName(name: CppQualifiedName | undefined): { simple: string, qualified: string } {
        if (!name) {
            return { simple: '', qualified: anonymousName(this.scope) };
        }
        const simple = name.parts[name.parts.length - 1].name;
        const path = name.parts.map(p => p.name).join('::');
        return { simple, qualified: name.global ? path : this.qualify(path) };
    }

    private parseEnumBody(keyword: Token, name: CppQualifiedName | undefined, nameToken: Token | undefined, scoped: boolean,
        underlyingType: CppTypeRef | undefined, doc: string | undefined): CppEnum {
        const names = this.declarationName(name);
        const open = this.expect('{');
        const enumerators: CppEnumerator[] = [];
        const outer = this.scope;
        const enumScope = names.qualified;
        try {
            while (!this.at('}') && !this.atEnd()) {
                this.skipAttributes();
                const token = this.peek();
                if (!this.atIdentifier()) {
                    // e.g. an enumerator produced by an unknown macro: skip to the next enumerator
                    this.report('warning', `unexpected '${token.text}' in enum ${names.simple || '(anonymous)'}`, this.range(token, token));
                    while (!this.atEnd() && !this.at(',') && !this.at('}')) {
                        if (this.at('(') || this.at('[') || this.at('{')) {
                            this.skipBalanced();
                        } else {
                            this.next();
                        }
                    }
                    this.accept(',');
                    continue;
                }
                const nameIndex = this.index;
                this.next();
                this.skipAttributes();
                this.skipTrailingMacros();
                let initializer: CppExpression | undefined;
                if (this.accept('=')) {
                    this.scope = enumScope;
                    initializer = this.parseInitializerSpan(false);
                    this.scope = outer;
                }
                const endIndex = this.index;
                if (!this.accept(',') && !this.at('}')) {
                    this.report('warning', `expected ',' or '}' after enumerator '${token.text}' but found '${this.peek().text || 'end of input'}'`, this.range(this.peek(), this.peek()));
                }
                const trailing = this.trailingDocs(nameIndex, endIndex);
                enumerators.push({
                    // enumerators of anonymous enums are named like members of the enclosing scope
                    kind: 'enumerator', name: token.text, qualifiedName: name ? `${enumScope}::${token.text}` : this.qualify(token.text), scope: enumScope,
                    fileName: this.fileName, range: this.range(token), nameRange: this.range(token, token),
                    ...(token.doc ?? trailing ? { doc: token.doc ?? trailing } : {}), ...(initializer ? { initializer } : {})
                });
            }
        } finally {
            this.scope = outer;
        }
        if (!this.accept('}')) {
            this.report('error', `missing '}' of enum ${names.simple}`, this.range(open, open));
        }
        return this.base<CppEnum>({
            kind: 'enum', name: names.simple, qualifiedName: names.qualified, scoped, anonymous: !name,
            ...(underlyingType ? { underlyingType } : {}), enumerators
        }, keyword, nameToken ?? keyword, doc, this.output);
    }

    private parseRecordBody(keyword: Token, name: CppQualifiedName | undefined, nameToken: Token | undefined, final: boolean,
        bases: CppBaseSpecifier[], doc: string | undefined): CppRecord {
        const names = this.declarationName(name);
        const open = this.expect('{');
        const record: Mutable<CppRecord> = this.base<Mutable<CppRecord>>({
            kind: 'record', key: keyword.text as CppRecord['key'], name: names.simple, qualifiedName: names.qualified,
            anonymous: !name, final, bases, fields: [], members: [], hasUserConstructors: false, hasVirtualFunctions: false,
            hasMemberFunctions: false
        }, keyword, nameToken ?? keyword, doc);
        const context: RecordContext = { record, fields: record.fields as CppField[], access: keyword.text === 'class' ? 'private' : 'public' };
        const outer = this.scope;
        const output = this.output;
        this.scope = names.qualified;
        try {
            this.parseDeclarations(record.members as CppDeclaration[], context);
        } finally {
            this.scope = outer;
            this.output = output;
        }
        if (!this.accept('}')) {
            this.report('error', `missing '}' of ${keyword.text} ${names.simple}`, this.range(open, open));
        }
        record.range = this.range(keyword);
        this.output.push(record);
        return record;
    }

    /** Creates a declaration with the common properties. Enums are also added to `output`. */
    private base<T extends CppDeclaration | Mutable<CppDeclaration>>(
        properties: Omit<T, 'scope' | 'fileName' | 'range' | 'nameRange' | 'doc'>,
        start: Token, nameToken: Token, doc: string | undefined, output?: CppDeclaration[]
    ): T {
        const declaration = {
            ...properties,
            scope: this.scope,
            fileName: this.fileName,
            range: this.range(start),
            nameRange: this.range(nameToken, nameToken),
            ...(doc ? { doc } : {})
        } as unknown as T;
        output?.push(declaration as CppDeclaration);
        return declaration;
    }
}
