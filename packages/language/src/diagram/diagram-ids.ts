/**
 * The ids of the diagram elements of a state machine, computed without laying out the diagram (the
 * same ids as assigned by `layoutStateMachine`, see layout.ts). Used to map manual layouts (keyed by
 * diagram ids) to the elements of the model and back.
 */
import type { AstNode } from 'langium';
import * as ast from '../generated/ast.js';
import { hasDefinitionSection, type ScopeContainer } from '../model-utils.js';
import { DEFINITION_ID, MACHINE_ID, finalNodeId, initialNodeId, vertexBaseId } from './layout.js';

export interface DiagramElementIds {
    /** Vertex, region, transition or state machine -> diagram id. */
    ids: Map<AstNode, string>;
    /** Container (state machine, state, region) -> id of its initial pseudo state (if it has one). */
    initial: Map<ScopeContainer, string>;
    /** Container -> id of its final state (if it has one). */
    final: Map<ScopeContainer, string>;
    /** Whether the diagram shows the definition section ({@link DEFINITION_ID}). */
    definitions: boolean;
}

export function diagramElementIds(machine: ast.StateMachine): DiagramElementIds {
    const ids = new Map<AstNode, string>([[machine, MACHINE_ID]]);
    const initial = new Map<ScopeContainer, string>();
    const final = new Map<ScopeContainer, string>();
    const used = new Set<string>([MACHINE_ID, DEFINITION_ID]);
    const nodes = new Set<string>();
    const unique = (base: string) => {
        let id = base;
        let counter = 1;
        while (used.has(id)) {
            id = `${base}~${counter++}`;
        }
        used.add(id);
        return id;
    };
    // nodes in the order of DiagramBuilder.createScopeContent / createState / createRegion
    const scopeContent = (container: ScopeContainer, scopeId: string) => {
        if (container.transitions.some(t => t.initial)) {
            const id = unique(initialNodeId(scopeId));
            nodes.add(id);
            initial.set(container, id);
        }
        for (const vertex of container.vertices) {
            const id = unique(vertex.name ? vertexBaseId(vertex) : '#unnamed');
            nodes.add(id);
            ids.set(vertex, id);
            if (ast.isState(vertex) && (vertex.vertices.length > 0 || vertex.regions.length > 0)) {
                vertex.regions.forEach((region, index) => {
                    const regionId = unique(`${id}#region${index + 1}`);
                    nodes.add(regionId);
                    ids.set(region, regionId);
                    scopeContent(region, regionId);
                });
                scopeContent(vertex, id);
            }
        }
        if (container.transitions.some(t => t.final)) {
            const id = unique(finalNodeId(scopeId));
            nodes.add(id);
            final.set(container, id);
        }
    };
    scopeContent(machine, MACHINE_ID);
    // transitions in the order of DiagramBuilder.createTransitions
    const transitions = (container: ScopeContainer) => {
        const scopeId = ids.get(container)!;
        for (const transition of container.transitions) {
            const source = transition.initial
                ? (nodes.has(initialNodeId(scopeId)) ? initialNodeId(scopeId) : undefined)
                : ids.get(transition.source?.ref as AstNode);
            const target = transition.final
                ? (nodes.has(finalNodeId(scopeId)) ? finalNodeId(scopeId) : undefined)
                : ids.get(transition.target?.ref as AstNode);
            if (source && target) {
                ids.set(transition, unique(`${source}->${target}`));
            }
        }
        for (const vertex of container.vertices) {
            if (ast.isState(vertex)) {
                transitions(vertex);
                vertex.regions.forEach(transitions);
            }
        }
    };
    transitions(machine);
    return { ids, initial, final, definitions: hasDefinitionSection(machine) };
}
