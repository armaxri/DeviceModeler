// Entry point of the self-contained `hsm` executable (docs/standalone.md):
//   hsm                     starts the graphical editor (`hsm ui`)
//   hsm ui [options]        starts the local server of the web app (options for embedding, e.g. in Eclipse)
//   hsm <command> ...       the command line tool of packages/language (validate, generate, render, ...)
//   hsm --version | --help
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { openBrowser } from './open-browser.js';
import { createUiServer, DEFAULT_UI_PORT, listen, runningInstance, uiUrl } from './ui-server.js';
import { directoryWebFiles, embeddedWebFiles } from './web-files.js';

declare const __HSM_VERSION__: string;
const version = typeof __HSM_VERSION__ === 'string' ? __HSM_VERSION__ : '0.0.0-dev';

const usage = `HSM Modeler ${version} - hierarchical state machines

Usage:
  hsm                      start the graphical editor in the default browser (same as \`hsm ui\`)
  hsm ui [options]         start the graphical editor
  hsm <command> [options]  run a command of the command line tool (see below)
  hsm --version            print the version
  hsm --help               print this help

Options of \`hsm ui\`:
  -p, --port <port>        port on 127.0.0.1 (default: ${DEFAULT_UI_PORT}; 0: a free port chosen by the system)
  --no-open                do not open the browser
  --json                   machine readable output: one JSON line per event on stdout, e.g.
                           {"event":"listening","url":"http://127.0.0.1:${DEFAULT_UI_PORT}/","port":${DEFAULT_UI_PORT},"pid":1234,"version":"${version}"}
  --exit-on-stdin-close    stop the server when stdin is closed (for processes started by an IDE)
  -h, --help               print this help

The editor runs until Ctrl+C. It keeps its files in the browser storage, which belongs to the address
(host and port): use the same port to find your files again.
`;

async function main(argv: string[]): Promise<void> {
    const [first] = argv;
    if (first === undefined || first === 'ui') {
        process.exitCode = await runUi(argv.slice(1));
    } else if (first === '--version' || first === '-V' || first === 'version') {
        console.log(version);
    } else if (first === '--help' || first === '-h' || (first === 'help' && argv.length === 1)) {
        process.stdout.write(`${usage}\nCommands of the command line tool:\n`);
        await runCli(['--help']);
    } else {
        await runCli(argv);
    }
}

/** Runs the command line tool of the language package with the given arguments. */
async function runCli(args: string[]): Promise<void> {
    // the CLI module parses process.argv when it is loaded (after the executable / script path)
    process.argv = [process.argv[0], process.argv[1] ?? process.argv[0], ...args];
    await import('../../language/src/cli/main.js');
}

interface UiOptions {
    port?: string;
    open: boolean;
    json: boolean;
    exitOnStdinClose: boolean;
}

function parseUiOptions(args: string[]): UiOptions | 'help' {
    const { values, positionals } = parseArgs({
        args,
        options: {
            port: { type: 'string', short: 'p' },
            'no-open': { type: 'boolean' },
            json: { type: 'boolean' },
            'exit-on-stdin-close': { type: 'boolean' },
            help: { type: 'boolean', short: 'h' }
        },
        strict: true,
        allowPositionals: true
    });
    if (values.help) {
        return 'help';
    }
    if (positionals.length > 0) {
        throw new Error(`unexpected argument '${positionals[0]}'`);
    }
    return { port: values.port, open: !values['no-open'], json: !!values.json, exitOnStdinClose: !!values['exit-on-stdin-close'] };
}

async function runUi(args: string[]): Promise<number> {
    let options: UiOptions | 'help';
    try {
        options = parseUiOptions(args);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (args.includes('--json')) {
            process.stdout.write(`${JSON.stringify({ event: 'error', message })}\n`);
        }
        console.error(`hsm ui: ${message}\n\n${usage}`);
        return 2;
    }
    if (options === 'help') {
        process.stdout.write(usage);
        return 0;
    }
    const json = options.json;
    // with --json, stdout only carries the JSON events; messages for humans go to stderr
    const info = (message: string) => json ? console.error(message) : console.log(message);
    const event = (data: Record<string, unknown>) => {
        if (json) {
            process.stdout.write(`${JSON.stringify(data)}\n`);
        }
    };
    const fail = (message: string) => {
        event({ event: 'error', message });
        console.error(`hsm ui: ${message}`);
        return 1;
    };

    const explicitPort = options.port !== undefined;
    const port = explicitPort ? Number(options.port) : DEFAULT_UI_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        fail(`invalid port '${options.port}'`);
        return 2;
    }
    const files = embeddedWebFiles() ?? directoryWebFiles(path.join(__dirname, 'web'));
    if (!files.get('index.html')) {
        return fail('the web app is missing (build it with `npm run build:exe`)');
    }

    const server = createUiServer({ files, version });
    let actualPort: number;
    try {
        actualPort = await listen(server, port);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
            return fail(error instanceof Error ? error.message : String(error));
        }
        const running = await runningInstance(port);
        if (running !== undefined && !explicitPort && options.open) {
            // the editor already runs (started earlier from another terminal): open it there
            info(`The HSM Modeler ${running} already runs at ${uiUrl(port)}`);
            await openBrowser(uiUrl(port));
            return 0;
        }
        if (explicitPort) {
            return fail(`port ${port} is already in use${running !== undefined ? ` by the HSM Modeler ${running}` : ''}`);
        }
        info(`Port ${port} is already in use, using a free port (the browser storage of another address is empty).`);
        actualPort = await listen(server, 0);
    }

    const url = uiUrl(actualPort);
    event({ event: 'listening', url, port: actualPort, pid: process.pid, version });
    info(`HSM Modeler ${version} running at ${url}\nPress Ctrl+C to stop.`);

    let stopping = false;
    const stop = (reason: string) => {
        if (stopping) {
            return;
        }
        stopping = true;
        event({ event: 'stopped', reason });
        server.close();
        server.closeAllConnections();
        process.exit(0);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    if (process.platform !== 'win32') {
        process.on('SIGHUP', () => stop('SIGHUP'));
    }
    if (options.exitOnStdinClose) {
        process.stdin.on('end', () => stop('stdin closed'));
        process.stdin.on('close', () => stop('stdin closed'));
        process.stdin.on('error', () => stop('stdin closed'));
        process.stdin.resume();
    }
    if (options.open && !await openBrowser(url)) {
        info('Could not open a browser: open the address above manually.');
    }
    return 0;
}

main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
