import { describe, expect, test } from 'vitest';
import { SemanticTokenTypes } from 'vscode-languageserver-types';
import { definitionLinks, declarationLinks, importLinks, navigationLinks, typeDefinitionLinks } from '../src/lsp/model-navigation.js';
import { ModelSemanticTokenProvider } from '../src/lsp/semantic-tokens.js';
import { hoverSignature, ModelHoverProvider } from '../src/lsp/model-hover.js';
import { errors, loader, parse } from './helpers.js';

/** Navigation and semantic highlighting of the web app's Monaco editor (lsp/model-navigation.ts, lsp/semantic-tokens.ts). */

const MOTOR = `statemachine Motor {
    interface:
        in event start
    [*] -> Off
    state Off
}
`;

const HEADER = `#pragma once
namespace hw {
enum class Mode { Slow, Fast };
}
`;

const MODEL = `statemachine Gate {
    import "motor.devm"
    import "hw.h"
    interface:
        in event open
        var mode : hw::Mode = hw::Mode::Fast
    internal:
        var motor : Motor
    [*] -> Closed
    state Closed
    state Moving : motor
    Closed -> Moving : open / raise motor.start
}
`;

const FILES = { 'motor.devm': MOTOR, 'hw.h': HEADER };

async function model() {
    const parsed = await parse(MODEL, FILES);
    expect(errors(parsed)).toEqual([]);
    return parsed.document;
}

const services = loader.services.Devm;

function text(source: string, range: { start: { line: number, character: number }, end: { line: number, character: number } }): string {
    return source.split('\n')[range.start.line].slice(range.start.character, range.end.character);
}

/** The decoded semantic tokens of a document: [text, type]. */
async function semanticTokens(document: Awaited<ReturnType<typeof parse>>['document'], source: string): Promise<Array<[string, string]>> {
    const provider = new ModelSemanticTokenProvider(services);
    const types = Object.keys(provider.tokenTypes);
    const data = (await provider.semanticHighlight(document, { textDocument: { uri: document.uri.toString() } })).data;
    const tokens: Array<[string, string]> = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i < data.length; i += 5) {
        line += data[i];
        character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
        tokens.push([source.split('\n')[line].slice(character, character + data[i + 2]), types[data[i + 3]]]);
    }
    return tokens;
}

describe('navigation of the web app editor', () => {
    test('definition: into the header (segment origin), to the imported state machine, within the model', async () => {
        const document = await model();
        const fast = await definitionLinks(services, document, MODEL.indexOf('hw::Mode::Fast') + 11);
        expect(fast).toHaveLength(1);
        expect(fast[0].uri).toMatch(/hw\.h$/);
        expect(text(HEADER, fast[0].selection)).toBe('Fast');
        expect(text(MODEL, fast[0].origin)).toBe('Fast');

        const machine = await definitionLinks(services, document, MODEL.indexOf(': Motor') + 3);
        expect(machine[0].uri).toMatch(/motor\.devm$/);
        expect(text(MOTOR, machine[0].selection)).toBe('Motor');
        expect(text(MODEL, machine[0].origin)).toBe('Motor');

        const imported = await definitionLinks(services, document, MODEL.indexOf('"motor.devm"') + 2);
        expect(imported[0].uri).toMatch(/motor\.devm$/);

        const header = await definitionLinks(services, document, MODEL.indexOf('"hw.h"') + 2);
        expect(header[0].uri).toMatch(/hw\.h$/);
        expect(header[0].selection.start.line).toBe(0);

        const event = await definitionLinks(services, document, MODEL.indexOf('Closed -> Moving : open') + 20);
        expect(event[0].uri).toBe(document.uri.toString());
        expect(text(MODEL, event[0].selection)).toBe('open');
        expect(text(MODEL, event[0].origin)).toBe('open');

        expect(await definitionLinks(services, document, MODEL.indexOf('interface:'))).toEqual([]);
    });

    test('declaration and type definition', async () => {
        const document = await model();
        const declarations = await declarationLinks(services, document, MODEL.indexOf('hw::Mode =') + 5);
        expect(declarations.map(d => text(HEADER, d.selection))).toContain('Mode');
        const type = typeDefinitionLinks(services, document, MODEL.indexOf('var mode') + 5);
        expect(type).toHaveLength(1);
        expect(text(HEADER, type[0].selection)).toBe('Mode');
        expect(text(MODEL, type[0].origin)).toBe('mode');
        const instance = await navigationLinks(services, document, MODEL.indexOf('var motor') + 5, 'typeDefinition');
        expect(instance[0].uri).toMatch(/motor\.devm$/);
    });

    test('links of the import paths', async () => {
        const document = await model();
        expect(importLinks(document).map(link => [text(MODEL, link.range), link.kind, link.target.replace(/^.*\//, '')])).toEqual([
            ['"motor.devm"', 'model', 'motor.devm'],
            ['"hw.h"', 'header', 'hw.h']
        ]);
    });

    test('semantic tokens: C++ names and references by kind', async () => {
        const tokens = await semanticTokens(await model(), MODEL);
        expect(tokens).toContainEqual(['hw::Mode', SemanticTokenTypes.enum]);
        expect(tokens).toContainEqual(['hw::Mode::Fast', SemanticTokenTypes.enumMember]);
        expect(tokens).toContainEqual(['Gate', SemanticTokenTypes.class]);
        expect(tokens).toContainEqual(['open', SemanticTokenTypes.event]);
        expect(tokens).toContainEqual(['Closed', SemanticTokenTypes.type]);
    });

    test('semantic tokens: undeclared C++ types of class sections are types', async () => {
        const controller = 'statemachine Controller {\n    import "hw.h"\n    private:\n        var driver : hal::Driver&\n    [*] -> A\n    state A\n}\n';
        const parsed = await parse(controller, FILES);
        expect(await semanticTokens(parsed.document, controller)).toContainEqual(['hal::Driver', SemanticTokenTypes.type]);
    });

    test('hover: signature and documentation, C++ declarations', async () => {
        const document = await model();
        const hover = new ModelHoverProvider(services);
        const at = (search: string, delta: number) => ({ textDocument: { uri: document.uri.toString() }, position: document.textDocument.positionAt(MODEL.indexOf(search) + delta) });
        const event = await hover.getHoverContent(document, at('in event open', 10));
        expect((event?.contents as { value: string }).value).toContain('```devm\ninterface: in event open\n```');
        const cpp = await hover.getHoverContent(document, at('hw::Mode::Fast', 11));
        expect((cpp?.contents as { value: string }).value).toContain('Fast');
        expect(hoverSignature(document.parseResult.value)).toBe('statemachine Gate');
    });
});
