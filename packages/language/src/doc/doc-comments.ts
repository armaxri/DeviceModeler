import { CstUtils, isJSDoc, parseJSDoc, type AstNode } from 'langium';

/** Names of the terminal rules of multi-line comments (see statemachine.langium). */
const COMMENT_RULES = ['ML_COMMENT'];

/**
 * The documentation comment (`/** … *\/`) directly preceding the given model element (state machine,
 * declaration, interface, state, pseudo state, region, transition, local reaction), rendered as
 * Markdown (JSDoc tags like `@see` are rendered as well). Plain comments (`/* … *\/`, `// …`) are
 * not documentation.
 *
 * This is what Langium's `JSDocDocumentationProvider` returns for the element, without the need for
 * the language services (works on any AST produced by the parser of the `.devm` language).
 */
export function docComment(node: AstNode | undefined): string | undefined {
    const comment = CstUtils.findCommentNode(node?.$cstNode, COMMENT_RULES)?.text;
    if (!comment || !isJSDoc(comment)) {
        return undefined;
    }
    const markdown = parseJSDoc(comment).toMarkdown()
        .split(/\r?\n/).map(line => line.trim()).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return markdown || undefined;
}
