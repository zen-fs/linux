// SPDX-License-Identifier: LGPL-3.0-or-later
/** The process and signal syscalls */
import type { UtsNameFields } from './abi.js';
import { read_utsname, UtsName } from './abi.js';
import { init, returned, syscall } from './base.js';

export { off_signal, on_signal, ready, type SignalHandler } from './base.js';

/** What this process was started with. Empty until the kernel has said. */
export function argv(): string[] {
	return init?.argv ?? [];
}

export function environ(): Record<string, string> {
	return init?.env ?? {};
}

export function getpid(): number {
	return syscall('getpid');
}

export function getppid(): number {
	return syscall('getppid');
}

export function getuid(): number {
	return syscall('getuid');
}

export function geteuid(): number {
	return syscall('geteuid');
}

export function getgid(): number {
	return syscall('getgid');
}

export function getegid(): number {
	return syscall('getegid');
}

/**
 * Stop this process. The kernel tears the thread down, so this never comes back.
 */
export function exit(code: number = 0): never {
	syscall('exit', code);

	// The thread is gone by the time the kernel answers, so this is only here to satisfy the type
	throw new Error('exit returned');
}

/** Start a child running `path`. It inherits the descriptors, the way it would across a fork. */
export function spawn(path: string, argv: string[] = [path], env: Record<string, string> = environ(), cwd?: string): number {
	return syscall('spawn', path, argv, env, cwd);
}

/** Replace what this process is running. Like {@link exit}, the thread does not survive it. */
export function execve(path: string, argv: string[] = [path], env: Record<string, string> = environ()): never {
	syscall('execve', path, argv, env);
	throw new Error('execve returned');
}

/**
 * Block until a child exits.
 * @param pid which child, or -1 for whichever exits first
 * @returns its exit code
 */
export function wait(pid: number = -1): number {
	return syscall('wait', pid);
}

export function kill(pid: number, signal: number): void {
	syscall('kill', pid, signal);
}

export function uname(): UtsNameFields {
	syscall('uname');
	const region = returned();
	return read_utsname(new UtsName(region.buffer, region.byteOffset));
}
