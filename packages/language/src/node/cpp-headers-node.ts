import * as fs from 'node:fs';
import * as path from 'node:path';
import { URI, type LangiumSharedCoreServices } from 'langium';
import { cppHeaderStore, type CppHeaderSettings } from '../cpp-headers.js';
import type { CppDataModel } from '../cpp-header/model.js';
import { parseHeaderConfig, type HeaderConfig } from '../generator/config.js';

/**
 * Node.js hosts of C/C++ header imports (the CLI and the language server of the VS Code extension):
 * headers are read synchronously from the file system when a model is linked, the settings come
 * from the `headers` block of the nearest generator configuration (`hsm.gen.json` or
 * `<name>.hsm.gen.json` in the directory of the model or a parent directory) and from the command
 * line (`-I`, `-D`, `--data-model`) or the VS Code settings (`hsm.headers.*`). Not exported from the
 * package index (the web app bundles the index).
 */

const CONFIG_FILE = /^(hsm\.gen\.json|.+\.hsm\.gen\.json)$/;

/** The settings of a `headers` block: include paths resolved relative to the directory of the configuration. */
export function headerSettingsFromConfig(headers: HeaderConfig, configDir: string): CppHeaderSettings {
    return {
        includePaths: (headers.includePaths ?? []).map(dir => URI.file(path.resolve(configDir, dir)).toString()),
        defines: headers.defines,
        dataModel: headers.dataModel
    };
}

/** Finds (and caches) the nearest configuration file with a `headers` block above a directory. */
export class HeaderConfigFinder {

    private readonly cache = new Map<string, { file: string, settings: CppHeaderSettings } | null>();

    /** `root`: the search stops at this directory (default: the file system root). */
    constructor(private readonly root?: string) { }

    /** The configuration for a model in `directory` (`undefined` if there is none). */
    find(directory: string): { file: string, settings: CppHeaderSettings } | undefined {
        const resolved = path.resolve(directory);
        const cached = this.cache.get(resolved);
        if (cached !== undefined) {
            return cached ?? undefined;
        }
        let result: { file: string, settings: CppHeaderSettings } | null = null;
        let entries: string[] = [];
        try {
            entries = fs.readdirSync(resolved).filter(name => CONFIG_FILE.test(name)).sort();
        } catch {
            // not readable: continue with the parent
        }
        for (const entry of entries) {
            const file = path.join(resolved, entry);
            let headers: HeaderConfig | undefined;
            try {
                headers = parseHeaderConfig(fs.readFileSync(file, 'utf-8'));
            } catch {
                headers = undefined;
            }
            if (headers) {
                result = { file, settings: headerSettingsFromConfig(headers, resolved) };
                break;
            }
        }
        const parent = path.dirname(resolved);
        if (!result && parent !== resolved && (!this.root || resolved !== path.resolve(this.root))) {
            result = this.find(parent) ?? null;
        }
        this.cache.set(resolved, result);
        return result ?? undefined;
    }

    /** Forgets the cached configurations (after a configuration file changed). */
    clear(): void {
        this.cache.clear();
    }
}

export interface NodeHeaderOptions {
    /** Global settings (CLI `-I` / `-D` / `--data-model`, VS Code settings); include paths absolute or as file URIs. */
    settings?: CppHeaderSettings;
    /** Whether the `headers` block of the nearest `hsm.gen.json` applies (default true). */
    configs?: boolean;
    /** The directory at which the search for configuration files stops. */
    root?: string;
}

/**
 * Installs the Node.js header support in the header store of the services: a synchronous file reader
 * and the settings of configuration files. Returns the configuration finder (to clear its cache when
 * configuration files change).
 */
export function installNodeHeaderSupport(shared: LangiumSharedCoreServices, options: NodeHeaderOptions = {}): HeaderConfigFinder {
    const store = cppHeaderStore(shared);
    store.reader = uri => {
        if (uri.scheme !== 'file') {
            return undefined;
        }
        try {
            return fs.statSync(uri.fsPath).isFile() ? fs.readFileSync(uri.fsPath, 'utf-8') : undefined;
        } catch {
            return undefined;
        }
    };
    store.lister = uri => {
        if (uri.scheme !== 'file') {
            return undefined;
        }
        try {
            return fs.readdirSync(uri.fsPath, { withFileTypes: true }).map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name);
        } catch {
            return undefined;
        }
    };
    const finder = new HeaderConfigFinder(options.root);
    store.updateSettings(normalizeSettings(options.settings ?? {}));
    if (options.configs ?? true) {
        store.settingsProvider = uri => uri.scheme === 'file' ? finder.find(path.dirname(uri.fsPath))?.settings : undefined;
    }
    return finder;
}

/** Include paths as file URIs (absolute or relative to the current directory). */
export function normalizeSettings(settings: CppHeaderSettings, baseDir = process.cwd()): CppHeaderSettings {
    return {
        ...settings,
        includePaths: (settings.includePaths ?? []).map(dir => /^[a-zA-Z][\w+.-]+:\/\//.test(dir) ? dir : URI.file(path.resolve(baseDir, dir)).toString())
    };
}

/** `-D NAME` / `-D NAME=VALUE` (like a compiler: `NAME` alone is `1`). */
export function parseDefines(list: readonly string[] | undefined): Record<string, string> {
    const defines: Record<string, string> = {};
    for (const item of list ?? []) {
        const match = /^([A-Za-z_]\w*)(?:=(.*))?$/.exec(item.trim());
        if (!match) {
            throw new Error(`invalid macro definition '${item}' (expected NAME or NAME=VALUE)`);
        }
        defines[match[1]] = match[2] ?? '1';
    }
    return defines;
}

/** The data models of `--data-model`: `lp64` (Linux / macOS 64-bit), `llp64` (Windows 64-bit), `ilp32` (32-bit targets, e.g. ARM Cortex-M). */
export function dataModelNamed(name: string | undefined): Partial<CppDataModel> | undefined {
    switch (name?.toLowerCase()) {
        case undefined:
            return undefined;
        case 'lp64':
            return { longBits: 64, pointerBits: 64 };
        case 'llp64':
            return { longBits: 32, pointerBits: 64 };
        case 'ilp32':
            return { longBits: 32, pointerBits: 32 };
        default:
            throw new Error(`unknown data model '${name}' (expected lp64, llp64 or ilp32)`);
    }
}

/** The VS Code settings `hsm.headers.*`. */
export interface HeaderSettingsSection {
    includePaths?: string[];
    defines?: Record<string, string | number>;
    dataModel?: string;
}

/** The header settings of the VS Code settings `hsm.headers.*`: include paths relative to the workspace folder (`${workspaceFolder}` supported). */
export function headerSettingsFromSection(section: HeaderSettingsSection | undefined, workspaceFolder: string | undefined): CppHeaderSettings {
    const base = workspaceFolder ?? process.cwd();
    let dataModel: Partial<CppDataModel> | undefined;
    try {
        dataModel = dataModelNamed(section?.dataModel || undefined);
    } catch {
        dataModel = undefined;
    }
    return normalizeSettings({
        includePaths: (section?.includePaths ?? []).map(dir => dir.split('${workspaceFolder}').join(base)),
        defines: Object.fromEntries(Object.entries(section?.defines ?? {}).map(([name, value]) => [name, String(value)])),
        dataModel
    }, base);
}

/**
 * The effective header settings for a model: the `headers` block of the nearest configuration file
 * combined with global settings (like `CppHeaderStore.settingsFor`).
 */
export function headerSettingsForModel(modelPath: string, finder: HeaderConfigFinder, global: CppHeaderSettings = {}): CppHeaderSettings {
    const own = finder.find(path.dirname(path.resolve(modelPath)))?.settings;
    if (!own) {
        return global;
    }
    return {
        includePaths: [...own.includePaths ?? [], ...global.includePaths ?? []],
        defines: { ...own.defines, ...global.defines },
        dataModel: { ...own.dataModel, ...global.dataModel }
    };
}

/** The settings of the CLI options `-I`, `-D`, `--data-model`. */
export function cliHeaderSettings(options: { include?: string[], define?: string[], dataModel?: string }): CppHeaderSettings {
    return normalizeSettings({
        includePaths: options.include ?? [],
        defines: parseDefines(options.define),
        dataModel: dataModelNamed(options.dataModel)
    });
}
