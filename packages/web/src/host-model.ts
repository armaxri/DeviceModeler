import type { AstNode } from 'langium';
import {
    isComponent, isCompositeType, isStructDeclaration, isStructureModel,
    type ComponentType, type ParsedModel, type ParsedStructureModel, type Region, type State, type StateMachine, type StructDeclaration,
    type StructureModel, type Transition, type Vertex
} from 'devm-language';
import type { HostModelReport, HostOutlineNode, HostProblem } from './host.js';

/**
 * Problems and outline of a parsed model (a state machine or a structure file) for the host of the embedded
 * app (`api/model`, see host.ts): the Eclipse plugin shows them as problem markers and in the Outline view.
 */
export function modelReport(parsed: ParsedModel | ParsedStructureModel): HostModelReport {
    const lineStarts = computeLineStarts(parsed.text);
    const offsetAt = (line: number, character: number) =>
        Math.min((lineStarts[line] ?? parsed.text.length) + character, parsed.text.length);
    const problems: HostProblem[] = [];
    for (const d of parsed.diagnostics) {
        if (d.severity !== 1 && d.severity !== 2 && d.severity !== 3) {
            continue;
        }
        const message = d.message as unknown;
        problems.push({
            severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
            message: typeof message === 'string' ? message : String((message as { value?: string }).value ?? message),
            line: d.range.start.line + 1,
            column: d.range.start.character + 1,
            offset: offsetAt(d.range.start.line, d.range.start.character),
            end: offsetAt(d.range.end.line, d.range.end.character)
        });
    }
    const model = parsed.model as StateMachine | StructureModel | undefined;
    const outline = !model ? [] : isStructureModel(model) ? structureOutlineOf(model) : outlineOf(model);
    return { textLength: parsed.text.length, problems, outline };
}

function computeLineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            starts.push(i + 1);
        }
    }
    return starts;
}

/** The outline: the state machine with its definitions, states (nested), pseudo states and transitions. */
export function outlineOf(machine: StateMachine): HostOutlineNode[] {
    const root = node(machine, `${machine.name ?? 'statemachine'}`, 'statemachine');
    if (!root) {
        return [];
    }
    const children: HostOutlineNode[] = [];
    const scopes = (machine.scopes ?? []).map(scope => scope.$cstNode).filter(c => c !== undefined);
    if (scopes.length > 0) {
        children.push({ label: 'definitions', kind: 'definitions', offset: scopes[0]!.offset, end: scopes[scopes.length - 1]!.end });
    }
    children.push(...contentOf(machine.vertices, machine.transitions));
    root.children = children;
    return [root];
}

function contentOf(vertices: readonly Vertex[] = [], transitions: readonly Transition[] = []): HostOutlineNode[] {
    return [
        ...vertices.map(vertexNode).filter(n => n !== undefined),
        ...transitions.map(transitionNode).filter(n => n !== undefined)
    ];
}

function vertexNode(vertex: Vertex): HostOutlineNode | undefined {
    if (vertex.$type === 'State') {
        const state = vertex as State;
        const submachine = state.submachine?.$refText;
        const result = node(state, submachine ? `${state.name} : ${submachine}` : state.name, 'state');
        if (result) {
            const children = [
                ...(state.regions ?? []).map((region, index) => regionNode(region, index)).filter(n => n !== undefined),
                ...contentOf(state.vertices, state.transitions)
            ];
            if (children.length > 0) {
                result.children = children;
            }
        }
        return result;
    }
    return node(vertex, `${vertex.name} (${vertex.kind})`, 'pseudostate');
}

function regionNode(region: Region, index: number): HostOutlineNode | undefined {
    const result = node(region, region.name ? `region ${region.name}` : `region ${index + 1}`, 'region');
    if (result) {
        result.children = contentOf(region.vertices, region.transitions);
    }
    return result;
}

function transitionNode(transition: Transition): HostOutlineNode | undefined {
    const text = transition.$cstNode?.text.split('\n')[0].replace(/\s+/g, ' ').trim() ?? '';
    return node(transition, text.length > 80 ? `${text.substring(0, 79)}…` : text, 'transition');
}

/**
 * The outline of a structure file: structs (with their fields), components (ports), subsystems and systems
 * (ports, threads with their instances, instances of subsystems, connections and delegations).
 */
export function structureOutlineOf(model: StructureModel): HostOutlineNode[] {
    return (model.elements ?? []).map(element => isStructDeclaration(element) ? structNode(element) : componentNode(element))
        .filter(n => n !== undefined);
}

function structNode(struct: StructDeclaration): HostOutlineNode | undefined {
    const result = node(struct, `struct ${struct.name}`, 'struct');
    if (result) {
        result.children = (struct.fields ?? []).map(field => node(field, `${field.name} : ${field.type?.name ?? ''}`, 'field')).filter(n => n !== undefined);
    }
    return result;
}

function componentNode(type: ComponentType): HostOutlineNode | undefined {
    const kind = isCompositeType(type) ? type.kind : 'component';
    const result = node(type, `${kind} ${type.name}`, kind);
    if (!result) {
        return undefined;
    }
    const ports = (type.ports ?? []).map(port => node(port, `${port.direction} ${port.kind} ${port.name}${port.type ? ` : ${port.type.name}` : ''}`, 'port'));
    const children = [...ports];
    if (isComponent(type) && type.behavior) {
        children.unshift(node(type.behavior, `behavior ${type.behavior.path ?? type.behavior.machine?.$refText ?? ''}`, 'behavior'));
    }
    if (isCompositeType(type)) {
        for (const thread of type.threads ?? []) {
            const threadNode = node(thread, `thread ${thread.name}`, 'thread');
            if (threadNode) {
                threadNode.children = [
                    ...(thread.instances ?? []).map(instance => node(instance, `${instance.name} : ${instance.type?.$refText ?? ''}`, 'instance')),
                    ...(thread.members ?? []).map(member => node(member, member.instance?.$refText ?? '', 'instance'))
                ].filter(n => n !== undefined);
            }
            children.push(threadNode);
        }
        children.push(...(type.instances ?? []).map(instance => node(instance, `${instance.name} : ${instance.type?.$refText ?? ''}`, 'instance')));
        children.push(...[...(type.connections ?? []), ...(type.delegations ?? [])]
            .sort((a, b) => (a.$cstNode?.offset ?? 0) - (b.$cstNode?.offset ?? 0))
            .map(connection => {
                const text = connection.$cstNode?.text.replace(/\s+/g, ' ').trim() ?? '';
                return node(connection, text.replace(/^(@\S+\s+)+/, ''), connection.$type === 'Connection' ? 'connection' : 'delegation');
            }));
    }
    const defined = children.filter(n => n !== undefined);
    if (defined.length > 0) {
        result.children = defined;
    }
    return result;
}

function node(ast: AstNode, label: string, kind: string): HostOutlineNode | undefined {
    const cst = ast.$cstNode;
    return cst ? { label, kind, offset: cst.offset, end: cst.end } : undefined;
}
