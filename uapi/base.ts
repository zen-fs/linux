function serialize(arg: unknown) {
	// @todo
}

function parse(value: unknown) {
	// @todo
}

export interface InitData {
	$type: 'init';
	/** Used to block for sync syscalls */
	sync: SharedArrayBuffer;
}

export interface SyscallReturn<T = any> {
	$type: 'ret';
	id: number;
	value: T;
	error?: Error;
}

let syncSyscallData: SharedArrayBuffer;

const asyncWaiters = new Map<number, [resolve: PromiseWithResolvers<any>['resolve'], reject: PromiseWithResolvers<any>['reject']]>();

addEventListener('message', event => {
	if (!event.data) return;

	const data = event.data as InitData | SyscallReturn;

	switch (data.$type) {
		case 'init': {
			syncSyscallData = data.sync;
			break;
		}
		case 'ret': {
			const { id, value, error } = data as SyscallReturn;

			const resolvers = asyncWaiters.get(id);
			if (!resolvers) return;

			const [resolve, reject] = resolvers;
			// @todo consider parsing errors
			if (error) reject(error);
			else resolve(parse(value));
			break;
		}
	}
});

let _nextSyscallId = 1;

export async function syscall<T>(name: string, ...args: any[]): Promise<T> {
	const id = _nextSyscallId++;
	postMessage({ name, args: args.map(serialize), id });
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	asyncWaiters.set(id, [resolve, reject]);
	return promise;
}

export function syscallSync<T>(name: string, ...args: any[]): T {
	const id = _nextSyscallId++;

	syncSyscallData;

	postMessage({ name, args: args.map(serialize), id, sync: true });
}
