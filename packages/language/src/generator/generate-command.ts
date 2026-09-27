import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { HsmModelLoader } from '../hsm-document.js';
import { createHsmServices } from '../hsm-module.js';
import {
    GENERATOR_CONFIG_FILE, GENERATOR_TARGETS, generateTarget, globToRegExp, isGlob, parseGeneratorConfig, targetConfigForModel,
    type CppTargetConfig, type CTargetConfig, type GeneratorConfig, type GeneratorTarget, type ModelEntry, type TargetConfig
} from './config.js';

/*
 * Node side of the generator configuration (`hsm generate`): loading `hsm.gen.json`, expanding the
 * model globs, running the generators and writing (or checking) the files. Not exported from
 * `index.ts` because the web bundle imports it.
 */

export interface GenerateDiagnostic {
    severity: 'error' | 'warning';
    message: string;
    /** File the diagnostic refers to (a model or the configuration). */
    file?: string;
    line?: number;
    column?: number;
}

export interface LoadedGeneratorConfig {
    config?: GeneratorConfig;
    /** Absolute path of the configuration file. */
    file: string;
    diagnostics: GenerateDiagnostic[];
}

/** Loads and validates a configuration file; `licenseHeaderFile`s are read into `licenseHeader`. */
export async function loadGeneratorConfig(file: string): Promise<LoadedGeneratorConfig> {
    const absolute = path.resolve(file);
    let text: string;
    try {
        text = await fs.readFile(absolute, 'utf-8');
    } catch {
        return { file: absolute, diagnostics: [{ severity: 'error', message: `cannot read the generator configuration ${file}`, file: absolute }] };
    }
    const parsed = parseGeneratorConfig(text);
    const diagnostics: GenerateDiagnostic[] = parsed.diagnostics.map(d => ({
        severity: d.severity,
        message: d.pointer ? `${d.pointer}: ${d.message}` : d.message,
        file: absolute
    }));
    const config = parsed.config;
    if (config) {
        const baseDir = path.dirname(absolute);
        const targetConfigs: Array<TargetConfig | undefined> = [config.cpp, config.c, ...config.models.flatMap(m => [m.cpp, m.c])];
        for (const options of targetConfigs) {
            if (options?.licenseHeaderFile !== undefined) {
                const licenseFile = path.resolve(baseDir, options.licenseHeaderFile);
                try {
                    options.licenseHeader = await fs.readFile(licenseFile, 'utf-8');
                    options.licenseHeaderFile = licenseFile;
                } catch {
                    diagnostics.push({ severity: 'error', message: `cannot read the license header file ${options.licenseHeaderFile}`, file: absolute });
                }
            }
        }
    }
    const hasErrors = diagnostics.some(d => d.severity === 'error');
    return { config: hasErrors ? undefined : config, file: absolute, diagnostics };
}

/** Directories skipped when expanding `**`. */
const SKIPPED_DIRECTORIES = new Set(['node_modules']);

/**
 * Expands a model path or glob relative to `baseDir` into absolute, sorted file paths. Globs support
 * `*`, `?` and `**` (hidden directories and `node_modules` are not searched).
 */
export async function expandModelPath(baseDir: string, pattern: string): Promise<string[]> {
    const normalized = pattern.replace(/\\/g, '/');
    if (!isGlob(normalized)) {
        const file = path.resolve(baseDir, normalized);
        try {
            return (await fs.stat(file)).isFile() ? [file] : [];
        } catch {
            return [];
        }
    }
    const segments = normalized.split('/');
    const firstGlob = segments.findIndex(segment => isGlob(segment));
    const root = path.resolve(baseDir, segments.slice(0, firstGlob).join('/') || '.');
    const regExp = globToRegExp(segments.slice(firstGlob).join('/'));
    const recursive = segments.slice(firstGlob).length > 1 || normalized.includes('**');
    const matches: string[] = [];
    const walk = async (directory: string, relative: string) => {
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (recursive && !entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) {
                    await walk(path.join(directory, entry.name), entryRelative);
                }
            } else if (regExp.test(entryRelative)) {
                matches.push(path.join(directory, entry.name));
            }
        }
    };
    await walk(root, '');
    return matches.sort();
}

export interface GenerationRequest {
    config: GeneratorConfig;
    /** Directory the relative paths of the configuration are resolved against. */
    baseDir: string;
    /** Only these targets (default: all configured targets). */
    targets?: GeneratorTarget[];
    /** Overrides the output directory of all targets (absolute or relative to the current directory). */
    outDir?: string;
    /** Options overriding the configuration of every target (e.g. from the command line). */
    overrides?: CppTargetConfig & CTargetConfig;
    /** `write`: writes the files; `check`: only compares them with the files on disk. */
    mode: 'write' | 'check';
}

export type OutputStatus = 'written' | 'unchanged' | 'up-to-date' | 'stale' | 'missing';

export interface GeneratedOutput {
    /** Absolute path. */
    file: string;
    target: GeneratorTarget;
    /** Absolute path of the model (the first one for shared files like `sc_statemachine.h`). */
    model: string;
    status: OutputStatus;
}

export interface GenerationResult {
    outputs: GeneratedOutput[];
    /** The models (absolute paths). */
    models: string[];
    diagnostics: GenerateDiagnostic[];
}

/**
 * Runs the generators of a configuration: resolves the models, generates every configured target
 * and writes the files (only the changed ones if `writeOnlyIfChanged`), or checks whether the files on
 * disk are up to date. Nothing is written if there are errors.
 */
export async function runGeneration(request: GenerationRequest): Promise<GenerationResult> {
    const { config, baseDir } = request;
    const diagnostics: GenerateDiagnostic[] = [];
    const targets = GENERATOR_TARGETS.filter(target => config[target] !== undefined && (!request.targets || request.targets.includes(target)));
    for (const target of request.targets ?? []) {
        if (config[target] === undefined) {
            diagnostics.push({ severity: 'error', message: `target '${target}' is not configured` });
        }
    }

    // models and the entries matching them, in configuration order
    const models = new Map<string, ModelEntry[]>();
    for (const entry of config.models) {
        const files = await expandModelPath(baseDir, entry.path);
        if (files.length === 0) {
            diagnostics.push({ severity: 'error', message: isGlob(entry.path) ? `'${entry.path}' matches no model` : `model '${entry.path}' not found` });
        }
        for (const file of files) {
            models.set(file, [...(models.get(file) ?? []), entry]);
        }
    }

    const loader = new HsmModelLoader(createHsmServices(NodeFileSystem));
    const contents = new Map<string, { content: string, target: GeneratorTarget, model: string }>();
    for (const [model, entries] of models) {
        const text = await fs.readFile(model, 'utf-8');
        const parsed = await loader.load(text, pathToFileURL(model).toString());
        let errors = 0;
        for (const d of parsed.diagnostics) {
            if (d.severity === 1 || d.severity === 2) {
                errors += d.severity === 1 ? 1 : 0;
                diagnostics.push({
                    severity: d.severity === 1 ? 'error' : 'warning',
                    message: typeof d.message === 'string' ? d.message : d.message.value,
                    file: model,
                    line: d.range.start.line + 1,
                    column: d.range.start.character + 1
                });
            }
        }
        if (errors > 0 || parsed.hasSyntaxErrors) {
            continue;
        }
        for (const target of targets) {
            const options = { ...targetConfigForModel(config, target, entries), ...definedValues(request.overrides) } as TargetConfig;
            const outDir = request.outDir !== undefined
                ? path.resolve(request.outDir)
                : options.outDir !== undefined ? path.resolve(baseDir, options.outDir) : path.dirname(model);
            const result = generateTarget(parsed.model, target, options);
            for (const d of result.diagnostics) {
                diagnostics.push({ severity: d.severity, message: `${target}: ${d.message}`, file: model, line: d.line });
            }
            if (result.files.length === 0 && !result.diagnostics.some(d => d.severity === 'error')) {
                diagnostics.push({ severity: 'error', message: `${target}: nothing generated`, file: model });
            }
            for (const generated of result.files) {
                const file = path.join(outDir, generated.path);
                const existing = contents.get(file);
                if (existing && existing.content !== generated.content) {
                    diagnostics.push({
                        severity: 'error',
                        message: `${file} is generated with different contents from ${existing.model} (${existing.target}) and ${model} (${target}); use different output directories, class names or prefixes`,
                        file: model
                    });
                } else if (!existing) {
                    contents.set(file, { content: generated.content, target, model });
                }
            }
        }
    }

    const outputs: GeneratedOutput[] = [];
    const hasErrors = diagnostics.some(d => d.severity === 'error');
    for (const [file, generated] of contents) {
        const current = await readIfExists(file);
        let status: OutputStatus;
        if (request.mode === 'check' || hasErrors) {
            status = current === undefined ? 'missing' : current === generated.content ? 'up-to-date' : 'stale';
        } else if (config.writeOnlyIfChanged && current === generated.content) {
            status = 'unchanged';
        } else {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, generated.content);
            status = 'written';
        }
        outputs.push({ file, target: generated.target, model: generated.model, status });
    }
    return { outputs, models: [...models.keys()], diagnostics };
}

function definedValues<T extends object>(values: T | undefined): Partial<T> {
    return Object.fromEntries(Object.entries(values ?? {}).filter(([, value]) => value !== undefined)) as Partial<T>;
}

async function readIfExists(file: string): Promise<string | undefined> {
    try {
        return await fs.readFile(file, 'utf-8');
    } catch {
        return undefined;
    }
}

export interface GenerateCommandOptions {
    config?: string;
    out?: string;
    namespace?: string;
    className?: string;
    std?: string;
    prefix?: string;
    check?: boolean;
    listOutputs?: boolean;
    listInputs?: boolean;
    outputsFile?: string;
}

/**
 * `hsm generate [target] [files...]`: without files, the models and options come from the
 * generator configuration (`--config`, default `hsm.gen.json` in the current directory); with files,
 * the given models are generated for the target (with the options of `--config` if given).
 * Returns the exit code.
 */
export async function runGenerateCommand(target: string | undefined, files: string[], options: GenerateCommandOptions): Promise<number> {
    const fail = (message: string) => {
        console.error(message);
        return 1;
    };
    if (target !== undefined && target !== 'cpp' && target !== 'c') {
        return fail(`Unknown target '${target}' (supported: cpp, c)`);
    }
    if (options.std !== undefined && options.std !== '11' && options.std !== '17') {
        return fail(`Unsupported C++ standard '${options.std}' (supported: 17, 11)`);
    }
    if (files.length > 0 && target === undefined) {
        return fail('A target (cpp or c) is required when model files are given');
    }

    let config: GeneratorConfig;
    let baseDir = process.cwd();
    const configDiagnostics: GenerateDiagnostic[] = [];
    let configFile: string | undefined;
    if (options.config !== undefined || files.length === 0) {
        configFile = path.resolve(options.config ?? GENERATOR_CONFIG_FILE);
        if (options.config === undefined && await readIfExists(configFile) === undefined) {
            return fail(`No ${GENERATOR_CONFIG_FILE} in ${process.cwd()}: pass a configuration with --config <file> or a target and model files (hsm generate cpp model.hsm)`);
        }
        const loaded = await loadGeneratorConfig(configFile);
        configDiagnostics.push(...loaded.diagnostics);
        if (!loaded.config) {
            printDiagnostics(configDiagnostics);
            return 1;
        }
        config = loaded.config;
        baseDir = path.dirname(loaded.file);
    } else {
        config = { models: [], writeOnlyIfChanged: true };
    }
    if (files.length > 0) {
        // the given models replace the models of the configuration; paths relative to the current directory
        config = { ...config, models: files.map(file => ({ path: path.resolve(file) })) };
        if (target && config[target] === undefined) {
            config = { ...config, [target]: {} };
        }
    }

    const result = await runGeneration({
        config,
        baseDir,
        targets: target ? [target] : undefined,
        outDir: options.out,
        overrides: {
            namespace: options.namespace,
            className: options.className,
            std: options.std === undefined ? undefined : options.std === '11' ? 11 : 17,
            prefix: options.prefix
        },
        mode: options.check || options.listOutputs || options.listInputs ? 'check' : 'write'
    });
    printDiagnostics([...configDiagnostics, ...result.diagnostics]);
    const hasErrors = result.diagnostics.some(d => d.severity === 'error');
    if (hasErrors) {
        return 1;
    }
    if (options.listOutputs || options.listInputs) {
        if (options.listInputs) {
            for (const input of [...(configFile ? [configFile] : []), ...result.models, ...licenseFiles(config)]) {
                console.log(input.replace(/\\/g, '/'));
            }
        }
        if (options.listOutputs) {
            for (const output of result.outputs) {
                console.log(output.file.replace(/\\/g, '/'));
            }
        }
        return 0;
    }
    const display = displayPath;
    if (options.check) {
        const outdated = result.outputs.filter(output => output.status !== 'up-to-date');
        for (const output of outdated) {
            console.error(`${output.status === 'missing' ? 'Missing' : 'Out of date'}: ${display(output.file)} (from ${display(output.model)})`);
        }
        console.log(outdated.length === 0
            ? `All ${result.outputs.length} generated files are up to date`
            : `${outdated.length} of ${result.outputs.length} generated files are out of date; run hsm generate`);
        return outdated.length === 0 ? 0 : 1;
    }
    for (const output of result.outputs) {
        console.log(`${output.status === 'written' ? 'Generated' : 'Unchanged'} ${display(output.file)}`);
    }
    if (options.outputsFile !== undefined) {
        return checkOutputsFile(options.outputsFile, result.outputs.map(output => output.file));
    }
    return 0;
}

/**
 * Compares the outputs with the list the build system knows (`--outputs-file`, written by CMake at
 * configure time). If they differ (e.g. a state machine was renamed), the list is updated – which
 * makes CMake re-run on the next build – and 1 is returned.
 */
async function checkOutputsFile(file: string, outputs: string[]): Promise<number> {
    const expected = ((await readIfExists(file)) ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line);
    const normalize = (list: string[]) => list.map(entry => path.resolve(entry)).sort().join('\n');
    if (normalize(expected) === normalize(outputs)) {
        return 0;
    }
    await fs.writeFile(file, outputs.map(output => output.replace(/\\/g, '/')).join('\n') + '\n');
    console.error(`The set of generated files changed (${file}); CMake has to be re-run: build again.`);
    return 1;
}

function licenseFiles(config: GeneratorConfig): string[] {
    const files = [config.cpp, config.c, ...config.models.flatMap(m => [m.cpp, m.c])]
        .map(options => options?.licenseHeaderFile)
        .filter((file): file is string => file !== undefined);
    return [...new Set(files)];
}

function printDiagnostics(diagnostics: GenerateDiagnostic[]): void {
    for (const d of diagnostics) {
        const location = d.file ? `${displayPath(d.file)}:${d.line !== undefined ? `${d.line}:${d.column !== undefined ? `${d.column}:` : ''}` : ''} ` : '';
        console.error(`${location}${d.severity}: ${d.message}`);
    }
}

/** A path relative to the current directory if it is inside it, otherwise the absolute path. */
function displayPath(file: string): string {
    const relative = path.relative(process.cwd(), file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}
