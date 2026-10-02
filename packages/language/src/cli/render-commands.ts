import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { NodeFileSystem } from 'langium/node';
import type { EdgeRouting, LayoutDirection } from '../diagram/diagram-model.js';
import { EDGE_ROUTINGS, parseEdgeRouting } from '../diagram/edge-routes.js';
import { layoutStateMachineWithLayout } from '../diagram/manual-layout.js';
import { describeStateMachine, generateDocIndex, generateModelDoc, type DocFormat, type DocIndexEntry } from '../doc/model-doc.js';
import type { StateMachine } from '../generated/ast.js';
import { HsmModelLoader } from '../hsm-document.js';
import { createHsmServices } from '../hsm-module.js';
import { installNodeHeaderSupport } from '../node/cpp-headers-node.js';
import { DIAGRAM_THEMES, renderSvg, type DiagramTheme } from '../render/svg.js';

/*
 * Commands `hsm render` (diagrams as SVG files) and `hsm doc` (documentation pages).
 */

export interface DiagramCommandOptions {
    theme?: string;
    direction?: string;
    routing?: string;
    /** Show transition priorities (default: true). */
    priorities?: boolean;
    /** Lay out automatically, ignoring the layout annotations of the models (default: false). */
    auto?: boolean;
}

export interface RenderCommandOptions extends DiagramCommandOptions {
    /** Output file (single model, `.svg`) or directory. */
    out?: string;
    format?: string;
}

export interface DocCommandOptions extends DiagramCommandOptions {
    /** Output directory (default: `docs`). */
    out?: string;
    format?: string;
    /** Title of the index page. */
    title?: string;
}

interface Logger {
    log(message: string): void;
    error(message: string): void;
}

const consoleLogger: Logger = {
    log: message => console.log(message),
    error: message => console.error(message)
};

const severities = ['', 'error', 'warning', 'info', 'hint'];

interface LoadedModel {
    file: string;
    model: StateMachine;
}

/**
 * Loads the models; prints their problems. Models with syntax errors are skipped (and counted as
 * failures), validation errors are reported but the models are still rendered.
 */
async function loadModels(files: string[], logger: Logger): Promise<{ models: LoadedModel[], failures: number }> {
    const services = createHsmServices(NodeFileSystem);
    // imported C/C++ headers: read from the file system, settings of the nearest hsm.gen.json
    installNodeHeaderSupport(services.shared);
    const loader = new HsmModelLoader(services);
    const models: LoadedModel[] = [];
    let failures = 0;
    for (const file of files) {
        let text: string;
        try {
            text = await fs.readFile(file, 'utf-8');
        } catch (error) {
            logger.error(`${file}: ${error instanceof Error ? error.message : error}`);
            failures++;
            continue;
        }
        const parsed = await loader.load(text, `file://${path.resolve(file)}`);
        for (const d of parsed.diagnostics.filter(d => d.severity === 1)) {
            logger.error(`${file}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${severities[d.severity ?? 1]}: ${d.message}`);
        }
        if (parsed.hasSyntaxErrors || !parsed.model?.name) {
            logger.error(`${file}: skipped (syntax errors)`);
            failures++;
            continue;
        }
        models.push({ file, model: parsed.model });
    }
    return { models, failures };
}

function diagramOptions(options: DiagramCommandOptions): { theme: DiagramTheme, direction: LayoutDirection, routing: EdgeRouting, priorities: boolean, auto: boolean } {
    const theme = (options.theme ?? 'classic').toLowerCase();
    if (!DIAGRAM_THEMES.includes(theme as DiagramTheme)) {
        throw new Error(`Unknown theme '${options.theme}' (supported: ${DIAGRAM_THEMES.join(', ')})`);
    }
    const direction = (options.direction ?? 'DOWN').toUpperCase();
    if (direction !== 'DOWN' && direction !== 'RIGHT') {
        throw new Error(`Unknown direction '${options.direction}' (supported: DOWN, RIGHT)`);
    }
    const routing = parseEdgeRouting(options.routing ?? 'SPLINES');
    if (!routing) {
        throw new Error(`Unknown routing '${options.routing}' (supported: ${EDGE_ROUTINGS.map(r => r.value).join(', ')})`);
    }
    return { theme: theme as DiagramTheme, direction, routing, priorities: options.priorities ?? true, auto: options.auto ?? false };
}

async function renderModel(model: StateMachine, options: ReturnType<typeof diagramOptions>, xmlDeclaration = true): Promise<string> {
    // the layout annotations of the model (manual layout) unless `auto`
    const { graph } = await layoutStateMachineWithLayout(model, { direction: options.direction, routing: options.routing, priorities: options.priorities },
        options.auto ? null : undefined);
    return renderSvg(graph, { theme: options.theme, xmlDeclaration });
}

/** `hsm render`: renders the diagrams of the given models (files, directories or glob patterns) as SVG files. Returns the exit code. */
export async function runRenderCommand(patterns: string[], options: RenderCommandOptions, logger: Logger = consoleLogger): Promise<number> {
    let settings: ReturnType<typeof diagramOptions>;
    try {
        settings = diagramOptions(options);
        const format = (options.format ?? 'svg').toLowerCase();
        if (format !== 'svg') {
            throw new Error(`Unsupported format '${options.format}' (supported: svg)`);
        }
    } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        return 2;
    }
    const files = await expandFiles(patterns);
    if (files.length === 0) {
        logger.error(`No .hsm files found: ${patterns.join(' ')}`);
        return 1;
    }
    const { models, failures } = await loadModels(files, logger);
    const single = files.length === 1 && options.out?.toLowerCase().endsWith('.svg');
    for (const { file, model } of models) {
        const svg = await renderModel(model, settings);
        const out = single ? options.out!
            : path.join(options.out ?? path.dirname(file), path.basename(file).replace(/\.hsm$/i, '') + '.svg');
        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, svg);
        logger.log(`Rendered ${out}`);
    }
    return failures > 0 ? 1 : 0;
}

/** `hsm doc`: writes a documentation page per state machine plus an index page. Returns the exit code. */
export async function runDocCommand(patterns: string[], options: DocCommandOptions, logger: Logger = consoleLogger): Promise<number> {
    let settings: ReturnType<typeof diagramOptions>;
    let format: DocFormat;
    try {
        settings = diagramOptions(options);
        const value = (options.format ?? 'md').toLowerCase();
        if (value !== 'md' && value !== 'html' && value !== 'markdown') {
            throw new Error(`Unsupported format '${options.format}' (supported: md, html)`);
        }
        format = value === 'html' ? 'html' : 'md';
    } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        return 2;
    }
    const files = await expandFiles(patterns);
    if (files.length === 0) {
        logger.error(`No .hsm files found: ${patterns.join(' ')}`);
        return 1;
    }
    const { models, failures } = await loadModels(files, logger);
    const outDir = options.out ?? 'docs';
    await fs.mkdir(outDir, { recursive: true });
    const index: DocIndexEntry[] = [];
    const usedNames = new Set<string>();
    const indexFile = `index.${format}`;
    for (const { file, model } of models) {
        let base = model.name;
        for (let i = 2; usedNames.has(base.toLowerCase()) || `${base}.${format}` === indexFile; i++) {
            base = `${model.name}-${i}`;
        }
        usedNames.add(base.toLowerCase());
        const doc = describeStateMachine(model);
        const source = toPosix(file);
        const sourceHref = toPosix(path.relative(outDir, file));
        const page = `${base}.${format}`;
        if (format === 'html') {
            const svg = await renderModel(model, settings, false);
            await fs.writeFile(path.join(outDir, page), generateModelDoc(doc, { format, svg, source, sourceHref, indexFile }));
        } else {
            const svgFile = `${base}.svg`;
            await fs.writeFile(path.join(outDir, svgFile), await renderModel(model, settings));
            await fs.writeFile(path.join(outDir, page), generateModelDoc(doc, { format, svgFile, source, sourceHref, indexFile }));
        }
        logger.log(`Generated ${path.join(outDir, page)}`);
        index.push({ name: model.name, file: page, description: doc.description, documentation: doc.documentation, source, sourceHref });
    }
    index.sort((a, b) => a.name.localeCompare(b.name));
    await fs.writeFile(path.join(outDir, indexFile), generateDocIndex(index, format, options.title));
    logger.log(`Generated ${path.join(outDir, indexFile)}`);
    return failures > 0 ? 1 : 0;
}

function toPosix(file: string): string {
    return file.split(path.sep).join('/');
}

/**
 * Expands the arguments into a sorted list of `.hsm` files: files are taken as they are, directories
 * are searched recursively and glob patterns (`*`, `?`, `**`) are matched against the file system
 * (for shells that do not expand them, e.g. on Windows or when quoted).
 */
export async function expandFiles(patterns: string[]): Promise<string[]> {
    const result: string[] = [];
    const add = (file: string) => {
        if (!result.includes(file)) {
            result.push(file);
        }
    };
    for (const pattern of patterns) {
        if (/[*?]/.test(pattern)) {
            const matches = await glob(pattern);
            matches.sort().forEach(add);
            continue;
        }
        const stat = await fs.stat(pattern).catch(() => undefined);
        if (stat?.isDirectory()) {
            (await walk(pattern)).filter(f => f.toLowerCase().endsWith('.hsm')).sort().forEach(add);
        } else {
            // missing files are reported when they are read
            add(pattern);
        }
    }
    return result;
}

async function walk(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
            continue;
        }
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await walk(file));
        } else if (entry.isFile()) {
            files.push(file);
        }
    }
    return files;
}

async function glob(pattern: string): Promise<string[]> {
    const normalized = pattern.replace(/\\/g, '/');
    const segments = normalized.split('/');
    // the longest prefix without wildcards is the directory to search
    let baseCount = 0;
    while (baseCount < segments.length - 1 && !/[*?]/.test(segments[baseCount])) {
        baseCount++;
    }
    const base = segments.slice(0, baseCount).join('/') || (normalized.startsWith('/') ? '/' : '.');
    const regex = globToRegExp(segments.slice(baseCount).join('/'));
    const files = await walk(base);
    return files.filter(file => regex.test(toPosix(path.relative(base, file))));
}

function globToRegExp(pattern: string): RegExp {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '*' && pattern[i + 1] === '*') {
            // `**/` matches any number of directories
            const slash = pattern[i + 2] === '/';
            source += slash ? '(?:.*/)?' : '.*';
            i += slash ? 2 : 1;
        } else if (char === '*') {
            source += '[^/]*';
        } else if (char === '?') {
            source += '[^/]';
        } else {
            source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`);
}

const ROUTING_HELP = `edge routing: ${EDGE_ROUTINGS.map(r => `${r.value} (${r.description})`).join(', ')}`;

/** Registers `render` and `doc` at the command line program. */
export function registerRenderCommands(program: Command): void {
    program.command('render')
        .argument('<files...>', '.hsm files, directories or glob patterns')
        .option('-o, --out <path>', 'output file (one model, *.svg) or directory (default: next to the model)')
        .option('-t, --theme <theme>', `diagram theme: ${DIAGRAM_THEMES.join(', ')}`, 'classic')
        .option('-d, --direction <direction>', 'layout direction: DOWN or RIGHT', 'DOWN')
        .option('-r, --routing <routing>', ROUTING_HELP, 'SPLINES')
        .option('--no-priorities', 'do not prefix transition labels with their priority')
        .option('--auto', 'lay out automatically, ignoring the layout annotations (@at, ...) of the models')
        .option('-f, --format <format>', 'output format (svg)', 'svg')
        .description('renders the diagrams of state machines as standalone SVG files')
        .action(async (files: string[], options: RenderCommandOptions) => {
            process.exitCode = await runRenderCommand(files, options);
        });

    program.command('doc')
        .argument('<files...>', '.hsm files, directories or glob patterns')
        .option('-o, --out <dir>', 'output directory', 'docs')
        .option('-f, --format <format>', 'md (Markdown + SVG files) or html (self-contained pages)', 'md')
        .option('-t, --theme <theme>', `diagram theme: ${DIAGRAM_THEMES.join(', ')}`, 'classic')
        .option('-d, --direction <direction>', 'layout direction: DOWN or RIGHT', 'DOWN')
        .option('-r, --routing <routing>', ROUTING_HELP, 'SPLINES')
        .option('--no-priorities', 'do not prefix transition labels with their priority')
        .option('--auto', 'lay out automatically, ignoring the layout annotations (@at, ...) of the models')
        .option('--title <title>', 'title of the index page', 'State machines')
        .description('generates documentation pages (diagram, interfaces, states, transitions, doc comments) and an index')
        .action(async (files: string[], options: DocCommandOptions) => {
            process.exitCode = await runDocCommand(files, options);
        });
}
