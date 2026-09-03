// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';

/**
 * The signals, like from `<asm-generic/signal.h>`.
 * The names are without their `SIG` prefix, which {@link signal_name} puts back.
 */
export enum Signal {
	HUP = 1,
	INT,
	QUIT,
	ILL,
	TRAP,
	ABRT,
	BUS,
	FPE,
	KILL,
	USR1,
	SEGV,
	USR2,
	PIPE,
	ALRM,
	TERM,
	STKFLT,
	CHLD,
	CONT,
	STOP,
	TSTP,
	TTIN,
	TTOU,
	URG,
	XCPU,
	XFSZ,
	VTALRM,
	PROF,
	WINCH,
	IO,
	PWR,
	SYS,
}

/** A signal the way it is spelled outside the kernel, e.g. `SIGINT` */
export type SignalName = `SIG${keyof typeof Signal}`;

/** What a signal may be given as: a number, `SIGINT`, or `INT` */
export type SignalLike = Signal | SignalName | keyof typeof Signal | number;

export function signal_name(signal: Signal): SignalName {
	return `SIG${Signal[signal] as keyof typeof Signal}`;
}

/**
 * Work out which signal something names.
 * @throws EINVAL when it doesn't name one
 */
export function signal_of(signal: SignalLike): Signal {
	if (typeof signal == 'number') {
		if (!(signal in Signal)) throw withErrno('EINVAL', `Unknown signal ${signal}`);
		return signal;
	}

	const value = Signal[(signal.startsWith('SIG') ? signal.slice(3) : signal) as keyof typeof Signal];
	if (value === undefined) throw withErrno('EINVAL', `Unknown signal ${signal}`);
	return value;
}

export type SignalHandler = (name: SignalName, signal: Signal) => void;

export type SignalAction = 'term' | 'core' | 'ign' | 'stop' | 'cont';

const coredump = new Set([
	Signal.QUIT,
	Signal.ILL,
	Signal.TRAP,
	Signal.ABRT,
	Signal.BUS,
	Signal.FPE,
	Signal.SEGV,
	Signal.SYS,
	Signal.XCPU,
	Signal.XFSZ,
]);
const ignored = new Set([Signal.CHLD, Signal.URG, Signal.WINCH]);
const stopping = new Set([Signal.STOP, Signal.TSTP, Signal.TTIN, Signal.TTOU]);
const kernel_only = new Set([Signal.KILL, Signal.STOP]);

/** Whether the kernel is the only one that acts on this signal, i.e. `sig_kernel_only` */
export function sig_kernel_only(signal: Signal): boolean {
	return kernel_only.has(signal);
}

/** What a signal does to a process that hasn't installed a handler for it */
export function default_action(signal: Signal): SignalAction {
	if (signal == Signal.CONT) return 'cont';
	if (ignored.has(signal)) return 'ign';
	if (stopping.has(signal)) return 'stop';
	if (coredump.has(signal)) return 'core';
	return 'term';
}
