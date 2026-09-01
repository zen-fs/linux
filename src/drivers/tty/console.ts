// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import type { TTY } from './tty.js';
import { TTYDriver } from './tty.js';

/**
 * The terminal everything without one of its own goes to, i.e. what `/dev/console` writes reach.
 * The first terminal attached becomes it, the way the first console Linux finds does.
 */
export let console_tty: TTY | null = null;

/**
 * Make a terminal the one `/dev/tty` and `/dev/console` talk to.
 * Attaching one already does this when there isn't one, so this is only needed to change it.
 */
export function set_console(tty: TTY | null): void {
	console_tty = tty;
}

/**
 * The driver behind `/dev/tty` (5:0) and `/dev/console` (5:1), i.e. `tty_std_driver`.
 */
export const console_driver = new TTYDriver({
	name: 'tty',
	major: 5,
	minor_start: 0,
	lines: 2,
	type: 'system',
	ops: {
		write(tty, data) {
			if (!console_tty) throw withErrno('ENXIO', 'There is no console');
			console_tty.write_raw(data);
		},
		redirect: () => console_tty ?? undefined,
		winsize: () => console_tty?.winsize,
		active: () => console_tty?.name,
	},
});
