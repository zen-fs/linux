// SPDX-License-Identifier: LGPL-3.0-or-later
import { decodeASCII } from 'utilium';
import type { BinFmt, BinPrm } from './exec.js';

// A script has no magic number of its own, so this format takes anything that isn't one of these.
const magic = ['\0asm', '\x7fELF'];

/**
 * Plain JavaScript.
 *
 * The loading is `uapi/exec.js`, on the process' own thread: a program gets a compartment for its
 * module graph, not for isolation, since there is nothing of the kernel in a thread to isolate it
 * from in the first place.
 */
const binfmt_js = {
	name: 'js',
	matches({ buf }: BinPrm): boolean {
		return !magic.some(string => decodeASCII(buf.subarray(0, string.length)) === string) && !buf.includes(0);
	},
} satisfies BinFmt;

export default binfmt_js;
