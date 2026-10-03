import { describe, expect, test } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { loader, parse } from './helpers.js';

describe('formatter', () => {
    test('formats nested states', async () => {
        const text = 'statemachine M{interface: in event e var g:boolean operation x():void [*]->A state A{entry/x() state A1} A->A:e[g]/x()}';
        const parsed = await parse(text);
        const edits = await loader.services.Devm.lsp.Formatter!.formatDocument(parsed.document, {
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

    test('indents doc comments of declarations like the declarations', async () => {
        const text = 'statemachine M {\n    interface:\n        in event a\n    /** Doc of b. */\n        in event b\n            // line comment\n        var x : integer\n    internal:\n/** Doc of y. */\n        var y : integer\n}';
        const parsed = await parse(text);
        const edits = await loader.services.Devm.lsp.Formatter!.formatDocument(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() },
            options: { tabSize: 4, insertSpaces: true }
        });
        const formatted = TextDocument.applyEdits(parsed.document.textDocument, edits);
        expect(formatted).toBe(`statemachine M {
    interface:
        in event a
        /** Doc of b. */
        in event b
        // line comment
        var x : integer
    internal:
        /** Doc of y. */
        var y : integer
}`);
    });

    test('formats imports and submachine states', async () => {
        const text = 'statemachine M{import  "motor.devm"\nimport:"a.devm"   "b.h" internal: var motor:Motor [*]->A state A:motor{entry/raise motor.start}}';
        const parsed = await parse(text, { 'motor.devm': 'statemachine Motor {\n    interface:\n        in event start\n}', 'a.devm': 'statemachine A {}' });
        const edits = await loader.services.Devm.lsp.Formatter!.formatDocument(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() },
            options: { tabSize: 4, insertSpaces: true }
        });
        const formatted = TextDocument.applyEdits(parsed.document.textDocument, edits);
        expect(formatted).toBe(`statemachine M {
    import "motor.devm"
    import: "a.devm" "b.h"
    internal:
        var motor : Motor
    [*] -> A
    state A : motor {
        entry / raise motor.start
    }
}`);
    });

    test('formats C++ names and member accesses', async () => {
        const text = 'statemachine M{import "t.h" interface: var m:t :: Mode var p : t::P [*]->A state A A->A:always[m==t :: Mode :: B]/p . x=t::kP . y}';
        const parsed = await parse(text, { 't.h': 'namespace t { enum class Mode { A, B }; struct P { int x; int y; }; constexpr P kP{1, 2}; }' });
        const edits = await loader.services.Devm.lsp.Formatter!.formatDocument(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() },
            options: { tabSize: 4, insertSpaces: true }
        });
        const formatted = TextDocument.applyEdits(parsed.document.textDocument, edits);
        expect(formatted).toBe(`statemachine M {
    import "t.h"
    interface:
        var m : t::Mode
        var p : t::P
    [*] -> A
    state A
    A -> A : always [m==t::Mode::B] / p.x=t::kP.y
}`);
    });
});
