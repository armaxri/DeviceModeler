import type { AstNode } from 'langium';
import { AbstractFormatter, Formatting } from 'langium/lsp';
import * as ast from './generated/ast.js';

export class HsmFormatter extends AbstractFormatter {

    protected override format(node: AstNode): void {
        if (ast.isStateMachine(node) || ast.isState(node) || ast.isRegion(node)) {
            const formatter = this.getNodeFormatter(node);
            const open = formatter.keyword('{');
            const close = formatter.keyword('}');
            if (open.nodes.length > 0 && close.nodes.length > 0) {
                open.prepend(Formatting.oneSpace());
                formatter.interior(open, close).prepend(Formatting.indent({ allowMore: true }));
                close.prepend(Formatting.newLine());
            }
            formatter.property('name').prepend(Formatting.oneSpace());
            if (ast.isState(node) || ast.isStateMachine(node)) {
                this.getNodeFormatter<ast.State | ast.StateMachine>(node).property('description').prepend(Formatting.oneSpace());
            }
            if (ast.isState(node)) {
                // submachine binding: `state Moving : motor`
                this.getNodeFormatter(node).keyword(':').surround(Formatting.oneSpace());
            }
        } else if (ast.isImport(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword(':').prepend(Formatting.noSpace());
            formatter.properties('paths').prepend(Formatting.oneSpace());
        } else if (ast.isPseudoState(node)) {
            this.getNodeFormatter(node).property('name').prepend(Formatting.oneSpace());
        } else if (ast.isInterfaceScope(node) || ast.isInternalScope(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword(':').prepend(Formatting.noSpace());
            formatter.properties('declarations').prepend(Formatting.indent({ allowMore: true }));
        } else if (ast.isEventDeclaration(node) || ast.isVariableDeclaration(node) || ast.isParameter(node) || ast.isTypeAliasDeclaration(node)) {
            const formatter = this.getNodeFormatter<ast.EventDeclaration | ast.VariableDeclaration | ast.Parameter | ast.TypeAliasDeclaration>(node);
            formatter.keyword(':').surround(Formatting.oneSpace());
            formatter.keyword('=').surround(Formatting.oneSpace());
        } else if (ast.isOperationDeclaration(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword('(').prepend(Formatting.noSpace()).append(Formatting.noSpace());
            formatter.keyword(')').prepend(Formatting.noSpace());
            formatter.keyword(':').surround(Formatting.oneSpace());
            formatter.keywords(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
        } else if (ast.isTransition(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword('->').surround(Formatting.oneSpace());
            formatter.keyword(':').prepend(Formatting.oneSpace()).append(Formatting.oneSpace());
            formatter.keyword('#').prepend(Formatting.oneSpace());
        } else if (ast.isReactionSpec(node) || ast.isLocalReaction(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword('[').prepend(Formatting.oneSpace()).append(Formatting.noSpace());
            formatter.keyword(']').prepend(Formatting.noSpace());
            formatter.keyword('/').surround(Formatting.oneSpace());
            formatter.keywords(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
        }
    }
}
