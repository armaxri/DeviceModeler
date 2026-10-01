import { spawn } from 'node:child_process';

/** The command opening a URL in the default browser of the platform. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
    switch (platform) {
        case 'darwin':
            return ['open', [url]];
        case 'win32':
            // the URL is passed as an argument of rundll32, not through `cmd /c start` (no shell quoting issues)
            return ['rundll32', ['url.dll,FileProtocolHandler', url]];
        default:
            return ['xdg-open', [url]];
    }
}

/** Opens a URL in the default browser; resolves to false if that failed (the caller prints the URL anyway). */
export function openBrowser(url: string): Promise<boolean> {
    const [command, args] = browserCommand(url);
    return new Promise(resolve => {
        try {
            const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
            child.once('error', () => resolve(false));
            child.once('spawn', () => {
                child.unref();
                resolve(true);
            });
        } catch {
            resolve(false);
        }
    });
}
