// SPDX-License-Identifier: LGPL-3.0-or-later
import { fs } from '@zenfs/core';
import { O_RDONLY, X_OK } from '@zenfs/core/constants';
import { UV } from 'kerium';
import { warn } from 'kerium/log';
import type { ProcessInit } from '../process.js';
import { Process, run_in, set_current } from '../process.js';
import binfmt_js from './binfmt_js.js';

export const binPrmBufSize = 256;

/** Everything a format needs to load a program, like `struct linux_binprm` */
export interface BinPrm {
	proc: Process;
	/** The path of the executable */
	filename: string;
	/** The first {@link binPrmBufSize} bytes of it, for recognizing the format */
	buf: Uint8Array;
	argv: string[];
	env: Record<string, string>;
}

/**
 * A way of loading a program, like `struct linux_binfmt`.
 * `load` may return an async thunk for a program that genuinely can't load synchronously
 * (e.g. `await import(...)`). Sync `execve` throws if handed one - use {@link execve_async} instead.
 */
export interface BinFmt {
	name: string;
	matches(prm: BinPrm): boolean;
	load(prm: BinPrm): (() => any) | (() => Promise<any>);
}

/** The registered formats, in the order they are tried */
export const binfmts = new Set<BinFmt>([binfmt_js]);

/** Hand the program to the first format that recognizes */
export function search_binary_handler(prm: BinPrm): (() => any) | (() => Promise<any>) {
	for (const fmt of binfmts) {
		if (fmt.matches(prm)) return fmt.load(prm);
	}

	throw UV('ENOEXEC', 'execve', prm.filename);
}

/** Read the header `search_binary_handler` needs and set up `proc` for a new program, shared by sync and async exec */
function prepare_exec(proc: Process, path: string, argv: string[], env: Record<string, string>): { filename: string; do_exec: () => any } {
	const $ = proc.context;

	const filename = fs.realpathSync.call($, path);
	fs.accessSync.call($, filename, X_OK);

	const buffer = new Uint8Array(binPrmBufSize);
	const fd = fs.openSync.call($, filename, O_RDONLY);
	let read: number;
	try {
		read = fs.readSync.call($, fd, buffer, 0, binPrmBufSize, 0);
	} finally {
		fs.closeSync.call($, fd);
	}

	proc.argv = argv;
	proc.exe = filename;
	proc.env = { ...env };
	proc.code = undefined;

	const do_exec = search_binary_handler({ proc, filename, buf: buffer.subarray(0, read), argv, env: proc.env });

	return { filename, do_exec };
}

/** Replace what `proc` is running with `path` */
export function execve(proc: Process, path: string, argv: string[] = [path], env: Record<string, string> = proc.env): number {
	const { filename, do_exec } = prepare_exec(proc, path, argv, env);

	const previous = set_current(proc);
	if (proc.tty) proc.tty.foreground = proc;

	proc.set_exiting(true);
	try {
		// Linux returns to userspace here and the program runs on its own; nothing here can do that.
		const result = do_exec();
		if (result instanceof Promise) {
			// Don't leave the program's rejection unhandled just because we can't wait for it here.
			result.catch(e => warn(`execve: async handler for "${filename}" rejected after being run synchronously: ${String(e)}`));
			throw UV('ENOEXEC', 'execve', `${filename}: binfmt handler is async; use execve_async`);
		}
	} catch (e) {
		if (e !== Process.exit) throw e;
	} finally {
		proc.set_exiting(false);
		set_current(previous);
	}

	return proc.code ?? 0;
}

/** Fork a child of `parent`, run a program in it, and wait for it */
export function spawn(
	parent: Process,
	path: string,
	argv: string[] = [path],
	env: Record<string, string> = parent.env,
	init: ProcessInit = {}
): number {
	using proc = new Process({ ...init, parent, argv, env });
	return execve(proc, path, argv, env);
}

/**
 * Async form of {@link execve}. Works with both sync and async `BinFmt.load` handlers -
 * `await` on a non-promise is just a microtask, so a sync handler runs exactly as it would under `execve`.
 */
export async function execve_async(proc: Process, path: string, argv: string[] = [path], env: Record<string, string> = proc.env): Promise<number> {
	const { do_exec } = prepare_exec(proc, path, argv, env);

	if (proc.tty) proc.tty.foreground = proc;

	proc.set_exiting(true);
	try {
		await run_in(proc, do_exec);
	} catch (e) {
		if (e !== Process.exit) throw e;
	} finally {
		proc.set_exiting(false);
	}

	return proc.code ?? 0;
}

/** Fork a child of `parent`, run a program in it, and wait for it, the async way. */
export async function spawn_async(
	parent: Process,
	path: string,
	argv: string[] = [path],
	env: Record<string, string> = parent.env,
	init: ProcessInit = {}
): Promise<number> {
	// Not `using`: disposal has to happen after the await, not at sync scope exit,
	// or the process would be torn down while the program it's running is still suspended.
	const proc = new Process({ ...init, parent, argv, env });
	try {
		return await execve_async(proc, path, argv, env);
	} finally {
		proc.dispose();
	}
}
