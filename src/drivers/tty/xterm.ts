// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
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
	// Nothing needs telling that the size changed, but holding the listener keeps `winsize` honest
	if (terminal.onResize) disposables.push(terminal.onResize(() => {}));
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
}
