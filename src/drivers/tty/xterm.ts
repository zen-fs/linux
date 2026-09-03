// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import type { Module } from '../../module.js';
import type { PlatformDevice } from '../base/platform.js';
import { PlatformDriver } from '../base/platform.js';
import { Signal } from '../../signal.js';
import type { DeviceTreeNode } from '../of/device_tree.js';
import { console_tty, set_console } from './console.js';
import type { TTY, WinSize } from './tty.js';
import { TTYDriver } from './tty.js';

/** The part of xterm.js' `Terminal` this driver uses. */
export interface XTermLike {
	write(data: string | Uint8Array): void;
	onData(listener: (data: string) => void): { dispose(): void };
	onResize?(listener: (size: { cols: number; rows: number }) => void): { dispose(): void };
	readonly cols?: number;
	readonly rows?: number;
}

/** What `onData` and `onResize` gave back, so they can be let go of on shutdown */
const listeners = new WeakMap<TTY, { dispose(): void }[]>();

/** The driver behind terminals using xterm.js. */
export const xterm_driver = new TTYDriver({
	name: 'xterm',
	major: 4,
	minor_start: 192,
	lines: 8,
	type: 'serial',
	ops: {
		write(tty, data) {
			terminal_of(tty).write(data);
		},
		winsize(tty): WinSize | undefined {
			const terminal = terminals.get(tty);
			if (!terminal?.cols || !terminal.rows) return;
			return { rows: terminal.rows, cols: terminal.cols };
		},
		shutdown(tty) {
			for (const listener of listeners.get(tty) ?? []) listener.dispose();
			listeners.delete(tty);
			terminals.delete(tty);
		},
	},
});

const terminals = new WeakMap<TTY, XTermLike>();

function terminal_of(tty: TTY): XTermLike {
	const terminal = terminals.get(tty);
	if (!terminal) throw withErrno('ENXIO', `${tty.name} is not attached to a terminal`);
	return terminal;
}

export interface AttachXTermOptions {
	/** Which line to use, so a page with more than one terminal can say which is which @default 0 */
	index?: number;
	/**
	 * Whether the tty takes what is typed into the terminal.
	 * Turn this off when something else is already reading the terminal.
	 * @default true
	 */
	input?: boolean;
}

/** Attach an xterm.js terminal, giving it a `/dev/xterm<n>` node. */
export function attach_xterm(terminal: XTermLike, options: AttachXTermOptions = {}): TTY {
	const tty = xterm_driver.line(options.index ?? 0);

	if (terminals.has(tty)) throw withErrno('EBUSY', `${tty.name} already has a terminal`);
	terminals.set(tty, terminal);

	const disposables = [];
	if (options.input ?? true) disposables.push(terminal.onData(data => tty.receive(data)));
	if (terminal.onResize) disposables.push(terminal.onResize(() => tty.signal(Signal.WINCH)));
	listeners.set(tty, disposables);

	tty.register();
	if (!console_tty) set_console(tty);
	return tty;
}

/** Let go of an xterm.js terminal and take its node away. */
export function detach_xterm(tty: TTY): void {
	xterm_driver.ops.shutdown?.(tty);
	tty.unregister();
	xterm_driver.ttys.delete(tty.index);
	if (console_tty === tty) set_console(null);
}

/** The lowest line nothing has taken yet, since a device tree node doesn't have to say which it wants */
function free_index(): number {
	for (let index = 0; index < xterm_driver.lines; index++) {
		if (!xterm_driver.ttys.has(index)) return index;
	}
	throw withErrno('ENOSPC', 'xterm: no free lines');
}

function xterm_probe(device: PlatformDevice): boolean {
	const node: DeviceTreeNode | undefined = device.of_node;
	if (node?.kind != 'xterm') return false;

	device.driver_data = attach_xterm(node.terminal, { index: free_index(), ...node.options });
	return true;
}

function xterm_remove(device: PlatformDevice): void {
	const tty = device.driver_data as TTY | undefined;
	if (tty) detach_xterm(tty);
	delete device.driver_data;
}

/**
 * What binds a `kind: 'xterm'` device tree node to a terminal.
 * Created when the tty module loads, since the platform bus does not exist before then.
 */
export let xterm_platform_driver: PlatformDriver | undefined;

/** @internal */
export function xterm_platform_driver_init(owner: Module): PlatformDriver {
	xterm_platform_driver = new PlatformDriver({ name: 'xterm', owner, of_match_table: ['xterm'], probe: xterm_probe, remove: xterm_remove });
	return xterm_platform_driver;
}

/** @internal */
export function xterm_platform_driver_exit(): void {
	xterm_platform_driver?.unregister();
	xterm_platform_driver = undefined;
}
