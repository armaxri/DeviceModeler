/**
 * Style sheet of the state machine diagram, shared by the web editor (injected into the page and
 * embedded into exported SVG files) and the SVG renderer of the language package (`renderSvg`).
 * The themes mimic the look of PlantUML state diagrams.
 *
 * The root `<svg>` of a diagram has the class `sprotty-graph`; the theme class (`theme-classic`,
 * `theme-modern` or `theme-dark`) is set on the root or on an ancestor (the diagram container of
 * the web editor). Standalone SVG files additionally have the class `devm-export`.
 */
export const DIAGRAM_CSS = `
.theme-classic, .theme-modern, .theme-dark {
    --devm-font: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif;
    --devm-select: #1a73e8;
    --devm-error: #d32f2f;
    --devm-warning: #f5a623;
    --devm-mono: "DejaVu Sans Mono", Menlo, Consolas, "Liberation Mono", monospace;
    --devm-def-fill: #fbfbf8;
    --devm-def-stroke: #b8b8b0;
    --devm-muted: #6e6e6e;
    --devm-keyword: #7a1f47;
}

/* PlantUML "classic" skin: light yellow states with dark red borders */
.theme-classic {
    --devm-bg: #ffffff;
    --devm-state-fill: #fefece;
    --devm-state-stroke: #a80036;
    --devm-text: #000000;
    --devm-edge: #a80036;
    --devm-pseudo: #000000;
    --devm-grid: #f3f3f3;
}

/* current PlantUML default look */
.theme-modern {
    --devm-bg: #ffffff;
    --devm-state-fill: #f1f1f1;
    --devm-state-stroke: #181818;
    --devm-text: #000000;
    --devm-edge: #181818;
    --devm-pseudo: #222222;
    --devm-grid: #f5f5f5;
}

.theme-dark {
    --devm-bg: #1e2227;
    --devm-state-fill: #2d333b;
    --devm-state-stroke: #9fb3c8;
    --devm-text: #e6edf3;
    --devm-edge: #9fb3c8;
    --devm-pseudo: #e6edf3;
    --devm-grid: #23282e;
    --devm-select: #58a6ff;
    --devm-def-fill: #252a30;
    --devm-def-stroke: #56606b;
    --devm-muted: #8b949e;
    --devm-keyword: #ff9ab5;
}

.theme-modern {
    --devm-keyword: #0b4f9c;
}

.sprotty-graph {
    background: var(--devm-bg);
    font-family: var(--devm-font);
}

.sprotty-graph text {
    font-family: var(--devm-font);
    fill: var(--devm-text);
    user-select: none;
    -webkit-user-select: none;
}

.export-background {
    fill: var(--devm-bg);
}

/* ---- states ---- */

.state-shape {
    fill: var(--devm-state-fill);
    stroke: var(--devm-state-stroke);
    stroke-width: 1.5px;
}

.state-separator {
    stroke: var(--devm-state-stroke);
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
    stroke: var(--devm-state-stroke);
    stroke-width: 1.2px;
    stroke-dasharray: 6 4;
}

.region-name {
    font-size: 11px;
    font-style: italic;
    opacity: 0.75;
}

.region.selected > .region-shape {
    fill: var(--devm-select);
    fill-opacity: 0.06;
    stroke: var(--devm-select);
    stroke-width: 1.5px;
    stroke-dasharray: 4 3;
}

/* ---- pseudo states ---- */

.initial-shape,
.junction-shape,
.final-inner {
    fill: var(--devm-pseudo);
}

.final-outer {
    fill: var(--devm-bg);
    stroke: var(--devm-pseudo);
    stroke-width: 1.5px;
}

.choice-shape,
.history-shape {
    fill: var(--devm-state-fill);
    stroke: var(--devm-state-stroke);
    stroke-width: 1.5px;
}

.history-text {
    font-size: 12px;
    font-weight: bold;
    text-anchor: middle;
}

.sync-shape {
    fill: var(--devm-pseudo);
}

.entry-shape,
.exit-shape {
    fill: var(--devm-bg);
    stroke: var(--devm-pseudo);
    stroke-width: 1.5px;
}

.exit-cross {
    fill: none;
    stroke: var(--devm-pseudo);
    stroke-width: 1.3px;
}

.node-label {
    font-size: 12px;
}

/* ---- submachine states ---- */

.submachine-icon rect,
.submachine-icon line {
    fill: none;
    stroke: var(--devm-state-stroke);
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
    fill: var(--devm-def-fill);
    stroke: var(--devm-def-stroke);
    stroke-width: 1.2px;
}

.definition-separator {
    stroke: var(--devm-def-stroke);
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
    fill: var(--devm-muted);
}

.definition-line {
    font-size: 11.5px;
}

.sprotty-graph .definition-line {
    font-family: var(--devm-mono);
}

.sprotty-graph .definition-scope {
    fill: var(--devm-keyword);
}

/* ---- transitions ---- */

.transition-line {
    fill: none;
    stroke: var(--devm-edge);
    stroke-width: 1.2px;
}

.transition-arrow {
    fill: var(--devm-edge);
    stroke: var(--devm-edge);
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

.devm-node.mouseover > .state-shape,
.devm-node.mouseover > .choice-shape,
.devm-node.mouseover > .history-shape {
    stroke-width: 2.5px;
}

.devm-node.mouseover > .initial-shape,
.devm-node.mouseover > .junction-shape,
.devm-node.mouseover > .sync-shape,
.devm-node.mouseover > .entry-shape,
.devm-node.mouseover > .exit-shape,
.devm-node.mouseover > .definition-shape,
.devm-node.mouseover > .final-outer {
    stroke: var(--devm-select);
    stroke-width: 2px;
}

.devm-node.selected > .state-shape,
.devm-node.selected > .choice-shape,
.devm-node.selected > .history-shape,
.devm-node.selected > .entry-shape,
.devm-node.selected > .exit-shape,
.devm-node.selected > .definition-shape,
.devm-node.selected > .final-outer {
    stroke: var(--devm-select);
    stroke-width: 2.5px;
}

.devm-node.selected > .state-separator,
.devm-node.selected > .definition-separator {
    stroke: var(--devm-select);
}

.devm-node.selected > .initial-shape,
.devm-node.selected > .sync-shape,
.devm-node.selected > .junction-shape {
    stroke: var(--devm-select);
    stroke-width: 3px;
}

.devm-node.pending-source > .state-shape,
.devm-node.pending-source > .choice-shape,
.devm-node.pending-source > .history-shape,
.devm-node.pending-source > .initial-shape,
.devm-node.pending-source > .sync-shape,
.devm-node.pending-source > .entry-shape,
.devm-node.pending-source > .exit-shape,
.devm-node.pending-source > .junction-shape {
    stroke: var(--devm-select);
    stroke-width: 3px;
    stroke-dasharray: 5 3;
}

.transition.mouseover .transition-line {
    stroke-width: 2px;
}

.transition.selected .transition-line {
    stroke: var(--devm-select);
    stroke-width: 2px;
}

.transition.selected .transition-arrow {
    fill: var(--devm-select);
    stroke: var(--devm-select);
}

.transition.selected .transition-label text {
    fill: var(--devm-select);
}

/* ---- problems ---- */

.devm-node.has-error > .state-shape,
.devm-node.has-error > .choice-shape,
.devm-node.has-error > .entry-shape,
.devm-node.has-error > .exit-shape,
.devm-node.has-error > .definition-shape,
.devm-node.has-error > .history-shape {
    stroke: var(--devm-error);
}

.transition.has-error .transition-line {
    stroke: var(--devm-error);
    stroke-dasharray: 5 3;
}

.issue circle {
    stroke: var(--devm-bg);
    stroke-width: 1.5px;
}

.issue-error circle {
    fill: var(--devm-error);
}

.issue-warning circle {
    fill: var(--devm-warning);
}

.sprotty-graph .issue text {
    fill: #ffffff;
    font-size: 11px;
    font-weight: bold;
    text-anchor: middle;
}

.devm-export .issue {
    display: none;
}

/* ---- simulation ---- */

.theme-classic, .theme-modern {
    --devm-active-fill: #d4f5cc;
    --devm-active-fill-composite: #effbeb;
    --devm-active-stroke: #1e8e3e;
    --devm-taken: #ff6d00;
    --devm-breakpoint: #e53935;
}

.theme-dark {
    --devm-active-fill: #1f4a2b;
    --devm-active-fill-composite: #22362a;
    --devm-active-stroke: #4ade80;
    --devm-taken: #ffa94d;
    --devm-breakpoint: #ff5252;
}

.state-shape,
.transition-line,
.transition-arrow {
    transition: fill 0.25s, stroke 0.9s ease-out, stroke-width 0.9s ease-out;
}

.devm-node.active > .state-shape {
    fill: var(--devm-active-fill);
    stroke: var(--devm-active-stroke);
    stroke-width: 3px;
}

.devm-node.active.composite > .state-shape {
    fill: var(--devm-active-fill-composite);
}

.devm-node.active > .state-separator {
    stroke: var(--devm-active-stroke);
    stroke-width: 2px;
}

.devm-node.active > .state-name {
    font-weight: bold;
}

.devm-node.active > .final-outer {
    stroke: var(--devm-active-stroke);
    stroke-width: 3px;
}

.devm-node.active > .final-inner {
    fill: var(--devm-active-stroke);
}

/* taken transitions are highlighted immediately and fade out when the flag is removed */
.transition.taken .transition-line {
    transition: none;
    stroke: var(--devm-taken);
    stroke-width: 3.5px;
}

.transition.taken .transition-arrow {
    transition: none;
    fill: var(--devm-taken);
    stroke: var(--devm-taken);
}

.breakpoint-marker circle {
    fill: var(--devm-breakpoint);
    stroke: var(--devm-bg);
    stroke-width: 1.5px;
}

.devm-export .breakpoint-marker {
    display: none;
}

/* ---- manual layout (experimental) ---- */

.resize-handle {
    fill: var(--devm-select);
    stroke: #fff;
    stroke-width: 1px;
    cursor: nwse-resize;
}

.bend-handle {
    fill: #fff;
    stroke: var(--devm-select);
    stroke-width: 1.5px;
    cursor: move;
}

.anchor-handle {
    fill: #fff;
    stroke: var(--devm-select);
    stroke-width: 1.5px;
    cursor: crosshair;
}

/* the end of a transition is anchored at the border (@from / @to) */
.anchor-handle.anchored {
    fill: var(--devm-select);
    stroke: #fff;
    stroke-width: 1px;
}

.manual-layout .transition.selected .transition-label {
    cursor: move;
}

.devm-export .resize-handle,
.devm-export .bend-handle,
.devm-export .anchor-handle {
    display: none;
}

/* ---- coverage (renderSvg highlight: 'covered' / 'uncovered') ---- */

.theme-classic, .theme-modern {
    --devm-covered-fill: #d4f5cc;
    --devm-covered-stroke: #1e8e3e;
    --devm-uncovered-fill: #fde0e0;
    --devm-uncovered-stroke: #d32f2f;
}

.theme-dark {
    --devm-covered-fill: #1f4a2b;
    --devm-covered-stroke: #4ade80;
    --devm-uncovered-fill: #4a1f24;
    --devm-uncovered-stroke: #ff6b6b;
}

.devm-node.devm-covered > .state-shape,
.devm-node.devm-covered > .choice-shape,
.devm-node.devm-covered > .history-shape {
    fill: var(--devm-covered-fill);
    stroke: var(--devm-covered-stroke);
    stroke-width: 2px;
}

.devm-node.devm-covered.composite > .state-shape,
.devm-node.devm-uncovered.composite > .state-shape {
    fill-opacity: 0.5;
}

.devm-node.devm-covered > .state-separator {
    stroke: var(--devm-covered-stroke);
}

.devm-node.devm-covered > .initial-shape,
.devm-node.devm-covered > .junction-shape,
.devm-node.devm-covered > .sync-shape,
.devm-node.devm-covered > .final-inner {
    fill: var(--devm-covered-stroke);
}

.devm-node.devm-covered > .final-outer,
.devm-node.devm-covered > .entry-shape,
.devm-node.devm-covered > .exit-shape,
.devm-node.devm-covered > .exit-cross {
    stroke: var(--devm-covered-stroke);
}

.devm-node.devm-uncovered > .state-shape,
.devm-node.devm-uncovered > .choice-shape,
.devm-node.devm-uncovered > .history-shape {
    fill: var(--devm-uncovered-fill);
    stroke: var(--devm-uncovered-stroke);
    stroke-width: 2px;
    stroke-dasharray: 6 3;
}

.devm-node.devm-uncovered > .state-separator {
    stroke: var(--devm-uncovered-stroke);
}

.devm-node.devm-uncovered > .initial-shape,
.devm-node.devm-uncovered > .junction-shape,
.devm-node.devm-uncovered > .sync-shape,
.devm-node.devm-uncovered > .final-inner {
    fill: var(--devm-uncovered-stroke);
}

.devm-node.devm-uncovered > .final-outer,
.devm-node.devm-uncovered > .entry-shape,
.devm-node.devm-uncovered > .exit-shape,
.devm-node.devm-uncovered > .exit-cross {
    stroke: var(--devm-uncovered-stroke);
}

.transition.devm-covered .transition-line {
    stroke: var(--devm-covered-stroke);
    stroke-width: 2px;
}

.transition.devm-covered .transition-arrow {
    fill: var(--devm-covered-stroke);
    stroke: var(--devm-covered-stroke);
}

.transition.devm-uncovered .transition-line {
    stroke: var(--devm-uncovered-stroke);
    stroke-width: 2px;
    stroke-dasharray: 6 3;
}

.transition.devm-uncovered .transition-arrow {
    fill: var(--devm-uncovered-stroke);
    stroke: var(--devm-uncovered-stroke);
}

.sprotty-graph .transition.devm-uncovered .transition-label text {
    fill: var(--devm-uncovered-stroke);
}

/* ---- title and legend of rendered SVG files (renderSvg) ---- */

.devm-title {
    font-size: 16px;
    font-weight: bold;
}

.devm-legend-label {
    font-size: 12px;
}

.devm-legend-frame {
    fill: var(--devm-bg);
    stroke: var(--devm-def-stroke);
    stroke-width: 1px;
}

/* ---- internal block diagrams of subsystems and systems (.devm, ibd-layout.ts) ---- */

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
    fill: var(--devm-muted);
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
    fill: var(--devm-state-fill);
    stroke: var(--devm-state-stroke);
    stroke-width: 1.5px;
}

.ibd-instance-separator {
    stroke: var(--devm-state-stroke);
    stroke-width: 0.8px;
    stroke-opacity: 0.45;
}

.ibd-icon rect,
.ibd-icon path {
    fill: none;
    stroke: var(--devm-state-stroke);
    stroke-width: 1.2px;
}

/* ports: hollow = sync (data), filled = async (event); the arrow shows the direction of the data (in / out / inout) */
.ibd-port-shape {
    stroke: var(--devm-state-stroke);
    stroke-width: 1.3px;
}

.ibd-port.async .ibd-port-shape {
    fill: var(--devm-state-stroke);
}

.ibd-port.sync .ibd-port-shape {
    fill: var(--devm-bg);
}

.ibd-port-arrow {
    fill: none;
    pointer-events: none;
    stroke-width: 1.3px;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.ibd-port.async .ibd-port-arrow {
    stroke: var(--devm-bg);
}

.ibd-port.sync .ibd-port-arrow {
    stroke: var(--devm-state-stroke);
}

.ibd-port-label {
    font-size: 11px;
}

.sprotty-graph .ibd-port-type {
    fill: var(--devm-muted);
}

/* data types (structs of the file): value type boxes, never connected */
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
    fill: var(--devm-muted);
}

.ibd-type-keyword {
    font-style: italic;
}

.ibd-node.mouseover > .ibd-type-shape {
    stroke-width: 2.2px;
}

.ibd-node.selected > .ibd-type-shape {
    stroke: var(--devm-select);
    stroke-width: 2.5px;
}

.ibd-node.has-error > .ibd-type-shape {
    stroke: var(--devm-error);
}

.route-highlight .ibd-type {
    opacity: 0.4;
}

.ibd-connector-line {
    fill: none;
    stroke: var(--devm-edge);
    stroke-width: 1.3px;
    stroke-linejoin: round;
}

.ibd-connector-arrow {
    fill: var(--devm-edge);
    stroke: none;
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
    stroke: var(--devm-select);
    stroke-width: 2.5px;
}

.ibd-port.mouseover .ibd-port-shape {
    stroke-width: 2.2px;
}

.ibd-port.selected .ibd-port-shape {
    stroke: var(--devm-select);
    stroke-width: 2.5px;
}

.ibd-connector.mouseover .ibd-connector-line {
    stroke-width: 2.2px;
}

.ibd-connector.selected .ibd-connector-line {
    stroke: var(--devm-select);
    stroke-width: 2.5px;
}

.ibd-connector.selected .ibd-connector-arrow {
    fill: var(--devm-select);
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

.ibd-connector.on-route .ibd-connector-arrow {
    fill: var(--ibd-route);
}

.ibd-port.async.on-route .ibd-port-shape {
    fill: var(--ibd-route);
}

.ibd-port.sync.on-route .ibd-port-arrow {
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
    stroke: var(--devm-select);
}

.ibd-connector.on-route.selected .ibd-connector-arrow {
    fill: var(--devm-select);
}

.ibd-port.on-route.selected .ibd-port-shape {
    stroke: var(--devm-select);
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
    stroke: var(--devm-error);
}

.ibd-connector.has-error .ibd-connector-line {
    stroke: var(--devm-error);
}

.ibd-port.has-error .ibd-port-shape {
    stroke: var(--devm-error);
}
`;
