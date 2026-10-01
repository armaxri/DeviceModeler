import { CstUtils, isJSDoc, type AstNode } from 'langium';

/**
 * The documentation comment (`/** … *\/`) of a model element as C++ comment lines for the generated code:
 * the text is kept as written (Doxygen commands like `@brief` included), only the indentation is
 * normalized. Empty if the element has no documentation comment.
 */
export function cppDocComment(node: AstNode): string[] {
    const comment = CstUtils.findCommentNode(node.$cstNode, ['ML_COMMENT'])?.text;
    if (!comment || !isJSDoc(comment)) {
        return [];
    }
    const lines = comment.split(/\r?\n/).map(line => line.trim());
    if (lines.length === 1) {
        return [lines[0]];
    }
    return lines.map((line, i) => {
        if (i === 0) {
            return line;
        }
        if (line.startsWith('*')) {
            return ` ${line}`;
        }
        return line ? ` * ${line}` : ' *';
    });
}
