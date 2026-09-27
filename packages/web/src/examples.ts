const files = {
    ...import.meta.glob('../../../examples/*.hsm', { query: '?raw', import: 'default', eager: true }),
    // two files: the gate imports the motor (submachine instance)
    ...import.meta.glob('../../../examples/door-with-motor/*.hsm', { query: '?raw', import: 'default', eager: true })
} as Record<string, string>;

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
    'motor.hsm': 'Motor (submachine of the gate)'
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
