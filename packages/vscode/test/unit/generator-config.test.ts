import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseGeneratorConfig } from 'devm-language';
import {
    generationFromConfig, generationFromSettings, isGeneratorConfigFile, matchingEntries, resolveGeneration, resolveOutputDirectory, type CppSettings
} from '../../src/extension/logic/generator-config.js';
import { runGeneration } from '../../../language/src/generator/generate-command.js';

const settings: CppSettings = { outputDirectory: '', namespace: null, standard: '17' };
const MODEL = 'statemachine Lamp {\n    interface:\n        in event toggle\n    [*] -> Off\n    state Off\n    state On\n    Off -> On : toggle\n    On -> Off : toggle\n}\n';

function config(value: unknown) {
    const parsed = parseGeneratorConfig(value);
    expect(parsed.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    return parsed.config!;
}

describe('generator configuration files', () => {
    it('recognizes devm.gen.json and <name>.devm.gen.json', () => {
        expect(isGeneratorConfigFile('devm.gen.json')).toBe(true);
        expect(isGeneratorConfigFile('firmware.devm.gen.json')).toBe(true);
        expect(isGeneratorConfigFile('package.json')).toBe(false);
        expect(isGeneratorConfigFile('devm.gen.json.bak')).toBe(false);
    });

    it('matches models by path and glob relative to the configuration', () => {
        const c = config({ models: ['models/*.devm', { path: './legacy/door.devm', cpp: { namespace: 'legacy' } }, 'other/**/*.devm'], cpp: {} });
        const dir = path.resolve('/work');
        expect(matchingEntries(c, dir, '/work/models/lamp.devm').map(e => e.path)).toEqual(['models/*.devm']);
        expect(matchingEntries(c, dir, '/work/legacy/door.devm').map(e => e.path)).toEqual(['./legacy/door.devm']);
        expect(matchingEntries(c, dir, '/work/other/a/b/x.devm').map(e => e.path)).toEqual(['other/**/*.devm']);
        expect(matchingEntries(c, dir, '/work/models/sub/lamp.devm')).toEqual([]);
        expect(matchingEntries(c, dir, '/elsewhere/models/lamp.devm')).toEqual([]);
    });

    it('generates only the model with the merged options of its entries', () => {
        const c = config({ models: ['*.devm', { path: 'door.devm', cpp: { namespace: 'legacy' } }], cpp: { outDir: 'gen', std: 11 } });
        const resolved = generationFromConfig(c, path.resolve('/work/devm.gen.json'), '/work/door.devm')!;
        expect(resolved.baseDir).toBe(path.resolve('/work'));
        expect(resolved.config.models).toEqual([{ path: path.resolve('/work/door.devm'), cpp: undefined }, { path: path.resolve('/work/door.devm'), cpp: { namespace: 'legacy' } }]);
        expect(resolved.config.cpp).toEqual({ outDir: 'gen', std: 11 });
        expect(resolved.config.c).toBeUndefined();
    });

    it('ignores configurations without the model or without the C++ target', () => {
        expect(generationFromConfig(config({ models: ['a.devm'], cpp: {} }), '/work/devm.gen.json', '/work/b.devm')).toBeUndefined();
        expect(generationFromConfig(config({ models: ['b.devm'], c: {} }), '/work/devm.gen.json', '/work/b.devm')).toBeUndefined();
    });
});

describe('settings', () => {
    it('resolves the output directory relative to the model', () => {
        expect(resolveOutputDirectory('/w/models/a.devm', '', '/w')).toBe(path.resolve('/w/models'));
        expect(resolveOutputDirectory('/w/models/a.devm', 'gen', '/w')).toBe(path.resolve('/w/models/gen'));
        expect(resolveOutputDirectory('/w/models/a.devm', '${workspaceFolder}/src-gen', '/w')).toBe(path.resolve('/w/src-gen'));
        expect(resolveOutputDirectory('/w/models/a.devm', '/abs/out', '/w')).toBe(path.resolve('/abs/out'));
    });

    it('maps the settings to a configuration', () => {
        const resolved = generationFromSettings('/w/a.devm', { outputDirectory: 'gen', namespace: 'app::sm', standard: '11' }, '/w');
        expect(resolved.config.cpp).toEqual({ outDir: path.resolve('/w/gen'), namespace: 'app::sm', std: 11 });
        expect(generationFromSettings('/w/a.devm', settings, '/w').config.cpp?.namespace).toBeUndefined();
        expect(generationFromSettings('/w/a.devm', { ...settings, namespace: '' }, '/w').config.cpp?.namespace).toBe('');
    });
});

describe('resolveGeneration', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devm-vscode-'));
        await fs.mkdir(path.join(dir, 'models'));
        await fs.writeFile(path.join(dir, 'models/lamp.devm'), MODEL);
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('falls back to the settings without configuration file', async () => {
        const resolved = await resolveGeneration(path.join(dir, 'models/lamp.devm'), settings, dir);
        expect(resolved.configFile).toBeUndefined();
        expect(resolved.config.cpp?.outDir).toBe(path.join(dir, 'models'));
    });

    it('uses a configuration file in a parent directory and generates like devm generate', async () => {
        await fs.writeFile(path.join(dir, 'devm.gen.json'), JSON.stringify({
            models: ['models/*.devm'], cpp: { outDir: 'src-gen', namespace: 'app', headerExtension: '.hpp', licenseHeader: 'Copyright ACME' }
        }));
        const model = path.join(dir, 'models/lamp.devm');
        const resolved = await resolveGeneration(model, settings, dir);
        expect(resolved.configFile).toBe(path.join(dir, 'devm.gen.json'));
        const result = await runGeneration({ config: resolved.config, baseDir: resolved.baseDir, targets: ['cpp'], mode: 'write' });
        expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        expect(result.outputs.map(o => path.relative(dir, o.file)).sort()).toEqual(['src-gen/Lamp.cpp', 'src-gen/Lamp.hpp', 'src-gen/sc_statemachine.hpp']);
        const source = await fs.readFile(path.join(dir, 'src-gen/Lamp.cpp'), 'utf-8');
        expect(source).toContain('Copyright ACME');
        expect(source).toContain('#include "Lamp.hpp"');
        expect(source).toContain('namespace app');
    });

    it('skips configuration files with errors and reports them', async () => {
        await fs.writeFile(path.join(dir, 'models/devm.gen.json'), '{ "models": ["*.devm"], "cpp": { "std": 14 } }');
        const resolved = await resolveGeneration(path.join(dir, 'models/lamp.devm'), settings, dir);
        expect(resolved.configFile).toBeUndefined();
        expect(resolved.diagnostics.some(d => d.severity === 'error' && d.file === path.join(dir, 'models/devm.gen.json'))).toBe(true);
    });

    it('does not search above the workspace folder', async () => {
        await fs.writeFile(path.join(dir, 'devm.gen.json'), JSON.stringify({ models: ['models/*.devm'], cpp: {} }));
        const resolved = await resolveGeneration(path.join(dir, 'models/lamp.devm'), settings, path.join(dir, 'models'));
        expect(resolved.configFile).toBeUndefined();
    });
});
