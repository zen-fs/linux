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
	load(prm: BinPrm): Promise<() => any> | (() => any);
}

/** The registered formats, in the order they are tried */
export const binfmts = new Set<BinFmt>([binfmt_js]);

/** Hand the program to the first format that recognizes */
export async function search_binary_handler(prm: BinPrm): Promise<() => any> {
	for (const fmt of binfmts) {
		if (fmt.matches(prm)) return await fmt.load(prm);
	}

	throw UV('ENOEXEC', 'execve', prm.filename);
}

/** Replace what `proc` is running with `path` */
export async function execve(proc: Process, path: string, argv: string[] = [path], env: Record<string, string> = proc.env): Promise<number> {
	const $ = proc.context;

	const filename = fs.realpathSync.call($, path);
	try {
		fs.accessSync.call($, filename, X_OK);
	} catch {
		throw UV('EACCES', 'execve', filename);
	}

	let buf;
	{
		await using handle = await fs.promises.open.call($, filename, O_RDONLY);
		const buffer = new Uint8Array(binPrmBufSize);
		const { bytesRead } = await handle.read({ buffer, offset: 0, length: binPrmBufSize, position: 0 });
		buf = buffer.subarray(0, bytesRead);
	}

	proc.argv = argv;
	proc.exe = filename;
	proc.env = env;
	proc.code = undefined;

	const do_exec = await search_binary_handler({ proc, filename, buf, argv, env });

	try {
		// Linux returns to userspace here and the program runs on its own; nothing here can do that.
		return await do_exec();
	} catch {
		proc.code ||= 1;
	}

	return proc.code ?? 0;
}

export async function spawn(
	parent: Process,
	path: string,
	argv: string[] = [path],
	env: Record<string, string> = parent.env,
	init: ProcessInit = {}
): Promise<number> {
	using proc = new Process({ ...init, parent, argv, env });
	return await execve(proc, path, argv, env);
}
