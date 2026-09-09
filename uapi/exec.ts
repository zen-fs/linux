// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Loading a program, from inside the process that is going to run it.
 *
 * This used to happen in the kernel, which meant handing a program a compartment carved out of the
 * kernel's own realm. A thread has nothing of the kernel in it to begin with, so the compartment is
 * only here for the module loading: bare specifiers name a library, and a library is a file.
 */
import { ModuleSource } from '@endo/module-source';
import 'ses';
import type { NamespaceModuleDescriptor } from 'ses';
import { decodeUTF8 } from 'utilium';
import { ready } from './base.js';
import * as fs from './fs.js';
import * as proc from './process.js';

/**
 * What a program gets on its global.
 *
 * A compartment starts with the standard intrinsics and nothing else, so the few platform things a
 * program can't do without are put back; anything past that is for whatever set the process up.
 */
export const globals: Record<string, unknown> = Object.assign(Object.create(null), {
	TextEncoder,
	TextDecoder,
	console,
});

/** What a program can import by name. The syscalls are always there, the way libc always is. */
export const modules: Record<string, object> = Object.assign(Object.create(null), {
	'@zenfs/linux/uapi/fs': fs,
	'@zenfs/linux/uapi/process': proc,
});

/** Where a bare specifier is looked for, before `LD_LIBRARY_PATH` */
export const library_paths: string[] = ['/lib'];

/**
 * What keeps a process alive once its program's top level is done, the way an open handle keeps a
 * Node process from exiting.
 *
 * There is no event loop to hand a descriptor to: a thread has nothing else to do while it waits, so
 * each handle just blocks until it has something and then does it. A process with none is finished.
 */
export const handles = new Set<() => void>();

function read_file(path: string): string {
	const fd = fs.open(path, 0 /* O_RDONLY */);

	try {
		const { size } = fs.fstat(fd);
		const data = new Uint8Array(size);

		for (let offset = 0; offset < size;) {
			const length = fs.read(fd, data.subarray(offset));
			if (!length) break;
			offset += length;
		}

		return decodeUTF8(data);
	} finally {
		fs.close(fd);
	}
}

/** Run a program. It has the thread to itself, so this only comes back when the program is done. */
export async function exec(path: string): Promise<void> {
	const { env } = await ready;

	const source = (path: string) => {
		const module = new ModuleSource(read_file(path));
		module.imports ??= [];
		return module;
	};

	const load = (specifier: string) => {
		if (specifier === path) return source(path);

		for (const directory of [...library_paths, ...(env.LD_LIBRARY_PATH?.split(':') ?? [])]) {
			try {
				return source(`${directory}/${specifier}.js`);
			} catch {
				// Not in this one
			}
		}

		throw new Error(`Cannot find library '${specifier}'`);
	};

	const namespaces: Record<string, NamespaceModuleDescriptor> = Object.create(null);
	for (const [name, namespace] of Object.entries(modules)) namespaces[name] = { namespace };

	const compartment = new Compartment({
		__options__: true,
		name: path,
		globals,
		modules: namespaces,
		resolveHook: (specifier: string) => specifier,
		importNowHook: load,
		importHook: load,
		noAggregateLoadErrors: true,
	});

	await compartment.import(path);
}
