// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The syscall boundary, from userspace.
 *
 * A sync syscall goes out over `postMessage` and the thread then blocks on the shared page, so the
 * arguments can be any values structured clone handles but the result cannot: it comes back as an
 * `i64`, with anything bigger left in the region. {@link returned} is that region.
 */
import { Errno, UV } from 'kerium';
import type { InitMessage, Syscalls } from './abi.js';
import { regionOffset, SyscallData, SyscallStatus } from './abi.js';
import { receive, send } from './port.js';

/** The control block of this thread's shared page, once the kernel has handed it over */
let control: SyscallData | undefined;

/** What the last syscall left behind */
let region: Uint8Array<ArrayBufferLike> = new Uint8Array();

/** What the last syscall returned, kept whole since a `number` can't hold every `i64` exactly */
let value = 0n;

/** What the kernel started this thread with */
export let init: InitMessage | undefined;

const started = Promise.withResolvers<InitMessage>();

/** Resolves once the kernel has handed over the shared page and this thread knows what it is */
export const ready: Promise<InitMessage> = started.promise;

const waiters = new Map<number, PromiseWithResolvers<number>>();

/** What userspace does when a signal arrives, i.e. the handlers `sigaction` installed */
export type SignalHandler = (signal: number) => void;

const signalHandlers = new Map<number, Set<SignalHandler>>();

receive(message => {
	switch (message.$) {
		case 'init':
			control = new SyscallData(message.page);
			init = message;
			started.resolve(message);
			break;
		case 'return': {
			const waiter = waiters.get(message.id);
			if (!waiter) return;
			waiters.delete(message.id);
			region = message.region ?? new Uint8Array();
			value = BigInt(message.value);
			waiter.resolve(message.value);
			break;
		}
	}
});

/**
 * Run the handlers for every signal in a pending mask.
 * The kernel raises these while the thread is blocked, so they run when it comes back up, the same
 * way Linux delivers a signal on the way back to userspace.
 */
function deliver(pending: number): void {
	for (let signal = 1; signal < 32; signal++) {
		if (!(pending & (1 << signal))) continue;
		for (const handler of [...(signalHandlers.get(signal) ?? [])]) handler(signal);
	}
}

/** Ask to be told when a signal arrives. The kernel is told too, so it stops taking the default action. */
export function on_signal(signal: number, handler: SignalHandler): void {
	let handlers = signalHandlers.get(signal);
	if (!handlers) signalHandlers.set(signal, (handlers = new Set()));
	handlers.add(handler);
	syscall('sigaction', signal, true);
}

/** Go back to the default action for a signal */
export function off_signal(signal: number, handler?: SignalHandler): void {
	const handlers = signalHandlers.get(signal);
	if (!handlers) return;

	if (handler) handlers.delete(handler);
	else handlers.clear();

	if (handlers.size) return;
	signalHandlers.delete(signal);
	syscall('sigaction', signal, false);
}

let _nextId = 1;

/**
 * Make a syscall and block until it is done.
 * @returns what the kernel returned, with a negative value being `-errno` the way a Linux syscall returns
 */
export function syscall_raw<K extends keyof Syscalls>(name: K, ...args: Parameters<Syscalls[K]>): number {
	if (!control) throw UV('ENOSYS', { syscall: name });

	const id = _nextId++;
	control.id = id;
	control.length = 0;
	control.signals = 0;
	Atomics.store(control.status, 0, SyscallStatus.Pending);

	send({ $: 'syscall', id, name, args, sync: true });

	// `not-equal` means the kernel answered before we got here, so either way the page has the result
	Atomics.wait(control.status, 0, SyscallStatus.Pending);

	value = control.value;
	region = new Uint8Array(control.buffer, regionOffset, control.length);

	// A handler can make syscalls of its own, so nothing may be read out of the page after this
	const pending = control.signals;
	if (pending) {
		control.signals = 0;
		deliver(pending);
	}

	return Number(value);
}

/**
 * Make a syscall and block until it is done.
 * @throws whatever the syscall failed with
 */
export function syscall<K extends keyof Syscalls>(name: K, ...args: Parameters<Syscalls[K]>): number {
	const value = syscall_raw(name, ...args);
	if (value < 0) throw UV(errno_name(-value), { syscall: name });
	return value;
}

/**
 * Like {@link syscall}, for the handful that count in something a `number` can't hold exactly, e.g.
 * an offset in a file.
 */
export function syscall_64<K extends keyof Syscalls>(name: K, ...args: Parameters<Syscalls[K]>): bigint {
	syscall(name, ...args);
	return value;
}

/**
 * Make a syscall without blocking. The kernel answers with a message, so this works with no shared
 * page at all, which is what a browser without cross-origin isolation gives you.
 */
export async function syscall_async<K extends keyof Syscalls>(name: K, ...args: Parameters<Syscalls[K]>): Promise<number> {
	const id = _nextId++;
	const waiter = Promise.withResolvers<number>();
	waiters.set(id, waiter);
	send({ $: 'syscall', id, name, args, sync: false });

	const value = await waiter.promise;
	if (value < 0) throw UV(errno_name(-value), { syscall: name });
	return value;
}

/** The signals raised on this thread that have not been delivered yet, as `1 << sig`.. */
export function pending(): number {
	return control?.signals ?? 0;
}

/**
 * What the last syscall left in the region, e.g. the bytes a `read` moved or the `struct stat` a
 * `stat` filled. It is only good until the next syscall.
 */
export function returned(): Uint8Array {
	return region;
}

/** kerium's `Errno` is a numeric enum, so the name a code goes with is a lookup away */
function errno_name(code: number): keyof typeof Errno {
	return (Errno as unknown as Record<number, keyof typeof Errno>)[code] ?? 'EINVAL';
}
