import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/**
 * End-to-end test of the CMake integration (cmake/HsmGenerate.cmake) with the example project
 * examples/cmake in a temporary copy: configure, build, ctest, then incremental rebuilds after model
 * changes. Uses Ninja if available, Unix Makefiles otherwise. Skipped if cmake or a C++ compiler is
 * missing. The CLI is run from `out/` (compiled by `tsc -b` before the test).
 */

function available(command: string, args = ['--version']): boolean {
    try {
        return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
    } catch {
        return false;
    }
}

const HAS_CMAKE = available('cmake') && (available('c++') || available('g++') || available('clang++'));
/** `HSM_CMAKE_GENERATOR='Unix Makefiles' npm test` tests another generator. */
const GENERATOR = process.env.HSM_CMAKE_GENERATOR ?? (available('ninja') ? 'Ninja' : 'Unix Makefiles');
const packageDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(packageDir, '../..');
const cli = path.join(packageDir, 'bin/cli.js');

describe.skipIf(!HAS_CMAKE)(`CMake integration (${GENERATOR})`, () => {

    let dir: string;
    let build: string;
    const run = (command: string, args: string[], cwd = dir) => {
        const result = spawnSync(command, args, { cwd, encoding: 'utf-8' });
        return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };
    const cmakeBuild = () => run('cmake', ['--build', build]);
    const editModel = (file: string, from: string | RegExp, to: string) => {
        const model = path.join(dir, 'examples', file);
        const text = fs.readFileSync(model, 'utf-8');
        expect(text).toMatch(from);
        // on file systems with coarse timestamps the change must be in a later second than the last build
        const waitUntil = Date.now() + (fs.statSync(model).mtimeMs % 1000 === 0 ? 1100 : 20);
        while (Date.now() < waitUntil) {
            // busy wait (rare)
        }
        fs.writeFileSync(model, text.replace(from, to));
    };

    beforeAll(() => {
        execFileSync(process.execPath, [path.join(repoDir, 'node_modules/typescript/bin/tsc'), '-b', path.join(packageDir, 'tsconfig.json')]);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-cmake-'));
        build = path.join(dir, 'build');
        fs.cpSync(path.join(repoDir, 'cmake'), path.join(dir, 'cmake'), { recursive: true });
        for (const entry of ['cmake', 'tests', 'traffic-light.hsm', 'cd-player.hsm']) {
            fs.cpSync(path.join(repoDir, 'examples', entry), path.join(dir, 'examples', entry), { recursive: true });
        }
        fs.rmSync(path.join(dir, 'examples/cmake/generated'), { recursive: true, force: true });
    }, 120_000);

    afterAll(() => {
        if (dir) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('configure, build, ctest and incremental regeneration', () => {
        const configure = run('cmake', ['-S', path.join(dir, 'examples/cmake'), '-B', build, '-G', GENERATOR, `-DHSM_EXECUTABLE=${process.execPath};${cli}`]);
        expect(configure.output).toContain('hsm: using');
        expect(configure.status, configure.output).toBe(0);

        const first = cmakeBuild();
        expect(first.status, first.output).toBe(0);
        expect(first.output).toContain('Generating state machine code for traffic_light_sm');
        expect(fs.existsSync(path.join(build, 'hsm_generated/cd_player_sm/CdPlayer.cc'))).toBe(true);

        const ctest = run('ctest', ['--output-on-failure'], build);
        expect(ctest.status, ctest.output).toBe(0);
        expect(ctest.output).toContain('100% tests passed, 0 tests failed out of 3');
        expect(fs.readFileSync(path.join(build, 'hsm_test_results/traffic-light.xml'), 'utf-8')).toContain('<testsuite');

        // a comment: the code is regenerated but nothing is recompiled
        editModel('traffic-light.hsm', '// A pedestrian traffic light', '// A changed pedestrian traffic light');
        const comment = cmakeBuild();
        expect(comment.status, comment.output).toBe(0);
        expect(comment.output).toContain('Generating state machine code for traffic_light_sm');
        expect(comment.output).not.toContain('Building CXX');

        // behavior: only the traffic light is regenerated and recompiled
        editModel('traffic-light.hsm', 'every 500 ms', 'every 400 ms');
        const check = run(process.execPath, [cli, 'generate', 'cpp', path.join(dir, 'examples/traffic-light.hsm'), '--namespace', 'example',
            '--std', '17', '-o', path.join(build, 'hsm_generated/traffic_light_sm'), '--check']);
        expect(check.status, check.output).toBe(1);
        expect(check.output).toContain('TrafficLight.cpp');
        const behavior = cmakeBuild();
        expect(behavior.status, behavior.output).toBe(0);
        expect(behavior.output).toMatch(/Building CXX object .*TrafficLight\.cpp/);
        expect(behavior.output).not.toContain('code for cd_player_sm');
        expect(behavior.output).not.toMatch(/Building CXX object .*CdPlayer/);

        const noop = cmakeBuild();
        expect(noop.status, noop.output).toBe(0);
        expect(noop.output).not.toContain('Generating');
        expect(noop.output).not.toContain('Building CXX');
    }, 300_000);
});
