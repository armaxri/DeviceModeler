import * as ast from '../generated/ast.js';
import { qualifiedName } from '../hsm-scope.js';
import { allTransitions, allVertices, definitionLines, nodeText, transitionLabel, type ScopeContainer } from '../model-utils.js';

/**
 * Generates a PlantUML state diagram (`@startuml ... @enduml`) for the given state machine.
 *
 * - Vertices whose simple name is not unique in the state machine get an alias derived from
 *   their qualified name (`state "Playing" as Closed_Active_Playing`).
 * - `sync` becomes `<<fork>>` (one incoming transition) or `<<join>>`, named entry points
 *   `<<entryPoint>>` and exit nodes `<<exitPoint>>`. Transitions using an entry point (`# >E`)
 *   lead to the entry point, transitions taken at an exit node (`# X>`) start at the exit node.
 * - The definition section is shown as a legend.
 */
export function generatePlantUml(machine: ast.StateMachine): string {
    return new PlantUmlGenerator(machine).generate();
}

class PlantUmlGenerator {

    private readonly aliases = new Map<ast.Vertex, string>();
    private readonly transitions: ast.Transition[];

    constructor(private readonly machine: ast.StateMachine) {
        this.transitions = allTransitions(machine);
        const vertices = allVertices(machine).filter(v => v.name);
        const counts = new Map<string, number>();
        for (const vertex of vertices) {
            counts.set(vertex.name, (counts.get(vertex.name) ?? 0) + 1);
        }
        const used = new Set(vertices.filter(v => counts.get(v.name) === 1).map(v => v.name));
        for (const vertex of vertices) {
            if (counts.get(vertex.name) === 1) {
                this.aliases.set(vertex, vertex.name);
                continue;
            }
            const base = qualifiedName(vertex).replace(/\./g, '_');
            let alias = base;
            for (let i = 2; used.has(alias); i++) {
                alias = `${base}_${i}`;
            }
            used.add(alias);
            this.aliases.set(vertex, alias);
        }
    }

    generate(): string {
        const machine = this.machine;
        const lines: string[] = ['@startuml', `title ${machine.name}`];
        if (machine.description) {
            lines.push(`caption ${machine.description}`);
        }
        const definitions = definitionLines(machine);
        if (definitions.length > 0) {
            lines.push('', 'legend top left', ...definitions, 'endlegend');
        }
        lines.push('');
        this.containerBody(machine, '', lines);
        lines.push('@enduml', '');
        return lines.join('\n');
    }

    private containerBody(container: ScopeContainer, indent: string, lines: string[]): void {
        for (const vertex of container.vertices) {
            this.vertex(vertex, indent, lines);
        }
        if (ast.isState(container)) {
            container.regions.forEach((region, index) => {
                if (index > 0) {
                    lines.push(`${indent}--`);
                }
                this.containerBody(region, indent, lines);
            });
        }
        for (const transition of container.transitions) {
            this.transition(transition, indent, lines);
        }
    }

    private transition(transition: ast.Transition, indent: string, lines: string[]): void {
        let sourceVertex = transition.source?.ref;
        let targetVertex = transition.target?.ref;
        let label = transitionLabel(transition);
        const entryPoint = transition.entryPoint && targetVertex ? namedPseudoState(targetVertex, 'entry', transition.entryPoint) : undefined;
        const exitPoint = transition.exitPoint && sourceVertex ? namedPseudoState(sourceVertex, 'exit', transition.exitPoint) : undefined;
        if (entryPoint || exitPoint) {
            // the transition leads to the entry point / starts at the exit node
            targetVertex = entryPoint ?? targetVertex;
            sourceVertex = exitPoint ?? sourceVertex;
            label = nodeText(transition.spec);
        }
        const source = transition.initial ? '[*]' : this.reference(sourceVertex);
        const target = transition.final ? '[*]' : this.reference(targetVertex);
        if (!source || !target) {
            return;
        }
        lines.push(`${indent}${source} --> ${target}${label ? ` : ${label}` : ''}`);
    }

    private vertex(vertex: ast.Vertex, indent: string, lines: string[]): void {
        const name = this.aliases.get(vertex) ?? vertex.name;
        const declaration = name === vertex.name ? `state ${name}` : `state "${vertex.name}" as ${name}`;
        if (ast.isPseudoState(vertex)) {
            const stereotype = this.stereotype(vertex);
            if (stereotype) {
                lines.push(`${indent}${declaration} <<${stereotype}>>`);
            }
            // history pseudo states are referenced as `Parent[H]` and need no declaration
            return;
        }
        if (vertex.vertices.length > 0 || vertex.regions.length > 0) {
            lines.push(`${indent}${declaration} {`);
            this.containerBody(vertex, indent + '  ', lines);
            lines.push(`${indent}}`);
        } else {
            lines.push(`${indent}${declaration}`);
        }
        if (vertex.description) {
            lines.push(`${indent}${name} : ${vertex.description}`);
        }
        for (const reaction of vertex.reactions) {
            lines.push(`${indent}${name} : ${nodeText(reaction)}`);
        }
    }

    private stereotype(pseudo: ast.PseudoState): string | undefined {
        switch (pseudo.kind) {
            case 'choice':
            case 'junction':
                return 'choice';
            case 'sync': {
                const incoming = this.transitions.filter(t => t.target?.ref === pseudo).length;
                return incoming === 1 ? 'fork' : 'join';
            }
            case 'entry':
                return 'entryPoint';
            case 'exit':
                return 'exitPoint';
            default:
                return undefined;
        }
    }

    private reference(vertex: ast.Vertex | undefined): string | undefined {
        if (!vertex) {
            return undefined;
        }
        if (ast.isPseudoState(vertex) && (vertex.kind === 'history' || vertex.kind === 'deephistory')) {
            const owner = ast.isRegion(vertex.$container) ? vertex.$container.$container : vertex.$container;
            const marker = vertex.kind === 'history' ? 'H' : 'H*';
            if (ast.isState(owner)) {
                return `${this.aliases.get(owner) ?? owner.name}[${marker}]`;
            }
            return `[${marker}]`;
        }
        return this.aliases.get(vertex) ?? vertex.name;
    }
}

/** The entry point / exit node with the given name declared directly in the state (or one of its regions). */
function namedPseudoState(vertex: ast.Vertex, kind: 'entry' | 'exit', name: string): ast.PseudoState | undefined {
    if (!ast.isState(vertex)) {
        return undefined;
    }
    return [...vertex.vertices, ...vertex.regions.flatMap(r => r.vertices)]
        .find((v): v is ast.PseudoState => ast.isPseudoState(v) && v.kind === kind && v.name === name);
}
