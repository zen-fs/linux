// SPDX-License-Identifier: LGPL-3.0-or-later
import { fs } from '@zenfs/core';
import { O_RDONLY, X_OK } from '@zenfs/core/constants';
import { UV } from 'kerium';
import type { ProcessInit } from '../process.js';
import { Process } from '../process.js';
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

/** A way of loading a program, like `struct linux_binfmt` */
export interface BinFmt {
	name: string;
	matches(prm: BinPrm): boolean;
	load(prm: BinPrm): () => any;
}

/** The registered formats, in the order they are tried */
export const binfmts = new Set<BinFmt>([binfmt_js]);

/** Hand the program to the first format that recognizes */
export function search_binary_handler(prm: BinPrm): () => any {
	for (const fmt of binfmts) {
		if (fmt.matches(prm)) return fmt.load(prm);
	}

	throw UV('ENOEXEC', 'execve', prm.filename);
}

/** Replace what `proc` is running with `path` */
export function execve(proc: Process, path: string, argv: string[] = [path], env: Record<string, string> = proc.env): number {
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

	try {
		// Linux returns to userspace here and the program runs on its own; nothing here can do that.
		do_exec();
	} catch (e) {
		if (e !== Process.exit) throw e;
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
