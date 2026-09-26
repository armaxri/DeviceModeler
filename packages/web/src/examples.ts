const files = import.meta.glob('../../../examples/*.hsm', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface Example {
    fileName: string;
    title: string;
    text: string;
}

const TITLES: Record<string, string> = {
    'traffic-light.hsm': 'Traffic light (time events, interfaces)',
    'cd-player.hsm': 'CD player (history, choice)',
    'keyboard.hsm': 'Keyboard (orthogonal regions)',
    'door.hsm': 'Door (entry / exit points, fork / join)'
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
