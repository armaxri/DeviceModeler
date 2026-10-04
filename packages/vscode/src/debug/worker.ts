/*
 * Entry of the debug worker (dist/debug-worker.cjs): runs the tests of a debug session with the
 * {@link DebugEngine}. The worker blocks while the engine is paused; commands of the adapter arrive on a
 * dedicated message port and are read synchronously (`receiveMessageOnPort`), signalled through a shared
 * counter (`Atomics.notify`).
 */
import { parentPort, receiveMessageOnPort, workerData, type MessagePort } from 'node:worker_threads';
import { DebugEngine, TerminatedError, type EngineHost } from './engine.js';
import type { EngineCommand, EngineMessage, EngineStart } from './protocol.js';

interface WorkerData {
    start: EngineStart;
    commands: MessagePort;
    signal: SharedArrayBuffer;
}

/** How long (ms) a paused worker waits before checking again (also lets `terminate` take effect). */
const WAIT_MS = 250;

export function createWorkerHost(commands: MessagePort, signal: Int32Array, post: (message: EngineMessage) => void): EngineHost {
    let seen = Atomics.load(signal, 0);
    const receive = (): EngineCommand | undefined => receiveMessageOnPort(commands)?.message as EngineCommand | undefined;
    return {
        post,
        waitForCommand() {
            for (;;) {
                const command = receive();
                if (command) {
                    return command;
                }
                const current = Atomics.load(signal, 0);
                // a command posted between the receive and the load is received now
                const late = receive();
                if (late) {
                    return late;
                }
                Atomics.wait(signal, 0, current, WAIT_MS);
            }
        },
        pollCommands() {
            const current = Atomics.load(signal, 0);
            if (current === seen) {
                return [];
            }
            seen = current;
            const result: EngineCommand[] = [];
            for (let command = receive(); command; command = receive()) {
                result.push(command);
            }
            return result;
        }
    };
}

if (parentPort && workerData) {
    const data = workerData as WorkerData;
    const port = parentPort;
    const host = createWorkerHost(data.commands, new Int32Array(data.signal), message => port.postMessage(message));
    new DebugEngine(data.start, host).run().catch(error => {
        if (!(error instanceof TerminatedError)) {
            port.postMessage({ type: 'fatal', message: error instanceof Error ? error.stack ?? error.message : String(error) } satisfies EngineMessage);
        }
    }).finally(() => data.commands.close());
}
