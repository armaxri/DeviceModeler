import { CstUtils, isJSDoc, type AstNode } from 'langium';
import { doxygenToMarkdown, stripCommentMarkers, type DoxygenMarkdownOptions } from './doxygen.js';

/** Names of the terminal rules of multi-line comments (see hsm.langium). */
const COMMENT_RULES = ['ML_COMMENT'];

/**
 * The documentation comment (`/** … *\/`) directly preceding the given model element (state machine,
 * declaration, interface, state, pseudo state, region, transition, local reaction), rendered as
 * Markdown: line breaks and paragraphs as written, Doxygen / JSDoc commands like `@param`, `@note` or
 * `@see` rendered readably (see `doxygen.ts`). Plain comments (`/* … *\/`, `// …`) are not
 * documentation.
 *
 * This is what the documentation provider of the language services returns for the element (without
 * the signature), without the need for the language services (works on any AST produced by the HSM
 * parser).
 */
export function docComment(node: AstNode | undefined, options?: DoxygenMarkdownOptions): string | undefined {
    const comment = CstUtils.findCommentNode(node?.$cstNode, COMMENT_RULES)?.text;
    return comment ? docCommentMarkdown(comment, options) : undefined;
}

/** A documentation comment (`/** … *\/`) as Markdown; `undefined` for other or empty comments. */
export function docCommentMarkdown(comment: string, options?: DoxygenMarkdownOptions): string | undefined {
    if (!isJSDoc(comment)) {
        return undefined;
    }
    return doxygenToMarkdown(stripCommentMarkers(comment), options) || undefined;
}
