import { MessageChannel, Worker } from 'node:worker_threads';
import type { EngineCommand, EngineMessage, EngineStart } from './protocol.js';

/** The adapter side of a running debug engine. */
export interface EngineConnection {
    send(command: EngineCommand): void;
    /** Stops the engine (also while it is paused). */
    terminate(): Promise<void>;
}

export type EngineFactory = (start: EngineStart, listener: (message: EngineMessage) => void, exited: (error?: Error) => void) => EngineConnection;

/**
 * Starts the debug engine in a worker thread (`script`: the bundled `debug-worker.cjs`). Commands are
 * posted to a dedicated port and signalled through a shared counter, so the paused worker can read them
 * synchronously.
 */
export function workerEngineFactory(script: string): EngineFactory {
    return (start, listener, exited) => {
        const channel = new MessageChannel();
        const signal = new SharedArrayBuffer(4);
        const counter = new Int32Array(signal);
        const worker = new Worker(script, { workerData: { start, commands: channel.port2, signal }, transferList: [channel.port2] });
        let ended = false;
        const end = (error?: Error) => {
            if (!ended) {
                ended = true;
                channel.port1.close();
                exited(error);
            }
        };
        worker.on('message', message => listener(message as EngineMessage));
        worker.on('error', error => end(error));
        worker.on('exit', () => end());
        return {
            send(command) {
                if (!ended) {
                    channel.port1.postMessage(command);
                    Atomics.add(counter, 0, 1);
                    Atomics.notify(counter, 0);
                }
            },
            async terminate() {
                if (!ended) {
                    this.send({ type: 'terminate' });
                    await worker.terminate();
                    end();
                }
            }
        };
    };
}
