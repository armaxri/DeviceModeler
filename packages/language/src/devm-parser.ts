import {
    AstUtils, createLangiumParser, GrammarAST, LangiumParserErrorMessageProvider, type AstNode, type Grammar, type LangiumCoreServices, type LangiumParser
} from 'langium';

/**
 * Whether the text of a `.devm` file is a structure file (not a state machine): the decision of the
 * parser by the first token (a state machine file starts with `statemachine`; an empty file is a
 * structure file), without parsing the text.
 */
export function isStructureText(text: string): boolean {
    return !/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*statemachine(?![\w])/.test(text);
}

/** The message of a `.devm` file containing both a state machine and structure elements. */
export const MIXED_KINDS_MESSAGE = 'A .devm file contains either a state machine or structure elements';

/** The keywords starting the structure elements of a `.devm` file (dmf.langium). */
const STRUCTURE_KEYWORDS = new Set(['package', 'import', 'struct', 'interface', 'component', 'subsystem', 'system', '@']);

/** The keywords accepted as names in a rule (the keyword alternatives of the name rule `HsmId` or `DmfId`). */
function keywordsOf(grammar: Grammar, ruleName: string): Set<string> {
    const rule = grammar.rules.find(r => r.name === ruleName);
    return new Set(rule ? AstUtils.streamAllContents(rule).filter(GrammarAST.isKeyword).map(keyword => keyword.value).toArray() : []);
}

/** The names of the parser rules reachable from a rule (by rule calls). */
function reachableRules(grammar: Grammar, ruleName: string): Set<string> {
    const result = new Set<string>();
    const visit = (name: string) => {
        const rule = grammar.rules.find(r => r.name === name);
        if (!rule || result.has(name) || !GrammarAST.isParserRule(rule)) {
            return;
        }
        result.add(name);
        AstUtils.streamAllContents(rule).filter(GrammarAST.isRuleCall).forEach(call => visit(call.rule.ref?.name ?? call.rule.$refText));
    };
    visit(ruleName);
    return result;
}

type TokenTypeLike = { name: string };

/**
 * Parser messages of the `.devm` language. A file is a state machine file or a structure file (the
 * entry rule of devm.langium decides by the first token), so text of the other kind after the model
 * is input the parser cannot consume: it is reported as mixing of the two kinds instead of the generic
 * "Expecting end of file". In the lists of expected tokens, the keywords of the other kind that are
 * accepted as names are shown as `ID` (once).
 */
export class DevmParserErrorMessageProvider extends LangiumParserErrorMessageProvider {

    /** The soft keywords by the names of the rules in which they are accepted as names. */
    protected readonly softKeywords = new Map<string, Set<string>>();

    constructor(grammar?: Grammar) {
        super();
        if (grammar) {
            for (const [root, names] of [['StateMachine', 'HsmId'], ['DmfModel', 'DmfId']]) {
                const keywords = keywordsOf(grammar, names);
                reachableRules(grammar, root).forEach(rule => this.softKeywords.set(rule, keywords));
            }
        }
    }

    override buildNoViableAltMessage(options: Parameters<LangiumParserErrorMessageProvider['buildNoViableAltMessage']>[0]): string {
        const seen = new Set<string>();
        const expectedPathsPerAlt = options.expectedPathsPerAlt.map(paths => this.collapse(paths, options.ruleName, seen)).filter(paths => paths.length > 0);
        return super.buildNoViableAltMessage({ ...options, expectedPathsPerAlt });
    }

    override buildEarlyExitMessage(options: Parameters<LangiumParserErrorMessageProvider['buildEarlyExitMessage']>[0]): string {
        return super.buildEarlyExitMessage({ ...options, expectedIterationPaths: this.collapse(options.expectedIterationPaths, options.ruleName, new Set()) });
    }

    /** The token paths with the soft keywords of the rule replaced by `ID`, without the paths in `seen`. */
    protected collapse<T extends TokenTypeLike>(paths: T[][], ruleName: string, seen: Set<string>): T[][] {
        // (the parser rules have a zero width space appended to their names)
        const keywords = this.softKeywords.get(ruleName.replace(/\u200B/g, ''));
        const result: T[][] = [];
        for (const path of paths) {
            const collapsed = keywords ? path.map(type => keywords.has(type.name) ? { ...type, name: 'ID', LABEL: undefined } : type) : path;
            const key = collapsed.map(type => type.name).join(' ');
            if (!seen.has(key)) {
                seen.add(key);
                result.push(collapsed);
            }
        }
        return result;
    }

    override buildNotAllInputParsedMessage(options: Parameters<LangiumParserErrorMessageProvider['buildNotAllInputParsedMessage']>[0]): string {
        const token = options.firstRedundant;
        if (token.image === 'statemachine') {
            return `${MIXED_KINDS_MESSAGE}: a state machine cannot follow structure elements (write it into a file of its own).`;
        }
        if (STRUCTURE_KEYWORDS.has(token.image)) {
            return `${MIXED_KINDS_MESSAGE}: \`${token.image}\` cannot follow the state machine (write structure elements into a file of their own).`;
        }
        return super.buildNotAllInputParsedMessage(options);
    }
}

/**
 * The parser of the `.devm` language. The root is always a state machine or a structure model: a
 * file without content (or only comments) is an empty structure file, which the grammar cannot express
 * (the structure alternative of the entry rule must consume a token, see dmf.langium), and a file
 * whose first token starts neither kind gets an empty structure model besides the syntax error.
 */
export function createDevmParser(services: LangiumCoreServices): LangiumParser {
    const parser = createLangiumParser(services);
    const lexer = services.parser.Lexer;
    const parse = parser.parse.bind(parser);
    parser.parse = ((input, options) => {
        const result = parse(input, options);
        const root = result.value as AstNode & { imports?: unknown[], elements?: unknown[] };
        if (root.$type === 'DevmFile') {
            (root as { $type: string }).$type = 'DmfModel';
            root.imports ??= [];
            root.elements ??= [];
            if (result.lexerErrors.length === 0 && lexer.tokenize(input).tokens.length === 0) {
                result.parserErrors.length = 0;
            }
        }
        return result;
    }) as LangiumParser['parse'];
    return parser;
}
