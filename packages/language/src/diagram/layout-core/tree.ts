/**
 * The node hierarchy of a diagram as seen by the manual layout engines: parents, paths, absolute
 * positions and the frame of an edge (the node in whose coordinate system its waypoints are stored).
 */
import type { Point } from '../diagram-model.js';
import type { Rect } from './model.js';

/** A diagram node with a position relative to its parent node. */
export interface LayoutTreeNode extends Rect {
    id: string;
}

export class LayoutTree<T extends LayoutTreeNode> {

    readonly nodes = new Map<string, T>();
    readonly parents = new Map<string, string>();

    /**
     * @param root the (possibly synthetic) root node: the canvas, positions of its children are absolute
     * @param childrenOf the child nodes of a node
     */
    constructor(readonly root: T, private readonly childrenOf: (node: T) => readonly T[]) {
        const collect = (node: T) => {
            this.nodes.set(node.id, node);
            for (const child of childrenOf(node)) {
                this.parents.set(child.id, node.id);
                collect(child);
            }
        };
        collect(root);
    }

    children(id: string): readonly T[] {
        const node = this.nodes.get(id);
        return node ? this.childrenOf(node) : [];
    }

    /** The ids from the root down to the node (inclusive). */
    path(id: string): string[] {
        const result = [id];
        let current = this.parents.get(id);
        while (current) {
            result.unshift(current);
            current = this.parents.get(current);
        }
        if (result[0] !== this.root.id) {
            result.unshift(this.root.id);
        }
        return result;
    }

    /**
     * The frame of an edge between two nodes: the innermost node containing both (for an edge between a
     * container and its content: the container; for an edge from a node to itself: its parent).
     */
    frameOf(source: string, target: string): string {
        const sourcePath = this.path(source);
        const targetPath = this.path(target);
        let frame = this.root.id;
        for (let i = 0; i < Math.min(sourcePath.length, targetPath.length) && sourcePath[i] === targetPath[i]; i++) {
            frame = sourcePath[i];
        }
        if (source === target) {
            frame = this.parents.get(source) ?? this.root.id;
        }
        return frame;
    }

    /** Absolute position of a node (the root is at (0, 0)). */
    absolutePosition(id: string): Point {
        let x = 0;
        let y = 0;
        for (let current: string | undefined = id; current && current !== this.root.id; current = this.parents.get(current)) {
            const node = this.nodes.get(current)!;
            x += node.x;
            y += node.y;
        }
        return { x, y };
    }

    /** Bounds of a node relative to the frame node (which must be an ancestor or the node itself). */
    boundsIn(id: string, frame: string): Rect {
        const node = this.nodes.get(id)!;
        if (id === frame) {
            return { x: 0, y: 0, width: node.width, height: node.height };
        }
        let x = 0;
        let y = 0;
        for (let current: string | undefined = id; current && current !== frame; current = this.parents.get(current)) {
            const n = this.nodes.get(current)!;
            x += n.x;
            y += n.y;
        }
        return { x, y, width: node.width, height: node.height };
    }

    /** Absolute bounds of all nodes (a snapshot, e.g. of the automatic layout). */
    absoluteBounds(): Map<string, Rect> {
        const result = new Map<string, Rect>();
        for (const [id, node] of this.nodes) {
            const p = this.absolutePosition(id);
            result.set(id, { x: p.x, y: p.y, width: node.width, height: node.height });
        }
        return result;
    }
}

/**
 * Absolute position of the frame of an edge between two nodes of a laid out diagram (see
 * {@link LayoutTree.frameOf}); waypoints placed in the diagram are stored relative to it.
 */
export function edgeFrameOrigin<T extends LayoutTreeNode>(roots: readonly T[], childrenOf: (node: T) => readonly T[], source: string, target: string): Point {
    const root = { id: '#layout-root', x: 0, y: 0, width: 0, height: 0 } as T;
    const tree = new LayoutTree<T>(root, node => node === root ? roots : childrenOf(node));
    if (!tree.nodes.has(source) || !tree.nodes.has(target)) {
        return { x: 0, y: 0 };
    }
    return tree.absolutePosition(tree.frameOf(source, target));
}
