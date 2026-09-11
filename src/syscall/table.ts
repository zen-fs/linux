// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Syscalls } from '@zenfs/linux/uapi/abi';
import { Errno, withErrno } from 'kerium';
import { err } from 'kerium/log';
import type { Process } from '../process.js';
import { set_current } from '../process.js';
import type { Thread } from '../thread.js';

/** The thread a syscall returns through. Only a process running on one can make these calls. */
export function thread_of(proc: Process): Thread {
	if (!proc.thread) throw withErrno('ENOSYS', 'This process has no thread to return through');
	return proc.thread;
}

/**
 * What a syscall does.
 *
 * The {@link Process} is the kernel's, and never crosses back over: a handler that has something
 * bigger than a number to return leaves it in the process' region with `proc.thread.put`.
 */
export type SyscallHandler<K extends keyof Syscalls> = (
	proc: Process,
	...args: Parameters<Syscalls[K]>
) => number | bigint | void | Promise<number | bigint | void>;

/** Every syscall the kernel knows, by the name userspace calls it. */
export const syscalls = new Map<keyof Syscalls, SyscallHandler<never>>();

/** Add a syscall to the table, i.e. `SYSCALL_DEFINEn` */
export function define_syscall<K extends keyof Syscalls>(name: K, handler: SyscallHandler<K>): void {
	if (syscalls.has(name)) throw withErrno('EEXIST', `Syscall '${name}' is already defined`);
	syscalls.set(name, handler);
}

/**
 * Run a syscall on behalf of a process.
 * @returns what it returned, with a negative value being `-errno` the way a Linux syscall returns
 */
export async function dispatch(proc: Process, name: keyof Syscalls, args: unknown[]): Promise<number> {
	const handler = syscalls.get(name);
	if (!handler) return -Errno.ENOSYS;

	const previous = set_current(proc);

	try {
		const call = handler as (proc: Process, ...args: unknown[]) => number | bigint | void | Promise<number | bigint | void>;
		const value = await call(proc, ...args);
		return typeof value == 'number' ? value : Number(value ?? 0);
	} catch (e) {
		const errno = (e as { errno?: unknown }).errno;
		if (typeof errno == 'number') return -errno;

		// Nothing else should come out of a handler, so it is a kernel bug rather than a failed call
		err(`syscall ${name}: ${String(e)}`);
		return -Errno.EIO;
	} finally {
		set_current(previous);
	}
}
