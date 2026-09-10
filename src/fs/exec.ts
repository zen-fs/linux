// SPDX-License-Identifier: LGPL-3.0-or-later
import { fs } from '@zenfs/core';
import { O_RDONLY, X_OK } from '@zenfs/core/constants';
import { UV } from 'kerium';
import type { ProcessInit } from '../process.js';
import { Process } from '../process.js';
import { Thread } from '../thread.js';
import { decodeASCII } from 'utilium';

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
 */
export interface BinFmt {
	name: string;
	matches(prm: BinPrm): boolean;
	/** What runs a program of this format, or nothing when the program runs itself */
	interpreter?: string;
}

// A script has no magic number of its own, so this format takes anything that isn't one of these.
const nonJSMagic = ['\0asm', '\x7fELF'];

const binfmt_js = {
	name: 'js',
	interpreter: '/bin/node',
	matches({ buf }: BinPrm): boolean {
		return !nonJSMagic.some(string => decodeASCII(buf.subarray(0, string.length)) === string) && !buf.includes(0);
	},
} satisfies BinFmt;

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

	// The thread runs the interpreter, so that is what the kernel loads. A program with none is its own.
	const interpreter = fmt.interpreter ? fs.realpathSync.call($, fmt.interpreter) : filename;
	const source = read_program(proc, interpreter);

	proc.thread?.kill();

	proc.thread = new Thread(proc);
	if (proc.tty) proc.tty.foreground = proc;

	await proc.thread.start(filename, interpreter, source);
}

/** Everything in an executable, which for an interpreter is what the thread is started on */
function read_program(proc: Process, path: string): Uint8Array {
	fs.accessSync.call(proc.context, path, X_OK);
	const data = fs.readFileSync.call(proc.context, path) as unknown as Uint8Array;
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
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
