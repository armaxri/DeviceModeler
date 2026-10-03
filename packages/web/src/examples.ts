const files = {
    ...import.meta.glob('../../../examples/*.hsm', { query: '?raw', import: 'default', eager: true }),
    // two files: the gate imports the motor (submachine instance)
    ...import.meta.glob('../../../examples/door-with-motor/*.hsm', { query: '?raw', import: 'default', eager: true }),
    // a model importing a C++ header (docs/cpp-integration.md)
    ...import.meta.glob('../../../examples/cpp-types/*.hsm', { query: '?raw', import: 'default', eager: true }),
    // the structure of a product (docs/structure-language.md): structure files and the state machines of its components
    ...import.meta.glob('../../../examples/device/*.{dmf,hsm}', { query: '?raw', import: 'default', eager: true })
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
    'traffic-light.hsm': 'Traffic light (time events, interfaces)',
    'cd-player.hsm': 'CD player (history, choice)',
    'keyboard.hsm': 'Keyboard (orthogonal regions)',
    'door.hsm': 'Door (entry / exit points, fork / join)',
    'gate.hsm': 'Gate with a motor submachine (imports motor.hsm)',
    'motor.hsm': 'Motor (submachine of the gate)',
    'conveyor.hsm': 'Conveyor (C++ enums, structs and constants of conveyor_types.h)',
    'system.dmf': 'Garage door: system (.dmf, threads, ports, connections)',
    'drive.dmf': 'Garage door: drive unit (subsystem)',
    'components.dmf': 'Garage door: component types',
    'types.dmf': 'Garage door: data types and interfaces',
    'light.dmf': 'Garage door: courtesy light (data types, components and a subsystem in one file)',
    'controller.hsm': 'Garage door: controller (behavior of DoorController)',
    'drive.hsm': 'Garage door: motor control (behavior of MotorController)'
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
