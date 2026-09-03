// SPDX-License-Identifier: LGPL-3.0-or-later
import { ModuleSource } from '@endo/module-source';
import { fs } from '@zenfs/core';
import * as path from '@zenfs/core/path';
import { UV } from 'kerium';
import 'ses';
import type { NamespaceModuleDescriptor } from 'ses';
import { decodeASCII } from 'utilium';
import type { BinFmt, BinPrm } from './exec.js';
import type { Process } from '../process.js';
import { err } from 'kerium/log';

// A script has no magic number of its own, so this format takes anything that isn't one of these.
const magic = ['\0asm', '\x7fELF'];

export interface JSBinHandler {
	(proc: Process): {
		modules?: Record<string, object>;
		globals?: Record<string, unknown>;
	};
}

export const jsBinHandlers = new Set<JSBinHandler>();

export const jsLib = ['/lib'];

const binfmt_js = {
	name: 'js',
	matches({ buf }: BinPrm): boolean {
		return !magic.some(string => decodeASCII(buf.subarray(0, string.length)) === string) && !buf.includes(0);
	},
	load({ proc, filename, env }: BinPrm) {
		const globals = Object.create(null),
			modules: Record<string, NamespaceModuleDescriptor> = Object.create(null);

		for (const handler of jsBinHandlers) {
			try {
				const extra = handler(proc);
				Object.assign(globals, extra.globals);
				for (const [name, namespace] of Object.entries(extra.modules || {})) {
					modules[name] = { namespace };
				}
			} catch (e) {
				err(`execve bad handler, "${handler.name}": ${String(e)}`);
				throw UV('ENOEXEC', 'execve', filename);
			}
		}

		function make(path: string) {
			const text = fs.readFileSync.call(proc.context, path, 'utf-8');
			const mod = new ModuleSource(text);
			mod.imports ??= [];
			return mod;
		}

		/** Bare specifiers name a library, which is a file in one of the library directories */
		function load(specifier: string) {
			if (specifier === filename) return make(filename);

			for (const dir of [...jsLib, ...(env.LD_LIBRARY_PATH?.split(':') ?? [])]) {
				const p = path.join(dir, specifier + '.js');
				if (fs.existsSync.call(proc.context, p)) return make(p);
			}

			throw UV('ELIBACC', 'execve', filename);
		}

		const compartment = new Compartment({
			__options__: true,
			name: filename,
			globals,
			modules,
			resolveHook: (specifier: string) => specifier,
			importNowHook: load,
			importHook: load,
			noAggregateLoadErrors: true,
		});

		return () => compartment.importNow(filename);
	},
} satisfies BinFmt;

export default binfmt_js;
