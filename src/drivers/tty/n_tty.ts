// SPDX-License-Identifier: LGPL-3.0-or-later
import { Signal } from '../../signal.js';
import type { TTY } from './tty.js';
import { cc, iflags, lflags, oflags } from './termios.js';

const encoder = new TextEncoder();

/** The characters that raise a signal and what each one raises, like the `__isig` switch */
const signal_chars: [index: number, signal: Signal][] = [
	[cc.VINTR, Signal.INT],
	[cc.VQUIT, Signal.QUIT],
	[cc.VSUSP, Signal.TSTP],
];

/**
 * The N_TTY line discipline, i.e. `drivers/tty/n_tty.c`.
 */
export class LineDiscipline {
	/** Input that is ready to be read, i.e. `read_buf` */
	protected buffer: number[] = [];

	/** The line being typed, which isn't readable until it is finished */
	protected line: number[] = [];

	/** Set by the EOF character, so the next read comes up empty instead of waiting */
	protected eof: boolean = false;

	public constructor(protected readonly tty: TTY) {}

	public get available(): number {
		return this.buffer.length;
	}

	/** Whether the terminal is handing over whole lines rather than single bytes */
	protected get canonical(): boolean {
		return !!(this.tty.termios.lflag & lflags.ICANON);
	}

	/** Echo bytes back to the terminal, if the terminal is set to echo */
	protected echo(...bytes: number[]): void {
		if (!(this.tty.termios.lflag & lflags.ECHO)) return;
		this.tty.write_raw(new Uint8Array(bytes));
	}

	/** Take bytes that arrived from the terminal, i.e. `n_tty_receive_buf`. */
	public receive(data: Uint8Array): void {
		const { iflag, lflag, cc: chars } = this.tty.termios;

		for (let byte of data) {
			if (iflag & iflags.ISTRIP) byte &= 0x7f;

			// CR and NL are mapped before anything else looks at them
			if (byte == 0x0d) {
				if (iflag & iflags.IGNCR) continue;
				if (iflag & iflags.ICRNL) byte = 0x0a;
			} else if (byte == 0x0a && iflag & iflags.INLCR) {
				byte = 0x0d;
			}

			if (lflag & lflags.ISIG) {
				const raised = signal_chars.find(([index]) => byte == chars[index]);
				if (raised) {
					this.echo(0x5e, 0x40 + byte);
					this.line = [];
					this.buffer = [];
					this.tty.signal(raised[1]);
					continue;
				}
			}

			if (!this.canonical) {
				this.buffer.push(byte);
				this.echo(byte);
				continue;
			}

			if (byte == chars[cc.VERASE]) {
				if (!this.line.pop()) continue;
				if (lflag & lflags.ECHOE) this.echo(0x08, 0x20, 0x08);
				continue;
			}

			if (byte == chars[cc.VKILL]) {
				for (const _ of this.line) if (lflag & lflags.ECHOE) this.echo(0x08, 0x20, 0x08);
				this.line = [];
				continue;
			}

			if (byte == chars[cc.VEOF]) {
				if (this.line.length) this.commit();
				else {
					this.eof = true;
					this.tty.wake_read();
				}
				continue;
			}

			if (byte == 0x0a) {
				this.line.push(byte);
				if (lflag & (lflags.ECHO | lflags.ECHONL)) this.tty.write(new Uint8Array([0x0a]));
				this.commit();
				continue;
			}

			this.line.push(byte);
			this.echo(byte);
		}

		// Without ICANON there are no lines to wait for, so everything taken in is published at the
		// end of the block rather than a byte at a time, the way `__receive_buf` does it.
		if (!this.canonical && this.buffer.length) this.tty.wake_read();
	}

	/** Hand the line being typed over to be read, i.e. `n_tty_receive_handle_newline` */
	protected commit(): void {
		this.buffer.push(...this.line);
		this.line = [];
		this.tty.wake_read();
	}

	/**
	 * Fill `buffer` with what is waiting and return how much that was.
	 */
	public read(buffer: Uint8Array): number {
		const count = Math.min(buffer.byteLength, this.buffer.length);

		buffer.set(this.buffer.splice(0, count), 0);
		if (!this.buffer.length) this.eof = false;

		return count;
	}

	/** Whether the terminal has been ended with the EOF character and has nothing left */
	public get at_eof(): boolean {
		return this.eof && !this.buffer.length;
	}

	/**
	 * Fix up bytes on their way to the terminal, i.e. `do_output_char`.
	 * This is what turns a bare newline into the carriage return and newline a terminal actually needs.
	 */
	public process_output(data: Uint8Array): Uint8Array {
		const { oflag } = this.tty.termios;
		if (!(oflag & oflags.OPOST)) return data;

		const out: number[] = [];

		for (const byte of data) {
			if (byte == 0x0a) {
				if (oflag & oflags.ONLCR) out.push(0x0d, 0x0a);
				else if (oflag & oflags.ONLRET) continue;
				else out.push(byte);
				continue;
			}

			if (byte == 0x0d && oflag & oflags.OCRNL) {
				out.push(0x0a);
				continue;
			}

			out.push(byte);
		}

		return new Uint8Array(out);
	}

	/** Throw away everything typed but not yet read, i.e. `TCIFLUSH` */
	public flush(): void {
		this.buffer = [];
		this.line = [];
		this.eof = false;
	}

	/** Put text into the input queue as if it had been typed, i.e. `TIOCSTI` */
	public push(text: string): void {
		this.receive(encoder.encode(text));
	}
}
