// SPDX-License-Identifier: LGPL-3.0-or-later
// The flags and characters are uapi, so they live in the ABI and are re-exported here.
// @see `<linux>/include/uapi/asm-generic/termbits.h`
import type { TermiosFields } from '@zenfs/linux/uapi/abi';
import { iflags, lflags, oflags } from '@zenfs/linux/uapi/abi';

/** The line settings of a terminal, i.e. `struct ktermios` */
export type Termios = TermiosFields;

/**
 * What a terminal starts out as, i.e. `tty_std_termios`.
 * Canonical input with echo, and NL turned into CR-NL on the way out.
 */
export const default_termios: Termios = {
	iflag: iflags.ICRNL,
	oflag: oflags.OPOST | oflags.ONLCR,
	lflag: lflags.ISIG | lflags.ICANON | lflags.ECHO | lflags.ECHOE,
	// INTR ^C, QUIT ^\, ERASE DEL, KILL ^U, EOF ^D, SUSP ^Z
	cc: [0x03, 0x1c, 0x7f, 0x15, 0x04, 0x1a],
};

/** Line settings with no processing at all, which is what a full-screen program wants */
export const raw_termios: Termios = {
	iflag: 0,
	oflag: 0,
	lflag: 0,
	cc: default_termios.cc,
};
