import { monaco } from './monaco.js';
import { HsmModelLoader, HsmMonarchSyntax, type ParsedModel } from 'hsm-language';
import type { Diagnostic, Range, TextEdit } from 'vscode-languageserver-types';

export const LANGUAGE_ID = 'hsm';
const DOCUMENT_URI = 'memory:///model.hsm';

/**
 * Runs the Langium services of the HSM language directly in the browser and connects them
 * to the Monaco editor (validation markers, completion, formatting, go to definition, rename).
 */
export class HsmLanguageSupport {

    readonly loader = new HsmModelLoader();
    private latest?: ParsedModel;
    private queue: Promise<unknown> = Promise.resolve();

    /** Parses, links and validates the text. Calls are serialized. */
    parse(text: string): Promise<ParsedModel> {
        const result = this.queue.then(async () => {
            if (this.latest?.text === text) {
                return this.latest;
            }
            const parsed = await this.loader.load(text, DOCUMENT_URI);
            this.latest = parsed;
            return parsed;
        });
        this.queue = result.catch(() => undefined);
        return result;
    }

    private async document(model: monaco.editor.ITextModel) {
        return (await this.parse(model.getValue())).document;
    }

    registerLanguage(): void {
        monaco.languages.register({ id: LANGUAGE_ID, extensions: ['.hsm'], aliases: ['HSM', 'hsm'] });
        monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, HsmMonarchSyntax as monaco.languages.IMonarchLanguage);
        monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
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

        const services = this.loader.services.Hsm;

        monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
            triggerCharacters: ['>', ' ', '/'],
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

        monaco.languages.registerDocumentFormattingEditProvider(LANGUAGE_ID, {
            provideDocumentFormattingEdits: async (model, options) => {
                const document = await this.document(model);
                const edits = await services.lsp.Formatter?.formatDocument(document, {
                    textDocument: { uri: document.uri.toString() },
                    options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces }
                });
                return (edits ?? []).map(toMonacoEdit);
            }
        });

        monaco.languages.registerDefinitionProvider(LANGUAGE_ID, {
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

        monaco.languages.registerReferenceProvider(LANGUAGE_ID, {
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

        monaco.languages.registerRenameProvider(LANGUAGE_ID, {
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
