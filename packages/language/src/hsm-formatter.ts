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
        } else if (ast.isPseudoState(node)) {
            this.getNodeFormatter(node).property('name').prepend(Formatting.oneSpace());
        } else if (ast.isStateAction(node)) {
            this.getNodeFormatter(node).keyword('/').surround(Formatting.oneSpace());
        } else if (ast.isInternalTransition(node) || ast.isTransition(node)) {
            const formatter = this.getNodeFormatter(node);
            if (ast.isTransition(node)) {
                formatter.keyword('->').surround(Formatting.oneSpace());
                formatter.keyword(':').prepend(Formatting.oneSpace());
            } else {
                formatter.property('event').prepend(Formatting.oneSpace());
            }
            formatter.keyword('[').prepend(Formatting.oneSpace()).append(Formatting.noSpace());
            formatter.keyword(']').prepend(Formatting.noSpace());
            formatter.keyword('/').surround(Formatting.oneSpace());
            formatter.property('event').prepend(Formatting.oneSpace());
        }
    }
}
