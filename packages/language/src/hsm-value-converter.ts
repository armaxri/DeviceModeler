import { CstUtils, DefaultValueConverter, isLeafCstNode, type CstNode, type GrammarAST, type ValueType } from 'langium';

/** Data type rules of (C++) type names whose value is rebuilt from the tokens (see {@link cppTypeText}). */
const TYPE_NAME_RULES = new Set(['TypeReferenceName', 'TemplateArgument', 'BaseTypeName', 'FundamentalTypeName']);

/**
 * Value converter of both languages: type names keep a single space between words (`unsigned int`,
 * `std::vector<const char*>`), Langium would concatenate the tokens of a data type rule (`unsignedint`).
 */
export class HsmValueConverter extends DefaultValueConverter {

    protected override runConverter(rule: GrammarAST.AbstractRule, input: string, cstNode: CstNode): ValueType {
        if (TYPE_NAME_RULES.has(rule.name)) {
            return cppTypeText(cstNode);
        }
        return super.runConverter(rule, input, cstNode);
    }
}

/** The tokens of a CST node joined without white space, except for a single space between two words and after commas. */
export function cppTypeText(node: CstNode): string {
    let text = '';
    for (const leaf of CstUtils.streamCst(node)) {
        if (!isLeafCstNode(leaf) || leaf.hidden) {
            continue;
        }
        if (/\w$/.test(text) && /^\w/.test(leaf.text)) {
            text += ' ';
        }
        text += leaf.text === ',' ? ', ' : leaf.text;
    }
    return text;
}
