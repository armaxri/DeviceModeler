export interface InlineEditorOptions {
    /** Client coordinates of the box the editor is placed on. */
    rect: { left: number, top: number, width: number, height: number };
    value: string;
    placeholder?: string;
    /** Minimum width of the editor in pixels. */
    minWidth?: number;
    /** Validates the value while typing; returns an error message or undefined. */
    validate?: (value: string) => string | undefined;
    /** Words offered as completion for the word in front of the cursor. */
    completions?: () => string[];
    commit: (value: string) => void;
    cancel?: () => void;
    /** Called when the editor loses the focus while the value is invalid (the edit is discarded). */
    discarded?: (value: string, error: string) => void;
}

let active: HTMLElement | undefined;

const MAX_SUGGESTIONS = 8;

/** Shows a text input on top of a diagram element, e.g. to rename a state. */
export function showInlineEditor(options: InlineEditorOptions): void {
    closeInlineEditor();
    const container = document.createElement('div');
    container.className = 'inline-editor';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = options.value;
    input.placeholder = options.placeholder ?? '';
    input.spellcheck = false;
    input.autocomplete = 'off';
    const message = document.createElement('div');
    message.className = 'inline-editor-message';
    const list = document.createElement('ul');
    list.className = 'inline-editor-completions';
    list.hidden = true;
    container.append(input, message, list);

    const width = Math.max(options.rect.width, options.minWidth ?? 160);
    container.style.left = `${Math.max(4, options.rect.left + options.rect.width / 2 - width / 2)}px`;
    container.style.top = `${options.rect.top + options.rect.height / 2 - 15}px`;
    container.style.width = `${width}px`;
    document.body.append(container);
    active = container;

    let done = false;
    let error: string | undefined;
    const validate = () => {
        error = options.validate?.(input.value);
        message.textContent = error ?? '';
        container.classList.toggle('invalid', !!error);
        return !error;
    };
    const finish = (commit: boolean) => {
        if (done) {
            return;
        }
        done = true;
        closeInlineEditor();
        if (commit && input.value !== options.value) {
            options.commit(input.value);
        } else if (!commit) {
            options.cancel?.();
        }
    };

    // ---- completion of the word in front of the cursor
    let suggestions: string[] = [];
    let selected = 0;
    const currentWord = () => {
        const before = input.value.substring(0, input.selectionStart ?? input.value.length);
        const match = /[\w.]*$/.exec(before)!;
        return { start: before.length - match[0].length, word: match[0] };
    };
    const renderSuggestions = () => {
        list.replaceChildren(...suggestions.map((suggestion, i) => {
            const item = document.createElement('li');
            item.textContent = suggestion;
            item.classList.toggle('selected', i === selected);
            item.addEventListener('mousedown', event => {
                event.preventDefault();
                accept(suggestion);
            });
            return item;
        }));
        list.hidden = suggestions.length === 0;
    };
    const updateSuggestions = () => {
        const { word } = currentWord();
        suggestions = [];
        if (options.completions && word.length > 0) {
            const lower = word.toLowerCase();
            suggestions = [...new Set(options.completions())]
                .filter(c => c.toLowerCase().startsWith(lower) && c !== word)
                .slice(0, MAX_SUGGESTIONS);
        }
        selected = 0;
        renderSuggestions();
    };
    const accept = (suggestion: string) => {
        const { start } = currentWord();
        const end = input.selectionStart ?? input.value.length;
        input.value = input.value.substring(0, start) + suggestion + input.value.substring(end);
        const cursor = start + suggestion.length - (suggestion.endsWith('()') ? 1 : 0);
        input.setSelectionRange(cursor, cursor);
        suggestions = [];
        renderSuggestions();
        validate();
    };

    input.addEventListener('input', () => {
        validate();
        updateSuggestions();
    });
    input.addEventListener('keydown', event => {
        event.stopPropagation();
        if (suggestions.length > 0) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                selected = (selected + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length;
                renderSuggestions();
                event.preventDefault();
                return;
            }
            if (event.key === 'Tab' || event.key === 'Enter') {
                accept(suggestions[selected]);
                event.preventDefault();
                return;
            }
            if (event.key === 'Escape') {
                suggestions = [];
                renderSuggestions();
                event.preventDefault();
                return;
            }
        }
        if (event.key === 'Enter') {
            if (validate()) {
                finish(true);
            }
            event.preventDefault();
        } else if (event.key === 'Escape') {
            finish(false);
            event.preventDefault();
        }
    });
    input.addEventListener('blur', () => {
        if (done) {
            return;
        }
        const valid = validate();
        if (!valid && error && input.value !== options.value) {
            options.discarded?.(input.value, error);
        }
        finish(valid);
    });
    validate();
    requestAnimationFrame(() => {
        input.focus();
        input.select();
    });
}

export function closeInlineEditor(): void {
    const element = active;
    active = undefined;
    element?.remove();
}
