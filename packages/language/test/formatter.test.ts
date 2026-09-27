import { describe, expect, test } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { loader, parse } from './helpers.js';

describe('formatter', () => {
    test('formats nested states', async () => {
        const text = 'statemachine M{interface: in event e var g:boolean operation x():void [*]->A state A{entry/x() state A1} A->A:e[g]/x()}';
        const parsed = await parse(text);
        const edits = await loader.services.Hsm.lsp.Formatter!.formatDocument(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() },
            options: { tabSize: 4, insertSpaces: true }
        });
        const formatted = TextDocument.applyEdits(parsed.document.textDocument, edits);
        expect(formatted).toBe(`statemachine M {
    interface:
        in event e
        var g : boolean
        operation x() : void
    [*] -> A
    state A {
        entry / x()
        state A1
    }
    A -> A : e [g] / x()
}`);
    });

    test('formats imports and submachine states', async () => {
        const text = 'statemachine M{import  "motor.hsm"\nimport:"a.hsm"   "b.h" internal: var motor:Motor [*]->A state A:motor{entry/raise motor.start}}';
        const parsed = await parse(text, { 'motor.hsm': 'statemachine Motor {\n    interface:\n        in event start\n}', 'a.hsm': 'statemachine A {}' });
        const edits = await loader.services.Hsm.lsp.Formatter!.formatDocument(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() },
            options: { tabSize: 4, insertSpaces: true }
        });
        const formatted = TextDocument.applyEdits(parsed.document.textDocument, edits);
        expect(formatted).toBe(`statemachine M {
    import "motor.hsm"
    import: "a.hsm" "b.h"
    internal:
        var motor : Motor
    [*] -> A
    state A : motor {
        entry / raise motor.start
    }
}`);
    });
});
