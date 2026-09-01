// SPDX-License-Identifier: LGPL-3.0-or-later
import type { IoctlContext, IoctlOps } from '@zenfs/core/internal/ioctl.js';
import { withErrno } from 'kerium';
import { Device, type DevNode } from '../../device.js';
import * as char_dev from '../../fs/char_dev.js';
import { CharDevice } from '../../fs/char_dev.js';
import type { DeviceFile, FileOperations } from '../../fs/devtmpfs.js';
import type { Module } from '../../module.js';
import { Class } from '../base/class.js';
import { LineDiscipline } from './n_tty.js';
import type { Termios } from './termios.js';
import { default_termios, iflags, lflags, oflags, tcflush } from './termios.js';

const encoder = new TextEncoder();

/** What a tty is driving, i.e. `enum tty_driver_type` */
export type TTYDriverType = 'system' | 'console' | 'serial' | 'pty';

/** How big the terminal is, i.e. `struct winsize` */
export interface WinSize {
	rows: number;
	cols: number;
}

/** `/sys/class/tty`. Terminals are world writable, the way they are on Linux. */
export const tty_class = new Class('tty', { dev_node: (): DevNode => ({ mode: 0o666 }) });

/**
 * One of a terminal's ioctls. Like {@link DeviceIoctl} except that the terminal has already been
 * worked out from the device file, redirect and all, so a driver never sees a minor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TTYIoctl = (context: IoctlContext, tty: TTY, ...args: any[]) => any;

/**
 * What a tty driver has to do to move bytes, i.e. `struct tty_operations`.
 */
export interface TTYOperations {
	/** Send bytes to the terminal. They have already been through output processing. */
	write(tty: TTY, data: Uint8Array): void;
	open?(tty: TTY): void;
	close?(tty: TTY): void;
	/** Called after the line settings change, e.g. when something turns off echo */
	set_termios?(tty: TTY, old: Termios): void;
	winsize?(tty: TTY): WinSize | undefined;
	/**
	 * The terminal this one's output ends up on, which is only interesting for a tty that
	 * redirects somewhere else. Providing it is what gives the tty an `active` attribute,
	 * the way only `/dev/console` and `/dev/tty0` have one on Linux.
	 */
	active?(tty: TTY): string | undefined;
	ioctl?: Record<number, TTYIoctl>;
	/**
	 * The terminal a device file really refers to, for a driver that stands in for another terminal.
	 * This is what `/dev/tty` is: a name for whichever terminal is the console.
	 */
	redirect?(tty: TTY): TTY | undefined;
	/** Stop driving the terminal and let go of whatever it is attached to */
	shutdown?(tty: TTY): void;
}

/** One terminal, i.e. `struct tty_struct`. */
export class TTY {
	/** The line discipline, i.e. `tty->ldisc`. Only N_TTY exists. */
	public readonly ldisc: LineDiscipline;

	public termios: Termios;

	/** The device in sysfs, only set while the tty is registered */
	public device?: Device;

	public constructor(
		public readonly driver: TTYDriver,
		/** Which line of the driver this is, i.e. `tty->index` */
		public readonly index: number
	) {
		this.termios = { ...driver.init_termios };
		this.ldisc = new LineDiscipline(this);
	}

	/** What this line is called, e.g. `ttyS0` for line 0 of a driver named `ttyS`. */
	public get name(): string {
		return this.driver.name + (this.driver.name_base + this.index);
	}

	public get dev_t(): { major: number; minor: number } {
		return { major: this.driver.major, minor: this.driver.minor_start + this.index };
	}

	/** What `TIOCSWINSZ` was told, for a terminal whose driver can't work its own size out */
	#win_size?: WinSize;

	/** How big the terminal is. Terminals that can't say are 80x24, the same default Linux uses. */
	public get winsize(): WinSize {
		return this.driver.ops.winsize?.(this) ?? this.#win_size ?? { rows: 24, cols: 80 };
	}

	/**
	 * Tell the terminal how big it is, i.e. `TIOCSWINSZ`.
	 * A driver that knows its own size keeps reporting that, since it is the one that can tell.
	 */
	public set winsize(size: WinSize) {
		this.#win_size = size;
	}

	/** Bytes that have been read from the terminal and are waiting to be handed over */
	public get available(): number {
		return this.ldisc.available;
	}

	/**
	 * Take bytes from the terminal.
	 * Call this from whatever is driving the tty when the user types something.
	 */
	public receive(data: Uint8Array | string): void {
		this.ldisc.receive(typeof data == 'string' ? encoder.encode(data) : data);
	}

	/** Start using the terminal, i.e. the `open` half of `tty_operations` */
	public open(): void {
		this.driver.ops.open?.(this);
	}

	/** Stop using the terminal */
	public close(): void {
		this.driver.ops.close?.(this);
	}

	/** Send bytes to the terminal, after output processing */
	public write(data: Uint8Array): void {
		this.driver.ops.write(this, this.ldisc.process_output(data));
	}

	/** Send bytes to the terminal without output processing, e.g. for echoing */
	public write_raw(data: Uint8Array): void {
		this.driver.ops.write(this, data);
	}

	/** Change the line settings, i.e. `TCSETS` */
	public set_termios(termios: Partial<Termios>): void {
		const old = this.termios;
		this.termios = { ...old, ...termios };
		this.driver.ops.set_termios?.(this, old);
	}

	/** The attributes the tty's device gets in sysfs */
	protected attrs(): Device['attrs'] {
		const attrs: Device['attrs'] = {
			line: { mode: 0o444, show: () => this.index + '\n' },
			winsize: { mode: 0o444, show: () => `${this.winsize.rows} ${this.winsize.cols}\n` },
			termios: { mode: 0o444, show: () => show_termios(this.termios) },
		};

		if (this.driver.ops.active) attrs.active = { mode: 0o444, show: () => (this.driver.ops.active!(this) ?? '(none)') + '\n' };

		return attrs;
	}

	/**
	 * Add the tty to sysfs and `/dev`, i.e. `tty_register_device`.
	 * @param name Overrides the name worked out from the driver, which is how `/dev/tty` and `/dev/console` get theirs
	 */
	public register(name: string = this.name): void {
		if (this.device) throw withErrno('EEXIST');

		this.device = new Device({ name, class: tty_class, dev_t: this.dev_t });
		this.device.attrs = this.attrs();
		this.device.register();
	}

	public unregister(): void {
		this.device?.unregister();
		delete this.device;
	}
}

export enum TtyIoctl {
	GetTermios = 0x5401,
	SetTermios = 0x5402,
	SetTermiosDrain = 0x5403,
	SetTermiosFlush = 0x5404,
	Flush = 0x540b,
	OutputQueue = 0x5411,
	SendInput = 0x5412,
	GetWinsize = 0x5413,
	SetWinsize = 0x5414,
	InputQueue = 0x541b,
}

/**
 * What a terminal answers, for
 * `fs.ioctlSync<TtyIoctl.GetWinsize, TTYIoctlOps>('/dev/tty', TtyIoctl.GetWinsize)`.
 */
export interface TTYIoctlOps extends IoctlOps {
	[TtyIoctl.GetTermios](): Termios;
	[TtyIoctl.SetTermios]($: IoctlContext, termios: Partial<Termios>): void;
	[TtyIoctl.SetTermiosDrain]($: IoctlContext, termios: Partial<Termios>): void;
	[TtyIoctl.SetTermiosFlush]($: IoctlContext, termios: Partial<Termios>): void;
	[TtyIoctl.Flush]($: IoctlContext, queue?: number): void;
	[TtyIoctl.OutputQueue](): number;
	[TtyIoctl.SendInput]($: IoctlContext, text: string): void;
	[TtyIoctl.GetWinsize](): WinSize;
	[TtyIoctl.SetWinsize]($: IoctlContext, size: WinSize): void;
	[TtyIoctl.InputQueue](): number;
}

/**
 * What the tty layer answers on its own, i.e. the switch in `tty_ioctl`.
 * `TTYIoctlOps` in `./ioctls.js` is what each of these takes and gives back.
 */
export const tty_ioctls: Record<number, TTYIoctl> = {
	// A copy, so changing the settings has to go through `set_termios` and the driver hears about it
	[TtyIoctl.GetTermios]: ($, tty): Termios => ({ ...tty.termios, cc: [...tty.termios.cc] }),
	// Writes go straight to the terminal, so there is never any output to drain
	[TtyIoctl.SetTermios]: ($, tty, termios: Partial<Termios>): void => tty.set_termios(termios),
	[TtyIoctl.SetTermiosDrain]: ($, tty, termios: Partial<Termios>): void => tty.set_termios(termios),
	[TtyIoctl.SetTermiosFlush]: ($, tty, termios: Partial<Termios>): void => {
		tty.ldisc.flush();
		tty.set_termios(termios);
	},
	[TtyIoctl.Flush]: ($, tty, queue: number = tcflush.TCIFLUSH): void => {
		// There is no output queue, so `TCOFLUSH` has nothing to throw away
		if (queue == tcflush.TCIFLUSH || queue == tcflush.TCIOFLUSH) tty.ldisc.flush();
	},
	[TtyIoctl.OutputQueue]: (): number => 0,
	[TtyIoctl.SendInput]: ($, tty, text: string): void => tty.ldisc.push(text),
	[TtyIoctl.InputQueue]: ($, tty): number => tty.available,
	[TtyIoctl.GetWinsize]: ($, tty): WinSize => tty.winsize,
	[TtyIoctl.SetWinsize]: ($, tty, size: WinSize): void => {
		tty.winsize = size;
	},
};

/** The line settings, in the shape `stty -a` prints them */
function show_termios(termios: Termios): string {
	const on = (flags: number, all: Record<string, number>) =>
		Object.entries(all)
			.map(([name, bit]) => (flags & bit ? name.toLowerCase() : '-' + name.toLowerCase()))
			.join(' ');

	return `iflag:\t${on(termios.iflag, iflags)}\noflag:\t${on(termios.oflag, oflags)}\nlflag:\t${on(termios.lflag, lflags)}\n`;
}

export interface TTYDriverInit extends Partial<
	Pick<TTYDriver, 'name_base' | 'minor_start' | 'lines' | 'type' | 'subtype' | 'init_termios' | 'owner'>
> {
	name: string;
	major: number;
	ops: TTYOperations;
}

/**
 * A tty driver, i.e. `struct tty_driver`.
 */
export class TTYDriver {
	public readonly name!: string;
	public readonly major!: number;
	public readonly ops!: TTYOperations;

	/** The number the driver starts counting names from, e.g. 1 for `/dev/ttyS1` being line 0 */
	public readonly name_base: number = 0;

	/** The first minor this driver is responsible for */
	public readonly minor_start: number = 0;

	/** How many lines this driver has, i.e. `tty_driver.num` */
	public readonly lines: number = 1;

	public readonly type: TTYDriverType = 'serial';

	public readonly subtype?: string;

	public readonly init_termios: Termios = default_termios;

	public owner?: Module;

	/** The lines that have been created, by index */
	public readonly ttys = new Map<number, TTY>();

	/** Only set while the driver is registered */
	protected cdev?: CharDevice;

	public constructor(init: TTYDriverInit) {
		if (!init.name || !init.major || !init.ops) throw withErrno('EINVAL');
		Object.assign(this, init);

		this.fops.ioctl = {};
		for (const [command, op] of Object.entries({ ...this.ops.ioctl, ...tty_ioctls }))
			this.fops.ioctl[+command] = ($, file, ...args) => op($, this.tty_of(file), ...args);
	}

	/**
	 * The tty a device file refers to, worked out from its minor.
	 * A driver that stands in for another terminal gets to say which one that is.
	 */
	protected tty_of(file: DeviceFile): TTY {
		const index = file.devt.minor - this.minor_start;
		const tty = this.ttys.get(index);
		if (!tty) throw withErrno('ENXIO');
		return this.ops.redirect?.(tty) ?? tty;
	}

	/** What the character device layer sees. Reads drain the line discipline, writes go to the terminal. */
	public readonly fops: FileOperations = {
		open: file => this.tty_of(file).open(),
		release: file => this.tty_of(file).close(),
		read: (file, buffer, start, end) => this.tty_of(file).ldisc.read(buffer.subarray(0, Math.max(end - start, 0))),
		write: (file, buffer) => this.tty_of(file).write(buffer),
		ioctl: {},
	};

	/** Make a line, i.e. `tty_driver.ttys[index]` being filled in */
	public line(index: number = 0): TTY {
		if (index < 0 || index >= this.lines) throw withErrno('ENXIO', `${this.name}: no line ${index}`);

		let tty = this.ttys.get(index);
		if (!tty) {
			tty = new TTY(this, index);
			this.ttys.set(index, tty);
		}
		return tty;
	}

	/** Reserve the driver's device numbers and publish its operations, i.e. `tty_register_driver`. */
	public register(): void {
		if (this.cdev) throw withErrno('EBUSY');

		const dev_t = { major: this.major, minor: this.minor_start };

		char_dev.register_region(dev_t, this.lines, this.name);

		this.cdev = new CharDevice(this.fops, this.owner);

		try {
			this.cdev.add(dev_t, this.lines);
		} catch (e) {
			char_dev.unregister_region(dev_t, this.lines);
			delete this.cdev;
			throw e;
		}
	}

	/** Take every line out of sysfs and give the device numbers back, i.e. `tty_unregister_driver`. */
	public unregister(): void {
		if (!this.cdev) return;

		for (const tty of this.ttys.values()) {
			this.ops.shutdown?.(tty);
			tty.unregister();
		}
		this.ttys.clear();

		this.cdev.del();
		delete this.cdev;

		char_dev.unregister_region({ major: this.major, minor: this.minor_start }, this.lines);
	}

	public [Symbol.dispose](): void {
		this.unregister();
	}
}
