import * as ast from '../generated/ast.js';
import { transitionLabel, type ScopeContainer } from '../model-utils.js';

/**
 * Generates a PlantUML state diagram (`@startuml ... @enduml`) for the given state machine.
 */
export function generatePlantUml(machine: ast.StateMachine): string {
    const lines: string[] = ['@startuml', `title ${machine.name}`];
    if (machine.description) {
        lines.push(`caption ${machine.description}`);
    }
    lines.push('');
    generateContainerBody(machine, '', lines);
    lines.push('@enduml', '');
    return lines.join('\n');
}

function generateContainerBody(container: ScopeContainer, indent: string, lines: string[]): void {
    for (const vertex of container.vertices) {
        generateVertex(vertex, indent, lines);
    }
    if (ast.isState(container)) {
        container.regions.forEach((region, index) => {
            if (index > 0) {
                lines.push(`${indent}--`);
            }
            generateContainerBody(region, indent, lines);
        });
    }
    for (const transition of container.transitions) {
        const source = transition.initial ? '[*]' : vertexReference(transition.source?.ref);
        const target = transition.final ? '[*]' : vertexReference(transition.target?.ref);
        if (!source || !target) {
            continue;
        }
        const label = transitionLabel(transition);
        lines.push(`${indent}${source} --> ${target}${label ? ` : ${label}` : ''}`);
    }
}

function generateVertex(vertex: ast.Vertex, indent: string, lines: string[]): void {
    if (ast.isPseudoState(vertex)) {
        if (vertex.kind === 'choice' || vertex.kind === 'junction') {
            lines.push(`${indent}state ${vertex.name} <<choice>>`);
        }
        // history pseudo states are referenced as `Parent[H]` and need no declaration
        return;
    }
    if (vertex.vertices.length > 0 || vertex.regions.length > 0) {
        lines.push(`${indent}state ${vertex.name} {`);
        generateContainerBody(vertex, indent + '  ', lines);
        lines.push(`${indent}}`);
    } else {
        lines.push(`${indent}state ${vertex.name}`);
    }
    if (vertex.description) {
        lines.push(`${indent}${vertex.name} : ${vertex.description}`);
    }
    for (const behavior of vertex.behaviors) {
        if (ast.isStateAction(behavior)) {
            lines.push(`${indent}${vertex.name} : ${behavior.kind} / ${behavior.action}`);
        } else {
            lines.push(`${indent}${vertex.name} : ${transitionLabel(behavior)}`);
        }
    }
}

function vertexReference(vertex: ast.Vertex | undefined): string | undefined {
    if (!vertex) {
        return undefined;
    }
    if (ast.isPseudoState(vertex) && (vertex.kind === 'history' || vertex.kind === 'deephistory')) {
        const owner = ast.isRegion(vertex.$container) ? vertex.$container.$container : vertex.$container;
        if (ast.isState(owner)) {
            return `${owner.name}[${vertex.kind === 'history' ? 'H' : 'H*'}]`;
        }
        return `[${vertex.kind === 'history' ? 'H' : 'H*'}]`;
    }
    return vertex.name;
}
