// SPDX-License-Identifier: LGPL-3.0-or-later
import { Signal } from '../../signal.js';
import type { TTY, WinSize } from './tty.js';
import { TTYDriver } from './tty.js';

/** The parts of Node's `process` this driver uses, so it can be handed a stand-in for testing */
export interface NodeStdio {
	stdout: {
		write(data: Uint8Array | string): unknown;
		readonly isTTY?: boolean;
		readonly columns?: number;
		readonly rows?: number;
		on?(event: string, listener: () => void): unknown;
		off?(event: string, listener: () => void): unknown;
	};
	stdin?: {
		on(event: string, listener: (chunk: Uint8Array | string) => void): unknown;
		off?(event: string, listener: (chunk: Uint8Array | string) => void): unknown;
		setRawMode?(raw: boolean): unknown;
		resume?(): unknown;
		pause?(): unknown;
		unref?(): unknown;
		readonly isTTY?: boolean;
	};
}

let stdio: NodeStdio | undefined;

/** Everything hooked up to the host's streams, so it can be undone */
let detach: (() => void) | undefined;

/** The driver behind the terminal a Node process was started on. */
export const node_driver = new TTYDriver({
	name: 'console',
	major: 4,
	minor_start: 64,
	lines: 1,
	type: 'console',
	ops: {
		write(tty, data) {
			stdio?.stdout.write(data);
		},
		winsize(): WinSize | undefined {
			const { columns, rows } = stdio?.stdout ?? {};
			if (!columns || !rows) return;
			return { rows, cols: columns };
		},
		shutdown() {
			detach?.();
			detach = undefined;
			stdio = undefined;
		},
	},
});

/** Look for a terminal to drive, the way a driver probes for hardware. */
export function probe_stdio(host: unknown = globalThis): NodeStdio | undefined {
	const process = (host as { process?: NodeStdio }).process;
	if (typeof process?.stdout?.write != 'function') return;
	return process;
}

/**
 * Attach the host's streams, giving them a `/dev/console0` node.
 * @returns the tty, or nothing when there is no terminal to attach to
 */
export function attach_stdio(host: unknown = globalThis): TTY | null {
	const found = probe_stdio(host);
	if (!found) return null;

	stdio = found;
	const tty = node_driver.line(0);

	const undo: (() => void)[] = [];

	const { stdin, stdout } = found;
	if (stdin) {
		const listener = (chunk: Uint8Array | string) => tty.receive(chunk);
		stdin.on('data', listener);
		const raw = stdin.isTTY && typeof stdin.setRawMode == 'function';
		if (raw) stdin.setRawMode!(true);
		stdin.resume?.();
		stdin.unref?.();
		undo.push(() => {
			stdin.off?.('data', listener);
			if (raw) stdin.setRawMode!(false);
			stdin.pause?.();
		});
	}

	if (stdout.on) {
		const listener = () => tty.signal(Signal.WINCH);
		stdout.on('resize', listener);
		undo.push(() => stdout.off?.('resize', listener));
	}

	detach = () => {
		for (const fn of undo) fn();
	};

	tty.register();
	return tty;
}
