/**
 * Monarch rules (Monaco editor of the web app) highlighting the Doxygen / JSDoc commands in the
 * documentation comments (`/** … *\/`) of models; the VS Code extension uses the TextMate injection
 * grammar `syntaxes/devm-doc-comments.tmLanguage.json` with the same rules.
 *
 * Tokens: `comment.doc` (the comment), `comment.doc.tag` (`@param`, `\brief`, `{@link …}`),
 * `comment.doc.param` (the name after `@param`, `@retval`, `@throws`) and `comment.doc.code` (the
 * word after `@c` / `@p`); themes without rules for them show them as comments.
 */

type MonarchAction = { token: string, next?: string };

/** A Monarch rule: a regular expression and its token (or one token per group). */
export interface DocCommentMonarchRule {
    readonly regex: RegExp;
    readonly action: MonarchAction | MonarchAction[];
}

const TAG = { token: 'comment.doc.tag' };
const TEXT = { token: 'comment.doc' };

/** The rule entering a documentation comment: in the `whitespace` state, before the rule of block comments. */
export const DOC_COMMENT_START: DocCommentMonarchRule = { regex: /\/\*\*(?![*/])/, action: { token: 'comment.doc', next: '@docComment' } };

/**
 * The rules of the state `docComment` (inside a documentation comment). `@` is written `\x40`: Monarch
 * replaces `@name` in regular expressions by the attribute `name` of the language definition.
 */
export const DOC_COMMENT_RULES: readonly DocCommentMonarchRule[] = [
    { regex: /\*\//, action: { token: 'comment.doc', next: '@pop' } },
    // e-mail addresses are no commands
    { regex: /\w+[\x40\\]\w[\w.]*/, action: TEXT },
    { regex: /([\x40\\](?:param|tparam|retval|throws?|exception)(?:\[[^\]]*\])?)(\s+)([^\s*]+)/, action: [TAG, TEXT, { token: 'comment.doc.param' }] },
    { regex: /([\x40\\][cp])(\s+)([^\s*]+)/, action: [TAG, TEXT, { token: 'comment.doc.code' }] },
    { regex: /\{\x40link(?:code|plain)?\s+[^}]*\}/, action: TAG },
    { regex: /[\x40\\](?:[a-zA-Z]+|[{}])/, action: TAG },
    { regex: /[^*\x40\\{\w]+|\w+/, action: TEXT },
    { regex: /./, action: TEXT }
];
