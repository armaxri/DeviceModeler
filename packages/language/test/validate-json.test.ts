import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { validateJson } from '../src/cli/validate-json.js';

describe('devm validate --json', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devm-validate-json-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('valid models with imports have no problems', async () => {
        const gate = path.resolve(__dirname, '../../../examples/door-with-motor/gate.devm');
        const result = await validateJson([gate]);
        expect(result.files).toEqual([{ file: gate, path: gate, problems: [] }]);
    });

    test('problems with 1-based positions and offsets, several files, unreadable files', async () => {
        const text = 'statemachine Broken {\r\n    [*] -> Missing\r\n    state Idle\r\n}\r\n';
        fs.writeFileSync(path.join(dir, 'broken.devm'), text);
        fs.writeFileSync(path.join(dir, 'gate.devm'), 'statemachine Gate {\n    import "nothing.devm"\n    [*] -> Idle\n    state Idle\n}\n');
        const result = await validateJson([path.join(dir, 'broken.devm'), path.join(dir, 'gate.devm'), path.join(dir, 'missing.devm')]);
        expect(result.files.map(file => path.basename(file.path))).toEqual(['broken.devm', 'gate.devm', 'missing.devm']);

        const missingState = result.files[0].problems.find(problem => problem.message.includes('Missing'))!;
        expect(missingState).toMatchObject({ severity: 'error', line: 2, path: path.join(dir, 'broken.devm') });
        // the offsets point at the text of the range (CR LF counted as two characters, as in Eclipse documents)
        expect(text.substring(missingState.offset, missingState.end)).toContain('Missing');
        expect(missingState.column).toBe(missingState.offset - text.indexOf('\n') );

        expect(result.files[1].problems.some(problem => problem.severity === 'error' && problem.message.includes('nothing.devm'))).toBe(true);
        expect(result.files[2].problems).toEqual([expect.objectContaining({ severity: 'error', line: 0, offset: -1 })]);
    });
});
