import type * as ast from '../generated/ast.js';
import {
    COVERAGE_METRICS, type CoverageCounter, type CoverageElement, type CoverageHighlight, type CoverageMetric, type CoverageReport,
    type CoverageTotals, type GuardCoverage, type MachineCoverage
} from './coverage.js';

/*
 * Report formats of the model coverage: text summary, JSON, LCOV, Cobertura XML and HTML.
 * All functions return strings (no file system access); `devm test --coverage` writes them.
 */

export type CoverageFormat = 'text' | 'json' | 'lcov' | 'cobertura' | 'html';

export const COVERAGE_FORMATS: readonly CoverageFormat[] = ['text', 'json', 'lcov', 'cobertura', 'html'];

export interface CoverageReportOptions {
    /** Maps the URI of a model document to the file name used in the report (default: the URI). */
    fileName?: (uri: string) => string;
}

const METRIC_TITLES: Record<CoverageMetric, string> = {
    states: 'States', transitions: 'Transitions', reactions: 'Reactions', guards: 'Guard decisions'
};

function formatCounter(counter: CoverageCounter): string {
    return counter.total === 0 ? '-' : `${counter.covered}/${counter.total} ${formatPercent(counter)}`;
}

function formatPercent(counter: CoverageCounter): string {
    return counter.percent === undefined ? '-' : `${counter.percent.toFixed(1)}%`;
}

function fileOf(machine: MachineCoverage, options: CoverageReportOptions): string {
    return machine.uri ? (options.fileName ?? (uri => uri))(machine.uri) : `${machine.machine}.devm`;
}

// ---------------------------------------------------------------------------------------------
// Text

/**
 * Text summary: a table with the coverage per state machine and the list of uncovered elements
 * (with line numbers).
 */
export function toCoverageText(report: CoverageReport, options: CoverageReportOptions & { uncovered?: boolean } = {}): string {
    const rows: string[][] = [['State machine', ...COVERAGE_METRICS.map(m => METRIC_TITLES[m])]];
    for (const machine of report.machines) {
        rows.push([machine.machine, ...COVERAGE_METRICS.map(m => formatCounter(machine.totals[m]))]);
    }
    if (report.machines.length > 1) {
        rows.push(['Total', ...COVERAGE_METRICS.map(m => formatCounter(report.totals[m]))]);
    }
    const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
    const line = (row: string[]) => row.map((cell, column) => column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])).join('  ').trimEnd();
    const lines = [line(rows[0]), widths.map(w => '-'.repeat(w)).join('  ')];
    rows.slice(1).forEach((row, index) => {
        if (index === report.machines.length && report.machines.length > 1) {
            lines.push(widths.map(w => '-'.repeat(w)).join('  '));
        }
        lines.push(line(row));
    });
    if (options.uncovered ?? true) {
        for (const machine of report.machines) {
            const missing = uncoveredItems(machine);
            if (missing.length === 0) {
                continue;
            }
            lines.push('', `Not covered in ${machine.machine} (${fileOf(machine, options)}):`);
            for (const item of missing) {
                lines.push(`  ${item.line !== undefined ? `${String(item.line).padStart(4)}: ` : '      '}${item.text}`);
            }
        }
    }
    return lines.join('\n') + '\n';
}

/** Uncovered elements and guard decisions of a machine, sorted by line. */
export function uncoveredItems(machine: MachineCoverage): Array<{ line?: number, text: string }> {
    const items: Array<{ line?: number, text: string }> = [];
    for (const element of machine.elements) {
        if (element.hits === 0) {
            items.push({ line: element.line, text: `${element.kind === 'final' ? 'final state' : element.kind} ${element.name}` });
        }
    }
    for (const guard of machine.guards) {
        const missing = guardMissing(guard);
        if (missing) {
            items.push({ line: guard.line, text: `guard [${guard.expression}] of ${guard.name}: ${missing}` });
        }
    }
    return items.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

function guardMissing(guard: GuardCoverage): string | undefined {
    if (guard.trueHits === 0 && guard.falseHits === 0) {
        return 'never evaluated';
    }
    if (guard.trueHits === 0) {
        return 'never true';
    }
    return guard.falseHits === 0 ? 'never false' : undefined;
}

// ---------------------------------------------------------------------------------------------
// JSON

/**
 * JSON report: the {@link CoverageReport} (schema version 1) with the file names of the models:
 *
 * ```
 * { version: 1, tests, totals: { states|transitions|reactions|guards: { covered, total, percent? } },
 *   machines: [{ machine, uri?, file, totals,
 *                elements: [{ id, kind: state|final|transition|reaction, name, line?, diagramId?, region?, hits, tests[] }],
 *                guards: [{ id, kind: transition|reaction, name, expression, line?, trueHits, falseHits, trueTests[], falseTests[] }] }] }
 * ```
 */
export function toCoverageJson(report: CoverageReport, options: CoverageReportOptions = {}): string {
    const machines = report.machines.map(machine => {
        const { machine: name, uri, totals, elements, guards } = machine;
        return { machine: name, uri, file: fileOf(machine, options), totals, elements, guards };
    });
    return JSON.stringify({ ...report, machines }, undefined, 2) + '\n';
}

// ---------------------------------------------------------------------------------------------
// Line based coverage (LCOV, Cobertura)

interface FileCoverage {
    readonly file: string;
    readonly machines: MachineCoverage[];
    /** line -> hits (a line is covered only if all elements starting on it are covered) */
    readonly lines: Map<number, number>;
    /** States as "functions". */
    readonly functions: Array<{ name: string, line: number, hits: number }>;
    /** Guards: line and the hits of the true / false branch (`undefined`: never evaluated). */
    readonly branches: Array<{ line: number, trueHits: number, falseHits: number }>;
}

function fileCoverage(report: CoverageReport, options: CoverageReportOptions): FileCoverage[] {
    const files = new Map<string, FileCoverage>();
    for (const machine of report.machines) {
        const file = fileOf(machine, options);
        let entry = files.get(file);
        if (!entry) {
            entry = { file, machines: [], lines: new Map(), functions: [], branches: [] };
            files.set(file, entry);
        }
        entry.machines.push(machine);
        for (const element of machine.elements) {
            if (element.line === undefined) {
                continue;
            }
            const current = entry.lines.get(element.line);
            entry.lines.set(element.line, current === undefined ? element.hits : Math.min(current, element.hits));
            if (element.kind === 'state' || element.kind === 'final') {
                entry.functions.push({ name: `${machine.machine}.${element.name}`, line: element.line, hits: element.hits });
            }
        }
        for (const guard of machine.guards) {
            if (guard.line !== undefined) {
                entry.branches.push({ line: guard.line, trueHits: guard.trueHits, falseHits: guard.falseHits });
            }
        }
    }
    return [...files.values()];
}

/**
 * LCOV tracefile: one record per `.devm` file. Lines (`DA`) are the source lines of states,
 * transitions and reactions, functions (`FN` / `FNDA`) are the states, branches (`BRDA`) the guard
 * decisions (branch 0: true, 1: false; `-`: guard never evaluated).
 */
export function toLcov(report: CoverageReport, options: CoverageReportOptions & { testName?: string } = {}): string {
    const out: string[] = [];
    for (const file of fileCoverage(report, options)) {
        out.push(`TN:${options.testName ?? ''}`, `SF:${file.file}`);
        for (const fn of file.functions) {
            out.push(`FN:${fn.line},${fn.name}`);
        }
        for (const fn of file.functions) {
            out.push(`FNDA:${fn.hits},${fn.name}`);
        }
        out.push(`FNF:${file.functions.length}`, `FNH:${file.functions.filter(f => f.hits > 0).length}`);
        let found = 0;
        let hit = 0;
        file.branches.forEach((branch, block) => {
            const evaluated = branch.trueHits + branch.falseHits > 0;
            for (const [index, hits] of [branch.trueHits, branch.falseHits].entries()) {
                out.push(`BRDA:${branch.line},${block},${index},${evaluated ? hits : '-'}`);
                found++;
                hit += hits > 0 ? 1 : 0;
            }
        });
        out.push(`BRF:${found}`, `BRH:${hit}`);
        const lines = [...file.lines.entries()].sort((a, b) => a[0] - b[0]);
        for (const [line, hits] of lines) {
            out.push(`DA:${line},${hits}`);
        }
        out.push(`LF:${lines.length}`, `LH:${lines.filter(([, hits]) => hits > 0).length}`, 'end_of_record');
    }
    return out.join('\n') + '\n';
}

/**
 * Cobertura XML (GitLab coverage visualization, Jenkins): one package per `.devm` file, one class per
 * state machine, lines as in {@link toLcov}, guard lines are branches (`condition-coverage`).
 */
export function toCobertura(report: CoverageReport, options: CoverageReportOptions & { sourceRoot?: string, timestamp?: number } = {}): string {
    const rate = (covered: number, total: number) => (total === 0 ? 1 : covered / total).toFixed(4);
    const files = fileCoverage(report, options);
    const summary = (list: FileCoverage[]) => {
        const lines = list.flatMap(f => [...f.lines.values()]);
        const branches = list.flatMap(f => f.branches.flatMap(b => [b.trueHits, b.falseHits]));
        return {
            linesValid: lines.length, linesCovered: lines.filter(h => h > 0).length,
            branchesValid: branches.length, branchesCovered: branches.filter(h => h > 0).length
        };
    };
    const all = summary(files);
    const out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">',
        `<coverage line-rate="${rate(all.linesCovered, all.linesValid)}" branch-rate="${rate(all.branchesCovered, all.branchesValid)}" `
        + `lines-covered="${all.linesCovered}" lines-valid="${all.linesValid}" branches-covered="${all.branchesCovered}" `
        + `branches-valid="${all.branchesValid}" complexity="0" version="devm-1" timestamp="${options.timestamp ?? Date.now()}">`,
        '  <sources>',
        `    <source>${escapeXml(options.sourceRoot ?? '.')}</source>`,
        '  </sources>',
        '  <packages>'
    ];
    for (const file of files) {
        const s = summary([file]);
        out.push(`    <package name="${escapeXml(file.file)}" line-rate="${rate(s.linesCovered, s.linesValid)}" branch-rate="${rate(s.branchesCovered, s.branchesValid)}" complexity="0">`);
        out.push('      <classes>');
        for (const machine of file.machines) {
            const lines = new Map<number, number>();
            for (const element of machine.elements) {
                if (element.line !== undefined) {
                    const current = lines.get(element.line);
                    lines.set(element.line, current === undefined ? element.hits : Math.min(current, element.hits));
                }
            }
            const branches = new Map<number, { covered: number, total: number }>();
            for (const guard of machine.guards) {
                if (guard.line === undefined) {
                    continue;
                }
                const b = branches.get(guard.line) ?? { covered: 0, total: 0 };
                b.covered += (guard.trueHits > 0 ? 1 : 0) + (guard.falseHits > 0 ? 1 : 0);
                b.total += 2;
                branches.set(guard.line, b);
                if (!lines.has(guard.line)) {
                    lines.set(guard.line, guard.trueHits + guard.falseHits);
                }
            }
            const lineCount = [...lines.values()];
            const branchCount = [...branches.values()];
            const bc = branchCount.reduce((sum, b) => sum + b.covered, 0);
            const bt = branchCount.reduce((sum, b) => sum + b.total, 0);
            out.push(`        <class name="${escapeXml(machine.machine)}" filename="${escapeXml(file.file)}" `
                + `line-rate="${rate(lineCount.filter(h => h > 0).length, lineCount.length)}" branch-rate="${rate(bc, bt)}" complexity="0">`);
            out.push('          <methods/>');
            out.push('          <lines>');
            for (const [line, hits] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
                const branch = branches.get(line);
                out.push(branch
                    ? `            <line number="${line}" hits="${hits}" branch="true" condition-coverage="${Math.round(branch.covered / branch.total * 100)}% (${branch.covered}/${branch.total})"/>`
                    : `            <line number="${line}" hits="${hits}" branch="false"/>`);
            }
            out.push('          </lines>');
            out.push('        </class>');
        }
        out.push('      </classes>');
        out.push('    </package>');
    }
    out.push('  </packages>', '</coverage>', '');
    return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// HTML

/**
 * Renders the diagram of a state machine with coverage highlighting as inline SVG (or any HTML),
 * e.g. `(machine, highlight) => renderSvg(layout(machine).graph, { highlight })`.
 */
export type CoverageDiagramRenderer = (machine: ast.StateMachine, highlight: CoverageHighlight) => string | Promise<string>;

export interface CoverageHtmlOptions extends CoverageReportOptions {
    /** Title of the report. */
    title?: string;
    /**
     * The state machine and its diagram highlighting for a machine of the report (e.g.
     * `CoverageCollector.diagramSource`); needed for diagrams.
     */
    diagramSource?: (machine: MachineCoverage) => { machine: ast.StateMachine, highlight: CoverageHighlight } | undefined;
    /** Renders the diagram of a machine; without it (or without `diagramSource`) the pages have no diagram. */
    renderDiagram?: CoverageDiagramRenderer;
}

/** A file of the HTML report. */
export interface ReportFile {
    /** Relative path (`index.html`, `Door.html`). */
    readonly path: string;
    readonly content: string;
}

/**
 * Self-contained HTML report: `index.html` with the summary and one page per state machine listing
 * all elements (covered / uncovered, hits, covering tests) and guards, with the diagram if a
 * {@link CoverageDiagramRenderer} is given (covered elements have the class `devm-covered`,
 * uncovered ones `devm-uncovered`).
 */
export async function toCoverageHtml(report: CoverageReport, options: CoverageHtmlOptions = {}): Promise<ReportFile[]> {
    const title = options.title ?? 'State machine coverage';
    const used = new Set<string>(['index']);
    const pages = report.machines.map(machine => {
        let base = machine.machine.replace(/[^\w.-]/g, '_') || 'machine';
        for (let i = 2; used.has(base.toLowerCase()); i++) {
            base = `${machine.machine.replace(/[^\w.-]/g, '_')}_${i}`;
        }
        used.add(base.toLowerCase());
        return { machine, path: `${base}.html` };
    });
    const files: ReportFile[] = [];
    const rows = pages.map(({ machine, path }) => `<tr><td><a href="${escapeXml(path)}">${escapeXml(machine.machine)}</a><div class="file">${escapeXml(fileOf(machine, options))}</div></td>${metricCells(machine.totals)}</tr>`);
    if (pages.length > 1) {
        rows.push(`<tr class="total"><td>Total</td>${metricCells(report.totals)}</tr>`);
    }
    files.push({
        path: 'index.html',
        content: htmlPage(title, `<h1>${escapeXml(title)}</h1>
<p class="meta">${report.tests} test${report.tests === 1 ? '' : 's'} · ${new Date().toISOString()}</p>
<table class="summary"><thead><tr><th>State machine</th>${COVERAGE_METRICS.map(m => `<th>${METRIC_TITLES[m]}</th>`).join('')}</tr></thead>
<tbody>${rows.join('\n')}</tbody></table>`)
    });
    for (const { machine, path } of pages) {
        let diagram = '';
        const entry = options.diagramSource?.(machine);
        if (entry && options.renderDiagram) {
            try {
                diagram = `<section class="diagram">${await options.renderDiagram(entry.machine, entry.highlight)}</section>`;
            } catch (error) {
                diagram = `<p class="meta">The diagram could not be rendered: ${escapeXml(error instanceof Error ? error.message : String(error))}</p>`;
            }
        }
        const elementRows = machine.elements.map(elementRow).join('\n');
        const guardRows = machine.guards.map(guardRow).join('\n');
        files.push({
            path,
            content: htmlPage(`${machine.machine} – ${title}`, `<p><a href="index.html">← ${escapeXml(title)}</a></p>
<h1>${escapeXml(machine.machine)}</h1>
<p class="meta">${escapeXml(fileOf(machine, options))}</p>
<table class="summary"><thead><tr>${COVERAGE_METRICS.map(m => `<th>${METRIC_TITLES[m]}</th>`).join('')}</tr></thead>
<tbody><tr>${metricCells(machine.totals)}</tr></tbody></table>
${diagram}
<h2>Elements</h2>
<table class="elements"><thead><tr><th>Line</th><th>Kind</th><th>Element</th><th>Hits</th><th>Tests</th></tr></thead>
<tbody>${elementRows}</tbody></table>
${machine.guards.length > 0 ? `<h2>Guards</h2>
<table class="elements"><thead><tr><th>Line</th><th>Guard</th><th>Of</th><th>true</th><th>false</th></tr></thead>
<tbody>${guardRows}</tbody></table>` : ''}`)
        });
    }
    return files;
}

function metricCells(totals: CoverageTotals): string {
    return COVERAGE_METRICS.map(metric => {
        const c = totals[metric];
        if (c.percent === undefined) {
            return '<td class="na">–</td>';
        }
        const level = c.percent >= 100 ? 'full' : c.percent >= 80 ? 'high' : c.percent >= 50 ? 'medium' : 'low';
        return `<td class="${level}"><div class="bar"><span style="width:${c.percent}%"></span></div>${c.percent.toFixed(1)}% <small>(${c.covered}/${c.total})</small></td>`;
    }).join('');
}

function elementRow(element: CoverageElement): string {
    const cls = element.hits > 0 ? 'covered' : 'uncovered';
    return `<tr class="${cls}" id="${escapeXml(element.id)}"><td class="num">${element.line ?? ''}</td><td>${element.kind === 'final' ? 'final state' : element.kind}</td>`
        + `<td><code>${escapeXml(element.name)}</code></td><td class="num">${element.hits}</td><td class="tests">${testList(element.tests)}</td></tr>`;
}

function guardRow(guard: GuardCoverage): string {
    const cls = guard.trueHits > 0 && guard.falseHits > 0 ? 'covered' : guard.trueHits + guard.falseHits > 0 ? 'partial' : 'uncovered';
    const cell = (hits: number, tests: readonly string[]) => `<td class="num ${hits > 0 ? 'yes' : 'no'}" title="${escapeXml(tests.join('\n'))}">${hits}</td>`;
    return `<tr class="${cls}"><td class="num">${guard.line ?? ''}</td><td><code>[${escapeXml(guard.expression)}]</code></td><td><code>${escapeXml(guard.name)}</code></td>`
        + `${cell(guard.trueHits, guard.trueTests)}${cell(guard.falseHits, guard.falseTests)}</tr>`;
}

function testList(tests: readonly string[]): string {
    if (tests.length === 0) {
        return '';
    }
    const shown = tests.slice(0, 3).map(escapeXml).join(', ');
    return tests.length <= 3 ? shown : `<details><summary>${shown}, … (${tests.length})</summary>${tests.slice(3).map(escapeXml).join(', ')}</details>`;
}

function htmlPage(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(title)}</title>
<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d9d9de; --ok: #e3f5e1; --ok-strong: #2e8b3a; --bad: #fde4e1; --bad-strong: #c62828; --warn: #fff4d6; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1b1d; --fg: #ececf1; --muted: #a0a0a8; --line: #3a3a40; --ok: #1f3a22; --ok-strong: #5cc46a; --bad: #43201e; --bad-strong: #ff6b5e; --warn: #3f3417; } }
body { margin: 0 auto; max-width: 1100px; padding: 16px; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
a { color: inherit; }
h1 { font-size: 22px; margin: 8px 0 4px; } h2 { font-size: 17px; margin-top: 28px; }
.meta, .file { color: var(--muted); font-size: 12px; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; font-size: 12px; color: var(--muted); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.covered td:first-child { box-shadow: inset 3px 0 var(--ok-strong); } tr.uncovered { background: var(--bad); } tr.uncovered td:first-child { box-shadow: inset 3px 0 var(--bad-strong); }
tr.partial { background: var(--warn); } td.no { color: var(--bad-strong); font-weight: 600; }
tr.total td { font-weight: 600; }
.bar { width: 80px; height: 6px; background: var(--bad); border-radius: 3px; overflow: hidden; margin-bottom: 2px; } .bar span { display: block; height: 100%; background: var(--ok-strong); }
td.na { color: var(--muted); } small { color: var(--muted); }
.tests { font-size: 12px; color: var(--muted); } code { font-size: 12.5px; word-break: break-word; }
.diagram { margin: 16px 0; overflow: auto; border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
.diagram svg { max-width: 100%; height: auto; }
.devm-covered { --devm-coverage: var(--ok-strong); } .devm-uncovered { --devm-coverage: var(--bad-strong); }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function escapeXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}
