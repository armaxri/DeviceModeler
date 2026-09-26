import type { AstNode } from 'langium';
import {
    allTransitions, allVertices, isPseudoState, isRegion, isState, isStateMachine, isTransition,
    nodeText, qualifiedName, scopeOf, stateAction, containerName,
    type DiagramNodeKind, type EditResult, type ModelEditor, type ScopeContainer, type StateMachine, type Vertex
} from 'hsm-language';
import type { Issue } from '../diagram/model.js';
import { h } from './dom.js';

export interface SelectionInfo {
    id?: string;
    kind?: DiagramNodeKind | 'transition' | 'machine';
    node?: AstNode;
    issue?: Issue;
    count: number;
    model?: StateMachine;
    syntaxErrors: boolean;
}

/** Operations of the application used by the properties panel. */
export interface PropertiesHost {
    applyEdit(producer: (editor: ModelEditor) => EditResult | undefined): Promise<boolean>;
    validateName(value: string, vertex?: Vertex): string | undefined;
    deleteSelection(): void;
    select(id: string | undefined, center?: boolean): void;
    setTool(tool: 'state' | 'transition' | 'select'): void;
}

const PSEUDO_LABELS: Record<string, string> = {
    choice: 'Choice pseudo state',
    junction: 'Junction pseudo state',
    history: 'Shallow history pseudo state',
    deephistory: 'Deep history pseudo state'
};

export function renderProperties(panel: HTMLElement, info: SelectionInfo, host: PropertiesHost): void {
    const content: HTMLElement[] = [];
    const node = info.node;
    if (info.syntaxErrors) {
        content.push(h('p', { class: 'hint' }, 'The text contains syntax errors. Fix them to continue editing in the diagram.'));
    }
    if (info.count > 1) {
        content.push(
            h('h2', {}, `${info.count} elements selected`),
            h('div', { class: 'actions' }, h('button', { class: 'danger', onClick: () => host.deleteSelection() }, 'Delete'))
        );
    } else if (!node || isStateMachine(node) && info.kind === 'machine') {
        content.push(...machinePanel(info.model, host));
    } else if (info.kind === 'initial' || info.kind === 'final') {
        content.push(...pseudoEndPanel(info, node as ScopeContainer, host));
    } else if (isState(node)) {
        content.push(...statePanel(node, info, host));
    } else if (isPseudoState(node)) {
        content.push(
            h('h2', {}, node.name),
            h('div', { class: 'kind' }, PSEUDO_LABELS[node.kind] ?? node.kind),
            ...problems(info.issue),
            nameField(node, host),
            h('div', { class: 'actions' },
                h('button', { onClick: () => host.setTool('transition') }, 'Add transition…'),
                h('button', { class: 'danger', onClick: () => host.deleteSelection() }, 'Delete'))
        );
    } else if (isRegion(node)) {
        const index = node.$container.regions.indexOf(node) + 1;
        content.push(
            h('h2', {}, node.name ?? `Region ${index}`),
            h('div', { class: 'kind' }, `Orthogonal region of ${node.$container.name}`),
            ...problems(info.issue),
            field('Name (optional)', h('input', {
                value: node.name ?? '',
                placeholder: 'unnamed',
                onChange: (e: Event) => host.applyEdit(editor => editor.renameRegion(node, (e.target as HTMLInputElement).value))
            })),
            h('div', { class: 'actions' },
                h('button', { onClick: () => host.applyEdit(editor => editor.addVertex(node, 'state')) }, 'Add state'),
                h('button', { class: 'danger', onClick: () => host.deleteSelection() }, 'Delete'))
        );
    } else if (isTransition(node)) {
        content.push(...transitionPanel(node, info, host));
    }
    panel.replaceChildren(...content);
}

function field(label: string, input: HTMLElement): HTMLElement {
    return h('label', { class: 'field' }, h('span', {}, label), input);
}

function problems(issue: Issue | undefined): HTMLElement[] {
    if (!issue) {
        return [];
    }
    return [h('ul', { class: 'problems' }, ...issue.messages.map(message => h('li', { class: issue.severity }, message)))];
}

function nameField(vertex: Vertex, host: PropertiesHost): HTMLElement {
    const input = h('input', { value: vertex.name, spellcheck: 'false' });
    input.addEventListener('input', () => {
        const error = host.validateName(input.value, vertex);
        input.setCustomValidity(error ?? '');
        input.title = error ?? '';
    });
    input.addEventListener('change', () => {
        if (!host.validateName(input.value, vertex)) {
            host.applyEdit(editor => editor.renameVertex(vertex, input.value.trim()));
        }
    });
    return field('Name', input);
}

function machinePanel(model: StateMachine | undefined, host: PropertiesHost): HTMLElement[] {
    if (!model) {
        return [h('p', { class: 'hint' }, 'Loading…')];
    }
    const vertices = allVertices(model);
    const states = vertices.filter(isState);
    const transitions = allTransitions(model);
    return [
        h('h2', {}, model.name),
        h('div', { class: 'kind' }, 'State machine'),
        h('dl', {},
            h('dt', {}, 'States'), h('dd', {}, String(states.length)),
            h('dt', {}, 'Composite'), h('dd', {}, String(states.filter(s => s.vertices.length > 0 || s.regions.length > 0).length)),
            h('dt', {}, 'Pseudo states'), h('dd', {}, String(vertices.length - states.length)),
            h('dt', {}, 'Transitions'), h('dd', {}, String(transitions.length))),
        h('div', { class: 'actions' },
            h('button', { onClick: () => host.setTool('state') }, 'Add state'),
            h('button', { onClick: () => host.setTool('transition') }, 'Add transition')),
        h('h2', { style: 'margin-top:18px' }, 'How to edit'),
        h('ul', { class: 'hint', style: 'padding-left:18px;margin:6px 0' },
            h('li', {}, 'Pick a tool in the palette, then click into the diagram. Hold ', h('kbd', {}, 'Shift'), ' to keep the tool.'),
            h('li', {}, 'Double-click a state or transition to rename it or to edit its label (', h('code', {}, 'event [guard] / effect'), ').'),
            h('li', {}, 'Double-click the canvas to add a state.'),
            h('li', {}, 'Drag a state onto another state to nest it, onto the canvas to move it to the top level.'),
            h('li', {}, h('kbd', {}, 'Del'), ' deletes, ', h('kbd', {}, 'F2'), ' renames, ', h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Z'), ' undoes.'),
            h('li', {}, 'Text and diagram are always in sync – edit whichever you prefer.'))
    ];
}

function statePanel(state: import('hsm-language').State, info: SelectionInfo, host: PropertiesHost): HTMLElement[] {
    const actionField = (kind: 'entry' | 'exit', label: string) => field(label, h('input', {
        value: nodeText(stateAction(state, kind)?.effect),
        placeholder: `e.g. x = 0; ${kind}Action()`,
        spellcheck: 'false',
        onChange: (e: Event) => host.applyEdit(editor => editor.setStateAction(state, kind, (e.target as HTMLInputElement).value))
    }));
    const simpleActions = [stateAction(state, 'entry'), stateAction(state, 'exit')];
    const internal = state.reactions.filter(r => !simpleActions.includes(r));
    const composite = state.vertices.length > 0 || state.regions.length > 0;
    const container = scopeOf(state);
    const isInitial = container.transitions.some(t => t.initial && t.target?.ref === state);
    return [
        h('h2', {}, state.name),
        h('div', { class: 'kind' }, `${composite ? 'Composite state' : 'State'} in ${containerName(container)}${isInitial ? ' · initial' : ''}`),
        ...problems(info.issue),
        nameField(state, host),
        field('Description', h('input', {
            value: state.description ?? '',
            placeholder: 'optional text shown in the state',
            onChange: (e: Event) => host.applyEdit(editor => editor.setStateDescription(state, (e.target as HTMLInputElement).value))
        })),
        actionField('entry', 'Entry action'),
        actionField('exit', 'Exit action'),
        internal.length > 0
            ? field('Local reactions', h('div', { class: 'hint' }, ...internal.map(r => h('div', {}, h('code', {}, nodeText(r))))))
            : undefined,
        h('div', { class: 'actions' },
            h('button', { onClick: () => host.applyEdit(editor => editor.addVertex(state, 'state')) }, 'Add sub state'),
            h('button', { onClick: () => host.applyEdit(editor => editor.addRegion(state)) }, 'Add region'),
            isInitial ? undefined : h('button', { onClick: () => host.applyEdit(editor => editor.setInitial(state)) }, 'Make initial'),
            h('button', { onClick: () => host.applyEdit(editor => editor.addTransition(state, { finalOf: container })) }, 'Add final'),
            h('button', { class: 'danger', onClick: () => host.deleteSelection() }, 'Delete'))
    ].filter((e): e is HTMLElement => !!e);
}

function transitionPanel(transition: import('hsm-language').Transition, info: SelectionInfo, host: PropertiesHost): HTMLElement[] {
    const model = info.model!;
    const names = allVertices(model).map(v => qualifiedName(v)).sort((a, b) => a.localeCompare(b));
    const endSelect = (end: 'source' | 'target') => {
        const pseudo = end === 'source' ? transition.initial : transition.final;
        if (pseudo) {
            return h('select', { disabled: true }, h('option', {}, end === 'source' ? '[*] initial' : '[*] final'));
        }
        const currentVertex = (end === 'source' ? transition.source : transition.target)?.ref;
        const current = currentVertex && qualifiedName(currentVertex);
        const select = h('select', {}, ...names.map(name => h('option', { value: name }, name)));
        select.value = current ?? '';
        select.addEventListener('change', () => {
            const vertex = allVertices(model).find(v => qualifiedName(v) === select.value);
            if (vertex) {
                host.applyEdit(editor => editor.reconnectTransition(transition, end, vertex));
            }
        });
        return select;
    };
    const spec = h('input', {
        value: nodeText(transition.spec),
        placeholder: 'trigger, trigger [guard] / effect',
        spellcheck: 'false',
        onChange: () => host.applyEdit(editor => editor.updateTransitionLabel(transition, spec.value))
    });
    const sourceName = transition.initial ? '[*]' : transition.source?.ref?.name ?? '?';
    const targetName = transition.final ? '[*]' : transition.target?.ref?.name ?? '?';
    return [
        h('h2', {}, `${sourceName} → ${targetName}`),
        h('div', { class: 'kind' }, transition.initial ? 'Initial transition' : transition.final ? 'Transition to the final state' : 'Transition'),
        ...problems(info.issue),
        field('Source', endSelect('source')),
        field('Target', endSelect('target')),
        field('Reaction (triggers [guard] / effect)', spec),
        h('div', { class: 'actions' },
            h('button', { class: 'danger', onClick: () => host.deleteSelection() }, 'Delete'))
    ];
}

function pseudoEndPanel(info: SelectionInfo, container: ScopeContainer, host: PropertiesHost): HTMLElement[] {
    const initial = info.kind === 'initial';
    const transitions = container.transitions.filter(t => initial ? t.initial : t.final);
    return [
        h('h2', {}, initial ? 'Initial state' : 'Final state'),
        h('div', { class: 'kind' }, `of ${containerName(container)}`),
        h('p', { class: 'hint' }, initial
            ? 'Defined by the initial transition ([*] -> …). Use the “Initial state” tool or “Make initial” to change the target.'
            : 'Defined by transitions to [*]. Deleting it removes these transitions.'),
        h('div', { class: 'hint' }, ...transitions.map(t => h('div', {}, h('code', {}, `${t.initial ? '[*]' : t.source?.ref?.name} -> ${t.final ? '[*]' : t.target?.ref?.name}`)))),
        h('div', { class: 'actions' }, h('button', { class: 'danger', onClick: () => host.deleteSelection() }, 'Delete'))
    ];
}
