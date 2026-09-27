import * as vscode from 'vscode';
import * as path from 'node:path';
import { generatePlantUml, HsmModelLoader, importSct, layoutStateMachine, renderSvg, type ParsedModel } from 'hsm-language';
import { runGeneration } from '../../../language/src/generator/generate-command.js';
import type { DiagramManager } from './diagram-panel.js';
import type { HsmTestController } from './test-controller.js';
import { effectiveTheme } from './logic/webview.js';
import { resolveGeneration, type CppSettings } from './logic/generator-config.js';

export interface CommandContext {
    diagrams: DiagramManager;
    tests: HsmTestController;
    output: vscode.LogOutputChannel;
}

let loader: HsmModelLoader | undefined;

/** Parses and validates the text of a model (in the extension host, independent of the language server). */
export async function parseModel(document: vscode.TextDocument): Promise<ParsedModel> {
    loader ??= new HsmModelLoader();
    return loader.load(document.getText(), document.uri.toString());
}

export function registerCommands(context: vscode.ExtensionContext, commands: CommandContext): void {
    const register = (id: string, handler: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
            return await handler(...args);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            commands.output.error(`${id}: ${message}`);
            vscode.window.showErrorMessage(`HSM: ${message}`);
            return undefined;
        }
    }));

    register('hsm.openDiagram', async (arg?: unknown) => {
        const uri = modelUri(arg, commands.diagrams);
        if (!uri) {
            vscode.window.showWarningMessage('HSM: Open an .hsm file to show its diagram.');
            return;
        }
        await commands.diagrams.open(uri);
    });

    register('hsm.generateCpp', async (arg?: unknown) => {
        const uri = modelUri(arg, commands.diagrams);
        if (!uri) {
            vscode.window.showWarningMessage('HSM: Select an .hsm file to generate C++ code for.');
            return;
        }
        await generateCppFor(uri, commands.output);
    });

    register('hsm.runTests', async (arg?: unknown) => {
        const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.languageId === 'hsmtest'
            ? vscode.window.activeTextEditor.document.uri : undefined;
        await commands.tests.runFile(uri);
    });

    register('hsm.importSct', async (arg?: unknown) => {
        let uri = arg instanceof vscode.Uri && arg.path.toLowerCase().endsWith('.sct') ? arg : undefined;
        if (!uri) {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'itemis CREATE statechart': ['sct'] },
                openLabel: 'Import',
                title: 'Import itemis CREATE model'
            });
            uri = picked?.[0];
        }
        if (uri) {
            await importSctFile(uri, commands.output);
        }
    });

    register('hsm.exportSvg', async (arg?: unknown) => {
        const uri = modelUri(arg, commands.diagrams);
        if (!uri) {
            vscode.window.showWarningMessage('HSM: Open an .hsm file to export its diagram.');
            return;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const svg = await renderModelSvg(document);
        const target = await vscode.window.showSaveDialog({
            defaultUri: uri.with({ path: uri.path.replace(/\.hsm$/i, '') + '.svg' }),
            filters: { SVG: ['svg'] },
            title: 'Export diagram as SVG'
        });
        if (target) {
            await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(svg));
            showWritten(`Exported ${path.basename(target.path)}.`, [target]);
        }
    });

    register('hsm.exportPlantUml', async (arg?: unknown) => {
        const uri = modelUri(arg, commands.diagrams);
        if (!uri) {
            vscode.window.showWarningMessage('HSM: Open an .hsm file to export it as PlantUML.');
            return;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const parsed = await parseModel(document);
        if (parsed.hasSyntaxErrors) {
            throw new Error(`${path.basename(uri.path)} contains syntax errors.`);
        }
        const target = await vscode.window.showSaveDialog({
            defaultUri: uri.with({ path: uri.path.replace(/\.hsm$/i, '') + '.puml' }),
            filters: { PlantUML: ['puml', 'plantuml'] },
            title: 'Export as PlantUML'
        });
        if (target) {
            await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(generatePlantUml(parsed.model)));
            showWritten(`Exported ${path.basename(target.path)}.`, [target]);
        }
    });
}

/** The model a command applies to: the argument (explorer), the active .hsm editor or the active diagram. */
function modelUri(arg: unknown, diagrams: DiagramManager): vscode.Uri | undefined {
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId === 'hsm') {
        return editor.document.uri;
    }
    return diagrams.active?.uri;
}

/**
 * The diagram of a model as SVG document (`renderSvg` of the language package: the same look as the
 * diagram view, styles embedded). Layout options follow the `hsm.diagram.*` settings; with the theme
 * `auto` the light theme is used (exported files are usually embedded in light documents).
 */
export async function renderModelSvg(document: vscode.TextDocument): Promise<string> {
    const parsed = await parseModel(document);
    if (parsed.hasSyntaxErrors || !parsed.model?.name) {
        throw new Error(`${path.basename(document.uri.path)} contains syntax errors.`);
    }
    const config = vscode.workspace.getConfiguration('hsm.diagram', document.uri);
    const { graph } = await layoutStateMachine(parsed.model, {
        direction: config.get<string>('direction') === 'RIGHT' ? 'RIGHT' : 'DOWN',
        routing: (['SPLINES', 'ORTHOGONAL', 'POLYLINE'] as const).find(r => r === config.get<string>('edgeRouting')) ?? 'SPLINES',
        priorities: config.get<boolean>('priorities', true)
    });
    return renderSvg(graph, { theme: effectiveTheme(config.get<string>('theme', 'auto'), config.get<string>('lightTheme', 'classic'), false) });
}

function cppSettings(uri: vscode.Uri): CppSettings {
    const config = vscode.workspace.getConfiguration('hsm.cpp', uri);
    return {
        outputDirectory: config.get<string>('outputDirectory', ''),
        namespace: config.get<string | null>('namespace', null),
        standard: config.get<string>('standard') === '11' ? '11' : '17'
    };
}

/**
 * `HSM: Generate C++`: generates `sc_statemachine.h`, `<Class>.h` and `<Class>.cpp` with the
 * generator of the language package (`runGeneration`, as `hsm generate`), configured by a
 * generator configuration file or the settings. Unsaved changes of the model are saved first.
 */
export async function generateCppFor(uri: vscode.Uri, output: vscode.LogOutputChannel): Promise<vscode.Uri[]> {
    if (uri.scheme !== 'file') {
        throw new Error('Only models stored in files can be generated.');
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) {
        await document.save();
    }
    const name = path.basename(uri.fsPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const generation = await resolveGeneration(uri.fsPath, cppSettings(uri), workspaceFolder);
    if (generation.configFile) {
        output.info(`${name}: using the generator configuration ${generation.configFile}`);
    }
    const result = await runGeneration({ config: generation.config, baseDir: generation.baseDir, targets: ['cpp'], mode: 'write' });
    const diagnostics = [...generation.diagnostics, ...result.diagnostics];
    for (const d of diagnostics) {
        const location = d.file ? `${d.file}${d.line !== undefined ? `:${d.line}${d.column !== undefined ? `:${d.column}` : ''}` : ''}: ` : '';
        (d.severity === 'error' ? output.error : output.warn).call(output, `${location}${d.message}`);
    }
    const errors = result.diagnostics.filter(d => d.severity === 'error');
    if (errors.length > 0) {
        output.show(true);
        throw new Error(`The C++ code of ${name} could not be generated: ${errors[0].message}${errors.length > 1 ? ` (and ${errors.length - 1} more, see the output 'HSM')` : ''}`);
    }
    const written = result.outputs.map(o => vscode.Uri.file(o.file));
    for (const o of result.outputs) {
        output.info(`${o.status === 'written' ? 'Generated' : 'Unchanged'} ${o.file}`);
    }
    const outDir = written[0] ? vscode.Uri.joinPath(written[0], '..') : uri;
    const unchanged = result.outputs.every(o => o.status === 'unchanged');
    showWritten(`${unchanged ? 'Up to date' : 'Generated'}: ${written.map(w => path.basename(w.path)).join(', ')} in ${vscode.workspace.asRelativePath(outDir, false)}.`, written);
    return written;
}

/** `HSM: Import itemis CREATE model`: converts an `.sct` file into an `.hsm` file next to it. */
export async function importSctFile(uri: vscode.Uri, output: vscode.LogOutputChannel): Promise<vscode.Uri | undefined> {
    const xml = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    const { text, warnings } = importSct(xml);
    const target = uri.with({ path: uri.path.replace(/\.sct$/i, '') + '.hsm' });
    let exists = false;
    try {
        await vscode.workspace.fs.stat(target);
        exists = true;
    } catch {
        // does not exist
    }
    if (exists) {
        const answer = await vscode.window.showWarningMessage(`${path.basename(target.path)} already exists. Overwrite it?`, { modal: true }, 'Overwrite');
        if (answer !== 'Overwrite') {
            return undefined;
        }
    }
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    for (const warning of warnings) {
        output.warn(`${path.basename(uri.path)}: ${warning}`);
    }
    await vscode.window.showTextDocument(target);
    if (warnings.length > 0) {
        vscode.window.showWarningMessage(`Imported ${path.basename(uri.path)} with ${warnings.length} warning(s) – see the output 'HSM'.`, 'Show Output')
            .then(choice => choice && output.show());
    } else {
        vscode.window.showInformationMessage(`Imported ${path.basename(uri.path)} as ${path.basename(target.path)}.`);
    }
    return target;
}

function showWritten(message: string, files: vscode.Uri[]): void {
    vscode.window.showInformationMessage(message, 'Open').then(choice => {
        if (choice && files[0]) {
            vscode.window.showTextDocument(files[files.length - 1]);
        }
    });
}
