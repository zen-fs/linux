// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Where a thread starts.
 *
 * The kernel hands over the shared page and says what to run; everything past that happens here. If
 * the process was given a runtime, it is imported first, so it can put whatever the program expects
 * in {@link globals} and {@link modules} before the program is loaded.
 */
import { ready } from './base.js';
import { exec, handles } from './exec.js';
import { exit } from './process.js';

const init = await ready;

if (init.runtime) await import(init.runtime);

/**
 * Let everything a handle set going actually run.
 */
function settle(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

try {
	await exec(init.exe);

	// The program's top level is done, but something may still be waiting on a descriptor
	while (handles.size) {
		for (const handle of [...handles]) {
			handle();
			await settle();
		}
	}

	exit(0);
} catch (e) {
	// There is no one left to tell but the kernel, and all it gets is the code
	console.error(String(e));
	exit(1);
}
