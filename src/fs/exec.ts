// SPDX-License-Identifier: LGPL-3.0-or-later
import { fs } from '@zenfs/core';
import { O_RDONLY, X_OK } from '@zenfs/core/constants';
import { UV } from 'kerium';
import type { ProcessInit } from '../process.js';
import { Process } from '../process.js';
import { Thread } from '../thread.js';
import binfmt_js from './binfmt_js.js';

export const binPrmBufSize = 256;

/** Everything a format needs to recognize a program, like `struct linux_binprm` */
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
 *
 * The kernel only picks the format; the loading itself happens on the process' own thread, so all a
 * format contributes is the module that thread imports to do it.
 */
export interface BinFmt {
	name: string;
	matches(prm: BinPrm): boolean;
	/** What the thread imports before the program, to put whatever it needs in place */
	runtime?: string;
}

/** The registered formats, in the order they are tried */
export const binfmts = new Set<BinFmt>([binfmt_js]);

/** Hand the program to the first format that recognizes it */
export function search_binary_handler(prm: BinPrm): BinFmt {
	for (const fmt of binfmts) {
		if (fmt.matches(prm)) return fmt;
	}

	throw UV('ENOEXEC', 'execve', prm.filename);
}

/**
 * Replace what `proc` is running with `path`.
 *
 * A new image means a new thread: the old one is torn down and the program is loaded on a fresh one,
 * which is as close to what Linux does as there is here. This comes back once the program is loaded,
 * not once it is done, so wait on {@link Process.exited} for that.
 */
export async function execve(proc: Process, path: string, argv: string[] = [path], env: Record<string, string> = proc.env): Promise<void> {
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

	const fmt = search_binary_handler({ proc, filename, buf: buffer.subarray(0, read), argv, env: proc.env });

	proc.thread?.kill();

	proc.thread = new Thread(proc);
	if (proc.tty) proc.tty.foreground = proc;

	await proc.thread.start(filename, fmt.runtime);
}

/**
 * Fork a child of `parent` and run a program in it.
 * This comes back with the child, which is still running; `parent.wait(child.pid)` reaps it.
 */
export async function spawn(
	parent: Process,
	path: string,
	argv: string[] = [path],
	env: Record<string, string> = parent.env,
	init: ProcessInit = {}
): Promise<Process> {
	const proc = new Process({ ...init, parent, argv, env });

	try {
		await execve(proc, path, argv, env);
	} catch (e) {
		proc.dispose();
		throw e;
	}

	return proc;
}
