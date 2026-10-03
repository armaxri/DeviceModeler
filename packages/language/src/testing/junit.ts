import type { TestResult } from './runner.js';

/**
 * JUnit XML report of test results (one `<testsuite>` per test class), as understood by CI
 * systems (GitHub Actions, GitLab, Jenkins).
 */
export function toJUnitXml(results: readonly TestResult[], options: { name?: string, fileName?: (uri: string) => string } = {}): string {
    const name = options.name ?? 'devm-tests';
    const fileName = options.fileName ?? ((uri: string) => uri);
    const suites = new Map<string, TestResult[]>();
    for (const result of results) {
        const suite = suites.get(result.testClass);
        if (suite) {
            suite.push(result);
        } else {
            suites.set(result.testClass, [result]);
        }
    }
    const count = (list: readonly TestResult[], status: TestResult['status']) => list.filter(r => r.status === status).length;
    const seconds = (list: readonly TestResult[]) => (list.reduce((sum, r) => sum + r.durationMs, 0) / 1000).toFixed(3);
    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<testsuites name="${escape(name)}" tests="${results.length}" failures="${count(results, 'failed')}" errors="${count(results, 'error')}" time="${seconds(results)}">`
    ];
    for (const [testClass, list] of suites) {
        lines.push(`  <testsuite name="${escape(testClass)}" tests="${list.length}" failures="${count(list, 'failed')}" errors="${count(list, 'error')}" skipped="0" time="${seconds(list)}">`);
        for (const result of list) {
            const attributes = `name="${escape(result.name)}" classname="${escape(testClass)}" time="${(result.durationMs / 1000).toFixed(3)}"`
                + (result.uri ? ` file="${escape(fileName(result.uri))}"` : '') + (result.line ? ` line="${result.line}"` : '');
            if (result.status === 'passed') {
                lines.push(`    <testcase ${attributes}/>`);
                continue;
            }
            const element = result.status === 'failed' ? 'failure' : 'error';
            const location = result.line ? `line ${result.line}: ` : '';
            lines.push(`    <testcase ${attributes}>`);
            lines.push(`      <${element} message="${escape(result.message ?? '')}" type="${result.status === 'failed' ? 'AssertionFailure' : 'Error'}">${escape(`${location}${result.message ?? ''}\n${result.trace.join('\n')}`)}</${element}>`);
            lines.push('    </testcase>');
        }
        lines.push('  </testsuite>');
    }
    lines.push('</testsuites>', '');
    return lines.join('\n');
}

function escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        // characters which are not allowed in XML 1.0
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}
