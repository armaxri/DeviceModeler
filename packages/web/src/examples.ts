const files = {
    ...import.meta.glob('../../../examples/*.devm', { query: '?raw', import: 'default', eager: true }),
    // two files: the gate imports the motor (submachine instance)
    ...import.meta.glob('../../../examples/door-with-motor/*.devm', { query: '?raw', import: 'default', eager: true }),
    // a model importing a C++ header (docs/cpp-integration.md)
    ...import.meta.glob('../../../examples/cpp-types/*.devm', { query: '?raw', import: 'default', eager: true }),
    // the structure of a product (docs/structure-language.md): structure files and the state machines of its components
    ...import.meta.glob('../../../examples/device/*.devm', { query: '?raw', import: 'default', eager: true })
} as Record<string, string>;

/** C/C++ headers of the examples (imported by the example models; not opened in the editor). */
const headerFiles = {
    ...import.meta.glob('../../../examples/cpp-types/*.h', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob('../../../examples/device/*.h', { query: '?raw', import: 'default', eager: true })
} as Record<string, string>;

/** The headers of the examples by file name. */
export const EXAMPLE_HEADERS: Record<string, string> = Object.fromEntries(Object.entries(headerFiles)
    .map(([path, text]) => [path.substring(path.lastIndexOf('/') + 1), text]));

export interface Example {
    fileName: string;
    title: string;
    text: string;
}

const TITLES: Record<string, string> = {
    'traffic-light.devm': 'Traffic light (time events, interfaces)',
    'cd-player.devm': 'CD player (history, choice)',
    'keyboard.devm': 'Keyboard (orthogonal regions)',
    'door.devm': 'Door (entry / exit points, fork / join)',
    'gate.devm': 'Gate with a motor submachine (imports motor.devm)',
    'motor.devm': 'Motor (submachine of the gate)',
    'conveyor.devm': 'Conveyor (C++ enums, structs and constants of conveyor_types.h)',
    'system.devm': 'Garage installation: the closed system (door, remote control, display)',
    'garage-door.devm': 'Garage door: subsystem (threads, ports, connections, delegations)',
    'drive-unit.devm': 'Garage door: drive unit (subsystem)',
    'components.devm': 'Garage door: component types',
    'types.devm': 'Garage door: data types',
    'light.devm': 'Garage door: courtesy light (data types, components and a subsystem in one file)',
    'controller.devm': 'Garage door: controller (behavior of DoorController)',
    'drive.devm': 'Garage door: motor control (behavior of MotorController)'
};

export const EXAMPLES: Example[] = Object.entries(files)
    .map(([path, text]) => {
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        return { fileName, title: TITLES[fileName] ?? fileName, text };
    })
    .sort((a, b) => Object.keys(TITLES).indexOf(a.fileName) - Object.keys(TITLES).indexOf(b.fileName));

export const EMPTY_MODEL = `statemachine NewMachine {
    interface:
        in event start

    [*] -> Idle

    state Idle
}
`;
