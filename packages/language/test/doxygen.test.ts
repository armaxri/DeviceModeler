import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DOC_COMMENT_RULES, DOC_COMMENT_START } from '../src/doc/doc-comment-highlighting.js';
import { docComment } from '../src/doc/doc-comments.js';
import { doxygenToMarkdown, stripCommentMarkers } from '../src/doc/doxygen.js';
import { cppHover } from '../src/lsp/cpp-lsp.js';
import { allVertices } from '../src/model-utils.js';
import { loader, parse } from './helpers.js';

const NBSP = '\u00a0';

describe('comment markers', () => {
    test('block comments: markers and the decoration of the lines are removed, lines and indentation kept', () => {
        expect(stripCommentMarkers('/**\n * First line.\n * Second line.\n *\n * Code:\n *     x = 1;\n */'))
            .toBe('First line.\nSecond line.\n\nCode:\n    x = 1;');
        expect(stripCommentMarkers('/*! Brief.\n    More text\n      indented */')).toBe('Brief.\nMore text\n  indented');
        expect(stripCommentMarkers('/** One line. */')).toBe('One line.');
        expect(stripCommentMarkers('/**< trailing member */')).toBe('trailing member');
        expect(stripCommentMarkers('/******************\n * Banner\n ******************/')).toBe('Banner');
        expect(stripCommentMarkers('/**\r\n * Windows\r\n * lines\r\n */')).toBe('Windows\nlines');
    });

    test('line comments', () => {
        expect(stripCommentMarkers('/// First\n/// Second\n///\n///   indented')).toBe('First\nSecond\n\n  indented');
        expect(stripCommentMarkers('//! Qt style\n//! comment')).toBe('Qt style\ncomment');
        expect(stripCommentMarkers('///< trailing')).toBe('trailing');
        expect(stripCommentMarkers('//!< trailing')).toBe('trailing');
    });
});

describe('Doxygen to Markdown', () => {
    const md = (text: string) => doxygenToMarkdown(text, { codeLanguage: 'cpp' });

    test('line breaks and paragraphs are kept', () => {
        // a single newline would be a space in Markdown: hard line breaks keep the lines
        expect(md('First line\nsecond line\n\n\nNew paragraph.')).toBe('First line  \nsecond line\n\nNew paragraph.');
        expect(md('')).toBe('');
    });

    test('indentation and lists', () => {
        expect(md('Steps:\n- first\n- second\n  continued\nAfter.')).toBe('Steps:\n- first\n- second  \n  continued\n\nAfter.');
        expect(md('-# one\n-# two')).toBe('1. one\n1. two');
        expect(md('Table:\n  a = 1\n  b = 2')).toBe(`Table:  \n${NBSP}${NBSP}a = 1  \n${NBSP}${NBSP}b = 2`);
        expect(md('@li first\n@li second')).toBe('- first\n- second');
    });

    test('brief and details', () => {
        expect(md('@brief Short.\n\n@details Long\ntext.')).toBe('Short.\n\nLong  \ntext.');
        // continuation lines aligned with the text after the command
        expect(md('\\brief Short text\n       continued.')).toBe('Short text  \ncontinued.');
    });

    test('parameters, return values and exceptions', () => {
        expect(md([
            'Moves the motor.',
            '@param[in]  target  the target',
            '                    in millimeters',
            '@param speed speed in rpm',
            '\\param[in,out] state the state',
            '@tparam T the type',
            '@return @c true if the move started',
            '@retval 0 ok',
            '@retval -1 failed',
            '@throws std::runtime_error if stalled'
        ].join('\n'))).toBe([
            'Moves the motor.',
            '',
            '**Parameters:**',
            '- `target` *(in)* — the target  ',
            '  in millimeters',
            '- `speed` — speed in rpm',
            '- `state` *(in,out)* — the state',
            '',
            '**Template parameters:**',
            '- `T` — the type',
            '',
            '**Returns:** `true` if the move started',
            '',
            '**Return values:**',
            '- `0` — ok',
            '- `-1` — failed',
            '',
            '**Throws:**',
            '- `std::runtime_error` — if stalled'
        ].join('\n'));
    });

    test('parameters separated by blank lines form one list; JSDoc types', () => {
        expect(md('@param a first\n\n@param {integer} b second')).toBe('**Parameters:**\n- `a` — first\n- `b` : `integer` — second');
        expect(md('@param a first\n\nText after.')).toBe('**Parameters:**\n- `a` — first\n\nText after.');
    });

    test('labelled sections', () => {
        expect(md('@note Read this\n      carefully.\n@warning Hot!\n\\see stop()\n@sa start()\n@deprecated Use other.\n@pre ready\n@post done'))
            .toBe('**Note:** Read this  \ncarefully.\n\n**Warning:** Hot!\n\n**See also:** stop()\n\n**See also:** start()\n\n'
                + '**Deprecated:** Use other.\n\n**Precondition:** ready\n\n**Postcondition:** done');
        expect(md('@note\nOn the next line.')).toBe('**Note:** On the next line.');
        expect(md('@par Example\nText')).toBe('**Example**  \nText');
    });

    test('code blocks', () => {
        expect(md('Usage:\n@code\n  if (x) {\n      y();\n  }\n@endcode\nDone.')).toBe('Usage:\n\n```cpp\nif (x) {\n    y();\n}\n```\n\nDone.');
        expect(md('\\code{.py}\nprint(1)\n\\endcode')).toBe('```py\nprint(1)\n```');
        expect(doxygenToMarkdown('@code\nx\n@endcode')).toBe('```\nx\n```');
        expect(md('@verbatim\n<raw> @c text\n@endverbatim')).toBe('```\n<raw> @c text\n```');
        // Markdown code blocks stay as they are
        expect(md('```\na  <b>\n```')).toBe('```\na  <b>\n```');
        // not closed
        expect(md('@code\nx')).toBe('```cpp\nx\n```');
    });

    test('inline commands and HTML', () => {
        expect(md('Use @c foo() or \\p bar, @a arg, @e emph, @em em and @b bold.'))
            .toBe('Use `foo()` or `bar`, *arg*, *emph*, *em* and **bold**.');
        expect(md('<b>bold</b> <i>it</i> <em>em</em> <tt>code</tt> <code>c</code> line<br>break'))
            .toBe('**bold** *it* *em* `code` `c` line<br>break');
        expect(md('A std::vector<int> and <unknown> tag; `<kept>` in code')).toBe('A std::vector\\<int> and \\<unknown> tag; `<kept>` in code');
        expect(md('See {@link Motor} and @ref Limits "the limits".')).toBe('See `Motor` and `the limits`.');
        const linked = doxygenToMarkdown('See {@link Motor the motor}.', { renderLink: (target, display) => `[${display}](#${target})` });
        expect(linked).toBe('See [the motor](#Motor).');
    });

    test('unknown commands stay visible, structural ones are dropped', () => {
        expect(md('@custom stays\nText')).toBe('@custom stays  \nText');
        expect(md('@note A note\n@custom own paragraph')).toBe('**Note:** A note\n\n@custom own paragraph');
        expect(md('@file motor.h\n@ingroup motors\nThe motor.')).toBe('The motor.');
    });

    test('a complete comment', () => {
        const comment = [
            '/**',
            ' * @brief Moves the motor to a position.',
            ' *',
            ' * The motor accelerates with the configured ramp',
            ' * and stops at the target.',
            ' *',
            ' * @param target the target position',
            ' * @return whether the move started',
            ' */'
        ].join('\n');
        expect(md(stripCommentMarkers(comment))).toBe([
            'Moves the motor to a position.',
            '',
            'The motor accelerates with the configured ramp  ',
            'and stops at the target.',
            '',
            '**Parameters:**',
            '- `target` — the target position',
            '',
            '**Returns:** whether the move started'
        ].join('\n'));
    });
});

const HEADER = `#pragma once
#include <cstdint>
namespace drive {
/**
 * @brief Operating mode of the drive.
 *
 * Switch with care:
 * - Off stops at once
 * - Slow ramps down
 *
 * @note Changing the mode while moving
 *       is delayed.
 */
enum class Mode : std::uint8_t { Off, Slow };

/// Maximum speed.
/// In rpm, see @c Mode.
constexpr std::int32_t kMaxSpeed = 6000;
}
`;

describe('hover', () => {
    test('of a C++ header symbol keeps the lines of its documentation and renders Doxygen commands', async () => {
        const text = 'statemachine M {\n    import "drive.h"\n    interface:\n        var mode : drive::Mode\n        var speed : integer = drive::kMaxSpeed\n    [*] -> A\n    state A\n}';
        const parsed = await parse(text, { 'drive.h': HEADER });
        expect(parsed.diagnostics.filter(d => d.severity === 1)).toEqual([]);
        const mode = cppHover(parsed.document, text.indexOf('drive::Mode') + 8)!;
        expect(mode).toContain([
            'Operating mode of the drive.',
            '',
            'Switch with care:',
            '- Off stops at once',
            '- Slow ramps down',
            '',
            '**Note:** Changing the mode while moving  ',
            'is delayed.'
        ].join('\n'));
        expect(mode).not.toContain('@brief');
        const speed = cppHover(parsed.document, text.indexOf('drive::kMaxSpeed') + 8)!;
        expect(speed).toContain('Maximum speed.  \nIn rpm, see `Mode`.');
    });

    test('of a model element keeps the lines of its documentation comment and renders Doxygen commands', async () => {
        const text = [
            'statemachine M {',
            '    interface:',
            '        /**',
            '         * Moves to a position.',
            '         * Second line.',
            '         *',
            '         * @param target the position',
            '         * @return the distance',
            '         */',
            '        operation moveTo(target : integer) : integer',
            '    [*] -> A',
            '    /**',
            '     * Waiting.',
            '     * @see {@link moveTo}, {@link M the machine}',
            '     */',
            '    state A',
            '}'
        ].join('\n');
        const parsed = await parse(text);
        const provider = loader.services.Devm.documentation.DocumentationProvider;
        const operation = parsed.model.scopes[0].declarations[0];
        expect(provider.getDocumentation(operation)).toBe([
            '```devm',
            'operation moveTo(target : integer) : integer',
            '```',
            '',
            'Moves to a position.  ',
            'Second line.',
            '',
            '**Parameters:**',
            '- `target` — the position',
            '',
            '**Returns:** the distance'
        ].join('\n'));
        const state = allVertices(parsed.model).find(v => v.name === 'A')!;
        // `{@link}`: a link to the state machine (names of the index), others as code
        expect(provider.getDocumentation(state)).toMatch(/\*\*See also:\*\* `moveTo`, \[the machine\]\([^)]*#L1%2C14\)$/);
        expect(docComment(state)).toBe('Waiting.\n\n**See also:** `moveTo`, `the machine`');
    });
});

describe('highlighting of documentation comments', () => {
    /** Tokens of a line inside a documentation comment (a minimal Monarch tokenizer of the `docComment` state). */
    function monarchTokens(line: string): Array<[string, string]> {
        const tokens: Array<[string, string]> = [];
        let rest = line;
        while (rest.length > 0) {
            const rule = DOC_COMMENT_RULES.find(r => new RegExp(`^(?:${r.regex.source})`).test(rest))!;
            const match = new RegExp(`^(?:${rule.regex.source})`).exec(rest)!;
            const actions = Array.isArray(rule.action) ? rule.action : [rule.action];
            const parts = Array.isArray(rule.action) ? match.slice(1) : [match[0]];
            parts.forEach((part, i) => {
                const last = tokens[tokens.length - 1];
                if (last && last[1] === actions[i].token) {
                    last[0] += part;
                } else {
                    tokens.push([part, actions[i].token]);
                }
            });
            rest = rest.slice(match[0].length);
        }
        return tokens.filter(([text, token]) => token !== 'comment.doc' || text.trim() !== '');
    }

    test('Monarch rules (web app)', () => {
        expect(DOC_COMMENT_START.regex.test('/** doc */')).toBe(true);
        expect(DOC_COMMENT_START.regex.test('/* plain */')).toBe(false);
        expect(DOC_COMMENT_START.regex.test('/**/')).toBe(false);
        // Monarch replaces `@name` in regular expressions by attributes of the language definition
        for (const rule of [DOC_COMMENT_START, ...DOC_COMMENT_RULES]) {
            expect(rule.regex.source).not.toMatch(/@\w/);
        }
        expect(monarchTokens(' * @param[in] target the @c x, see {@link Motor} \\brief a@b.de */')).toEqual([
            [' * ', 'comment.doc'], ['@param[in]', 'comment.doc.tag'], [' ', 'comment.doc'], ['target', 'comment.doc.param'],
            [' the ', 'comment.doc'], ['@c', 'comment.doc.tag'], [' ', 'comment.doc'], ['x,', 'comment.doc.code'],
            [' see ', 'comment.doc'], ['{@link Motor}', 'comment.doc.tag'], [' ', 'comment.doc'], ['\\brief', 'comment.doc.tag'],
            [' a@b.de */', 'comment.doc']
        ].filter(([text, token]) => token !== 'comment.doc' || text.trim() !== ''));
    });

    test('TextMate injection grammar (VS Code)', () => {
        const file = path.resolve(__dirname, '../syntaxes/devm-doc-comments.tmLanguage.json');
        const grammar = JSON.parse(fs.readFileSync(file, 'utf-8'));
        expect(grammar.injectionSelector).toContain('L:source.devm');
        const repository = grammar.repository;
        const regex = (source: string) => new RegExp(source);
        expect(regex(repository['doc-comment'].begin).test('/** doc')).toBe(true);
        expect(regex(repository['doc-comment'].begin).test('/* plain')).toBe(false);
        expect(regex(repository.parameter.match).exec(' * @param[in] target the target')?.slice(1, 5)).toEqual(['@param', '[in]', undefined, 'target']);
        expect(regex(repository.parameter.match).exec(' * \\param {integer} count')?.slice(1, 5)).toEqual(['\\param', undefined, '{integer}', 'count']);
        expect(regex(repository.command.match).exec(' * \\brief Text')?.[0]).toBe('\\brief');
        expect(regex(repository.command.match).test('mail a@b.de')).toBe(false);
        expect(regex(repository.inline.patterns[0].match).exec('the @c value')?.slice(1, 3)).toEqual(['@c', 'value']);
        expect(regex(repository.code.begin).exec('@code{.cpp}')?.slice(1, 3)).toEqual(['@code', '{.cpp}']);
        // the extension registers the grammar (copied by the build of the extension)
        const extension = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../vscode/package.json'), 'utf-8'));
        expect(extension.contributes.grammars).toContainEqual(expect.objectContaining({ scopeName: grammar.scopeName, injectTo: ['source.devm', 'source.devmtest'] }));
    });
});
