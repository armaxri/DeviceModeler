// Entry point of the self-contained `hsm` command line executable (docs/installation.md):
//   hsm <command> ...       the command line tool of packages/language (validate, generate, render, ...)
//   hsm                     prints the help
//   hsm --version | --help
// The graphical editor is the desktop app (packages/desktop), not part of this executable.

declare const __HSM_VERSION__: string;
const version = typeof __HSM_VERSION__ === 'string' ? __HSM_VERSION__ : '0.0.0-dev';

async function main(argv: string[]): Promise<void> {
    const [first] = argv;
    if (first === '--version' || first === '-V' || first === 'version') {
        console.log(version);
    } else if (first === undefined || first === '--help' || first === '-h' || (first === 'help' && argv.length === 1)) {
        process.stdout.write(`HSM Modeler ${version} - command line tool for hierarchical state machines\n`
            + 'The graphical editor is the desktop app "HSM Modeler" (see docs/installation.md).\n\n');
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

main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
