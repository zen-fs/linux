// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The syscall ABI. This is the one file both the kernel and userspace import, so it must not pull in
 * either side: no `@zenfs/core`, no worker globals.
 */
import { struct, types as t } from 'memium';
import { decodeUTF8, encodeUTF8 } from 'utilium';

/**
 * The states of the word a blocked thread waits on.
 * A syscall that failed is still `Done`; the error is a negative {@link SyscallData.value}.
 */
export const enum SyscallStatus {
	Pending = 0,
	Done = 1,
}

/**
 * The head of a process' shared page.
 *
 * A thread blocked in `Atomics.wait` can't be handed a message, so everything a sync syscall returns
 * has to come back through here: a value in {@link SyscallData.value}, and anything bigger in the
 * region that follows.
 */
export class SyscallData extends struct('syscall_data', {
	/** The word `Atomics.wait` blocks on */
	status: t.int32(1).$type<[SyscallStatus] & Int32Array>(),
	/** Which syscall this result is for, so a stale wake-up can be told apart */
	id: t.uint32,
	/** What the syscall returned. Negative is `-errno`, the way a Linux syscall returns. */
	value: t.int64,
	/** Signals raised while the thread was blocked, as `1 << sig` */
	signals: t.uint32,
	/** How much of the region the syscall filled */
	length: t.uint32,
}) {}

/** Where the return region starts in the shared page. The control block is 24 bytes; this is rounded up. */
export const regionOffset = 32;

/** How big the return region is by default. A read bigger than this comes back short, which is allowed. */
export const defaultRegionSize = 1024 * 1024;

/**
 * `struct stat`, the layout of what `stat` and friends leave in the region.
 * The fields and their order are x86-64's, so a WALI adapter can write the same thing at a pointer.
 */
export class Stat extends struct('stat', {
	dev: t.uint64,
	ino: t.uint64,
	nlink: t.uint64,
	mode: t.uint32,
	uid: t.uint32,
	gid: t.uint32,
	__pad0: t.uint32,
	rdev: t.uint64,
	size: t.int64,
	blksize: t.int64,
	blocks: t.int64,
	atime: t.int64,
	atime_nsec: t.int64,
	mtime: t.int64,
	mtime_nsec: t.int64,
	ctime: t.int64,
	ctime_nsec: t.int64,
	/** Linux leaves these three reserved and keeps the birth time in `statx` instead; the VFS has one, so it goes here. */
	btime: t.int64,
	btime_nsec: t.int64,
	__unused: t.int64(1),
}) {}

/** What a `struct stat` says, in the units the VFS keeps them in */
export interface StatFields {
	dev: number;
	ino: number;
	nlink: number;
	mode: number;
	uid: number;
	gid: number;
	rdev: number;
	size: number;
	blksize: number;
	blocks: number;
	atimeMs: number;
	mtimeMs: number;
	ctimeMs: number;
	birthtimeMs: number;
}

/** Milliseconds split the way `struct timespec` keeps them */
function split(ms: number): [seconds: bigint, nanoseconds: bigint] {
	const seconds = Math.floor(ms / 1000);
	return [BigInt(seconds), BigInt(Math.round((ms - seconds * 1000) * 1e6))];
}

export function write_stat(stat: Stat, from: StatFields): void {
	stat.dev = BigInt(from.dev);
	stat.ino = BigInt(from.ino);
	stat.nlink = BigInt(from.nlink);
	stat.mode = from.mode;
	stat.uid = from.uid;
	stat.gid = from.gid;
	stat.rdev = BigInt(from.rdev);
	stat.size = BigInt(from.size);
	stat.blksize = BigInt(from.blksize);
	stat.blocks = BigInt(from.blocks);
	[stat.atime, stat.atime_nsec] = split(from.atimeMs);
	[stat.mtime, stat.mtime_nsec] = split(from.mtimeMs);
	[stat.ctime, stat.ctime_nsec] = split(from.ctimeMs);
	[stat.btime, stat.btime_nsec] = split(from.birthtimeMs);
}

export function read_stat(stat: Stat): StatFields {
	const ms = (seconds: bigint, nanoseconds: bigint) => Number(seconds) * 1000 + Number(nanoseconds) / 1e6;

	return {
		dev: Number(stat.dev),
		ino: Number(stat.ino),
		nlink: Number(stat.nlink),
		mode: stat.mode,
		uid: stat.uid,
		gid: stat.gid,
		rdev: Number(stat.rdev),
		size: Number(stat.size),
		blksize: Number(stat.blksize),
		blocks: Number(stat.blocks),
		atimeMs: ms(stat.atime, stat.atime_nsec),
		mtimeMs: ms(stat.mtime, stat.mtime_nsec),
		ctimeMs: ms(stat.ctime, stat.ctime_nsec),
		birthtimeMs: ms(stat.btime, stat.btime_nsec),
	};
}

/**
 * The fixed part of `struct linux_dirent64`. The name follows, NUL terminated, and `reclen` covers
 * both, so entries can be walked without knowing how long the names are.
 */
export class Dirent64 extends struct('linux_dirent64', {
	ino: t.uint64,
	off: t.int64,
	reclen: t.uint16,
	type: t.uint8,
}) {}

/** Where the name starts in a {@link Dirent64} record. Linux packs the struct, so it is not `Dirent64.size`. */
export const direntNameOffset = 19;

export interface DirentFields {
	ino: number;
	/** A `DT_*` */
	type: number;
	name: string;
}

/**
 * Lay entries out as `linux_dirent64` records, stopping when there is no more room.
 * @returns how many bytes they took
 */
export function write_dirents(into: Uint8Array, entries: readonly DirentFields[]): number {
	let offset = 0;

	for (const entry of entries) {
		const name = encodeUTF8(entry.name);

		// The fixed part, the name, its NUL, and enough padding to keep the next record aligned
		const reclen = Math.ceil((direntNameOffset + name.byteLength + 1) / 8) * 8;
		if (offset + reclen > into.byteLength) break;

		const dirent = new Dirent64(into.buffer, into.byteOffset + offset);
		dirent.ino = BigInt(entry.ino);
		dirent.off = BigInt(offset + reclen);
		dirent.reclen = reclen;
		dirent.type = entry.type;

		into.set(name, offset + direntNameOffset);
		into.fill(0, offset + direntNameOffset + name.byteLength, offset + reclen);

		offset += reclen;
	}

	return offset;
}

export function read_dirents(from: Uint8Array): DirentFields[] {
	const entries: DirentFields[] = [];

	for (let offset = 0; offset + direntNameOffset < from.byteLength;) {
		const dirent = new Dirent64(from.buffer, from.byteOffset + offset);
		const reclen = dirent.reclen;
		if (!reclen) break;

		const start = offset + direntNameOffset;
		let end = start;
		while (end < offset + reclen && from[end]) end++;

		entries.push({ ino: Number(dirent.ino), type: dirent.type, name: decodeUTF8(from.subarray(start, end)) });
		offset += reclen;
	}

	return entries;
}

/** `struct utsname`, with the same field size Linux uses */
export class UtsName extends struct('utsname', {
	sysname: t.char(65),
	nodename: t.char(65),
	release: t.char(65),
	version: t.char(65),
	machine: t.char(65),
	domainname: t.char(65),
}) {}

/**
 * The terminal ioctls, from `<asm-generic/ioctls.h>`.
 * These are the ones with an answer that doesn't fit in the return value.
 */
export const enum Ioctl {
	TCGETS = 0x5401,
	TCSETS = 0x5402,
	TIOCGWINSZ = 0x5413,
	TIOCSWINSZ = 0x5414,
	FIONREAD = 0x541b,
}

/** `struct winsize`, what `TIOCGWINSZ` fills in */
export class Winsize extends struct('winsize', {
	row: t.uint16,
	col: t.uint16,
	xpixel: t.uint16,
	ypixel: t.uint16,
}) {}

/**
 * `struct termios`. Linux keeps `c_cc` at `NCCS` bytes whatever a driver uses of it, so this does
 * too; the fields past `c_lflag` that no terminal here has (`c_cflag`, `c_line`) are still in place.
 */
export class TermiosAbi extends struct('termios', {
	iflag: t.uint32,
	oflag: t.uint32,
	cflag: t.uint32,
	lflag: t.uint32,
	line: t.uint8,
	cc: t.uint8(19),
}) {}

// The terminal flags, from `<asm-generic/termbits.h>`. Only what means anything without hardware.

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
	VSUSP: 5,
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

/** The line settings, in the shape everything on either side of the syscall uses them */
export interface TermiosFields {
	iflag: number;
	oflag: number;
	lflag: number;
	cc: number[];
}

export function write_termios(into: TermiosAbi, from: TermiosFields): void {
	into.iflag = from.iflag;
	into.oflag = from.oflag;
	into.lflag = from.lflag;
	into.cc.set(from.cc.slice(0, into.cc.length));
}

export function read_termios(from: TermiosAbi): TermiosFields {
	return { iflag: from.iflag, oflag: from.oflag, lflag: from.lflag, cc: [...from.cc] };
}

/** `SEEK_*` */
export const enum Whence {
	Set = 0,
	Cur = 1,
	End = 2,
}

/**
 * Every syscall, with the types both sides are held to.
 *
 * The arguments are ordinary values: they ride `postMessage`, which runs its structured clone before
 * the thread blocks. The return is an `i64`, since that is all the shared page can carry back; a
 * syscall with a bigger result returns how many bytes it left in the region.
 */
export interface Syscalls {
	// Files
	open(path: string, flags: number, mode: number): number;
	close(fd: number): number;
	/** @returns the number of bytes read, which are in the region */
	read(fd: number, count: number, position: number): number;
	write(fd: number, data: Uint8Array, position: number): number;
	lseek(fd: number, offset: number, whence: Whence): number;
	ftruncate(fd: number, length: number): number;
	fsync(fd: number): number;
	fdatasync(fd: number): number;
	dup(fd: number): number;
	dup2(oldfd: number, newfd: number): number;
	ioctl(fd: number, request: number, arg: unknown): number;

	// Metadata. These leave a `struct stat` in the region.
	stat(path: string): number;
	lstat(path: string): number;
	fstat(fd: number): number;

	// Directories
	/** @returns the number of bytes of `linux_dirent64` records left in the region */
	getdents(fd: number): number;
	mkdir(path: string, mode: number): number;
	rmdir(path: string): number;

	// Names
	unlink(path: string): number;
	rename(from: string, to: string): number;
	link(target: string, path: string): number;
	symlink(target: string, path: string): number;
	/** @returns the length of the target, which is in the region */
	readlink(path: string): number;
	/** @returns the length of the resolved path, which is in the region */
	realpath(path: string): number;

	// Attributes
	truncate(path: string, length: number): number;
	chmod(path: string, mode: number): number;
	fchmod(fd: number, mode: number): number;
	chown(path: string, uid: number, gid: number): number;
	fchown(fd: number, uid: number, gid: number): number;
	/** Times are in milliseconds, since that is what the VFS keeps */
	utimes(path: string, atime: number, mtime: number): number;
	futimes(fd: number, atime: number, mtime: number): number;
	access(path: string, mode: number): number;

	// The process' view of the tree
	chdir(path: string): number;
	/** @returns the length of the working directory, which is in the region */
	getcwd(): number;

	// Processes
	exit(code: number): number;
	getpid(): number;
	getppid(): number;
	getuid(): number;
	geteuid(): number;
	getgid(): number;
	getegid(): number;
	/**
	 * Start a child running `path`. Descriptors are inherited, the way they are across a fork.
	 * @param cwd where the child starts, or nothing to start where the parent is
	 */
	spawn(path: string, argv: string[], env: Record<string, string>, cwd?: string): number;
	/** Replace what this process is running. It never returns: the thread is torn down. */
	execve(path: string, argv: string[], env: Record<string, string>): number;
	/** Block until a child exits. Without a pid, until any child does. @returns its exit code */
	wait(pid: number): number;

	// Signals
	kill(pid: number, signal: number): number;
	/** Tell the kernel whether this process handles a signal itself, i.e. `SIG_DFL` or not */
	sigaction(signal: number, caught: boolean): number;

	// The system
	uname(): number;
}

/** What the kernel sends a thread once, before anything else */
export interface InitMessage {
	$: 'init';
	/** The shared page: the control block, then the return region */
	page: SharedArrayBuffer;
	pid: number;
	argv: string[];
	env: Record<string, string>;
	cwd: string;
	/** The program to run, which the thread loads itself */
	exe: string;
	interpreter: string;
}

/** A syscall on its way to the kernel */
export interface SyscallMessage {
	$: 'syscall';
	id: number;
	name: keyof Syscalls;
	args: unknown[];
	/** Whether the caller is blocked on the shared page rather than waiting for a reply */
	sync: boolean;
}

/**
 * The reply to an async syscall. A sync one is answered through the shared page instead, so this is
 * only used when there is no page to answer through.
 */
export interface ReturnMessage {
	$: 'return';
	id: number;
	/** The same `i64` a sync syscall would have left in the page. Negative is `-errno`. */
	value: number;
	/** What the syscall would have left in the region */
	region?: Uint8Array;
}

/** What a thread says once it is up and has loaded its program */
export interface ReadyMessage {
	$: 'ready';
}

export type ToThread = InitMessage | ReturnMessage;
export type FromThread = SyscallMessage | ReadyMessage;
