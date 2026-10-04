declare module 'monaco-editor/esm/vs/editor/edcore.main.js' {
    export * from 'monaco-editor';
}

declare module 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js' {
    import type { languages } from 'monaco-editor';
    export const conf: languages.LanguageConfiguration;
    export const language: languages.IMonarchLanguage;
}
