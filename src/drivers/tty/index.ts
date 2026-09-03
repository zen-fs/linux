// SPDX-License-Identifier: LGPL-3.0-or-later
import { Module } from '../../module.js';
import { console_driver, set_console } from './console.js';
import { attach_stdio, node_driver, probe_stdio } from './node.js';
import { xterm_driver, xterm_platform_driver_exit, xterm_platform_driver_init } from './xterm.js';

export * from './console.js';
export * from './n_tty.js';
export * from './node.js';
export * from './termios.js';
export * from './tty.js';
export * from './xterm.js';

/** Undo everything `init` set up, in the reverse order */
function unregister_drivers(): void {
	xterm_platform_driver_exit();
	for (const driver of [node_driver, xterm_driver, console_driver]) driver.unregister();
}

export const tty = new Module({
	name: 'tty',
	description: 'Terminals, backed by the host stdio or an xterm.js terminal',
	license: 'LGPL-3.0-or-later',
	params: {
		/** Whether to look for a terminal on the host when the module loads */
		probe: { value: true },
	},
	init() {
		console_driver.owner = tty;
		xterm_driver.owner = tty;
		node_driver.owner = tty;

		console_driver.register();

		try {
			for (const [index, name] of ['tty', 'console'].entries()) console_driver.line(index).register(name);

			xterm_driver.register();
			node_driver.register();
		} catch (e) {
			unregister_drivers();
			throw e;
		}

		if (tty.param<boolean>('probe') && probe_stdio()) set_console(attach_stdio());

		xterm_platform_driver_init(tty).register();
	},
	exit() {
		set_console(null);
		unregister_drivers();
	},
});
