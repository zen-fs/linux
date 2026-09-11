// SPDX-License-Identifier: LGPL-3.0-or-later
/* eslint-disable @typescript-eslint/only-throw-error */
import { fs, type FSContext } from '@zenfs/core';
import { O_RDONLY, X_OK } from '@zenfs/core/constants';
import * as xattr from '@zenfs/core/vfs/xattr';
import type { FileCapabilities } from '@zenfs/linux/uapi/abi';
import { capabilityXattr, read_file_capabilities, VfsCapData, vfsCapRevision2, vfsCapRevisionMask } from '@zenfs/linux/uapi/abi';
import { UV } from 'kerium';
import { decodeASCII } from 'utilium';
import { capabilities_on_exec } from '../capability.js';
import type { ProcessInit } from '../process.js';
import { Process } from '../process.js';
import { Thread } from '../thread.js';

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
	/** Rewrite what is being loaded, the way a `#!` line does. The search then starts over on the new program. */
	load?(prm: BinPrm): void;
}

/** How many times a program may be rewritten into another before `execve` gives up */
const maxDepth = 5;

const binfmt_script = {
	name: 'script',
	matches({ buf }: BinPrm): boolean {
		return decodeASCII(buf.subarray(0, 2)) === '#!';
	},
	load(prm: BinPrm): void {
		let text = decodeASCII(prm.buf).slice(2);

		const end = /[\n\0]/.exec(text)?.index ?? -1;
		const truncated = end < 0;
		if (!truncated) text = text.slice(0, end);

		const [, name, arg] = /^[ \t]*([^ \t]*)[ \t]*(.*?)[ \t]*$/.exec(text)!;

		if (!name || (truncated && name.length == text.trimStart().length)) throw UV('ENOEXEC', 'execve', prm.filename);

		prm.argv = [name, ...(arg ? [arg] : []), prm.filename, ...prm.argv.slice(1)];
		prm.filename = name;
	},
} satisfies BinFmt;

// A script has no magic number of its own, so this format takes anything that isn't one of these.
const nonJSMagic = ['\0asm', '\x7fELF'];

const binfmt_js = {
	name: 'js',
	interpreter: '/bin/node',
	matches({ buf }: BinPrm): boolean {
		return !nonJSMagic.some(string => decodeASCII(buf.subarray(0, string.length)) === string) && !buf.includes(0);
	},
} satisfies BinFmt;

const binfmt_wasm = {
	name: 'wasm',
	interpreter: '/bin/wali',
	matches({ buf }: BinPrm): boolean {
		return decodeASCII(buf.subarray(0, 4)) === '\0asm';
	},
} satisfies BinFmt;

/** The registered formats, in the order they are tried */
export const binfmts = new Set<BinFmt>([binfmt_script, binfmt_wasm, binfmt_js]);

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

	const prm: BinPrm = { proc, filename: fs.realpathSync.call($, path), buf: new Uint8Array(0), argv, env: { ...env } };

	let fmt: BinFmt;
	for (let depth = 0; ; depth++) {
		if (depth > maxDepth) throw UV('ELOOP', 'execve', path);

		fs.accessSync.call($, prm.filename, X_OK);

		const buffer = new Uint8Array(binPrmBufSize);
		const fd = fs.openSync.call($, prm.filename, O_RDONLY);
		try {
			prm.buf = buffer.subarray(0, fs.readSync.call($, fd, buffer, 0, binPrmBufSize, 0));
		} finally {
			fs.closeSync.call($, fd);
		}

		fmt = search_binary_handler(prm);
		if (!fmt.load) break;

		fmt.load(prm);
		prm.filename = fs.realpathSync.call($, prm.filename);
	}

	proc.argv = prm.argv;
	proc.exe = prm.filename;
	proc.env = prm.env;
	proc.code = undefined;

	let caps: FileCapabilities | undefined;

	try {
		const value = xattr.getSync.call(proc.context, prm.filename, capabilityXattr, {}) as unknown as Uint8Array;
		if (value.byteLength < VfsCapData.size) throw null;
		// Revision 1 is 32 bits wide and long gone, so anything older than revision 2 is not read
		if ((new VfsCapData(value.buffer, value.byteOffset).magic_etc & vfsCapRevisionMask) < vfsCapRevision2) throw null;
		caps = read_file_capabilities(value);
	} catch {
		// this is fine
	}

	proc.caps = capabilities_on_exec(proc.caps, proc.context.credentials.euid, caps);

	const interpreter = fmt.interpreter ? fs.realpathSync.call($, fmt.interpreter) : prm.filename;
	fs.accessSync.call(proc.context, interpreter, X_OK);
	const data = fs.readFileSync.call<FSContext, [string], Uint8Array>(proc.context, interpreter);
	const source = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

	proc.thread?.kill();

	proc.thread = new Thread(proc);
	if (proc.tty) proc.tty.foreground = proc;

	await proc.thread.start(prm.filename, interpreter, source);
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
