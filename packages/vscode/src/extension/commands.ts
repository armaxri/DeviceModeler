import * as vscode from 'vscode';
import * as path from 'node:path';
import {
    cppHeaderStore, StructureModelLoader, StateMachineModelLoader, importSct, isStructureText, layoutFileName, layoutStateMachineWithLayout, layoutStructure, layoutTextEdits,
    parseEdgeRouting, parseManualLayout, renderIbdSvg, renderSvg, type ParsedModel
} from 'devm-language';
import { runGeneration } from '../../../language/src/generator/generate-command.js';
import { installNodeHeaderSupport } from '../../../language/src/node/cpp-headers-node.js';
import { isStructureFile, readText, vscodeHeaderSettings, type DiagramManager } from './diagram-panel.js';
import type { DevmTestController } from './test-controller.js';
import { effectiveTheme } from './logic/webview.js';
import { resolveGeneration, type CppSettings } from './logic/generator-config.js';
import type { LayoutCommand } from '../common/protocol.js';
import { toRangeEdits } from './logic/edits.js';

export interface CommandContext {
    diagrams: DiagramManager;
    tests: DevmTestController;
    output: vscode.LogOutputChannel;
}

let loader: StateMachineModelLoader | undefined;
let structureLoader: StructureModelLoader | undefined;

/** Parses and validates the text of a model (in the extension host, independent of the language server). */
export async function parseModel(document: vscode.TextDocument): Promise<ParsedModel> {
    // imported state machines are read from the open documents or the file system
    if (!loader) {
        loader = new StateMachineModelLoader(undefined, { readFile: uri => readText(uri.toString()) });
        // imported C/C++ headers: read from disk with the settings of devm.gen.json
        installNodeHeaderSupport(loader.services.shared);
    }
    cppHeaderStore(loader.services.shared).updateSettings(vscodeHeaderSettings(document.uri));
    return loader.load(document.getText(), document.uri.toString());
}

/**
 * The diagram of a structure file as SVG document (`renderIbdSvg` of the language package, like
 * `devm render`): the internal block diagram of `element` (a subsystem, system or component type; default:
 * the first system, else the first subsystem, else the component types, else the data types).
 */
export async function renderStructureSvg(document: vscode.TextDocument, element?: string): Promise<string> {
    if (!structureLoader) {
        structureLoader = new StructureModelLoader(undefined, { readFile: uri => readText(uri.toString()) });
        installNodeHeaderSupport(structureLoader.services.shared);
    }
    cppHeaderStore(structureLoader.services.shared).updateSettings(vscodeHeaderSettings(document.uri));
    const parsed = await structureLoader.load(document.getText(), document.uri.toString());
    if (parsed.hasSyntaxErrors) {
        throw new Error(`${path.basename(document.uri.path)} contains syntax errors.`);
    }
    const layout = await layoutStructure(parsed.model, { element: element || undefined });
    if (!layout) {
        throw new Error(`${path.basename(document.uri.path)} declares no components, subsystems, systems or data types.`);
    }
    const config = vscode.workspace.getConfiguration('devm.diagram', document.uri);
    return renderIbdSvg(layout.graph, { theme: effectiveTheme(config.get<string>('theme', 'auto'), config.get<string>('lightTheme', 'classic'), false) });
}

export function registerCommands(context: vscode.ExtensionContext, commands: CommandContext): void {
    const register = (id: string, handler: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
            return await handler(...args);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            commands.output.error(`${id}: ${message}`);
            vscode.window.showErrorMessage(`Device Modeler: ${message}`);
            return undefined;
        }
    }));

    register('devm.openDiagram', async (arg?: unknown) => {
        const uri = modelUri(arg, commands.diagrams);
        if (!uri) {
            vscode.window.showWarningMessage('Device Modeler: Open a .devm file to show its diagram.');
            return;
        }
        await commands.diagrams.openStandalone(uri);
    });

    register('devm.generateCpp', async (arg?: unknown) => {
        const uri = modelUri(arg, commands.diagrams);
        if (!uri || await isStructureFile(uri)) {
            vscode.window.showWarningMessage('Device Modeler: Select the .devm file of a state machine to generate C++ code for.');
            return;
        }
        await generateCppFor(uri, commands.output);
    });

    register('devm.runTests', async (arg?: unknown) => {
        const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.languageId === 'devmtest'
            ? vscode.window.activeTextEditor.document.uri : undefined;
        await commands.tests.runFile(uri);
    });

    register('devm.debugTests', async (arg?: unknown) => {
        const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.languageId === 'devmtest'
            ? vscode.window.activeTextEditor.document.uri : undefined;
        if (!uri) {
            vscode.window.showWarningMessage('Device Modeler: Open a .devmtest file to debug its tests.');
            return;
        }
        await commands.tests.debugFile(uri);
    });

    register('devm.importSct', async (arg?: unknown) => {
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

    register('devm.exportDiagram', async (arg?: unknown, element?: unknown) => {
        const uri = modelUri(arg, commands.diagrams);
        if (!uri) {
            vscode.window.showWarningMessage('Device Modeler: Open a .devm file to export its diagram.');
            return;
        }
        const format = await vscode.window.showQuickPick([
            { label: 'SVG', description: 'scalable vector graphic', format: 'svg' as const },
            { label: 'PNG', description: 'image with twice the screen resolution', format: 'png' as const }
        ], { title: 'Export diagram', placeHolder: 'Format' });
        if (!format) {
            return;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        // structure files: the structure shown in the diagram (`element`, from its toolbar)
        const svg = isStructureText(document.getText()) ? await renderStructureSvg(document, typeof element === 'string' ? element : undefined) : await renderModelSvg(document);
        const target = await vscode.window.showSaveDialog({
            defaultUri: uri.with({ path: uri.path.replace(/\.devm$/i, '') + '.' + format.format }),
            filters: format.format === 'svg' ? { SVG: ['svg'] } : { PNG: ['png'] },
            title: `Export diagram as ${format.label}`
        });
        if (!target) {
            return;
        }
        // the PNG is rendered from the same SVG in the diagram webview (it needs a canvas)
        const content = format.format === 'svg' ? new TextEncoder().encode(svg) : await commands.diagrams.rasterize(uri, svg);
        await vscode.workspace.fs.writeFile(target, content);
        showWritten(`Exported ${path.basename(target.path)}.`, [target]);
    });

    // manual layout (layout annotations in the model, state machines and structure files): commands of the
    // diagram (also buttons in its toolbar)
    const layoutCommands: Record<string, LayoutCommand> = {
        'devm.autoArrange': 'arrange',
        'devm.resetLayout': 'reset'
    };
    for (const [id, command] of Object.entries(layoutCommands)) {
        register(id, async (arg?: unknown) => {
            const language = vscode.window.activeTextEditor?.document.languageId;
            const uri = arg instanceof vscode.Uri ? arg : language === 'devm'
                ? vscode.window.activeTextEditor!.document.uri : undefined;
            if (uri && !commands.diagrams.get(uri)) {
                await (await commands.diagrams.open(uri)).whenReady();
            }
            if (!commands.diagrams.layoutCommand(uri, command)) {
                vscode.window.showWarningMessage('Device Modeler: Open the diagram of a .devm file first.');
            }
        });
    }

    // Back / Forward of the navigation between diagrams (also buttons and Alt+← / Alt+→ in the diagram)
    for (const direction of ['back', 'forward'] as const) {
        register(direction === 'back' ? 'devm.navigateBack' : 'devm.navigateForward', () => {
            if (!commands.diagrams.requestNavigation(direction)) {
                vscode.window.showWarningMessage('Device Modeler: Open a diagram first.');
            }
        });
    }

    register('devm.convertLayoutFile', async (arg?: unknown) => {
        const uri = modelUri(arg, commands.diagrams);
        if (!uri || await isStructureFile(uri)) {
            vscode.window.showWarningMessage('Device Modeler: Open the .devm file of a state machine to convert its layout file.');
            return;
        }
        const layoutFile = await convertLayoutFile(uri);
        if (layoutFile) {
            vscode.window.showInformationMessage(`The layout of ${path.basename(layoutFile.path)} was written into ${path.basename(uri.path)} as annotations; `
                + `${path.basename(layoutFile.path)} is no longer used and can be deleted.`);
        }
    });
}

/** The model a command applies to: the argument (explorer), the active .devm editor or the active diagram. */
function modelUri(arg: unknown, diagrams: DiagramManager): vscode.Uri | undefined {
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId === 'devm') {
        return editor.document.uri;
    }
    return diagrams.active?.uri;
}

/**
 * `Device Modeler: Convert Layout File to Annotations`: writes the layout of the sidecar file `<model>.layout`
 * (of earlier builds of the manual layout) into the model as layout annotations (one undoable edit of
 * the document, not saved). The file is left in place. Returns the layout file, undefined if there is none.
 */
export async function convertLayoutFile(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const layoutFile = uri.with({ path: layoutFileName(uri.path) });
    let content: string;
    try {
        content = new TextDecoder().decode(await vscode.workspace.fs.readFile(layoutFile));
    } catch {
        vscode.window.showWarningMessage(`Device Modeler: There is no layout file ${path.basename(layoutFile.path)} next to ${path.basename(uri.path)}.`);
        return undefined;
    }
    const layout = parseManualLayout(content);
    const document = await vscode.workspace.openTextDocument(uri);
    const parsed = await parseModel(document);
    if (parsed.hasSyntaxErrors || !parsed.model?.name) {
        throw new Error(`${path.basename(uri.path)} contains syntax errors.`);
    }
    const text = document.getText();
    const edit = new vscode.WorkspaceEdit();
    for (const e of toRangeEdits(layoutTextEdits(parsed.model, text, layout), text.length, offset => document.positionAt(offset))) {
        edit.replace(uri, new vscode.Range(e.start, e.end), e.text);
    }
    if (!await vscode.workspace.applyEdit(edit)) {
        throw new Error(`The layout could not be written into ${path.basename(uri.path)}.`);
    }
    return layoutFile;
}

/**
 * The diagram of a model as SVG document (`renderSvg` of the language package: the same look as the
 * diagram view, styles embedded). Layout options follow the `devm.diagram.*` settings; with the theme
 * `auto` the light theme is used (exported files are usually embedded in light documents). The layout
 * annotations of the model (manual layout) are applied.
 */
export async function renderModelSvg(document: vscode.TextDocument): Promise<string> {
    const parsed = await parseModel(document);
    if (parsed.hasSyntaxErrors || !parsed.model?.name) {
        throw new Error(`${path.basename(document.uri.path)} contains syntax errors.`);
    }
    const config = vscode.workspace.getConfiguration('devm.diagram', document.uri);
    const { graph } = await layoutStateMachineWithLayout(parsed.model, {
        direction: config.get<string>('direction') === 'RIGHT' ? 'RIGHT' : 'DOWN',
        routing: parseEdgeRouting(config.get<string>('edgeRouting')) ?? 'SPLINES',
        priorities: config.get<boolean>('priorities', true)
    });
    return renderSvg(graph, { theme: effectiveTheme(config.get<string>('theme', 'auto'), config.get<string>('lightTheme', 'classic'), false) });
}

function cppSettings(uri: vscode.Uri): CppSettings {
    const config = vscode.workspace.getConfiguration('devm.cpp', uri);
    return {
        outputDirectory: config.get<string>('outputDirectory', ''),
        namespace: config.get<string | null>('namespace', null),
        standard: config.get<string>('standard') === '11' ? '11' : '17'
    };
}

/**
 * `Device Modeler: Generate C++`: generates `sc_statemachine.h`, `<Class>.h` and `<Class>.cpp` with the
 * generator of the language package (`runGeneration`, as `devm generate`), configured by a
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
        throw new Error(`The C++ code of ${name} could not be generated: ${errors[0].message}${errors.length > 1 ? ` (and ${errors.length - 1} more, see the output 'Device Modeler')` : ''}`);
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

/**
 * `Device Modeler: Import itemis CREATE model`: converts an `.sct` file into a `.devm` file next to it. The
 * arrangement of the itemis diagram becomes the manual layout (layout annotations in the model, experimental).
 */
export async function importSctFile(uri: vscode.Uri, output: vscode.LogOutputChannel): Promise<vscode.Uri | undefined> {
    const xml = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    const { text, warnings, layout } = importSct(xml);
    const target = uri.with({ path: uri.path.replace(/\.sct$/i, '') + '.devm' });
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
        vscode.window.showWarningMessage(`Imported ${path.basename(uri.path)} with ${warnings.length} warning(s) – see the output 'Device Modeler'.`, 'Show Output')
            .then(choice => choice && output.show());
    } else {
        vscode.window.showInformationMessage(`Imported ${path.basename(uri.path)} as ${path.basename(target.path)}`
            + (layout ? ' (with the arrangement of the itemis diagram).' : '.'));
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
