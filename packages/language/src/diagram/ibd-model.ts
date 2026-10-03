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
 * - overview of all component types of a file: {@link IBD_OVERVIEW_ID}, the blocks as above
 * - struct / interface of the file:           `type:Position` (shown next to the diagram, unlinked)
 * - diagram of a file with data types only:   {@link IBD_TYPES_ID}.
 * Duplicates (invalid models) get a suffix `~1`, `~2`, ….
 */

/**
 * `frame`: the enclosing frame of the shown subsystem or system (`ibd [system] GarageDoor`), `thread`: a
 * thread frame, `instance`: a part (`door : DoorController`), `block`: a component type shown on its own
 * (a component without parts, or the overview of the component types of a file), `type`: a struct or
 * interface declared in the file (a value type box «struct» / «interface» with its fields / events,
 * outside of the frame and never connected).
 */
export type IbdNodeKind = 'frame' | 'thread' | 'instance' | 'block' | 'type';

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
    /**
     * The label (position relative to the node, inside an instance, outside of the frame): the port name
     * and, for a port typed by a named type, the type (`cmd : DoorCmd`).
     */
    label: DiagramLabel;
    /** The named type of the port (`DoorCmd`, `integer`), shown in the label; `undefined` for a list of events. */
    typeName?: string;
}

/** A field of a struct (`x : real`) or an event of an interface (`event up : integer`) in a type box. */
export interface IbdMember {
    /** `event ` for events. */
    prefix?: string;
    name: string;
    type?: string;
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
    /** `component`, `subsystem`, `system`, `thread`; type boxes: `struct`, `interface`. */
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
    /** Instances: the type is a subsystem (composite, can be opened). */
    composite?: IbdComposite;
    /** Type boxes: the fields of a struct or the events of an interface. */
    members?: IbdMember[];
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
    /** Name of the subsystem. */
    structure: string;
    /** URI of the file declaring the subsystem. */
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
    /**
     * What is shown: a subsystem / system (IBD), a component type (block), all component types of the file
     * or (a file without component types) its data types. The structs and interfaces of the file are shown
     * next to any of them (nodes of kind `type`).
     */
    kind: 'subsystem' | 'system' | 'component' | 'overview' | 'types';
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

/** Id of the diagram of a file without component types: its structs and interfaces. */
export const IBD_TYPES_ID = '#types';
