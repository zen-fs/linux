// SPDX-License-Identifier: LGPL-3.0-or-later
import type { FromThread, SyscallMessage, ToThread } from '@zenfs/linux/uapi/abi';
import { defaultRegionSize, regionOffset, SyscallData, SyscallStatus } from '@zenfs/linux/uapi/abi';
import { Errno, withErrno } from 'kerium';
import { err } from 'kerium/log';
import type { Process } from './process.js';
import type { Signal } from './signal.js';
import { dispatch } from './syscall/table.js';

/** Whatever the host runs a thread on: a web worker, or one of Node's. */
export interface HostThread {
	post(message: ToThread): void;
	terminate(): void;
	onMessage(handler: (message: FromThread) => void): void;
	onExit(handler: (code: number) => void): void;
	onError(handler: (error: unknown) => void): void;
}

export type ThreadFactory = (interpreter: Uint8Array) => HostThread | Promise<HostThread>;

/** The parts of a web worker this uses, so the kernel does not need the DOM to be typed */
interface WebWorker {
	postMessage(message: unknown): void;
	terminate(): void;
	addEventListener(type: string, listener: (event: WorkerEvent) => void): void;
}

/** A `MessageEvent` or an `ErrorEvent`, as much of either as this needs */
interface WorkerEvent {
	data?: unknown;
	message?: string;
	filename?: string;
	lineno?: number;
	error?: unknown;
}

/**
 * What a web worker's `error` event actually says.
 * Stringifying one gives `[object ErrorEvent]`, which says nothing at all.
 */
function describe(event: WorkerEvent): string {
	if (!event.message) return String(event.error ?? event);
	return event.message + (event.filename ? ` (${event.filename}:${event.lineno})` : '');
}

const WebWorker = (globalThis as { Worker?: new (url: URL, options?: { type?: string }) => WebWorker }).Worker;

/** Kept out of the import so it stays opaque to bundlers; a browser build never reaches it */
const node_worker_threads = 'node:' + 'worker_threads';

const entries = new Map<Uint8Array, URL>();

function entry_for(interpreter: Uint8Array): URL {
	let entry = entries.get(interpreter);
	if (entry) return entry;

	if (WebWorker) {
		const blob = new Blob([interpreter as Uint8Array<ArrayBuffer>], { type: 'text/javascript' });
		entry = new URL(URL.createObjectURL(blob));
	} else {
		// Node won't take a blob URL for a worker, but it does read a module out of a `data:` URL
		entry = new URL('data:text/javascript;base64,' + base64(interpreter));
	}

	entries.set(interpreter, entry);
	return entry;
}

function base64(data: Uint8Array): string {
	let text = '';
	for (const byte of data) text += String.fromCharCode(byte);
	return btoa(text);
}

async function host_thread(interpreter: Uint8Array): Promise<HostThread> {
	const entry = entry_for(interpreter);

	if (WebWorker) {
		const worker = new WebWorker(entry, { type: 'module' });

		return {
			post: message => worker.postMessage(message),
			terminate: () => worker.terminate(),
			onMessage: handler => worker.addEventListener('message', event => handler(event.data as FromThread)),
			// A web worker has nothing to say when it goes, so an error is the only end we hear about
			onExit: () => {},
			onError: handler => worker.addEventListener('error', event => handler(describe(event))),
		};
	}

	const { Worker: NodeWorker } = (await import(/* @vite-ignore */ node_worker_threads)) as typeof import('node:worker_threads');
	const worker = new NodeWorker(entry);

	return {
		post: message => worker.postMessage(message),
		terminate: () => void worker.terminate(),
		onMessage: handler => void worker.on('message', handler),
		onExit: handler => void worker.on('exit', handler),
		onError: handler => void worker.on('error', handler),
	};
}

export let create_thread: ThreadFactory = host_thread;

/** Run threads on something else, e.g. a pool or a stub for testing */
export function set_thread_factory(factory: ThreadFactory): void {
	create_thread = factory;
}

/**
 * The kernel's half of a process running on its own thread.
 *
 * Everything a sync syscall returns goes through the shared page, since a thread waiting on it can't
 * be handed a message. The page is the control block followed by the return region.
 */
export class Thread {
	public readonly page: SharedArrayBuffer;

	protected readonly control: SyscallData;

	/** Where a syscall leaves anything too big for the control block */
	public readonly region: Uint8Array;

	protected host?: HostThread;

	/** The syscall the thread is blocked on, so a result that arrives after it gave up can be dropped */
	protected blockedOn?: number;

	protected readonly _exited = Promise.withResolvers<number>();

	/** Resolves with the exit code once the thread is gone */
	public readonly exited: Promise<number> = this._exited.promise;

	/** The signals raised but not yet taken, as `1 << sig` */
	public get pending_signals(): number {
		return this.control.signals;
	}

	protected _interrupts = 0;

	/**
	 * How many signals have been raised on the thread.
	 *
	 * The thread clears {@link pending_signals} as soon as it wakes, and it does that on its own core,
	 * so the kernel can lose the race to see the flag. This only ever goes up, so a wait that started
	 * before a signal can always tell one arrived.
	 */
	public get interrupts(): number {
		return this._interrupts;
	}

	public constructor(
		public readonly proc: Process,
		regionSize: number = defaultRegionSize
	) {
		// Serve it with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.'
		if (!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) throw withErrno('ENOSYS', 'Missing SharedArrayBuffer!');

		this.page = new SharedArrayBuffer(regionOffset + regionSize);
		this.control = new SyscallData(this.page);
		this.region = new Uint8Array(this.page, regionOffset, regionSize);
	}

	/**
	 * Start the thread.
	 *
	 * The kernel loads the interpreter and nothing else: the thread runs that, and the interpreter
	 * goes and gets the program itself. When a program needs no interpreter it is its own.
	 *
	 * @param source the interpreter's bytes, read out of the file system
	 */
	public async start(exe: string, interpreter: string, source: Uint8Array): Promise<void> {
		const host = (this.host = await create_thread(source));

		host.onMessage(message => {
			if (message.$ == 'syscall') void this.syscall(message);
		});
		host.onError(error => err(`pid ${this.proc.pid}: ${String(error)}`));
		host.onExit(code => this._exited.resolve(this.proc.code ?? code));

		host.post({
			$: 'init',
			page: this.page,
			pid: this.proc.pid,
			argv: this.proc.argv,
			env: this.proc.env,
			cwd: this.proc.cwd,
			exe,
			interpreter,
		});
	}

	/**
	 * Put something in the return region.
	 * A syscall that has more than fits comes back short, which is what a `read` does anyway.
	 * @returns how much of it made it
	 */
	public put(data: Uint8Array): number {
		const length = Math.min(data.byteLength, this.region.byteLength);
		this.region.set(data.subarray(0, length));
		return this.filled(length);
	}

	/** Say how much of the region a syscall wrote into it in place @returns the same */
	public filled(length: number): number {
		this.control.length = Math.min(length, this.region.byteLength);
		return this.control.length;
	}

	protected async syscall({ id, name, args, sync }: SyscallMessage): Promise<void> {
		if (sync) this.blockedOn = id;
		this.control.length = 0;

		const value = await dispatch(this.proc, name, args);

		if (!sync) {
			this.host?.post({ $: 'return', id, value, region: this.region.slice(0, this.control.length) });
			return;
		}

		// A signal woke the thread while this was running, so it is no longer waiting for it
		if (this.blockedOn != id) return;

		this.blockedOn = undefined;
		this.wake(value);
	}

	protected wake(value: number): void {
		this.control.value = BigInt(value);
		Atomics.store(this.control.status, 0, SyscallStatus.Done);
		Atomics.notify(this.control.status, 0);
	}

	/**
	 * Raise a signal on the thread.
	 *
	 * A thread blocked in a syscall is woken with `EINTR` so its handlers run, the same way Linux
	 * delivers a signal on the way back to userspace. One that is off computing sees it whenever it
	 * makes its next syscall, which is why {@link kill} exists.
	 */
	public raise(signal: Signal): void {
		this.control.signals |= 1 << signal;
		this._interrupts++;

		// Anything the kernel is still working on for this process gives up rather than being waited for
		this.proc.sigwait.wake_up();

		if (this.blockedOn === undefined) return;

		this.blockedOn = undefined;
		this.control.length = 0;
		this.wake(-Errno.EINTR);
	}

	/** Stop the thread where it stands. This is the only thing that reaches one that isn't listening. */
	public kill(): void {
		this.host?.terminate();
		this.host = undefined;
		this._exited.resolve(this.proc.code ?? 128);
	}
}
