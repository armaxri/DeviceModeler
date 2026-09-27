import { DIAGRAM_CSS } from 'hsm-language';

/*
 * The style sheet of the diagram is shared with the SVG renderer of the language package
 * (`DIAGRAM_CSS` in packages/language/src/render/diagram-styles.ts): it is injected into the page.
 */
const style = document.createElement('style');
style.id = 'hsm-diagram-styles';
style.textContent = DIAGRAM_CSS;
document.head.append(style);
