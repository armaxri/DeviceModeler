/**
 * Documentation comments (Doxygen / JSDoc style) rendered as Markdown for hover tooltips, completion
 * details and the generated model documentation. Used for the doc comments of C/C++ headers and for
 * the `/** … *\/` comments of the models.
 *
 * The text keeps its structure: line breaks are kept (Markdown hard line breaks), blank lines separate
 * paragraphs, indentation and lists stay as written. Common Doxygen commands (`@` or `\` prefix) are
 * rendered readably: `@brief` starts the text, `@param` / `@tparam` / `@retval` / `@throws` become
 * lists, `@return`, `@note`, `@warning`, `@see`, … labelled paragraphs, `@code … @endcode` a code
 * block, `@c` / `@p` / `@a` / `@e` / `@b` and `<b>` / `<i>` / `<tt>` inline styles. Unknown commands
 * stay visible as they are.
 */

/** Options of {@link doxygenToMarkdown}. */
export interface DoxygenMarkdownOptions {
    /** Language of `@code` blocks without an explicit language (e.g. `cpp`); none by default. */
    readonly codeLanguage?: string;
    /**
     * Renders a link (`{@link target}`, `{@link target text}`, `@ref target "text"`) as Markdown;
     * `undefined` renders the text as code.
     */
    readonly renderLink?: (target: string, display: string) => string | undefined;
}

/**
 * The text of a documentation comment without the comment markers: `/**`, `/*!`, `*\/`, the leading
 * `*` of each line, `///`, `//!` and the trailing-member forms `/**<`, `///<`, `//!<`. Line breaks,
 * blank lines and the indentation relative to the comment are kept; leading and trailing blank lines
 * are removed. Consecutive line comments may be passed together (one per line).
 */
export function stripCommentMarkers(comment: string): string {
    const text = comment.replace(/\r\n?/g, '\n').trim();
    let lines: string[];
    if (text.startsWith('/*')) {
        const body = text.replace(/^\/\*[*!]?<?/, '').replace(/\*+\/$/, '');
        const [first, ...rest] = body.split('\n');
        // the decoration ` * ` at the start of the lines (only if all lines have it)
        const decorated = rest.filter(line => line.trim() !== '').every(line => /^\s*\*/.test(line));
        const content = decorated ? rest.map(line => line.replace(/^\s*\*/, '')) : rest;
        lines = [first.replace(/^\**/, '').trim(), ...dedent(content)];
    } else {
        lines = dedent(text.split('\n').map(line => line.replace(/^\s*\/\/[/!]?<?/, '')));
    }
    // banner lines (`/*********`, ` *********/`)
    return trimBlankLines(lines.map(line => /^\s*\*+\s*$/.test(line) ? '' : line.trimEnd())).join('\n');
}

/**
 * Renders the text of a documentation comment (without comment markers, see
 * {@link stripCommentMarkers}) as Markdown. Returns an empty string for an empty text.
 */
export function doxygenToMarkdown(text: string, options: DoxygenMarkdownOptions = {}): string {
    return new DoxygenRenderer(options).render(text);
}

/** Labels of the commands that start a labelled paragraph. */
const SECTION_LABELS: Record<string, string> = {
    return: 'Returns', returns: 'Returns', result: 'Returns',
    note: 'Note', warning: 'Warning', attention: 'Attention', important: 'Important',
    remark: 'Remark', remarks: 'Remark', deprecated: 'Deprecated',
    see: 'See also', sa: 'See also',
    pre: 'Precondition', post: 'Postcondition', invariant: 'Invariant',
    since: 'Since', version: 'Version', author: 'Author', authors: 'Author', date: 'Date',
    todo: 'To do', bug: 'Bug', copyright: 'Copyright', test: 'Test', example: 'Example'
};

/** Commands rendered as a list of names with descriptions. */
const LIST_TITLES: Record<string, string> = {
    param: 'Parameters', tparam: 'Template parameters', retval: 'Return values',
    throws: 'Throws', throw: 'Throws', exception: 'Throws'
};

/** Structural commands without visible content (the declaration is known from the code). */
const IGNORED = new Set([
    'file', 'class', 'struct', 'union', 'enum', 'fn', 'var', 'def', 'typedef', 'namespace', 'package', 'interface',
    'ingroup', 'defgroup', 'addtogroup', 'weakgroup', 'name', '{', '}', 'internal', 'endinternal',
    'private', 'public', 'protected', 'privatesection', 'publicsection', 'protectedsection',
    'nosubgrouping', 'hideinitializer', 'showinitializer', 'overload', 'mainpage', 'page', 'cond', 'endcond',
    'headerfile', 'relates', 'relatesalso', 'memberof', 'related', 'relatedalso', 'static', 'pure', 'callgraph',
    'callergraph', 'hidecallgraph', 'hidecallergraph', 'showrefby', 'hiderefby', 'showrefs', 'hiderefs'
]);

/** A command at the start of a line: name, options (`[in]`, `{.cpp}`) and the rest of the line. */
const LINE_COMMAND = /^[@\\]([A-Za-z]+|[{}])(\[[^\]]*\]|\{[^}]*\})?(?=\s|$)\s*(.*)$/;
/** A Markdown list item (`- `, `* `, `+ `, `1. `, `1) `) or a Doxygen numbered list item (`-#`). */
const LIST_ITEM = /^\s*([-*+]|-#|\d+[.)])\s/;

interface Paragraph {
    /** Label prefixed to the first line, e.g. `**Note:**`. */
    readonly label?: string;
    /**
     * Whether the paragraph was started by a command (`@brief`, `@note`, …): the indentation of its
     * continuation lines only aligns them with the text after the command.
     */
    readonly command?: boolean;
    readonly lines: string[];
}

interface ItemList {
    readonly title: string;
    readonly items: string[][];
}

class DoxygenRenderer {
    private readonly blocks: string[] = [];
    private paragraph: Paragraph | undefined;
    private list: ItemList | undefined;
    /** Whether non-command lines continue the last list item (until a blank line). */
    private inItem = false;

    constructor(private readonly options: DoxygenMarkdownOptions) { }

    render(text: string): string {
        const lines = dedent(trimBlankLines(text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd())));
        for (let i = 0; i < lines.length; i++) {
            i = this.line(lines, i);
        }
        this.flush();
        return this.blocks.join('\n\n');
    }

    /** Handles the line at `i`; returns the index of the last line consumed. */
    private line(lines: string[], i: number): number {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === '') {
            this.flushParagraph();
            this.inItem = false;
            return i;
        }
        const fence = /^(`{3,}|~{3,})/.exec(trimmed);
        if (fence) {
            // a Markdown code block: verbatim
            let end = i + 1;
            while (end < lines.length && !lines[end].trim().startsWith(fence[1])) {
                end++;
            }
            this.flush();
            this.blocks.push(dedent(lines.slice(i, Math.min(end + 1, lines.length))).join('\n'));
            return end;
        }
        const command = LINE_COMMAND.exec(trimmed);
        if (!command) {
            this.text(line);
            return i;
        }
        const [, name, option, rest] = command;
        if (name === 'code' || name === 'verbatim') {
            return this.code(lines, i, name, option, rest);
        }
        if (name === 'brief' || name === 'short' || name === 'details') {
            this.flush();
            this.paragraph = { command: true, lines: rest ? [this.inline(rest)] : [] };
        } else if (LIST_TITLES[name]) {
            this.item(LIST_TITLES[name], name, option, rest);
        } else if (SECTION_LABELS[name]) {
            this.flush();
            this.paragraph = { label: `**${SECTION_LABELS[name]}:**`, command: true, lines: rest ? [this.inline(rest)] : [] };
        } else if (name === 'par' || name === 'section' || name === 'subsection' || name === 'subsubsection' || name === 'paragraph') {
            // `@par Title` / `@section id Title`: a bold title line
            this.flush();
            const title = name === 'par' ? rest : rest.replace(/^\S+\s*/, '');
            this.paragraph = { command: true, lines: title ? [`**${this.inline(title)}**`] : [] };
        } else if (name === 'li' || name === 'arg') {
            this.text(`- ${rest}`);
        } else if (IGNORED.has(name)) {
            // the declaration is known from the code
        } else {
            // an unknown command stays visible; it starts a new paragraph like the known ones
            if (this.paragraph?.command) {
                this.flushParagraph();
            }
            this.text(line);
        }
        return i;
    }

    /** A line of text: continues the current list item or paragraph. */
    private text(line: string): void {
        if (this.inItem && this.list && !this.paragraph) {
            this.list.items[this.list.items.length - 1].push(this.inline(line.trim()));
            return;
        }
        this.flushList();
        this.paragraph ??= { lines: [] };
        const indentation = this.paragraph.command ? '' : /^\s*/.exec(line)![0];
        this.paragraph.lines.push(indentation + this.inline(line.slice(indentation.length).trimStart()));
    }

    /** `@param[in] name description`, `@retval value description`, `@throws type description`. */
    private item(title: string, name: string, option: string | undefined, rest: string): void {
        this.flushParagraph();
        if (this.list?.title !== title) {
            this.flushList();
            this.list = { title, items: [] };
        }
        // JSDoc style type: `@param {integer} count`
        const typed = /^\{([^}]*)\}\s*(.*)$/.exec(rest);
        const body = typed ? typed[2] : rest;
        const match = /^(\S+)\s*(.*)$/.exec(body);
        let entry: string;
        if (!match) {
            entry = '';
        } else {
            const direction = name === 'param' && option?.startsWith('[') ? option.slice(1, -1).replace(/\s+/g, '') : undefined;
            entry = [
                codeSpan(match[1]),
                typed ? ` : ${codeSpan(typed[1].trim())}` : '',
                direction ? ` *(${direction})*` : '',
                match[2] ? ` — ${this.inline(match[2])}` : ''
            ].join('');
        }
        this.list.items.push([entry]);
        this.inItem = true;
    }

    /** `@code{.cpp} … @endcode`, `@verbatim … @endverbatim`: a fenced code block. */
    private code(lines: string[], i: number, name: string, option: string | undefined, rest: string): number {
        this.flush();
        const endCommand = new RegExp(`[@\\\\]end${name}\\b`);
        const content: string[] = [];
        let end = i;
        let first: string | undefined = rest;
        for (;;) {
            const line = first ?? lines[end];
            first = undefined;
            const close = endCommand.exec(line);
            if (close) {
                content.push(line.slice(0, close.index));
                break;
            }
            content.push(line);
            if (++end >= lines.length) {
                break;
            }
        }
        const body = trimBlankLines(dedent(content.map(line => line.trimEnd())));
        const language = name === 'code' ? (/^\{\.?([^}]*)\}$/.exec(option ?? '')?.[1].trim() || this.options.codeLanguage || '') : '';
        const longest = Math.max(2, ...body.map(line => /^\s*(`+)/.exec(line)?.[1].length ?? 0));
        const fence = '`'.repeat(longest + 1);
        this.blocks.push([fence + language, ...body, fence].join('\n'));
        return Math.min(end, lines.length - 1);
    }

    private flush(): void {
        this.flushParagraph();
        this.flushList();
    }

    private flushParagraph(): void {
        const paragraph = this.paragraph;
        this.paragraph = undefined;
        if (!paragraph) {
            return;
        }
        const lines = [...paragraph.lines];
        if (paragraph.label) {
            lines[0] = lines.length > 0 ? `${paragraph.label} ${lines[0].trimStart()}` : paragraph.label;
        }
        if (lines.length > 0) {
            this.blocks.push(joinLines(lines));
        }
    }

    private flushList(): void {
        const list = this.list;
        this.list = undefined;
        this.inItem = false;
        if (!list) {
            return;
        }
        const items = list.items.map(([first, ...more]) => ['- ' + first, ...more.map(line => '  ' + line)].join('  \n'));
        this.blocks.push([`**${list.title}:**`, ...items].join('\n'));
    }

    /** Inline commands and HTML tags of a line (code spans stay as they are). */
    private inline(text: string): string {
        return text.split(/(`+[^`]*`+)/).map((part, index) => index % 2 === 1 ? part : this.inlineText(part)).join('');
    }

    private inlineText(text: string): string {
        // a word: up to white space, without trailing punctuation, with balanced parentheses (`f(x)`)
        const word = String.raw`((?:[^\s()]|\([^\s()]*\))+?)(?=[.,;:!?)]*(?:\s|$))`;
        const pattern = new RegExp([
            String.raw`\{@link(?:code|plain)?\s+([^\s}|]+)\s*\|?\s*([^}]*)\}`,
            String.raw`[@\\]ref\s+${word}(?:\s+"([^"]*)")?`,
            String.raw`[@\\](c|p|a|e|em|b)\s+${word}`,
            String.raw`<(\/?)(b|strong|i|em|tt|code)>`,
            String.raw`<br\s*\/?>`,
            String.raw`<(?=[A-Za-z/!?])`
        ].join('|'), 'g');
        return text.replace(pattern, (match, linkTarget?: string, linkText?: string, refTarget?: string, refText?: string,
            style?: string, styled?: string, _closing?: string, tag?: string) => {
            if (linkTarget !== undefined || refTarget !== undefined) {
                const target = (linkTarget ?? refTarget)!;
                const display = (linkText ?? refText ?? '').trim() || target;
                return this.options.renderLink?.(target, display) ?? codeSpan(display);
            }
            if (style) {
                switch (style) {
                    case 'c': case 'p': return codeSpan(styled!);
                    case 'b': return `**${styled}**`;
                    default: return `*${styled}*`;
                }
            }
            if (tag) {
                switch (tag) {
                    case 'b': case 'strong': return '**';
                    case 'tt': case 'code': return '`';
                    default: return '*';
                }
            }
            if (match.startsWith('<br')) {
                return '<br>';
            }
            // any other `<` (e.g. `std::vector<int>`, `<unknown>`) is text, not HTML
            return '\\<';
        });
    }
}

/** Lines joined so that the line breaks are kept (Markdown hard line breaks), lists and indentation as written. */
function joinLines(lines: string[]): string {
    let result = '';
    let inList = false;
    lines.forEach((line, index) => {
        const item = LIST_ITEM.test(line);
        const indented = /^\s/.test(line);
        let rendered = line;
        if (item) {
            rendered = line.replace(/^(\s*)-#(?=\s)/, '$11.');
        } else if (indented && !inList) {
            // non-breaking spaces keep the indentation (Markdown removes leading spaces of a line)
            rendered = line.replace(/^\s+/, spaces => ' '.repeat(spaces.length));
        }
        if (index > 0) {
            if (item) {
                result += '\n';
            } else if (inList && !indented) {
                // text after a list starts a new paragraph
                result += '\n\n';
            } else {
                result += '  \n';
            }
        }
        if (item) {
            inList = true;
        } else if (!indented) {
            inList = false;
        }
        result += rendered;
    });
    return result;
}

function codeSpan(text: string): string {
    const fence = text.includes('`') ? '``' : '`';
    const padding = fence.length > 1 ? ' ' : '';
    return `${fence}${padding}${text}${padding}${fence}`;
}

/** The lines without their common indentation (tabs count as four spaces). */
function dedent(lines: string[]): string[] {
    const expanded = lines.map(line => line.replace(/^[ \t]+/, space => space.replace(/\t/g, '    ')));
    const indentations = expanded.filter(line => line.trim() !== '').map(line => /^ */.exec(line)![0].length);
    const common = indentations.length > 0 ? Math.min(...indentations) : 0;
    return expanded.map(line => line.slice(Math.min(common, /^ */.exec(line)![0].length)));
}

function trimBlankLines(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === '') {
        start++;
    }
    while (end > start && lines[end - 1].trim() === '') {
        end--;
    }
    return lines.slice(start, end);
}
