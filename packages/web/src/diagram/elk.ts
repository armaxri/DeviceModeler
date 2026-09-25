import ElkApi from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';

type ElkConstructor = typeof ElkApi;

/** ELK running in a web worker, so that the layout never blocks the user interface. */
export function createWorkerElk(): InstanceType<ElkConstructor> {
    const module = ElkApi as unknown as ElkConstructor | { default: ElkConstructor };
    const Constructor = typeof module === 'function' ? module : module.default;
    return new Constructor({ workerUrl: elkWorkerUrl });
}
