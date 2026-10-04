import { AstUtils, GrammarUtils, type LangiumDocument, type MaybePromise } from 'langium';
import type { CodeActionProvider } from 'langium/lsp';
import { CodeActionKind, type CodeAction, type Command, type Diagnostic, type TextEdit } from 'vscode-languageserver-types';
import * as ast from '../generated/ast.js';
import { importPaths } from '../imports.js';
import { INCOMPLETE_CPP_TYPE, UNKNOWN_CPP_TYPE, type UnknownCppTypeData } from '../cpp-unknown-types.js';

type CodeActionParams = Parameters<CodeActionProvider['getCodeActions']>[1];

/**
 * Quick fixes of the state machine files, shared by the VS Code language server and the web app: an unknown
 * C++ type of a class section (see cpp-unknown-types.ts) is fixed by importing the header that declares
 * it (`import "driver.h"`, `import "<vector>"`), a type that is only forward-declared by importing the
 * header that defines it.
 */
export class DevmCodeActionProvider implements CodeActionProvider {

    getCodeActions(document: LangiumDocument, params: CodeActionParams): MaybePromise<Array<Command | CodeAction> | undefined> {
        const actions: CodeAction[] = [];
        const seen = new Set<string>();
        for (const diagnostic of params.context.diagnostics) {
            const action = importCodeAction(document, diagnostic);
            if (action && !seen.has(action.title)) {
                seen.add(action.title);
                actions.push(action);
            }
        }
        return actions;
    }
}

/** The quick fix of a diagnostic of an unknown or only forward-declared C++ type: import the header that declares (defines) it. */
export function importCodeAction(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
    const data = diagnostic.data as UnknownCppTypeData | undefined;
    if ((diagnostic.code !== UNKNOWN_CPP_TYPE && diagnostic.code !== INCOMPLETE_CPP_TYPE) || !data?.importPath) {
        return undefined;
    }
    const offset = document.textDocument.offsetAt(diagnostic.range.start);
    const root = document.parseResult.value;
    const machine = AstUtils.streamAst(root).filter(ast.isStateMachine)
        .find(m => m.$cstNode !== undefined && m.$cstNode.offset <= offset && offset <= m.$cstNode.end);
    if (!machine || importPaths(machine).some(p => p.path === data.importPath)) {
        return undefined;
    }
    const edit = importEdit(document, machine, data.importPath);
    if (!edit) {
        return undefined;
    }
    return {
        title: `Import "${data.importPath}"`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: { changes: { [document.textDocument.uri]: [edit] } }
    };
}

/** Inserts `import "path"` after the last import of the machine (else after the namespace or the opening brace). */
function importEdit(document: LangiumDocument, machine: ast.StateMachine, path: string): TextEdit | undefined {
    const text = document.textDocument.getText();
    const indentOf = (offset: number) => /^[ \t]*/.exec(text.substring(text.lastIndexOf('\n', offset - 1) + 1))![0];
    const line = `import "${path}"`;
    const last = machine.imports[machine.imports.length - 1]?.$cstNode;
    const cst = machine.$cstNode;
    if (!cst) {
        return undefined;
    }
    const anchor = last ?? GrammarUtils.findNodeForProperty(cst, 'namespace');
    if (anchor) {
        const position = document.textDocument.positionAt(anchor.end);
        return { range: { start: position, end: position }, newText: `\n${indentOf(anchor.offset)}${line}` };
    }
    const brace = GrammarUtils.findNodeForKeyword(cst, '{');
    if (!brace) {
        return undefined;
    }
    const position = document.textDocument.positionAt(brace.end);
    return { range: { start: position, end: position }, newText: `\n${indentOf(cst.offset)}    ${line}` };
}
