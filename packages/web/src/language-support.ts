import { monaco } from './monaco.js';
import { cppHover, DevmMonarchSyntax, isStructureText } from 'devm-language';
import type { HsmServices } from 'devm-language';
import { HsmModelService } from './model-service.js';
import type { Diagnostic, Range, TextEdit } from 'vscode-languageserver-types';

export { describeSyntaxProblem, type SyntaxProblem } from './model-service.js';

/** Language id of the model files of the Device Modeler (`.devm`: state machines and structure files). */
export const LANGUAGE_ID = 'devm';
export const EDITOR_THEMES = { light: 'devm-light', dark: 'devm-dark' } as const;

/**
 * Runs the Langium services of the `.devm` language directly in the browser and connects them
 * to the Monaco editor (validation markers, completion, formatting, go to definition, rename).
 */
export class HsmLanguageSupport extends HsmModelService {

    private async document(model: monaco.editor.ITextModel) {
        return isStructureText(model.getValue())
            ? (await this.parseStructure(model.getValue())).document
            : (await this.parse(model.getValue())).document;
    }

    registerLanguage(): void {
        monaco.languages.register({ id: LANGUAGE_ID, extensions: ['.devm'], aliases: ['Device Modeler', 'devm'] });
        monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, monarchSyntax(DevmMonarchSyntax, ['integer', 'real', 'boolean', 'string', 'void']));
        monaco.editor.defineTheme(EDITOR_THEMES.light, {
            base: 'vs', inherit: true, colors: {},
            rules: [
                { token: 'annotation', foreground: '9c5d00' },
                { token: 'type', foreground: '267f99' },
                { token: 'operator', foreground: '555555' }
            ]
        });
        monaco.editor.defineTheme(EDITOR_THEMES.dark, {
            base: 'vs-dark', inherit: true, colors: {},
            rules: [
                { token: 'annotation', foreground: 'dcdcaa' },
                { token: 'type', foreground: '4ec9b0' },
                { token: 'operator', foreground: 'c8c8c8' }
            ]
        });
        this.configureLanguage(LANGUAGE_ID);
        this.registerProviders(LANGUAGE_ID, this.loader.services.Hsm);
    }

    private configureLanguage(languageId: string): void {
        monaco.languages.setLanguageConfiguration(languageId, {
            comments: { lineComment: '//', blockComment: ['/*', '*/'] },
            brackets: [['{', '}'], ['[', ']']],
            autoClosingPairs: [
                { open: '{', close: '}' },
                { open: '[', close: ']' },
                { open: '"', close: '"', notIn: ['string', 'comment'] }
            ],
            surroundingPairs: [{ open: '{', close: '}' }, { open: '"', close: '"' }],
            indentationRules: {
                increaseIndentPattern: /^.*\{[^}"']*$/,
                decreaseIndentPattern: /^\s*\}/
            }
        });
    }

    /** Completion, hover, formatting, go to definition, references and rename with the Langium services of a language. */
    private registerProviders(languageId: string, services: HsmServices): void {
        monaco.languages.registerCompletionItemProvider(languageId, {
            triggerCharacters: ['>', ' ', '/', '.', '(', ':'],
            provideCompletionItems: async (model, position) => {
                const document = await this.document(model);
                const list = await services.lsp.CompletionProvider?.getCompletion(document, {
                    textDocument: { uri: document.uri.toString() },
                    position: { line: position.lineNumber - 1, character: position.column - 1 }
                });
                const word = model.getWordUntilPosition(position);
                const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
                return {
                    suggestions: (list?.items ?? []).map(item => {
                        const edit = item.textEdit && 'range' in item.textEdit ? item.textEdit : undefined;
                        return {
                            label: item.label,
                            kind: completionKind(item.kind),
                            detail: item.detail,
                            documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
                            sortText: item.sortText,
                            filterText: item.filterText,
                            insertText: edit?.newText ?? item.insertText ?? item.label,
                            insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                            range: edit ? toMonacoRange(edit.range) : defaultRange
                        };
                    })
                };
            }
        });

        monaco.languages.registerHoverProvider(languageId, {
            provideHover: async (model, position) => {
                const document = await this.document(model);
                const offset = model.getOffsetAt(position);
                // C++ names of imported headers: declaration, value and documentation of the header
                const cpp = cppHover(document, offset);
                const hover = cpp ? { contents: { kind: 'markdown', value: cpp } } : await services.lsp.HoverProvider?.getHoverContent(document, {
                    textDocument: { uri: document.uri.toString() },
                    position: { line: position.lineNumber - 1, character: position.column - 1 }
                });
                const contents = hover?.contents;
                const value = typeof contents === 'string' ? contents : contents && 'value' in contents ? contents.value : undefined;
                return value ? { contents: [{ value }] } : undefined;
            }
        });

        monaco.languages.registerDocumentFormattingEditProvider(languageId, {
            provideDocumentFormattingEdits: async (model, options) => {
                const document = await this.document(model);
                const edits = await services.lsp.Formatter?.formatDocument(document, {
                    textDocument: { uri: document.uri.toString() },
                    options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces }
                });
                return (edits ?? []).map(toMonacoEdit);
            }
        });

        monaco.languages.registerDefinitionProvider(languageId, {
            provideDefinition: async (model, position) => {
                const document = await this.document(model);
                const links = await services.lsp.DefinitionProvider?.getDefinition(document, {
                    textDocument: { uri: document.uri.toString() },
                    position: { line: position.lineNumber - 1, character: position.column - 1 }
                });
                return (links ?? []).map(link => ({
                    uri: model.uri,
                    range: toMonacoRange(link.targetSelectionRange)
                }));
            }
        });

        monaco.languages.registerReferenceProvider(languageId, {
            provideReferences: async (model, position, context) => {
                const document = await this.document(model);
                const locations = await services.lsp.ReferencesProvider?.findReferences(document, {
                    textDocument: { uri: document.uri.toString() },
                    position: { line: position.lineNumber - 1, character: position.column - 1 },
                    context
                });
                return (locations ?? []).map(location => ({ uri: model.uri, range: toMonacoRange(location.range) }));
            }
        });

        monaco.languages.registerRenameProvider(languageId, {
            provideRenameEdits: async (model, position, newName) => {
                const document = await this.document(model);
                const edit = await services.lsp.RenameProvider?.rename(document, {
                    textDocument: { uri: document.uri.toString() },
                    position: { line: position.lineNumber - 1, character: position.column - 1 },
                    newName
                });
                const edits = Object.values(edit?.changes ?? {}).flat();
                return {
                    edits: edits.map(e => ({
                        resource: model.uri,
                        versionId: model.getVersionId(),
                        textEdit: toMonacoEdit(e)
                    }))
                };
            }
        });
    }

    /** Shows the diagnostics of the language services as markers in the editor. */
    static setMarkers(model: monaco.editor.ITextModel, diagnostics: Diagnostic[]): void {
        monaco.editor.setModelMarkers(model, LANGUAGE_ID, diagnostics.map(d => ({
            severity: markerSeverity(d.severity),
            message: typeof d.message === 'string' ? d.message : d.message.value,
            startLineNumber: d.range.start.line + 1,
            startColumn: d.range.start.character + 1,
            endLineNumber: d.range.end.line + 1,
            endColumn: d.range.end.character + 1
        })));
    }
}

type MonarchRule = { regex?: RegExp, include?: string, action?: { token?: string, cases?: Record<string, { token: string }> } };

/**
 * The generated Monarch grammar, adjusted for nicer highlighting: numbers, annotations (`@EventDriven`),
 * built-in type names and the `[*]` pseudo state.
 */
function monarchSyntax(syntax: object, typeNames: string[]): monaco.languages.IMonarchLanguage {
    const generated = syntax as unknown as { tokenizer: Record<string, MonarchRule[]> };
    const rename: Record<string, string> = { HEX: 'number.hex', REAL: 'number.float', ID: 'identifier' };
    const initial = generated.tokenizer.initial.map((rule): MonarchRule => {
        const action = rule.action;
        if (action?.token && rename[action.token]) {
            return { ...rule, action: { ...action, token: rename[action.token] } };
        }
        if (action?.cases?.['@default']?.token === 'ID') {
            return {
                ...rule,
                action: { cases: { '@keywords': { token: 'keyword' }, '@typeNames': { token: 'type' }, '@default': { token: 'identifier' } } }
            };
        }
        return rule;
    });
    return {
        ...syntax,
        typeNames,
        tokenizer: {
            ...generated.tokenizer,
            initial: [
                { regex: /@[_a-zA-Z]\w*/, action: { token: 'annotation' } },
                { regex: /\[\*\]/, action: { token: 'keyword' } },
                ...initial
            ]
        }
    } as unknown as monaco.languages.IMonarchLanguage;
}

function toMonacoRange(range: Range): monaco.IRange {
    return new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
}

function toMonacoEdit(edit: TextEdit): monaco.languages.TextEdit {
    return { range: toMonacoRange(edit.range), text: edit.newText };
}

function markerSeverity(severity: number | undefined): monaco.MarkerSeverity {
    switch (severity) {
        case 1: return monaco.MarkerSeverity.Error;
        case 2: return monaco.MarkerSeverity.Warning;
        case 3: return monaco.MarkerSeverity.Info;
        default: return monaco.MarkerSeverity.Hint;
    }
}

function completionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
    const k = monaco.languages.CompletionItemKind;
    switch (kind) {
        case 14: return k.Keyword;
        case 7: return k.Class;
        case 6: return k.Variable;
        case 15: return k.Snippet;
        case 18: return k.Reference;
        default: return k.Text;
    }
}
