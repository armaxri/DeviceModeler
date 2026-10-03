/**
 * Style sheet of the state machine diagram, shared by the web editor (injected into the page and
 * embedded into exported SVG files) and the SVG renderer of the language package (`renderSvg`).
 * The themes mimic the look of PlantUML state diagrams.
 *
 * The root `<svg>` of a diagram has the class `sprotty-graph`; the theme class (`theme-classic`,
 * `theme-modern` or `theme-dark`) is set on the root or on an ancestor (the diagram container of
 * the web editor). Standalone SVG files additionally have the class `hsm-export`.
 */
export const DIAGRAM_CSS = `
.theme-classic, .theme-modern, .theme-dark {
    --hsm-font: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif;
    --hsm-select: #1a73e8;
    --hsm-error: #d32f2f;
    --hsm-warning: #f5a623;
    --hsm-mono: "DejaVu Sans Mono", Menlo, Consolas, "Liberation Mono", monospace;
    --hsm-def-fill: #fbfbf8;
    --hsm-def-stroke: #b8b8b0;
    --hsm-muted: #6e6e6e;
    --hsm-keyword: #7a1f47;
}

/* PlantUML "classic" skin: light yellow states with dark red borders */
.theme-classic {
    --hsm-bg: #ffffff;
    --hsm-state-fill: #fefece;
    --hsm-state-stroke: #a80036;
    --hsm-text: #000000;
    --hsm-edge: #a80036;
    --hsm-pseudo: #000000;
    --hsm-grid: #f3f3f3;
}

/* current PlantUML default look */
.theme-modern {
    --hsm-bg: #ffffff;
    --hsm-state-fill: #f1f1f1;
    --hsm-state-stroke: #181818;
    --hsm-text: #000000;
    --hsm-edge: #181818;
    --hsm-pseudo: #222222;
    --hsm-grid: #f5f5f5;
}

.theme-dark {
    --hsm-bg: #1e2227;
    --hsm-state-fill: #2d333b;
    --hsm-state-stroke: #9fb3c8;
    --hsm-text: #e6edf3;
    --hsm-edge: #9fb3c8;
    --hsm-pseudo: #e6edf3;
    --hsm-grid: #23282e;
    --hsm-select: #58a6ff;
    --hsm-def-fill: #252a30;
    --hsm-def-stroke: #56606b;
    --hsm-muted: #8b949e;
    --hsm-keyword: #ff9ab5;
}

.theme-modern {
    --hsm-keyword: #0b4f9c;
}

.sprotty-graph {
    background: var(--hsm-bg);
    font-family: var(--hsm-font);
}

.sprotty-graph text {
    font-family: var(--hsm-font);
    fill: var(--hsm-text);
    user-select: none;
    -webkit-user-select: none;
}

.export-background {
    fill: var(--hsm-bg);
}

/* ---- states ---- */

.state-shape {
    fill: var(--hsm-state-fill);
    stroke: var(--hsm-state-stroke);
    stroke-width: 1.5px;
}

.state-separator {
    stroke: var(--hsm-state-stroke);
    stroke-width: 1.5px;
}

.state-name {
    font-size: 14px;
    text-anchor: middle;
}

.state-body {
    font-size: 12px;
}

/* ---- regions ---- */

.region-shape {
    fill: transparent;
    stroke: none;
}

.region-separator {
    stroke: var(--hsm-state-stroke);
    stroke-width: 1.2px;
    stroke-dasharray: 6 4;
}

.region-name {
    font-size: 11px;
    font-style: italic;
    opacity: 0.75;
}

.region.selected > .region-shape {
    fill: var(--hsm-select);
    fill-opacity: 0.06;
    stroke: var(--hsm-select);
    stroke-width: 1.5px;
    stroke-dasharray: 4 3;
}

/* ---- pseudo states ---- */

.initial-shape,
.junction-shape,
.final-inner {
    fill: var(--hsm-pseudo);
}

.final-outer {
    fill: var(--hsm-bg);
    stroke: var(--hsm-pseudo);
    stroke-width: 1.5px;
}

.choice-shape,
.history-shape {
    fill: var(--hsm-state-fill);
    stroke: var(--hsm-state-stroke);
    stroke-width: 1.5px;
}

.history-text {
    font-size: 12px;
    font-weight: bold;
    text-anchor: middle;
}

.sync-shape {
    fill: var(--hsm-pseudo);
}

.entry-shape,
.exit-shape {
    fill: var(--hsm-bg);
    stroke: var(--hsm-pseudo);
    stroke-width: 1.5px;
}

.exit-cross {
    fill: none;
    stroke: var(--hsm-pseudo);
    stroke-width: 1.3px;
}

.node-label {
    font-size: 12px;
}

/* ---- submachine states ---- */

.submachine-icon rect,
.submachine-icon line {
    fill: none;
    stroke: var(--hsm-state-stroke);
    stroke-width: 1.2px;
}

.submachine-instance {
    font-style: italic;
}

.submachine-point-label {
    font-size: 11px;
}

/* ---- definition section ---- */

.definition-shape {
    fill: var(--hsm-def-fill);
    stroke: var(--hsm-def-stroke);
    stroke-width: 1.2px;
}

.definition-separator {
    stroke: var(--hsm-def-stroke);
    stroke-width: 1px;
}

.definition-header {
    font-size: 14px;
}

.definition-name {
    font-weight: bold;
}

.sprotty-graph .definition-kind {
    font-size: 11px;
    font-style: italic;
    fill: var(--hsm-muted);
}

.definition-line {
    font-size: 11.5px;
}

.sprotty-graph .definition-line {
    font-family: var(--hsm-mono);
}

.sprotty-graph .definition-scope {
    fill: var(--hsm-keyword);
}

/* ---- transitions ---- */

.transition-line {
    fill: none;
    stroke: var(--hsm-edge);
    stroke-width: 1.2px;
}

.transition-arrow {
    fill: var(--hsm-edge);
    stroke: var(--hsm-edge);
    stroke-width: 0.6px;
    stroke-linejoin: round;
}

.transition-hit {
    fill: none;
    stroke: transparent;
    stroke-width: 12px;
}

.transition-label text {
    font-size: 12px;
}

.transition-label-hit {
    fill: transparent;
}

/* ---- interaction feedback ---- */

.hsm-node.mouseover > .state-shape,
.hsm-node.mouseover > .choice-shape,
.hsm-node.mouseover > .history-shape {
    stroke-width: 2.5px;
}

.hsm-node.mouseover > .initial-shape,
.hsm-node.mouseover > .junction-shape,
.hsm-node.mouseover > .sync-shape,
.hsm-node.mouseover > .entry-shape,
.hsm-node.mouseover > .exit-shape,
.hsm-node.mouseover > .definition-shape,
.hsm-node.mouseover > .final-outer {
    stroke: var(--hsm-select);
    stroke-width: 2px;
}

.hsm-node.selected > .state-shape,
.hsm-node.selected > .choice-shape,
.hsm-node.selected > .history-shape,
.hsm-node.selected > .entry-shape,
.hsm-node.selected > .exit-shape,
.hsm-node.selected > .definition-shape,
.hsm-node.selected > .final-outer {
    stroke: var(--hsm-select);
    stroke-width: 2.5px;
}

.hsm-node.selected > .state-separator,
.hsm-node.selected > .definition-separator {
    stroke: var(--hsm-select);
}

.hsm-node.selected > .initial-shape,
.hsm-node.selected > .sync-shape,
.hsm-node.selected > .junction-shape {
    stroke: var(--hsm-select);
    stroke-width: 3px;
}

.hsm-node.pending-source > .state-shape,
.hsm-node.pending-source > .choice-shape,
.hsm-node.pending-source > .history-shape,
.hsm-node.pending-source > .initial-shape,
.hsm-node.pending-source > .sync-shape,
.hsm-node.pending-source > .entry-shape,
.hsm-node.pending-source > .exit-shape,
.hsm-node.pending-source > .junction-shape {
    stroke: var(--hsm-select);
    stroke-width: 3px;
    stroke-dasharray: 5 3;
}

.transition.mouseover .transition-line {
    stroke-width: 2px;
}

.transition.selected .transition-line {
    stroke: var(--hsm-select);
    stroke-width: 2px;
}

.transition.selected .transition-arrow {
    fill: var(--hsm-select);
    stroke: var(--hsm-select);
}

.transition.selected .transition-label text {
    fill: var(--hsm-select);
}

/* ---- problems ---- */

.hsm-node.has-error > .state-shape,
.hsm-node.has-error > .choice-shape,
.hsm-node.has-error > .entry-shape,
.hsm-node.has-error > .exit-shape,
.hsm-node.has-error > .definition-shape,
.hsm-node.has-error > .history-shape {
    stroke: var(--hsm-error);
}

.transition.has-error .transition-line {
    stroke: var(--hsm-error);
    stroke-dasharray: 5 3;
}

.issue circle {
    stroke: var(--hsm-bg);
    stroke-width: 1.5px;
}

.issue-error circle {
    fill: var(--hsm-error);
}

.issue-warning circle {
    fill: var(--hsm-warning);
}

.sprotty-graph .issue text {
    fill: #ffffff;
    font-size: 11px;
    font-weight: bold;
    text-anchor: middle;
}

.hsm-export .issue {
    display: none;
}

/* ---- simulation ---- */

.theme-classic, .theme-modern {
    --hsm-active-fill: #d4f5cc;
    --hsm-active-fill-composite: #effbeb;
    --hsm-active-stroke: #1e8e3e;
    --hsm-taken: #ff6d00;
    --hsm-breakpoint: #e53935;
}

.theme-dark {
    --hsm-active-fill: #1f4a2b;
    --hsm-active-fill-composite: #22362a;
    --hsm-active-stroke: #4ade80;
    --hsm-taken: #ffa94d;
    --hsm-breakpoint: #ff5252;
}

.state-shape,
.transition-line,
.transition-arrow {
    transition: fill 0.25s, stroke 0.9s ease-out, stroke-width 0.9s ease-out;
}

.hsm-node.active > .state-shape {
    fill: var(--hsm-active-fill);
    stroke: var(--hsm-active-stroke);
    stroke-width: 3px;
}

.hsm-node.active.composite > .state-shape {
    fill: var(--hsm-active-fill-composite);
}

.hsm-node.active > .state-separator {
    stroke: var(--hsm-active-stroke);
    stroke-width: 2px;
}

.hsm-node.active > .state-name {
    font-weight: bold;
}

.hsm-node.active > .final-outer {
    stroke: var(--hsm-active-stroke);
    stroke-width: 3px;
}

.hsm-node.active > .final-inner {
    fill: var(--hsm-active-stroke);
}

/* taken transitions are highlighted immediately and fade out when the flag is removed */
.transition.taken .transition-line {
    transition: none;
    stroke: var(--hsm-taken);
    stroke-width: 3.5px;
}

.transition.taken .transition-arrow {
    transition: none;
    fill: var(--hsm-taken);
    stroke: var(--hsm-taken);
}

.breakpoint-marker circle {
    fill: var(--hsm-breakpoint);
    stroke: var(--hsm-bg);
    stroke-width: 1.5px;
}

.hsm-export .breakpoint-marker {
    display: none;
}

/* ---- manual layout (experimental) ---- */

.resize-handle {
    fill: var(--hsm-select);
    stroke: #fff;
    stroke-width: 1px;
    cursor: nwse-resize;
}

.bend-handle {
    fill: #fff;
    stroke: var(--hsm-select);
    stroke-width: 1.5px;
    cursor: move;
}

.manual-layout .transition.selected .transition-label {
    cursor: move;
}

.hsm-export .resize-handle,
.hsm-export .bend-handle {
    display: none;
}

/* ---- coverage (renderSvg highlight: 'covered' / 'uncovered') ---- */

.theme-classic, .theme-modern {
    --hsm-covered-fill: #d4f5cc;
    --hsm-covered-stroke: #1e8e3e;
    --hsm-uncovered-fill: #fde0e0;
    --hsm-uncovered-stroke: #d32f2f;
}

.theme-dark {
    --hsm-covered-fill: #1f4a2b;
    --hsm-covered-stroke: #4ade80;
    --hsm-uncovered-fill: #4a1f24;
    --hsm-uncovered-stroke: #ff6b6b;
}

.hsm-node.hsm-covered > .state-shape,
.hsm-node.hsm-covered > .choice-shape,
.hsm-node.hsm-covered > .history-shape {
    fill: var(--hsm-covered-fill);
    stroke: var(--hsm-covered-stroke);
    stroke-width: 2px;
}

.hsm-node.hsm-covered.composite > .state-shape,
.hsm-node.hsm-uncovered.composite > .state-shape {
    fill-opacity: 0.5;
}

.hsm-node.hsm-covered > .state-separator {
    stroke: var(--hsm-covered-stroke);
}

.hsm-node.hsm-covered > .initial-shape,
.hsm-node.hsm-covered > .junction-shape,
.hsm-node.hsm-covered > .sync-shape,
.hsm-node.hsm-covered > .final-inner {
    fill: var(--hsm-covered-stroke);
}

.hsm-node.hsm-covered > .final-outer,
.hsm-node.hsm-covered > .entry-shape,
.hsm-node.hsm-covered > .exit-shape,
.hsm-node.hsm-covered > .exit-cross {
    stroke: var(--hsm-covered-stroke);
}

.hsm-node.hsm-uncovered > .state-shape,
.hsm-node.hsm-uncovered > .choice-shape,
.hsm-node.hsm-uncovered > .history-shape {
    fill: var(--hsm-uncovered-fill);
    stroke: var(--hsm-uncovered-stroke);
    stroke-width: 2px;
    stroke-dasharray: 6 3;
}

.hsm-node.hsm-uncovered > .state-separator {
    stroke: var(--hsm-uncovered-stroke);
}

.hsm-node.hsm-uncovered > .initial-shape,
.hsm-node.hsm-uncovered > .junction-shape,
.hsm-node.hsm-uncovered > .sync-shape,
.hsm-node.hsm-uncovered > .final-inner {
    fill: var(--hsm-uncovered-stroke);
}

.hsm-node.hsm-uncovered > .final-outer,
.hsm-node.hsm-uncovered > .entry-shape,
.hsm-node.hsm-uncovered > .exit-shape,
.hsm-node.hsm-uncovered > .exit-cross {
    stroke: var(--hsm-uncovered-stroke);
}

.transition.hsm-covered .transition-line {
    stroke: var(--hsm-covered-stroke);
    stroke-width: 2px;
}

.transition.hsm-covered .transition-arrow {
    fill: var(--hsm-covered-stroke);
    stroke: var(--hsm-covered-stroke);
}

.transition.hsm-uncovered .transition-line {
    stroke: var(--hsm-uncovered-stroke);
    stroke-width: 2px;
    stroke-dasharray: 6 3;
}

.transition.hsm-uncovered .transition-arrow {
    fill: var(--hsm-uncovered-stroke);
    stroke: var(--hsm-uncovered-stroke);
}

.sprotty-graph .transition.hsm-uncovered .transition-label text {
    fill: var(--hsm-uncovered-stroke);
}

/* ---- title and legend of rendered SVG files (renderSvg) ---- */

.hsm-title {
    font-size: 16px;
    font-weight: bold;
}

.hsm-legend-label {
    font-size: 12px;
}

.hsm-legend-frame {
    fill: var(--hsm-bg);
    stroke: var(--hsm-def-stroke);
    stroke-width: 1px;
}

/* ---- internal block diagrams of subsystems and systems (.dmf, ibd-layout.ts) ---- */

.theme-classic {
    --ibd-thread-fill: #f4f7fb;
    --ibd-thread-stroke: #7f95ab;
    --ibd-frame-stroke: #a80036;
    --ibd-tab-fill: #fbf3dd;
    --ibd-type-fill: #f4f6f8;
    --ibd-type-stroke: #6b7b8c;
    --ibd-type-header: #e6ebf0;
}

.theme-modern {
    --ibd-thread-fill: #f6f8fa;
    --ibd-thread-stroke: #8a96a3;
    --ibd-frame-stroke: #181818;
    --ibd-tab-fill: #ececec;
    --ibd-type-fill: #fafafa;
    --ibd-type-stroke: #7a7a7a;
    --ibd-type-header: #efefef;
}

.theme-dark {
    --ibd-thread-fill: #252b32;
    --ibd-thread-stroke: #66727f;
    --ibd-frame-stroke: #9fb3c8;
    --ibd-tab-fill: #2d333b;
    --ibd-type-fill: #22262c;
    --ibd-type-stroke: #7d8a99;
    --ibd-type-header: #2c323a;
}

.theme-classic, .theme-modern {
    --ibd-route: #e8590c;
    --ibd-route-fill: #fff0e6;
}

.theme-dark {
    --ibd-route: #ffa94d;
    --ibd-route-fill: #4a3220;
}

.ibd-frame-shape {
    fill: none;
    stroke: var(--ibd-frame-stroke);
    stroke-width: 1.5px;
}

.ibd-frame-tab {
    fill: var(--ibd-tab-fill);
    stroke: var(--ibd-frame-stroke);
    stroke-width: 1.2px;
}

.ibd-frame-title {
    font-size: 13px;
}

.ibd-frame-kind,
.ibd-frame-name {
    font-weight: bold;
}

.ibd-thread-shape {
    fill: var(--ibd-thread-fill);
    stroke: var(--ibd-thread-stroke);
    stroke-width: 1.3px;
}

.ibd-thread-title {
    font-size: 13px;
}

.ibd-thread-name {
    font-weight: bold;
}

.sprotty-graph .ibd-thread-details {
    font-size: 11px;
    fill: var(--hsm-muted);
}

.sprotty-graph .ibd-stereotype {
    font-size: 11px;
    font-style: italic;
    font-weight: normal;
}

.ibd-block-stereotype,
.ibd-instance-name {
    text-anchor: middle;
}

.ibd-instance-name {
    font-size: 13px;
    font-weight: bold;
}

.ibd-instance-shape {
    fill: var(--hsm-state-fill);
    stroke: var(--hsm-state-stroke);
    stroke-width: 1.5px;
}

.ibd-instance-separator {
    stroke: var(--hsm-state-stroke);
    stroke-width: 0.8px;
    stroke-opacity: 0.45;
}

.ibd-icon rect,
.ibd-icon path {
    fill: none;
    stroke: var(--hsm-state-stroke);
    stroke-width: 1.2px;
}

/* ports: filled = provided, hollow = required; the chevron of async ports shows the event direction */
.ibd-port-shape {
    stroke: var(--hsm-state-stroke);
    stroke-width: 1.3px;
}

.ibd-port.provided .ibd-port-shape {
    fill: var(--hsm-state-stroke);
}

.ibd-port.required .ibd-port-shape {
    fill: var(--hsm-bg);
}

.ibd-port-chevron {
    fill: none;
    stroke-width: 1.5px;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.ibd-port.provided .ibd-port-chevron {
    stroke: var(--hsm-bg);
}

.ibd-port.required .ibd-port-chevron {
    stroke: var(--hsm-state-stroke);
}

.ibd-port-label {
    font-size: 11px;
}

.sprotty-graph .ibd-port-type {
    fill: var(--hsm-muted);
}

/* data types (structs, interfaces of the file): value type boxes, never connected */
.ibd-type-shape {
    fill: var(--ibd-type-fill);
    stroke: var(--ibd-type-stroke);
    stroke-width: 1.2px;
}

.ibd-type-header {
    fill: var(--ibd-type-header);
    stroke: none;
}

.ibd-type-separator {
    stroke: var(--ibd-type-stroke);
    stroke-width: 0.8px;
}

.ibd-type-stereotype,
.ibd-type-name {
    text-anchor: middle;
}

.ibd-type-name {
    font-size: 13px;
    font-weight: bold;
}

.ibd-type-member {
    font-size: 11px;
}

.sprotty-graph .ibd-type-keyword,
.sprotty-graph .ibd-type-member-type,
.sprotty-graph .ibd-type-empty {
    fill: var(--hsm-muted);
}

.ibd-type-keyword {
    font-style: italic;
}

.ibd-node.mouseover > .ibd-type-shape {
    stroke-width: 2.2px;
}

.ibd-node.selected > .ibd-type-shape {
    stroke: var(--hsm-select);
    stroke-width: 2.5px;
}

.ibd-node.has-error > .ibd-type-shape {
    stroke: var(--hsm-error);
}

.route-highlight .ibd-type {
    opacity: 0.4;
}

.ibd-connector-line {
    fill: none;
    stroke: var(--hsm-edge);
    stroke-width: 1.3px;
    stroke-linejoin: round;
}

.ibd-connector.cross-thread .ibd-connector-line {
    stroke-dasharray: 6 4;
}

.ibd-connector-hit {
    fill: none;
    stroke: transparent;
    stroke-width: 10px;
}

/* selection and hover */

.ibd-node.mouseover > .ibd-instance-shape,
.ibd-node.mouseover > .ibd-thread-shape {
    stroke-width: 2.5px;
}

.ibd-node.selected > .ibd-instance-shape,
.ibd-node.selected > .ibd-thread-shape,
.ibd-node.selected > .ibd-frame-shape {
    stroke: var(--hsm-select);
    stroke-width: 2.5px;
}

.ibd-port.mouseover .ibd-port-shape {
    stroke-width: 2.2px;
}

.ibd-port.selected .ibd-port-shape {
    stroke: var(--hsm-select);
    stroke-width: 2.5px;
}

.ibd-connector.mouseover .ibd-connector-line {
    stroke-width: 2.2px;
}

.ibd-connector.selected .ibd-connector-line {
    stroke: var(--hsm-select);
    stroke-width: 2.5px;
}

/* route highlighting: the elements of the route of the selection (class on-route), the others dimmed */

.ibd-connector.on-route .ibd-connector-line {
    stroke: var(--ibd-route);
    stroke-width: 2.6px;
}

.ibd-port.on-route .ibd-port-shape {
    stroke: var(--ibd-route);
    stroke-width: 2px;
}

.ibd-port.provided.on-route .ibd-port-shape {
    fill: var(--ibd-route);
}

.ibd-port.required.on-route .ibd-port-chevron {
    stroke: var(--ibd-route);
}

.sprotty-graph .ibd-port.on-route .ibd-port-label {
    fill: var(--ibd-route);
    font-weight: bold;
}

.ibd-node.on-route > .ibd-instance-shape {
    stroke: var(--ibd-route);
    stroke-width: 2.2px;
}

.ibd-node.on-route.selected > .ibd-instance-shape,
.ibd-connector.on-route.selected .ibd-connector-line {
    stroke: var(--hsm-select);
}

.ibd-port.on-route.selected .ibd-port-shape {
    stroke: var(--hsm-select);
    stroke-width: 2.5px;
}

.route-highlight .ibd-instance:not(.on-route),
.route-highlight .ibd-connector:not(.on-route),
.route-highlight .ibd-port:not(.on-route) {
    opacity: 0.4;
}

.route-highlight .ibd-instance:not(.on-route) .ibd-port:not(.on-route) {
    opacity: 1;
}

/* problems */

.ibd-node.has-error > .ibd-instance-shape,
.ibd-node.has-error > .ibd-thread-shape {
    stroke: var(--hsm-error);
}

.ibd-connector.has-error .ibd-connector-line {
    stroke: var(--hsm-error);
}

.ibd-port.has-error .ibd-port-shape {
    stroke: var(--hsm-error);
}
`;
