import type { AstNode } from 'langium';
import type { DiagramLabel, Point } from './diagram-model.js';

/*
 * The diagram of a structure file (`.dmf`): an internal block diagram (IBD) in the style of SysML.
 * Computed by `layoutStructure` (ibd-layout.ts), rendered by the web editor (packages/web, Sprotty
 * views `Ibd*View`) and by `renderIbdSvg` (render/ibd-svg.ts) with the same CSS classes and themes as the
 * state machine diagrams.
 *
 * Element ids (stable while other elements are added or removed; `S` is the name of the shown
 * structure, see {@link ibdIds}):
 * - frame of the structure / system:          `S`
 * - boundary port of the structure:           `S.remote`
 * - thread:                                   `S/thread:ControlTask`
 * - instance (part):                          `S/door`
 * - port of an instance:                      `S/door.cmd`
 * - connection:                               `S/door.motor->drive.ctrl`
 * - delegation:                               `S/remote->door.cmd`
 * - component type shown as a block:          `C` (its ports `C.cmd`)
 * - overview of all component types of a file: {@link IBD_OVERVIEW_ID}, the blocks as above.
 * Duplicates (invalid models) get a suffix `~1`, `~2`, ….
 */

/**
 * `frame`: the enclosing frame of the shown structure (`ibd [system] GarageDoor`), `thread`: a thread
 * frame, `instance`: a part (`door : DoorController`), `block`: a component type shown on its own (a
 * component without parts, or the overview of the component types of a file).
 */
export type IbdNodeKind = 'frame' | 'thread' | 'instance' | 'block';

export type IbdPortSide = 'WEST' | 'EAST' | 'NORTH' | 'SOUTH';

export interface IbdPort {
    id: string;
    name: string;
    direction: 'provides' | 'requires';
    kind: 'sync' | 'async';
    /** `cmd : DoorCmd` (tooltip). */
    title: string;
    side: IbdPortSide;
    /** Position of the port square (top left corner) relative to its node. */
    x: number;
    y: number;
    size: number;
    /** The port name, position relative to the node (inside an instance, outside of the frame). */
    label: DiagramLabel;
}

export interface IbdNode {
    id: string;
    kind: IbdNodeKind;
    /** Position relative to the parent node. */
    x: number;
    y: number;
    width: number;
    height: number;
    /** The name: of the instance, thread, structure or component type. */
    name: string;
    /** Name of the type of an instance (`DoorController`), `?` if it cannot be resolved. */
    typeName?: string;
    /** `component`, `structure`, `system`, `thread`. */
    stereotype?: string;
    /** Threads: the settings shown below the name (`priority 5 · period 10 ms`); the frame: the text of its tab (`ibd [system] Car`). */
    details?: string;
    /** Description / documentation (tooltip). */
    description?: string;
    /** The frame: width of its tab. */
    tabWidth?: number;
    /** Height of the header (name compartment) of instances, blocks and threads, of the frame tab. */
    headerHeight: number;
    /** Instances and blocks: the type is implemented by a state machine (`behavior`). */
    behavior?: IbdBehavior;
    /** Instances: the type is a structure (composite, can be opened). */
    composite?: IbdComposite;
    ports: IbdPort[];
    children: IbdNode[];
}

export interface IbdBehavior {
    /** Name of the state machine, if it is resolved. */
    machine?: string;
    /** URI of the file of the state machine. */
    uri?: string;
}

export interface IbdComposite {
    /** Name of the structure. */
    structure: string;
    /** URI of the file declaring the structure. */
    uri?: string;
}

export interface IbdEdge {
    id: string;
    kind: 'connect' | 'delegate';
    /** Id of the port at the source of the statement (the required side). */
    source: string;
    /** Id of the port at the target of the statement (the provided side). */
    target: string;
    /** The connection crosses threads: drawn dashed (see `connectionThreads`). */
    crossThread: boolean;
    /** `connect door.motor -> drive.ctrl` (tooltip). */
    title: string;
    /** Absolute coordinates of the orthogonal route. */
    points: Point[];
}

export interface IbdGraph {
    id: string;
    /** Name of the shown element. */
    name: string;
    /** What is shown: a structure / system (IBD), a component type (block) or all component types of the file. */
    kind: 'structure' | 'system' | 'component' | 'overview';
    width: number;
    height: number;
    children: IbdNode[];
    edges: IbdEdge[];
}

export interface IbdLayoutResult {
    graph: IbdGraph;
    /** Maps diagram element ids to AST nodes (ports: the `Port`, see {@link IbdLayoutResult.instances}). */
    elements: Map<string, AstNode>;
    /** Maps AST nodes to diagram element ids (not ports of instances: a port is shown at every instance). */
    ids: Map<AstNode, string>;
    /** Port ids of instances -> the instance (the port itself is in {@link IbdLayoutResult.elements}). */
    instances: Map<string, AstNode>;
}

/** Id of the diagram showing all component types of a file. */
export const IBD_OVERVIEW_ID = '#components';
