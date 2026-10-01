import * as fs from 'node:fs';
import * as path from 'node:path';
import { AstUtils, type AstNode } from 'langium';
import { describe, expect, test } from 'vitest';
import * as ast from '../src/generated/ast.js';
import { generateCpp } from '../src/generator/cpp/index.js';
import { cppContextCompletionItems, cppHover } from '../src/lsp/cpp-lsp.js';
import { scenarioFiles, scenarioText, validateScenario } from '../src/simulation/index.js';
import { errors, loader, parse } from './helpers.js';

/**
 * Features used together: members of the C++ class sections whose types are C++ enums of an imported
 * header, documented with Doxygen comments (model and header). The model is the one of the scenario
 * `s10-cpp-class-section-enum-doc`, whose generated C++ code is compiled and run by
 * test/cpp-generator.test.ts.
 */

const scenario = validateScenario(JSON.parse(fs.readFileSync(path.resolve(__dirname, 'scenarios/s10-cpp-class-section-enum-doc.json'), 'utf-8')), 'scenario');
const MODEL = scenarioText(scenario)!;
const FILES = scenarioFiles(scenario);

function declaration(model: ast.StateMachine, name: string): AstNode {
    return AstUtils.streamAllContents(model).find(n => (ast.isVariableDeclaration(n) || ast.isOperationDeclaration(n)) && n.name === name)!;
}

describe('C++ class sections with C++ enums and Doxygen comments', () => {
    test('the model is valid', async () => {
        expect(errors(await parse(MODEL, FILES))).toEqual([]);
    });

    test('hover of class section members: C++ types as written, Doxygen rendered', async () => {
        const parsed = await parse(MODEL, FILES);
        const provider = loader.services.Hsm.documentation.DocumentationProvider;
        expect(provider.getDocumentation(declaration(parsed.model, 'mode'))).toBe(
            '```hsm\nvar mode : dev::Mode = dev::Mode::Off\n```\n\nThe current mode.\n\n**Note:** Changed by `select` only.');
        const next = provider.getDocumentation(declaration(parsed.model, 'next'))!;
        expect(next).toContain('```hsm\nconst operation next(current : dev::Mode) : dev::Mode\n```');
        expect(next).toContain('**Parameters:**\n- `current` — the current mode');
        expect(next).not.toMatch(/@brief|@param|@return/);
        expect(provider.getDocumentation(declaration(parsed.model, 'changes'))).toBe('```hsm\nvar changes : unsigned int\n```');
    });

    test('hover of the enums and enumerators of the header: Doxygen rendered', async () => {
        const { document } = await parse(MODEL, FILES);
        const text = document.textDocument.getText();
        const mode = cppHover(document, text.indexOf('dev::Mode =') + 'dev::'.length)!;
        expect(mode).toContain('enum class dev::Mode : std::uint8_t');
        expect(mode).toContain('Operating mode of the device.\n\n**Note:** The values are sent to the hardware.');
        expect(mode).not.toContain('@brief');
        const off = cppHover(document, text.indexOf('dev::Mode::Off') + 'dev::Mode::'.length)!;
        expect(off).toContain('dev::Mode::Off = 0');
        expect(off).toContain('switched off');
        expect(off).not.toContain('@brief');
        const state = cppHover(document, text.indexOf('dev::Device::State') + 'dev::Device::'.length)!;
        expect(state).toContain('States of a device.');
    });

    test('completion of a class section member of enum type proposes the enumerators with rendered documentation', async () => {
        const source = MODEL.replace('/ mode = dev::Mode::Off;', '/ mode = |;');
        const { document } = await parse(source.replace('|', ''), FILES);
        const items = cppContextCompletionItems(document, source.indexOf('|'));
        expect(items.map(i => i.label)).toEqual(['dev::Mode::Off', 'dev::Mode::Slow', 'dev::Mode::Fast']);
        expect(items.map(i => i.documentation)).toEqual([
            { kind: 'markdown', value: 'switched off' },
            { kind: 'markdown', value: 'slow, see `Fast`' },
            { kind: 'markdown', value: 'fast' }
        ]);
        const unscoped = MODEL.replace('status = dev::Device::Busy;', 'status = |;');
        const parsed = await parse(unscoped.replace('|', ''), FILES);
        expect(cppContextCompletionItems(parsed.document, unscoped.indexOf('|')).map(i => i.label)).toEqual(['dev::Device::Idle', 'dev::Device::Busy']);
    });

    test('the generated class keeps the Doxygen comments verbatim', async () => {
        const parsed = await parse(MODEL, FILES);
        const result = generateCpp(parsed.model);
        expect(result.diagnostics).toEqual([]);
        const header = result.files.find(f => f.path === 'M.h')!.content;
        expect(header).toContain([
            '    /**',
            '     * @brief The next mode after @p current.',
            '     * @param current the current mode',
            '     * @return the next mode',
            '     */',
            '    virtual dev::Mode next(dev::Mode current) const;'
        ].join('\n'));
        expect(header).toContain([
            '    /**',
            '     * @brief The current mode.',
            '     * @note Changed by @c select only.',
            '     */',
            '    dev::Mode mode = dev::Mode::Off;'
        ].join('\n'));
        expect(header).toContain('    dev::Device::State status = dev::Device::Idle;');
    });
});
