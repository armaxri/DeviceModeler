import { DefaultScopeProvider, EMPTY_SCOPE, type ReferenceInfo, type Scope } from 'langium';
import { Transition } from './generated/ast.js';
import { allVertices, getStateMachine } from './model-utils.js';

/**
 * State names are unique within a state machine. Transitions may therefore refer to
 * every vertex of the machine, independently of the nesting level.
 */
export class HsmScopeProvider extends DefaultScopeProvider {

    override getScope(context: ReferenceInfo): Scope {
        if (context.container.$type === Transition.$type) {
            try {
                return this.createScopeForNodes(allVertices(getStateMachine(context.container)));
            } catch {
                return EMPTY_SCOPE;
            }
        }
        return super.getScope(context);
    }
}
