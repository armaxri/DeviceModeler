export interface InlineEditorOptions {
    /** Client coordinates of the box the editor is placed on. */
    rect: { left: number, top: number, width: number, height: number };
    value: string;
    placeholder?: string;
    /** Validates the value while typing; returns an error message or undefined. */
    validate?: (value: string) => string | undefined;
    commit: (value: string) => void;
    cancel?: () => void;
}

let active: HTMLElement | undefined;

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
    const message = document.createElement('div');
    message.className = 'inline-editor-message';
    container.append(input, message);

    const width = Math.max(options.rect.width, 160);
    container.style.left = `${options.rect.left + options.rect.width / 2 - width / 2}px`;
    container.style.top = `${options.rect.top + options.rect.height / 2 - 15}px`;
    container.style.width = `${width}px`;
    document.body.append(container);
    active = container;

    let done = false;
    const validate = () => {
        const error = options.validate?.(input.value);
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
    input.addEventListener('input', validate);
    input.addEventListener('keydown', event => {
        event.stopPropagation();
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
    input.addEventListener('blur', () => finish(validate()));
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
