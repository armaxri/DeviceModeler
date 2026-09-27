import type { LineMap, Token } from './lexer.js';
import type {
    CppBinaryOperator, CppEnum, CppExpression, CppExpressionNode, CppInitializerElement, CppNamePart, CppQualifiedName,
    CppRange, CppRecord, CppTemplateArgument, CppTypeName, CppTypeRef, CppUnaryOperator
} from './model.js';

/**
 * Token cursor with the parsers for expressions, names and type-ids that are shared by the
 * declaration parser and the preprocessor (`#if`).
 *
 * @module
 * @internal
 */

/** Thrown when a construct cannot be parsed; caught by the declaration parser, which skips it. */
export class SyntaxError extends Error {
    constructor(message: string, readonly token: Token) {
        super(message);
    }
}

/** Keywords that form fundamental types. */
export const FUNDAMENTAL_KEYWORDS = new Set([
    'void', 'bool', 'char', 'wchar_t', 'char8_t', 'char16_t', 'char32_t', 'short', 'int', 'long', 'signed',
    'unsigned', 'float', 'double', '__int128', '__int64', '__int32', '__int16', '__int8', '_Bool'
]);

const CV_KEYWORDS = new Set(['const', 'volatile']);

/** GNU spellings of keywords. */
const KEYWORD_ALIASES: Record<string, string> = {
    __signed__: 'signed', __signed: 'signed', __const: 'const', __const__: 'const', __volatile__: 'volatile', __volatile: 'volatile'
};

/** Keywords that can follow an (ignorable) macro in declaration specifiers. */
const SPECIFIER_KEYWORDS = new Set([
    'static', 'constexpr', 'consteval', 'constinit', 'inline', 'extern', 'typedef', 'virtual', 'explicit', 'friend',
    'mutable', 'thread_local', 'struct', 'class', 'union', 'enum', 'typename', 'auto'
]);

/** Whether a name looks like a macro (`API_EXPORT`, `__THROW`) rather than a type. */
function isMacroLike(name: CppQualifiedName): boolean {
    if (name.global || name.parts.length !== 1 || name.parts[0].templateArguments) {
        return false;
    }
    const text = name.parts[0].name;
    return (text.length >= 2 && /^[A-Z_][A-Z0-9_]*$/.test(text)) || /^__\w+$/.test(text);
}

/** Keywords that are never names. */
export const KEYWORDS = new Set([
    ...FUNDAMENTAL_KEYWORDS, 'alignas', 'alignof', 'asm', 'auto', 'break', 'case', 'catch', 'class', 'const', 'consteval',
    'constexpr', 'constinit', 'const_cast', 'continue', 'co_await', 'co_return', 'co_yield', 'decltype', 'default',
    'delete', 'do', 'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'for', 'friend', 'goto',
    'if', 'inline', 'mutable', 'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'private', 'protected', 'public',
    'register', 'reinterpret_cast', 'requires', 'return', 'sizeof', 'static', 'static_assert', 'static_cast', 'struct',
    'switch', 'template', 'this', 'thread_local', 'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union',
    'using', 'virtual', 'volatile', 'while', 'concept'
]);

/** Alternative operator spellings. */
const ALTERNATIVE_OPERATORS: Record<string, string> = {
    and: '&&', or: '||', not: '!', bitand: '&', bitor: '|', xor: '^', compl: '~', not_eq: '!='
};

const BINARY_PRECEDENCE: Record<string, number> = {
    '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7,
    '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10
};

const CASTS = new Set(['static_cast', 'reinterpret_cast', 'const_cast', 'dynamic_cast', 'bit_cast']);

/**
 * The canonical name of a fundamental type given by its keywords, e.g. `['unsigned']` -> `unsigned int`,
 * `['long', 'unsigned', 'long', 'int']` -> `unsigned long long`. `undefined` for invalid combinations.
 */
export function fundamentalName(keywords: readonly string[]): string | undefined {
    const count = (k: string) => keywords.filter(w => w === k).length;
    const unsigned = count('unsigned') > 0;
    const signed = count('signed') > 0;
    const longs = count('long');
    const has = (k: string) => count(k) > 0;
    const sign = unsigned ? 'unsigned ' : '';
    if (has('_Bool')) {
        return 'bool';
    }
    for (const simple of ['void', 'bool', 'wchar_t', 'char8_t', 'char16_t', 'char32_t', 'float']) {
        if (has(simple)) {
            return simple;
        }
    }
    if (has('double')) {
        return longs > 0 ? 'long double' : 'double';
    }
    if (has('char')) {
        return unsigned ? 'unsigned char' : signed ? 'signed char' : 'char';
    }
    if (has('__int128')) {
        return `${sign}__int128`;
    }
    if (has('__int8')) {
        return unsigned ? 'unsigned char' : 'signed char';
    }
    if (has('__int16') || has('short')) {
        return `${sign}short`;
    }
    if (has('__int64') || longs >= 2) {
        return `${sign}long long`;
    }
    if (longs === 1) {
        return `${sign}long`;
    }
    if (has('int') || has('__int32') || unsigned || signed) {
        return `${sign}int`;
    }
    return undefined;
}

/** Spelling of a qualified name, e.g. `std::array<uint8_t, 4>`. */
export function qualifiedNameText(name: CppQualifiedName): string {
    return (name.global ? '::' : '') + name.parts.map(part =>
        part.templateArguments ? `${part.name}<${part.templateArguments.map(a => a.text).join(', ')}>` : part.name
    ).join('::');
}

/** Spelling of a type name. */
export function typeNameText(name: CppTypeName): string {
    switch (name.kind) {
        case 'fundamental': return name.name;
        case 'named': return qualifiedNameText(name.name);
        case 'declared': return name.declaration.qualifiedName;
        case 'other': return name.text;
    }
}

/** Joins token texts; whitespace between tokens in the source is collapsed to one space. */
export function joinTokens(tokens: readonly Token[]): string {
    let text = '';
    let previous: Token | undefined;
    for (const token of tokens) {
        if (previous && needsSpace(previous, token)) {
            text += ' ';
        }
        text += token.text;
        previous = token;
    }
    return text;
}

function needsSpace(a: Token, b: Token): boolean {
    // keep the spacing of the source (collapsed to one space), but always separate words
    return b.offset > a.end || b.offset < a.offset || (/\w$/.test(a.text) && /^\w/.test(b.text));
}

/**
 * The source text of tokens (whitespace collapsed; macro uses as written) if they are in source
 * order, otherwise the joined token texts.
 */
export function tokensText(tokens: readonly Token[], source: string): string {
    if (tokens.length === 0) {
        return '';
    }
    for (let i = 1; i < tokens.length; i++) {
        if (tokens[i].offset < tokens[i - 1].offset) {
            return joinTokens(tokens);
        }
    }
    let text = source.slice(tokens[0].offset, Math.max(...tokens.map(t => t.end)));
    if (!/["']/.test(text)) {
        text = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    }
    return text.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

interface Mark {
    readonly pos: number;
    readonly splits: number;
}

/** A cursor over tokens; positions beyond `limit` read as `eof`. */
export class TokenCursor {
    protected pos: number;
    private limit: number;
    private readonly splits: Array<{ index: number, token: Token }> = [];
    private readonly eof: Token;

    constructor(protected readonly tokens: Token[], protected readonly lines: LineMap, start = 0, limit = tokens.length - 1) {
        this.pos = start;
        this.limit = limit;
        const last = tokens[Math.min(limit, tokens.length - 1)];
        this.eof = { kind: 'eof', text: '', offset: last?.offset ?? 0, end: last?.offset ?? 0, lineStart: true };
    }

    get index(): number {
        return this.pos;
    }

    peek(ahead = 0): Token {
        const index = this.pos + ahead;
        return index < this.limit ? this.tokens[index] : this.eof;
    }

    /** The token before the current one. */
    previous(): Token {
        return this.tokens[Math.max(0, this.pos - 1)];
    }

    next(): Token {
        const token = this.peek();
        if (this.pos < this.limit) {
            this.pos++;
        }
        return token;
    }

    at(text: string, ahead = 0): boolean {
        const token = this.peek(ahead);
        return token.text === text && token.kind !== 'string' && token.kind !== 'char' && token.kind !== 'eof';
    }

    atEnd(): boolean {
        return this.peek().kind === 'eof';
    }

    accept(text: string): boolean {
        if (this.at(text)) {
            this.next();
            return true;
        }
        return false;
    }

    expect(text: string): Token {
        if (!this.at(text)) {
            throw new SyntaxError(`expected '${text}' but found '${this.peek().text || 'end of input'}'`, this.peek());
        }
        return this.next();
    }

    atIdentifier(ahead = 0): boolean {
        const token = this.peek(ahead);
        return token.kind === 'identifier' && !KEYWORDS.has(token.text);
    }

    protected mark(): Mark {
        return { pos: this.pos, splits: this.splits.length };
    }

    protected reset(mark: Mark): void {
        this.pos = mark.pos;
        while (this.splits.length > mark.splits) {
            const split = this.splits.pop()!;
            this.tokens[split.index] = split.token;
        }
    }

    /** Consumes a closing `>` of a template argument list, splitting `>>`, `>=`, `>>=`. */
    protected acceptCloseAngle(): boolean {
        const token = this.peek();
        if (token.kind !== 'punctuator' || this.pos >= this.limit) {
            return false;
        }
        if (token.text === '>') {
            this.next();
            return true;
        }
        if (token.text === '>>' || token.text === '>=' || token.text === '>>=') {
            this.splits.push({ index: this.pos, token });
            this.tokens[this.pos] = { ...token, text: token.text.slice(1), offset: token.offset + 1 };
            return true;
        }
        return false;
    }

    /** Skips a balanced `(…)`, `[…]` or `{…}` group starting at the current token. */
    skipBalanced(): void {
        const open = this.next().text;
        const close = open === '(' ? ')' : open === '[' ? ']' : '}';
        const stack = [close];
        while (!this.atEnd() && stack.length > 0) {
            const token = this.next();
            if (token.kind !== 'punctuator') {
                continue;
            }
            if (token.text === '(') {
                stack.push(')');
            } else if (token.text === '[') {
                stack.push(']');
            } else if (token.text === '{') {
                stack.push('}');
            } else if (token.text === stack[stack.length - 1]) {
                stack.pop();
            } else if (token.text === '}' && stack.includes('}')) {
                // unbalanced parentheses inside braces: recover at the brace
                while (stack.pop() !== '}') {
                    // pop
                }
            }
        }
    }

    range(start: Token, end: Token = this.previous()): CppRange {
        return this.lines.range(start.offset, Math.max(start.offset, end.end));
    }

    /** The normalized text of the tokens from index `start` (inclusive) to `end` (exclusive). */
    textBetween(start: number, end: number): string {
        return tokensText(this.tokens.slice(start, Math.min(end, this.limit)), this.lines.text);
    }

    // -----------------------------------------------------------------------------------------
    // attributes
    // -----------------------------------------------------------------------------------------

    /** Skips attributes: `[[…]]`, `__attribute__((…))`, `__declspec(…)`, `alignas(…)`, `__extension__`. */
    skipAttributes(): boolean {
        let skipped = false;
        for (;;) {
            if (this.at('[') && this.at('[', 1)) {
                this.skipBalanced();
            } else if ((this.at('__attribute__') || this.at('__declspec') || this.at('alignas') || this.at('__asm__') || this.at('__asm')) && this.at('(', 1)) {
                this.next();
                this.skipBalanced();
            } else if (this.at('__extension__') || this.at('__restrict') || this.at('__restrict__') || this.at('__inline')
                || this.at('__forceinline') || this.at('__cdecl') || this.at('__stdcall')) {
                this.next();
            } else {
                return skipped;
            }
            skipped = true;
        }
    }

    // -----------------------------------------------------------------------------------------
    // names
    // -----------------------------------------------------------------------------------------

    /** Whether a (possibly global) qualified name starts here. */
    atName(): boolean {
        return this.atIdentifier() || (this.at('::') && this.atIdentifier(1));
    }

    /**
     * Parses a qualified name `a::b<T>::c`. Template arguments are parsed if `<` follows a name part
     * and the argument list is followed by `::`, `(`, `{`, or if `templates` is `always`.
     */
    parseQualifiedName(templates: 'always' | 'speculative' = 'speculative'): CppQualifiedName {
        const global = this.accept('::');
        const parts: CppNamePart[] = [];
        for (;;) {
            if (this.at('template')) {
                this.next();
            }
            if (this.at('~') && this.peek(1).kind === 'identifier') {
                this.next();
                parts.push({ name: '~' + this.next().text });
                break;
            }
            if (!this.atIdentifier() && !(this.at('operator'))) {
                throw new SyntaxError(`expected a name but found '${this.peek().text || 'end of input'}'`, this.peek());
            }
            const name = this.next().text;
            let templateArguments: CppTemplateArgument[] | undefined;
            if (this.at('<')) {
                const mark = this.mark();
                try {
                    templateArguments = this.parseTemplateArguments();
                    if (templates === 'speculative' && !this.at('::') && !this.at('(') && !this.at('{')) {
                        this.reset(mark);
                        templateArguments = undefined;
                    }
                } catch (error) {
                    if (!(error instanceof SyntaxError)) {
                        throw error;
                    }
                    this.reset(mark);
                    templateArguments = undefined;
                }
            }
            parts.push(templateArguments ? { name, templateArguments } : { name });
            if (this.at('::') && (this.atIdentifier(1) || this.at('template', 1) || this.at('~', 1))) {
                this.next();
                continue;
            }
            break;
        }
        return { global, parts };
    }

    /** Parses `<arg, …>` (the current token is `<`). */
    parseTemplateArguments(): CppTemplateArgument[] {
        this.expect('<');
        const args: CppTemplateArgument[] = [];
        if (this.acceptCloseAngle()) {
            return args;
        }
        for (;;) {
            const start = this.index;
            const startToken = this.peek();
            let argument: CppTemplateArgument | undefined;
            const mark = this.mark();
            try {
                const type = this.parseTypeId();
                if (this.at(',') || this.at('>') || this.at('>>') || this.at('>=') || this.at('>>=') || this.at('...')) {
                    this.accept('...');
                    const plainName = type.name.kind === 'named' && type.pointer === 0 && !type.reference && !type.const
                        && type.arrayDimensions.length === 0 && !type.functionPointer;
                    argument = {
                        text: this.textBetween(start, this.index),
                        type,
                        expression: plainName ? { text: type.spelling, range: type.range, node: { kind: 'name', name: (type.name as { name: CppQualifiedName }).name, range: type.range } } : undefined
                    };
                } else {
                    this.reset(mark);
                }
            } catch (error) {
                if (!(error instanceof SyntaxError)) {
                    throw error;
                }
                this.reset(mark);
            }
            if (!argument) {
                const node = this.parseConditional(true);
                argument = { text: this.textBetween(start, this.index), expression: { text: this.textBetween(start, this.index), range: this.range(startToken), node } };
            }
            args.push(argument);
            if (this.accept(',')) {
                continue;
            }
            if (this.acceptCloseAngle()) {
                return args;
            }
            throw new SyntaxError(`expected '>' but found '${this.peek().text || 'end of input'}'`, this.peek());
        }
    }

    // -----------------------------------------------------------------------------------------
    // types
    // -----------------------------------------------------------------------------------------

    /** Whether a type-id (as in a cast or `sizeof`) starts here (keywords only, names are ambiguous). */
    atTypeKeyword(): boolean {
        const text = this.peek().text;
        return this.peek().kind === 'identifier' && (FUNDAMENTAL_KEYWORDS.has(text) || CV_KEYWORDS.has(text)
            || ['struct', 'class', 'union', 'enum', 'typename', 'auto', 'decltype'].includes(text));
    }

    /**
     * Hook for class / enum specifiers: the declaration parser overrides this to parse definitions.
     * The default parses elaborated type specifiers (`struct X`, `enum class E`).
     */
    protected parseClassOrEnumSpecifier(): CppTypeName {
        this.next();
        if (this.at('class') || this.at('struct')) {
            this.next();
        }
        this.skipAttributes();
        return { kind: 'named', name: this.parseQualifiedName() };
    }

    /**
     * Parses a type specifier sequence (cv-qualifiers, fundamental keywords, a name or class/enum
     * specifier). Stops at the first token that does not belong to it. Throws if there is no type.
     */
    protected parseTypeSpecifiers(onOther?: (token: Token) => boolean): { name: CppTypeName, const: boolean, volatile: boolean } {
        const keywords: string[] = [];
        let name: CppTypeName | undefined;
        let isConst = false;
        let isVolatile = false;
        for (;;) {
            this.skipAttributes();
            const token = this.peek();
            if (token.kind !== 'identifier' && !(token.text === '::' && !name && keywords.length === 0)) {
                break;
            }
            const text = KEYWORD_ALIASES[token.text] ?? token.text;
            if (text === 'const') {
                isConst = true;
                this.next();
            } else if (text === 'volatile') {
                isVolatile = true;
                this.next();
            } else if (FUNDAMENTAL_KEYWORDS.has(text) && !name) {
                this.next();
                keywords.push(text);
            } else if (onOther?.(token)) {
                // consumed by the caller (storage class specifiers etc.)
            } else if (name || keywords.length > 0) {
                break;
            } else if (['struct', 'class', 'union', 'enum'].includes(token.text)) {
                name = this.parseClassOrEnumSpecifier();
            } else if (token.text === 'typename') {
                this.next();
            } else if (token.text === 'auto') {
                this.next();
                name = { kind: 'other', text: 'auto' };
            } else if ((token.text === 'decltype' || token.text === '__typeof__' || token.text === 'typeof' || token.text === '_Atomic') && this.at('(', 1)) {
                const start = this.index;
                this.next();
                this.skipBalanced();
                name = { kind: 'other', text: this.textBetween(start, this.index) };
            } else if (KEYWORDS.has(token.text)) {
                break;
            } else {
                const parsed = this.parseQualifiedName('always');
                if (keywords.length === 0 && isMacroLike(parsed) && this.atSpecifierContinuation()) {
                    // an unknown macro used as specifier, e.g. `API_EXPORT int f();`, `_GLIBCXX_INLINE constexpr …`
                    continue;
                }
                name = { kind: 'named', name: parsed };
            }
        }
        if (!name) {
            const fundamental = fundamentalName(keywords);
            if (!fundamental) {
                throw new SyntaxError(`expected a type but found '${this.peek().text || 'end of input'}'`, this.peek());
            }
            name = { kind: 'fundamental', name: fundamental };
        }
        return { name, const: isConst, volatile: isVolatile };
    }

    /**
     * Whether the tokens after a name continue the declaration specifiers, i.e. the name is not the
     * type (a specifier keyword follows, or a type name followed by a declarator).
     */
    private atSpecifierContinuation(): boolean {
        const token = this.peek();
        if (token.kind !== 'identifier') {
            return false;
        }
        const text = KEYWORD_ALIASES[token.text] ?? token.text;
        if (FUNDAMENTAL_KEYWORDS.has(text) || SPECIFIER_KEYWORDS.has(text)) {
            return true;
        }
        if (KEYWORDS.has(text)) {
            return false;
        }
        const after = this.peek(1);
        return (after.kind === 'identifier' && !KEYWORDS.has(after.text)) || ['*', '&', '&&', '::', '<'].includes(after.text);
    }

    /** Parses a type-id: type specifiers and an abstract declarator (`*`, `&`, `[N]`). */
    parseTypeId(): CppTypeRef {
        const start = this.peek();
        const specifiers = this.parseTypeSpecifiers();
        let pointer = 0;
        let reference: 'lvalue' | 'rvalue' | undefined;
        let functionPointer = false;
        for (;;) {
            if (this.accept('*')) {
                pointer++;
            } else if (this.at('&') || this.at('&&')) {
                reference = this.next().text === '&' ? 'lvalue' : 'rvalue';
            } else if (this.at('const') || this.at('volatile')) {
                this.next();
            } else if (!this.skipAttributes()) {
                break;
            }
        }
        if (this.at('(') && (this.at('*', 1) || this.at('&', 1))) {
            this.skipBalanced();
            functionPointer = true;
        }
        if (this.at('(')) {
            this.skipBalanced();
            functionPointer = true;
        }
        const arrayDimensions: (CppExpression | undefined)[] = [];
        while (this.at('[')) {
            arrayDimensions.push(this.parseArrayDimension());
        }
        return makeTypeRef(specifiers, pointer, reference, arrayDimensions, functionPointer, this.range(start));
    }

    /** Parses `[N]` (the current token is `[`). */
    protected parseArrayDimension(): CppExpression | undefined {
        const open = this.expect('[');
        if (this.accept(']')) {
            return undefined;
        }
        const end = this.findClosing(this.index - 1);
        const expression = this.parseExpressionSpan(this.index, end);
        this.pos = end;
        this.expect(']');
        void open;
        return expression;
    }

    /** The index of the token that closes the group opened at `openIndex`. */
    protected findClosing(openIndex: number): number {
        const mark = this.mark();
        this.pos = openIndex;
        this.skipBalanced();
        const end = this.pos - 1;
        this.reset(mark);
        return end;
    }

    // -----------------------------------------------------------------------------------------
    // expressions
    // -----------------------------------------------------------------------------------------

    /**
     * Parses the tokens `[start, end)` as an expression. Never throws: tokens that cannot be parsed
     * yield an `unsupported` node with their text.
     */
    parseExpressionSpan(start: number, end: number): CppExpression {
        const startToken = this.tokens[start];
        const endToken = this.tokens[Math.max(start, end - 1)];
        const range = this.lines.range(startToken.offset, Math.max(startToken.offset, end > start ? endToken.end : startToken.offset));
        const text = tokensText(this.tokens.slice(start, end), this.lines.text);
        const sub = new TokenCursor(this.tokens, this.lines, start, end);
        let node: CppExpressionNode;
        try {
            node = sub.parseConditional(false);
            if (!sub.atEnd()) {
                throw new SyntaxError(`unexpected '${sub.peek().text}'`, sub.peek());
            }
        } catch (error) {
            if (!(error instanceof SyntaxError)) {
                throw error;
            }
            sub.reset({ pos: start, splits: 0 });
            node = { kind: 'unsupported', text, range };
        }
        return { text, range, node };
    }

    /** Parses a conditional expression (no comma operator, no assignments). */
    parseConditional(noGreater: boolean): CppExpressionNode {
        const start = this.peek();
        const condition = this.parseBinary(1, noGreater);
        if (this.accept('?')) {
            const whenTrue = this.parseConditional(false);
            this.expect(':');
            const whenFalse = this.parseConditional(noGreater);
            return { kind: 'conditional', condition, whenTrue, whenFalse, range: this.range(start) };
        }
        return condition;
    }

    private binaryOperator(noGreater: boolean): string | undefined {
        const token = this.peek();
        if (token.kind === 'identifier' && ALTERNATIVE_OPERATORS[token.text] && token.text !== 'not' && token.text !== 'compl') {
            return ALTERNATIVE_OPERATORS[token.text];
        }
        if (token.kind !== 'punctuator' || BINARY_PRECEDENCE[token.text] === undefined) {
            return undefined;
        }
        if (noGreater && (token.text === '>' || token.text === '>>' || token.text === '>=')) {
            return undefined;
        }
        return token.text;
    }

    private parseBinary(minPrecedence: number, noGreater: boolean): CppExpressionNode {
        const start = this.peek();
        let left = this.parseUnary(noGreater);
        for (;;) {
            const operator = this.binaryOperator(noGreater);
            const precedence = operator ? BINARY_PRECEDENCE[operator] : 0;
            if (!operator || precedence < minPrecedence) {
                return left;
            }
            this.next();
            const right = this.parseBinary(precedence + 1, noGreater);
            left = { kind: 'binary', operator: operator as CppBinaryOperator, left, right, range: this.range(start) };
        }
    }

    private parseUnary(noGreater: boolean): CppExpressionNode {
        const start = this.peek();
        const alternative = start.kind === 'identifier' ? ALTERNATIVE_OPERATORS[start.text] : undefined;
        if ((start.kind === 'punctuator' && ['+', '-', '!', '~'].includes(start.text)) || alternative === '!' || alternative === '~') {
            this.next();
            const operand = this.parseUnary(noGreater);
            return { kind: 'unary', operator: (alternative ?? start.text) as CppUnaryOperator, operand, range: this.range(start) };
        }
        if (start.text === 'sizeof' || start.text === 'alignof' || start.text === '_Alignof') {
            this.next();
            const operator = start.text === 'sizeof' ? 'sizeof' : 'alignof';
            if (this.at('...')) {
                throw new SyntaxError('sizeof... is not supported', start);
            }
            if (this.at('(')) {
                const mark = this.mark();
                this.next();
                try {
                    const type = this.parseTypeId();
                    if (this.accept(')')) {
                        return { kind: 'sizeof', operator, type, range: this.range(start) };
                    }
                } catch (error) {
                    if (!(error instanceof SyntaxError)) {
                        throw error;
                    }
                }
                this.reset(mark);
            }
            const operand = this.parseUnary(noGreater);
            return { kind: 'sizeof', operator, operand, range: this.range(start) };
        }
        if (start.kind === 'punctuator' && ['&', '*', '++', '--'].includes(start.text)) {
            throw new SyntaxError(`unsupported operator '${start.text}'`, start);
        }
        // C-style cast
        if (this.at('(')) {
            const mark = this.mark();
            this.next();
            if (this.atTypeKeyword() || this.atName()) {
                const keywordType = this.atTypeKeyword();
                try {
                    const type = this.parseTypeId();
                    if (this.accept(')') && (keywordType || type.pointer > 0 || this.atCastOperand())) {
                        const operand = this.parseUnary(noGreater);
                        return { kind: 'cast', type, operand, range: this.range(start) };
                    }
                } catch (error) {
                    if (!(error instanceof SyntaxError)) {
                        throw error;
                    }
                }
            }
            this.reset(mark);
        }
        return this.parsePostfix(noGreater);
    }

    /** Whether the token after `(Name)` starts an operand (so the parentheses are a cast). */
    private atCastOperand(): boolean {
        const token = this.peek();
        switch (token.kind) {
            case 'identifier':
                return !ALTERNATIVE_OPERATORS[token.text] || token.text === 'not' || token.text === 'compl';
            case 'number':
            case 'char':
            case 'string':
                return true;
            case 'punctuator':
                return token.text === '(' || token.text === '~' || token.text === '!';
            default:
                return false;
        }
    }

    private parsePostfix(noGreater: boolean): CppExpressionNode {
        const start = this.peek();
        let node = this.parsePrimary(noGreater);
        for (;;) {
            if (this.at('(') || (this.at('{') && (node.kind === 'name'))) {
                const braces = this.at('{');
                const args = this.parseArguments(braces ? '}' : ')');
                node = { kind: 'call', callee: node, arguments: args, braces, range: this.range(start) };
            } else if (this.at('.') && this.atIdentifier(1)) {
                this.next();
                node = { kind: 'member', object: node, member: this.next().text, range: this.range(start) };
            } else if (this.at('[') || this.at('->') || this.at('++') || this.at('--')) {
                throw new SyntaxError(`unsupported operator '${this.peek().text}'`, this.peek());
            } else {
                return node;
            }
        }
    }

    private parseArguments(close: string): CppExpressionNode[] {
        this.next();
        const args: CppExpressionNode[] = [];
        if (this.accept(close)) {
            return args;
        }
        for (;;) {
            args.push(this.at('{') ? this.parseInitializerList() : this.parseConditional(false));
            if (this.accept(',')) {
                if (this.accept(close)) {
                    return args;
                }
                continue;
            }
            this.expect(close);
            return args;
        }
    }

    /** Parses `{a, b}` / `{.x = a}` (the current token is `{`). */
    parseInitializerList(): CppExpressionNode {
        const start = this.expect('{');
        const elements: CppInitializerElement[] = [];
        while (!this.at('}')) {
            let designator: string | undefined;
            if (this.at('.') && this.atIdentifier(1) && (this.at('=', 2) || this.at('{', 2))) {
                this.next();
                designator = this.next().text;
                this.accept('=');
            }
            const value = this.at('{') ? this.parseInitializerList() : this.parseConditional(false);
            elements.push(designator ? { designator, value } : { value });
            if (!this.accept(',')) {
                break;
            }
        }
        this.expect('}');
        return { kind: 'initializerList', elements, range: this.range(start) };
    }

    private parsePrimary(noGreater: boolean): CppExpressionNode {
        const start = this.peek();
        switch (start.kind) {
            case 'number':
                this.next();
                return { kind: 'number', text: start.text, range: this.range(start) };
            case 'char':
                this.next();
                return { kind: 'char', prefix: start.prefix ?? '', codes: start.codes ?? [], range: this.range(start) };
            case 'string': {
                let value = '';
                while (this.peek().kind === 'string') {
                    value += String.fromCodePoint(...(this.next().codes ?? []));
                }
                // user-defined literal suffix (e.g. "abc"sv) is not supported
                return { kind: 'string', value, range: this.range(start) };
            }
            case 'punctuator':
                if (start.text === '(') {
                    this.next();
                    const inner = this.parseConditional(false);
                    this.expect(')');
                    return inner;
                }
                if (start.text === '{') {
                    return this.parseInitializerList();
                }
                if (start.text === '::' && this.atIdentifier(1)) {
                    return { kind: 'name', name: this.parseQualifiedName(), range: this.range(start) };
                }
                break;
            case 'identifier':
                if (start.text === 'true' || start.text === 'false') {
                    this.next();
                    return { kind: 'boolean', value: start.text === 'true', range: this.range(start) };
                }
                if (start.text === 'nullptr' || start.text === 'NULL') {
                    this.next();
                    return { kind: 'nullptr', range: this.range(start) };
                }
                if (CASTS.has(start.text) && this.at('<', 1)) {
                    this.next();
                    this.expect('<');
                    const type = this.parseTypeId();
                    if (!this.acceptCloseAngle()) {
                        throw new SyntaxError(`expected '>' but found '${this.peek().text}'`, this.peek());
                    }
                    this.expect('(');
                    const operand = this.parseConditional(false);
                    this.expect(')');
                    if (start.text !== 'static_cast' && start.text !== 'bit_cast') {
                        return { kind: 'unsupported', text: start.text, range: this.range(start) };
                    }
                    return { kind: 'cast', type, operand, range: this.range(start) };
                }
                if (FUNDAMENTAL_KEYWORDS.has(start.text)) {
                    // functional cast `int(x)`, `unsigned{x}`
                    const type = this.parseTypeId();
                    if (!this.at('(') && !this.at('{')) {
                        throw new SyntaxError(`expected '(' after '${type.spelling}'`, this.peek());
                    }
                    const braces = this.at('{');
                    const args = this.parseArguments(braces ? '}' : ')');
                    if (args.length !== 1) {
                        if (args.length === 0) {
                            return { kind: 'call', callee: { kind: 'name', name: { global: false, parts: [{ name: type.spelling }] }, range: type.range }, arguments: [], braces, range: this.range(start) };
                        }
                        throw new SyntaxError('a functional cast takes one argument', start);
                    }
                    return { kind: 'cast', type, operand: args[0], range: this.range(start) };
                }
                if (!KEYWORDS.has(start.text) || start.text === 'operator') {
                    return { kind: 'name', name: this.parseQualifiedName(), range: this.range(start) };
                }
                break;
        }
        void noGreater;
        throw new SyntaxError(`unexpected '${start.text || 'end of input'}' in expression`, start);
    }
}

/** Creates a type reference with its normalized spelling. */
export function makeTypeRef(
    specifiers: { name: CppTypeName, const: boolean, volatile: boolean },
    pointer: number,
    reference: 'lvalue' | 'rvalue' | undefined,
    arrayDimensions: readonly (CppExpression | undefined)[],
    functionPointer: boolean,
    range: CppRange
): CppTypeRef {
    let spelling = (specifiers.const ? 'const ' : '') + (specifiers.volatile ? 'volatile ' : '') + typeNameText(specifiers.name)
        + '*'.repeat(pointer) + (reference === 'lvalue' ? '&' : reference === 'rvalue' ? '&&' : '');
    if (functionPointer) {
        spelling += '(*)(…)';
    }
    spelling += arrayDimensions.map(d => `[${d?.text ?? ''}]`).join('');
    return {
        spelling, name: specifiers.name, const: specifiers.const, volatile: specifiers.volatile, pointer,
        reference, arrayDimensions, functionPointer, range
    };
}

/** Type guard helper for declared type names. */
export function declaredOf(name: CppTypeName): CppEnum | CppRecord | undefined {
    return name.kind === 'declared' ? name.declaration : undefined;
}
