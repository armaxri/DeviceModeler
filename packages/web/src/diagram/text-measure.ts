import { DiagramMetrics, type TextMeasure, type TextStyle } from 'hsm-language';

/** Font family used in the diagram. Must match `--hsm-font` in diagram.css. */
export const DIAGRAM_FONT = '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif';

let context: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, number>();

/** Measures text with the real font metrics of the browser. */
export const canvasTextMeasure: TextMeasure = (text: string, style: TextStyle) => {
    const size = DiagramMetrics.fontSize[style];
    const key = `${style}|${text}`;
    let width = cache.get(key);
    if (width === undefined) {
        context ??= document.createElement('canvas').getContext('2d');
        if (context) {
            context.font = `${size}px ${DIAGRAM_FONT}`;
            width = Math.ceil(context.measureText(text).width);
        } else {
            width = Math.ceil(text.length * size * 0.6);
        }
        if (cache.size > 5000) {
            cache.clear();
        }
        cache.set(key, width);
    }
    return { width, height: DiagramMetrics.lineHeight[style] };
};
