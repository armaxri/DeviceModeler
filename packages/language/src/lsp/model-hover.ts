import type { AstNode, LangiumDocument, MaybePromise } from 'langium';
import { MultilineCommentHoverProvider } from 'langium/lsp';
import type { Hover } from 'vscode-languageserver-types';
import * as ast from '../generated/ast.js';
import { qualifiedName } from '../hsm-scope.js';
import { nodeText, scopeLabel } from '../model-utils.js';
import { cppHover } from './cpp-lsp.js';

type HoverParams = Parameters<MultilineCommentHoverProvider['getHoverContent']>[1];

/**
 * Hover of models, shared by the VS Code language server and the web app's Monaco editor: a short signature
 * of the declaration (e.g. `in event request : integer` or `state Operating.Red`) followed by its
 * documentation comment; C++ names, struct members and header imports show the declaration of the header.
 */
export class ModelHoverProvider extends MultilineCommentHoverProvider {

    override async getHoverContent(document: LangiumDocument, params: HoverParams): Promise<Hover | undefined> {
        const cpp = cppHover(document, document.textDocument.offsetAt(params.position));
        if (cpp) {
            return { contents: { kind: 'markdown', value: cpp } };
        }
        return super.getHoverContent(document, params);
    }

    protected override getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
        const signature = hoverSignature(node);
        const documentation = super.getAstNodeHoverContent(node);
        // the documentation provider starts with a shorter signature of its own: replaced by this one
        const withoutSignature = (doc: string | undefined) => signature ? doc?.replace(/^```hsm\n[^\n]*\n```(\n\n)?/, '') : doc;
        const combine = (doc: string | undefined) => [signature ? '```hsm\n' + signature + '\n```' : undefined, withoutSignature(doc)].filter(part => part).join('\n\n') || undefined;
        return documentation instanceof Promise ? documentation.then(combine) : combine(documentation);
    }
}

/** The signature shown in the hover of a declaration. */
export function hoverSignature(node: AstNode): string | undefined {
    if (ast.isState(node)) {
        return `state ${qualifiedName(node)}`;
    }
    if (ast.isPseudoState(node)) {
        return `${node.kind} ${qualifiedName(node)}`;
    }
    if (ast.isStateMachine(node)) {
        return `statemachine ${node.name}`;
    }
    if (ast.isEventDeclaration(node) || ast.isVariableDeclaration(node) || ast.isOperationDeclaration(node)) {
        const text = nodeText(node).replace(/\s+/g, ' ');
        const scope = node.$container;
        const prefix = ast.isInterfaceScope(scope) || ast.isInternalScope(scope) || ast.isClassScope(scope) ? `${scopeLabel(scope)} ` : '';
        return prefix + text;
    }
    if (node.$type === 'TestClass' || node.$type === 'TestOperation') {
        return nodeText(node).split('\n')[0].replace(/\s*\{\s*$/, '');
    }
    return undefined;
}
