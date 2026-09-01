// SPDX-License-Identifier: LGPL-3.0-or-later
// The subset of `struct termios` that means anything without real hardware.
// @see `<linux>/include/uapi/asm-generic/termbits.h`

/** Input flags, i.e. `c_iflag` */
export const iflags = {
	/** Strip the eighth bit off every input byte */
	ISTRIP: 0x0020,
	/** Map NL to CR on input */
	INLCR: 0x0040,
	/** Ignore CR on input */
	IGNCR: 0x0080,
	/** Map CR to NL on input, which is what makes Enter work */
	ICRNL: 0x0100,
} as const;

/** Output flags, i.e. `c_oflag` */
export const oflags = {
	/** Do any output processing at all. Without this the rest are ignored. */
	OPOST: 0x0001,
	/** Map NL to CR-NL on output, which is what a terminal needs to return to column 0 */
	ONLCR: 0x0004,
	/** Map CR to NL on output */
	OCRNL: 0x0008,
	/** Don't send CR at all */
	ONLRET: 0x0020,
} as const;

/** Local flags, i.e. `c_lflag` */
export const lflags = {
	/** Turn the interrupt, quit and suspend characters into signals */
	ISIG: 0x0001,
	/** Line-at-a-time input, with editing. Without this every byte is handed over as it arrives. */
	ICANON: 0x0002,
	/** Echo input back to the terminal */
	ECHO: 0x0008,
	/** Erase erases the character on screen, rather than just in the buffer */
	ECHOE: 0x0010,
	/** Echo NL even when ECHO is off */
	ECHONL: 0x0040,
} as const;

/** The special characters, i.e. indices into `c_cc` */
export const cc = {
	VINTR: 0,
	VQUIT: 1,
	VERASE: 2,
	VKILL: 3,
	VEOF: 4,
} as const;

/** What `tcflush` and `TCFLSH` throw away */
export const tcflush = {
	/** What has been typed but not read */
	TCIFLUSH: 0,
	/** What has been written but not sent */
	TCOFLUSH: 1,
	/** Both */
	TCIOFLUSH: 2,
} as const;

/** The line settings of a terminal, i.e. `struct ktermios` */
export interface Termios {
	iflag: number;
	oflag: number;
	lflag: number;
	/** The special characters, by the indices in `cc` */
	cc: number[];
}

/**
 * What a terminal starts out as, i.e. `tty_std_termios`.
 * Canonical input with echo, and NL turned into CR-NL on the way out.
 */
export const default_termios: Termios = {
	iflag: iflags.ICRNL,
	oflag: oflags.OPOST | oflags.ONLCR,
	lflag: lflags.ISIG | lflags.ICANON | lflags.ECHO | lflags.ECHOE,
	// INTR ^C, QUIT ^\, ERASE DEL, KILL ^U, EOF ^D
	cc: [0x03, 0x1c, 0x7f, 0x15, 0x04],
};

/** Line settings with no processing at all, which is what a full-screen program wants */
export const raw_termios: Termios = {
	iflag: 0,
	oflag: 0,
	lflag: 0,
	cc: default_termios.cc,
};
