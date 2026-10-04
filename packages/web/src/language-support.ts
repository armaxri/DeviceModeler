import { monaco } from './monaco.js';
import { conf as cppConfiguration, language as cppMonarchSyntax } from 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js';
import {
    cppHover, DOC_COMMENT_RULES, DOC_COMMENT_START, HsmMonarchSyntax, importKind, importLinks, ModelSemanticTokenProvider, navigationLinks,
    type CppNavigationKind, type NavigationLink
} from 'hsm-language';
import { HsmModelService } from './model-service.js';
import type { Diagnostic, Range, TextEdit } from 'vscode-languageserver-types';

export { describeSyntaxProblem, type SyntaxProblem } from './model-service.js';

export const LANGUAGE_ID = 'hsm';
export const CPP_LANGUAGE_ID = 'cpp';
export const EDITOR_THEMES = { light: 'hsm-light', dark: 'hsm-dark' } as const;
/**
 * Scheme of the URIs of the other files of the workspace (`memory:///include/motor.h`): the language
 * services resolve imports against them, and the Monaco models of navigation targets (peek, Ctrl+hover
 * preview, file viewer) have these URIs. The edited model has Monaco's own URI.
 */
export const WORKSPACE_SCHEME = 'memory';

/**
 * Colors of the semantic tokens (as VS Code's Light+ / Dark+ themes show the semantic tokens of the language
 * server): Monaco matches the token type followed by its modifiers (`variable.declaration.readonly`).
 */
function semanticRules(dark: boolean): monaco.editor.ITokenThemeRule[] {
    const type = dark ? '4ec9b0' : '267f99';
    const constant = dark ? '4fc1ff' : '0070c1';
    const variable = dark ? '9cdcfe' : '001080';
    const fn = dark ? 'dcdcaa' : '795e26';
    return [
        ...['class', 'enum', 'struct', 'interface', 'namespace', 'typeParameter'].map(token => ({ token, foreground: type })),
        { token: 'enumMember', foreground: constant },
        { token: 'variable', foreground: variable },
        { token: 'variable.readonly', foreground: constant },
        { token: 'variable.declaration.readonly', foreground: constant },
        { token: 'parameter', foreground: variable },
        { token: 'function', foreground: fn },
        { token: 'method', foreground: fn }
    ];
}

/** Monaco location links of navigation targets; `uri`: the Monaco URI of a target (the edited model for its own document). */
export function toMonacoLinks(links: readonly NavigationLink[], uri: (target: string) => monaco.Uri): monaco.languages.LocationLink[] {
    return links.map(link => ({
        uri: uri(link.uri),
        range: toMonacoRange(link.range),
        targetSelectionRange: toMonacoRange(link.selection),
        originSelectionRange: toMonacoRange(link.origin)
    }));
}

/**
 * Runs the Langium services of the HSM language directly in the browser and connects them
 * to the Monaco editor (validation markers, completion, formatting, go to definition, rename).
 */
export class HsmLanguageSupport extends HsmModelService {

    /** The links of the last navigation (see {@link targetSelection}). */
    private recentLinks: monaco.languages.LocationLink[] = [];

    /**
     * The whole name a navigation leads to: Monaco opens other files with the start of the target only, the
     * hosts select the name of the declaration (`Mode` of `enum class Mode`).
     */
    targetSelection(uri: monaco.Uri, range: monaco.IRange): monaco.IRange {
        const link = this.recentLinks.find(l => l.uri.toString() === uri.toString() && l.targetSelectionRange
            && monaco.Position.equals(monaco.Range.getStartPosition(l.targetSelectionRange), monaco.Range.getStartPosition(range)));
        return link?.targetSelectionRange && monaco.Range.isEmpty(range) ? link.targetSelectionRange : range;
    }

    /** The Monaco models of the other files of the workspace that were navigation targets, by URI of the file. */
    private readonly workspaceModels = new Map<string, monaco.editor.ITextModel>();

    override setWorkspace(...args: Parameters<HsmModelService['setWorkspace']>): void {
        super.setWorkspace(...args);
        // the models of navigation targets follow the texts of their files
        for (const [uri, model] of this.workspaceModels) {
            const text = this.fileText(uri);
            if (text === undefined || model.isDisposed()) {
                model.dispose();
                this.workspaceModels.delete(uri);
            } else if (text !== model.getValue()) {
                model.setValue(text);
            }
        }
    }

    private async document(model: monaco.editor.ITextModel) {
        return (await this.parse(model.getValue())).document;
    }

    registerLanguage(): void {
        monaco.languages.register({ id: LANGUAGE_ID, extensions: ['.hsm'], aliases: ['HSM', 'hsm'] });
        monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, monarchSyntax());
        monaco.editor.defineTheme(EDITOR_THEMES.light, {
            base: 'vs', inherit: true, colors: {},
            rules: [
                { token: 'annotation', foreground: '9c5d00' },
                { token: 'type', foreground: '267f99' },
                { token: 'operator', foreground: '555555' },
                // Doxygen / JSDoc commands in documentation comments (colors of VS Code's Light+ theme)
                { token: 'comment.doc.tag', foreground: '0000ff', fontStyle: 'bold' },
                { token: 'comment.doc.param', foreground: '001080' },
                { token: 'comment.doc.code', foreground: 'a31515' },
                ...semanticRules(false)
            ]
        });
        monaco.editor.defineTheme(EDITOR_THEMES.dark, {
            base: 'vs-dark', inherit: true, colors: {},
            rules: [
                { token: 'annotation', foreground: 'dcdcaa' },
                { token: 'type', foreground: '4ec9b0' },
                { token: 'operator', foreground: 'c8c8c8' },
                // Doxygen / JSDoc commands in documentation comments (colors of VS Code's Dark+ theme)
                { token: 'comment.doc.tag', foreground: '569cd6', fontStyle: 'bold' },
                { token: 'comment.doc.param', foreground: '9cdcfe' },
                { token: 'comment.doc.code', foreground: 'ce9178' },
                ...semanticRules(true)
            ]
        });
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

        // C/C++ headers (navigation targets: peek, file viewer) with the Monarch grammar of Monaco
        monaco.languages.register({ id: CPP_LANGUAGE_ID, extensions: ['.h', '.hh', '.hpp', '.hxx', '.inl'], aliases: ['C++', 'cpp'] });
        monaco.languages.setMonarchTokensProvider(CPP_LANGUAGE_ID, cppMonarchSyntax);
        monaco.languages.setLanguageConfiguration(CPP_LANGUAGE_ID, cppConfiguration);

        const services = this.loader.services.Hsm;

        monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
            triggerCharacters: ['>', ' ', '/', '.', '(', ':'],
            provideCompletionItems: async (model, position) => {
                if (!isEditedModel(model)) {
                    return undefined;
                }
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
                            // the label description shows e.g. the values of enumerators (`= 3 (0x3)`)
                            label: item.labelDetails?.description ? { label: item.label, description: item.labelDetails.description } : item.label,
                            kind: completionKind(item.kind),
                            detail: item.detail,
                            documentation: typeof item.documentation === 'string' || !item.documentation ? item.documentation
                                : item.documentation.kind === 'markdown' ? { value: item.documentation.value } : item.documentation.value,
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

        monaco.languages.registerHoverProvider(LANGUAGE_ID, {
            provideHover: async (model, position) => {
                if (!isEditedModel(model)) {
                    return undefined;
                }
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

        monaco.languages.registerDocumentFormattingEditProvider(LANGUAGE_ID, {
            provideDocumentFormattingEdits: async (model, options) => {
                if (!isEditedModel(model)) {
                    return undefined;
                }
                const document = await this.document(model);
                const edits = await services.lsp.Formatter?.formatDocument(document, {
                    textDocument: { uri: document.uri.toString() },
                    options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces }
                });
                return (edits ?? []).map(toMonacoEdit);
            }
        });

        // go to definition / declaration / type definition (also into the imported headers and models, see
        // lsp/model-navigation.ts of the language package) and the links of import paths
        const navigation = (kind: CppNavigationKind) => async (model: monaco.editor.ITextModel, position: monaco.Position) => {
            if (!isEditedModel(model)) {
                return undefined;
            }
            const document = await this.document(model);
            const links = toMonacoLinks(await navigationLinks(services, document, model.getOffsetAt(position), kind), uri => this.targetUri(uri, model));
            this.recentLinks = links;
            return links;
        };
        monaco.languages.registerDefinitionProvider(LANGUAGE_ID, { provideDefinition: navigation('definition') });
        monaco.languages.registerDeclarationProvider(LANGUAGE_ID, { provideDeclaration: navigation('declaration') });
        monaco.languages.registerTypeDefinitionProvider(LANGUAGE_ID, { provideTypeDefinition: navigation('typeDefinition') });
        monaco.languages.registerLinkProvider(LANGUAGE_ID, {
            provideLinks: async model => {
                if (!isEditedModel(model)) {
                    return undefined;
                }
                const document = await this.document(model);
                return {
                    links: importLinks(document).map(link => ({
                        range: toMonacoRange(link.range),
                        url: this.targetUri(link.target, model),
                        tooltip: link.kind === 'header' ? 'Open header' : 'Open state machine'
                    }))
                };
            }
        });

        // semantic highlighting (C++ names of the headers, states, events, variables, …), as in VS Code
        const semanticTokens = new ModelSemanticTokenProvider(services);
        const legend = semanticTokens.semanticTokensOptions.legend;
        monaco.languages.registerDocumentSemanticTokensProvider(LANGUAGE_ID, {
            getLegend: () => legend,
            provideDocumentSemanticTokens: async model => {
                if (!isEditedModel(model)) {
                    return null;
                }
                const document = await this.document(model);
                const tokens = await semanticTokens.semanticHighlight(document, { textDocument: { uri: document.uri.toString() } });
                return { data: new Uint32Array(tokens.data) };
            },
            releaseDocumentSemanticTokens: () => undefined
        });

        // quick fixes (the import of the header declaring an unknown C++ type of a class section)
        monaco.languages.registerCodeActionProvider(LANGUAGE_ID, {
            provideCodeActions: async (model, range) => {
                if (!isEditedModel(model)) {
                    return { actions: [], dispose: () => undefined };
                }
                const parsed = await this.parse(model.getValue());
                const diagnostics = parsed.diagnostics.filter(d => d.code !== undefined
                    && monaco.Range.areIntersectingOrTouching(toMonacoRange(d.range), range));
                if (diagnostics.length === 0) {
                    return { actions: [], dispose: () => undefined };
                }
                const actions = await services.lsp.CodeActionProvider?.getCodeActions(parsed.document, {
                    textDocument: { uri: parsed.document.uri.toString() },
                    range: { start: { line: range.startLineNumber - 1, character: range.startColumn - 1 }, end: { line: range.endLineNumber - 1, character: range.endColumn - 1 } },
                    context: { diagnostics }
                }) ?? [];
                return {
                    actions: actions.flatMap(action => 'edit' in action && action.edit ? [{
                        title: action.title,
                        kind: action.kind,
                        isPreferred: action.isPreferred,
                        edit: {
                            edits: Object.values(action.edit.changes ?? {}).flat().map(edit => ({
                                resource: model.uri, versionId: model.getVersionId(), textEdit: toMonacoEdit(edit)
                            }))
                        }
                    }] : []),
                    dispose: () => undefined
                };
            }
        });

        monaco.languages.registerReferenceProvider(LANGUAGE_ID, {
            provideReferences: async (model, position, context) => {
                if (!isEditedModel(model)) {
                    return undefined;
                }
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
                if (!isEditedModel(model)) {
                    return undefined;
                }
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

    /**
     * The Monaco URI of a navigation target: the edited model for its own document, otherwise the URI of the
     * file of the workspace, whose Monaco model is created (peek and the Ctrl+hover preview need it).
     */
    private targetUri(uri: string, edited: monaco.editor.ITextModel): monaco.Uri {
        if (uri === this.uri) {
            return edited.uri;
        }
        return this.workspaceModel(uri)?.uri ?? monaco.Uri.parse(uri);
    }

    /**
     * The (read-only) Monaco model of another file of the workspace (`memory:///include/motor.h`), created or
     * updated from the text given to {@link setWorkspace}; undefined if the file is unknown.
     */
    workspaceModel(uri: string): monaco.editor.ITextModel | undefined {
        const text = this.fileText(uri);
        const existing = this.workspaceModels.get(uri);
        if (text === undefined) {
            return existing;
        }
        if (existing && !existing.isDisposed()) {
            if (existing.getValue() !== text) {
                existing.setValue(text);
            }
            return existing;
        }
        // (Monaco writes `memory:///motor.h` as `memory:/motor.h`)
        const monacoUri = monaco.Uri.parse(uri);
        const model = monaco.editor.getModel(monacoUri) ?? monaco.editor.createModel(text, importKind(uri) === 'header' ? CPP_LANGUAGE_ID : LANGUAGE_ID, monacoUri);
        this.workspaceModels.set(uri, model);
        return model;
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

/** The edited model (the models of other files of the workspace are only navigation targets). */
function isEditedModel(model: monaco.editor.ITextModel): boolean {
    return model.uri.scheme !== WORKSPACE_SCHEME;
}

type MonarchRule = { regex?: RegExp, include?: string, action?: unknown };

/**
 * The generated Monarch grammar, adjusted for nicer highlighting: numbers, annotations (`@EventDriven`),
 * built-in type names, the `[*]` pseudo state and the Doxygen / JSDoc commands in documentation
 * comments (`/** @param … *\/`).
 */
function monarchSyntax(): monaco.languages.IMonarchLanguage {
    const generated = HsmMonarchSyntax as unknown as { tokenizer: Record<string, MonarchRule[]> };
    const rename: Record<string, string> = { HEX: 'number.hex', REAL: 'number.float', ID: 'identifier' };
    const initial = generated.tokenizer.initial.map((rule): MonarchRule => {
        const action = rule.action as { token?: string, cases?: Record<string, { token: string }> } | undefined;
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
        ...HsmMonarchSyntax,
        typeNames: ['integer', 'real', 'boolean', 'string', 'void'],
        tokenizer: {
            ...generated.tokenizer,
            initial: [
                { regex: /@[_a-zA-Z]\w*/, action: { token: 'annotation' } },
                { regex: /\[\*\]/, action: { token: 'keyword' } },
                ...initial
            ],
            whitespace: [DOC_COMMENT_START, ...generated.tokenizer.whitespace],
            docComment: [...DOC_COMMENT_RULES]
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
