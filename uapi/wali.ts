// SPDX-License-Identifier: LGPL-3.0-or-later
import { Errno } from 'kerium';
import { decodeUTF8, encodeUTF8 } from 'utilium';
import { capabilityVersion, CapData, capDataCount, CapHeader, Ioctl, read_capdata, read_termios, TermiosAbi, Winsize } from './abi.js';
import type { Syscalls } from './abi.js';
import { pending, returned, syscall_raw } from './base.js';
import { environ, argv as get_argv, getpid } from './process.js';

/** The flags `__get_init_envfile` needs to leave the environment somewhere musl can read it */
const O_WRONLY = 1,
	O_CREAT = 0o100,
	O_TRUNC = 0o1000;

const AT_FDCWD = -100;

/** A wasm page. Linear memory only ever grows by these. */
const wasmPageSize = 65536;

/** What musl thinks a page is, which is what its `mmap` lengths are rounded to */
const pageSize = 4096;

let memory: WebAssembly.Memory | undefined;

let buffer: ArrayBufferLike | undefined,
	bytes = new Uint8Array(),
	words = new Int32Array(),
	view = new DataView(new ArrayBuffer(0));

/**
 * The views onto linear memory, remade when it has grown.
 */
function sync(): void {
	const current = memory!.buffer;
	if (current === buffer && bytes.byteLength === current.byteLength) return;

	buffer = current;
	bytes = new Uint8Array(current);
	words = new Int32Array(current);
	view = new DataView(current);
}

/** Read a NUL-terminated string, the way a syscall taking a `const char *` does */
function getString(ptr: number): string {
	sync();
	if (!ptr) return '';
	const end = bytes.indexOf(0, ptr);
	// Copied out because linear memory is shared, and a decoder is not required to take that
	return new TextDecoder().decode(bytes.slice(ptr, end < 0 ? undefined : end));
}

/** Write a string and its NUL, the way `strcpy` does. @returns how many bytes that took */
function putString(ptr: number, text: string): number {
	sync();
	const encoded = encodeUTF8(text);
	bytes.set(encoded, ptr);
	bytes[ptr + encoded.byteLength] = 0;
	return encoded.byteLength + 1;
}

/** A copy of a range of linear memory, so what goes to the kernel is not shared out from under it */
function read_at(ptr: number, length: number): Uint8Array {
	sync();
	return bytes.slice(ptr, ptr + length);
}

function struct_at<T>(Type: { new (buffer: ArrayBufferLike, offset: number): T; size: number }, ptr: number): T {
	const copy = read_at(ptr, Type.size);
	return new Type(copy.buffer, copy.byteOffset);
}

/** Put whatever the last syscall left in the region at a pointer, up to `limit` bytes */
function give(ptr: number, limit: number = Infinity): number {
	const region = returned();
	const length = Math.min(region.byteLength, limit);
	sync();
	bytes.set(region.subarray(0, length), ptr);
	return length;
}

/*
 * mmap.
 *
 * Anonymous mappings are all musl's allocator asks for, and linear memory can only grow at the end,
 * so this hands out the space after the module's own data and grows to cover it. WALI's host does
 * exactly this, which is why `munmap` can only ever give back the most recent mapping.
 */

/** Where mappings start: the end of the memory the module was instantiated with */
let mmapBase = 0;

/** How far past {@link mmapBase} has been handed out */
let mmapLength = 0;

function mmap(length: number): number {
	if (length <= 0) return -Errno.EINVAL;

	const size = Math.ceil(length / pageSize) * pageSize;
	const address = mmapBase + mmapLength;

	sync();
	const needed = address + size - bytes.byteLength;
	if (needed > 0) {
		try {
			memory!.grow(Math.ceil(needed / wasmPageSize));
		} catch {
			// `MAP_FAILED`, which is what musl checks for
			return -1;
		}
		sync();
	}

	mmapLength += size;
	return address;
}

const sigactionSize = 32;

/** What each signal was last given, so `sigaction` can report the old disposition. */
const dispositions = new Map<number, Uint8Array>();

/** The i32 at a wasm address, for the futex calls */
function word(ptr: number): number {
	sync();
	return ptr >> 2;
}

function sys<K extends keyof Syscalls>(name: K, ...args: Parameters<Syscalls[K]>): bigint {
	const narrowed = args.map(arg => (typeof arg == 'bigint' ? Number(arg) : arg)) as Parameters<Syscalls[K]>;
	const value = syscall_raw(name, ...narrowed);
	if (tracing) trace(name, narrowed, value);
	return BigInt(value);
}

/** Set from `WALI_TRACE` in the environment, the way `strace` is turned on from outside */
let tracing = false;

/** The last few calls, so a program that traps can say what it was doing */
export const recent: string[] = [];

function trace(name: string, args: unknown[], value: number): void {
	const shown = args.map(arg => (arg instanceof Uint8Array ? `<${arg.byteLength} bytes>` : JSON.stringify(arg))).join(', ');
	recent.push(`${name}(${shown}) = ${value}`);
	if (recent.length > 32) recent.shift();
}

export const wali = {
	__call_ctors: () => {},
	__call_dtors: () => {},
	__init: () => 0,
	__deinit: () => 0,
	__proc_exit: (code: number) => void syscall_raw('exit', code),

	__cl_get_argc: () => get_argv().length,
	__cl_get_argv_len: (index: number) => encodeUTF8(get_argv()[index] ?? '').byteLength,
	__cl_copy_argv: (ptr: number, index: number) => {
		putString(ptr, get_argv()[index] ?? '');
		return 0;
	},

	/**
	 * musl reads the environment out of a file rather than off the stack, since a wasm module
	 * has no stack to put it on. So this writes one and says where it is.
	 */
	__get_init_envfile: (ptr: number, size: number) => {
		const path = `/tmp/wali_env.${getpid()}`;
		const lines = Object.entries(environ())
			.map(([key, value]) => `${key}=${value}\n`)
			.join('');

		const fd = syscall_raw('open', path, O_WRONLY | O_CREAT | O_TRUNC, 0o600);
		if (fd < 0) return 0;
		syscall_raw('write', fd, encodeUTF8(lines), -1);
		syscall_raw('close', fd);

		if (path.length + 1 > size) return 0;
		putString(ptr, path);
		return 1;
	},

	// Memory. None of these reach the kernel: linear memory is the address space.
	SYS_mmap: (_addr: number, length: number) => BigInt(mmap(length)),
	SYS_munmap: (addr: number, length: number) => {
		// Only a mapping at the very end can be given back, the same as under WALI's host
		const size = Math.ceil(length / pageSize) * pageSize;
		if (addr + size === mmapBase + mmapLength) mmapLength -= size;
		return 0n;
	},
	SYS_mremap: (addr: number, old: number, length: number) => {
		const moved = mmap(length);
		if (moved < 0) return BigInt(moved);
		sync();
		bytes.copyWithin(moved, addr, addr + Math.min(old, length));
		return BigInt(moved);
	},
	SYS_mprotect: () => 0n,
	SYS_madvise: () => 0n,
	/** `brk` is a no-op under WALI: there is no break to move. */
	SYS_brk: () => 0n,

	// Files
	SYS_open: (path: number, flags: number, mode: number) => sys('open', getString(path), flags, mode),
	SYS_openat: (dirfd: number, path: number, flags: number, mode: number) => at(dirfd, path, () => sys('open', getString(path), flags, mode)),
	SYS_close: (fd: number) => sys('close', fd),

	SYS_read: (fd: number, ptr: number, count: number) => {
		const length = syscall_raw('read', fd, count, -1);
		if (length < 0) return BigInt(length);
		return BigInt(give(ptr, count));
	},
	SYS_write: (fd: number, ptr: number, count: number) => sys('write', fd, read_at(ptr, count), -1),

	SYS_readv: (fd: number, iov: number, count: number) => {
		let total = 0;
		for (const { base, length } of iovecs(iov, count)) {
			if (!length) continue;
			const got = syscall_raw('read', fd, length, -1);
			if (got < 0) return total ? BigInt(total) : BigInt(got);
			total += give(base, length);
			// A short read means there is nothing more to be had right now
			if (got < length) break;
		}
		return BigInt(total);
	},
	SYS_writev: (fd: number, iov: number, count: number) => {
		const parts = iovecs(iov, count);
		const total = parts.reduce((sum, { length }) => sum + length, 0);

		const data = new Uint8Array(total);
		let offset = 0;
		for (const { base, length } of parts) {
			data.set(read_at(base, length), offset);
			offset += length;
		}

		return sys('write', fd, data, -1);
	},

	SYS_lseek: (fd: number, offset: bigint, whence: number) => sys('lseek', fd, Number(offset), whence),
	SYS_ftruncate: (fd: number, length: bigint) => sys('ftruncate', fd, Number(length)),
	SYS_fsync: (fd: number) => sys('fsync', fd),
	SYS_fdatasync: (fd: number) => sys('fdatasync', fd),
	SYS_dup: (fd: number) => sys('dup', fd),
	SYS_dup2: (from: number, to: number) => sys('dup2', from, to),
	SYS_fcntl: (fd: number, cmd: number) => (cmd == 0 ? sys('dup', fd) : 0n),
	SYS_ioctl: (fd: number, request: Ioctl, ptr: number) => {
		const value = syscall_raw('ioctl', fd, request, ioctl_argument(request, ptr));
		if (value < 0) return BigInt(value);

		if (request == Ioctl.TCGETS || request == Ioctl.TIOCGWINSZ) {
			give(ptr);
			return 0n;
		}

		if (ptr && (request == Ioctl.TIOCGPGRP || request == Ioctl.FIONREAD || request == Ioctl.TIOCOUTQ)) {
			sync();
			view.setInt32(ptr, value, true);
			return 0n;
		}

		return BigInt(value);
	},

	SYS_pipe: (ptr: number) => pipe_fds(ptr, 0),
	SYS_pipe2: (ptr: number, flags: number) => pipe_fds(ptr, flags),

	SYS_poll: (ptr: number, nfds: number, timeout: number) => poll_fds(ptr, nfds, timeout),
	SYS_ppoll: (ptr: number, nfds: number, ts: number) => poll_fds(ptr, nfds, duration(ts, 1e6)),
	SYS_select: (nfds: number, r: number, w: number, e: number, tv: number) => select_fds(nfds, r, w, e, duration(tv, 1e3)),
	SYS_pselect6: (nfds: number, r: number, w: number, e: number, ts: number) => select_fds(nfds, r, w, e, duration(ts, 1e6)),

	// Metadata. The kernel writes a `struct stat` that is already the layout musl expects.
	SYS_stat: (path: number, ptr: number) => filled_at('stat', ptr, getString(path)),
	SYS_lstat: (path: number, ptr: number) => filled_at('lstat', ptr, getString(path)),
	SYS_fstat: (fd: number, ptr: number) => filled_at('fstat', ptr, fd),
	SYS_fstatat: (dirfd: number, path: number, ptr: number, flags: number) =>
		at(dirfd, path, () => filled_at(flags & 0x100 ? 'lstat' : 'stat', ptr, getString(path))),

	SYS_statfs: (path: number, ptr: number) => filled_at('statfs', ptr, getString(path)),
	SYS_fstatfs: (fd: number, ptr: number) => filled_at('fstatfs', ptr, fd),

	SYS_access: (path: number, mode: number) => sys('access', getString(path), mode),
	SYS_faccessat: (dirfd: number, path: number, mode: number) => at(dirfd, path, () => sys('access', getString(path), mode)),

	SYS_getcwd: (ptr: number, size: number) => {
		const value = syscall_raw('getcwd');
		if (value < 0) return BigInt(value);
		const cwd = returned();
		if (cwd.byteLength + 1 > size) return -BigInt(Errno.ERANGE);
		sync();
		bytes.set(cwd, ptr);
		bytes[ptr + cwd.byteLength] = 0;
		return BigInt(ptr);
	},
	SYS_chdir: (path: number) => sys('chdir', getString(path)),

	SYS_mkdir: (path: number, mode: number) => sys('mkdir', getString(path), mode),
	SYS_rmdir: (path: number) => sys('rmdir', getString(path)),
	SYS_unlink: (path: number) => sys('unlink', getString(path)),
	SYS_unlinkat: (dirfd: number, path: number, flags: number) => at(dirfd, path, () => sys(flags & 0x200 ? 'rmdir' : 'unlink', getString(path))),
	SYS_rename: (from: number, to: number) => sys('rename', getString(from), getString(to)),
	SYS_symlink: (target: number, path: number) => sys('symlink', getString(target), getString(path)),
	SYS_link: (target: number, path: number) => sys('link', getString(target), getString(path)),
	SYS_readlink: (path: number, ptr: number, size: number) => {
		const value = syscall_raw('readlink', getString(path));
		if (value < 0) return BigInt(value);
		return BigInt(give(ptr, size));
	},

	SYS_getxattr: (path: number, name: number, ptr: number, size: number) => sized('getxattr', ptr, size, getString(path), getString(name), false),
	SYS_lgetxattr: (path: number, name: number, ptr: number, size: number) => sized('getxattr', ptr, size, getString(path), getString(name), true),
	SYS_setxattr: (path: number, name: number, ptr: number, size: number) =>
		sys('setxattr', getString(path), getString(name), read_at(ptr, size), false),
	SYS_lsetxattr: (path: number, name: number, ptr: number, size: number) =>
		sys('setxattr', getString(path), getString(name), read_at(ptr, size), true),
	SYS_removexattr: (path: number, name: number) => sys('removexattr', getString(path), getString(name), false),
	SYS_lremovexattr: (path: number, name: number) => sys('removexattr', getString(path), getString(name), true),
	SYS_listxattr: (path: number, ptr: number, size: number) => sized('listxattr', ptr, size, getString(path), false),
	SYS_llistxattr: (path: number, ptr: number, size: number) => sized('listxattr', ptr, size, getString(path), true),

	SYS_getdents64: (fd: number, ptr: number, size: number) => {
		const value = syscall_raw('getdents', fd);
		if (value < 0) return BigInt(value);
		return BigInt(give(ptr, size));
	},

	SYS_truncate: (path: number, length: bigint) => sys('truncate', getString(path), Number(length)),
	SYS_chmod: (path: number, mode: number) => sys('chmod', getString(path), mode),
	SYS_fchmod: (fd: number, mode: number) => sys('fchmod', fd, mode),
	SYS_chown: (path: number, uid: number, gid: number) => sys('chown', getString(path), uid, gid),
	SYS_fchown: (fd: number, uid: number, gid: number) => sys('fchown', fd, uid, gid),

	// Processes
	SYS_exit: (code: number) => sys('exit', code),
	SYS_exit_group: (code: number) => sys('exit', code),
	SYS_getpid: () => sys('getpid'),
	SYS_getppid: () => sys('getppid'),
	SYS_getuid: () => sys('getuid'),
	SYS_geteuid: () => sys('geteuid'),
	SYS_getgid: () => sys('getgid'),
	SYS_getegid: () => sys('getegid'),
	/** There are no threads within a process here, so a thread id is the process id */
	SYS_gettid: () => sys('getpid'),
	SYS_set_tid_address: () => sys('getpid'),

	// Signals
	SYS_kill: (pid: number, signal: number) => sys('kill', pid, signal),
	SYS_tkill: (_tid: number, signal: number) => sys('kill', getpid(), signal),
	SYS_rt_sigaction: (signal: number, act: number, old: number) => {
		const previous = dispositions.get(signal);

		if (act) {
			const disposition = read_at(act, sigactionSize);
			const handler = new DataView(disposition.buffer, disposition.byteOffset).getUint32(0, true);
			const result = sys('sigaction', signal, handler != 0);
			if (result < 0n) return result;
			dispositions.set(signal, disposition);
		}

		if (old) {
			sync();
			if (previous) bytes.set(previous, old);
			else bytes.fill(0, old, old + sigactionSize);
		}

		return 0n;
	},
	SYS_rt_sigprocmask: () => 0n,

	SYS_rt_sigpending: (ptr: number, size: number) => {
		if (!ptr) return -BigInt(Errno.EFAULT);

		sync();
		bytes.fill(0, ptr, ptr + size);
		view.setUint32(ptr, pending() >>> 1, true);
		return 0n;
	},
	SYS_setitimer: (which: number, next: number, previous: number) => {
		const interval = next ? duration(next, 1e3) : 0;
		const value = next ? duration(next + 16, 1e3) : 0;

		const result = syscall_raw('setitimer', which, Math.max(0, value), Math.max(0, interval));
		if (result < 0) return BigInt(result);

		if (previous) {
			const region = returned();
			const answer = new DataView(region.buffer, region.byteOffset);
			write_timeval(previous, answer.getFloat64(8, true));
			write_timeval(previous + 16, answer.getFloat64(0, true));
		}

		return 0n;
	},
	SYS_alarm: (seconds: number) => {
		const result = syscall_raw('setitimer', 0, seconds * 1000, 0);
		if (result < 0) return BigInt(result);

		const region = returned();
		return BigInt(Math.ceil(new DataView(region.buffer, region.byteOffset).getFloat64(0, true) / 1000));
	},

	/**
	 * A real futex, on linear memory. The waiting is what a thread does anyway, and shared
	 * memory is exactly what `Atomics` wants.
	 */
	SYS_futex: (ptr: number, op: number, value: number, timeout: number) => {
		// The private flag says nothing here: there is one address space either way
		switch (op & ~128) {
			case 0: {
				const ms = timeout ? Number(view.getBigInt64(timeout, true)) * 1000 + view.getInt32(timeout + 8, true) / 1e6 : Infinity;
				const woke = Atomics.wait(words, word(ptr), value, ms);
				if (woke == 'not-equal') return -BigInt(Errno.EAGAIN);
				if (woke == 'timed-out') return -BigInt(Errno.ETIMEDOUT);
				return 0n;
			}
			case 1:
				return BigInt(Atomics.notify(words, word(ptr), value));
			default:
				return -BigInt(Errno.ENOSYS);
		}
	},
	SYS_sched_yield: () => 0n,

	SYS_uname: (ptr: number) => filled_at('uname', ptr),
	SYS_sethostname: (ptr: number, length: number) => sys('sethostname', decodeUTF8(read_at(ptr, length))),
	SYS_setdomainname: (ptr: number, length: number) => sys('setdomainname', decodeUTF8(read_at(ptr, length))),

	SYS_capget: (header: number, data: number) => {
		const head = struct_at(CapHeader, header);
		if (head.version != capabilityVersion) return -BigInt(Errno.EINVAL);
		return data ? filled_at('capget', data, head.pid) : sys('capget', head.pid);
	},
	SYS_capset: (header: number, data: number) => {
		const head = struct_at(CapHeader, header);
		if (head.version != capabilityVersion) return -BigInt(Errno.EINVAL);

		const { effective, permitted, inheritable } = read_capdata(read_at(data, CapData.size * capDataCount));
		return sys('capset', head.pid, effective, permitted, inheritable);
	},

	SYS_clock_gettime: (_clock: number, ptr: number) => timespec(ptr, Date.now()),
	SYS_gettimeofday: (ptr: number) => {
		if (!ptr) return 0n;
		const now = Date.now();
		sync();
		view.setBigInt64(ptr, BigInt(Math.floor(now / 1000)), true);
		view.setBigInt64(ptr + 8, BigInt(Math.round((now % 1000) * 1000)), true);
		return 0n;
	},
	SYS_clock_getres: (_clock: number, ptr: number) => timespec(ptr, 1),

	SYS_getrandom: (ptr: number, length: number) => {
		const random = new Uint8Array(length);
		crypto.getRandomValues(random);
		sync();
		bytes.set(random, ptr);
		return BigInt(length);
	},

	/** Positioned reads and writes, which the kernel takes as an argument rather than a seek */
	SYS_pread64: (fd: number, ptr: number, count: number, offset: bigint) => {
		const length = syscall_raw('read', fd, count, Number(offset));
		if (length < 0) return BigInt(length);
		return BigInt(give(ptr, count));
	},
	SYS_pwrite64: (fd: number, ptr: number, count: number, offset: bigint) => sys('write', fd, read_at(ptr, count), Number(offset)),

	SYS_mkdirat: (dirfd: number, path: number, mode: number) => at(dirfd, path, () => sys('mkdir', getString(path), mode)),
	SYS_readlinkat: (dirfd: number, path: number, ptr: number, size: number) =>
		at(dirfd, path, () => {
			const value = syscall_raw('readlink', getString(path));
			if (value < 0) return BigInt(value);
			return BigInt(give(ptr, size));
		}),
	SYS_fchmodat: (dirfd: number, path: number, mode: number) => at(dirfd, path, () => sys('chmod', getString(path), mode)),
	SYS_fchownat: (dirfd: number, path: number, uid: number, gid: number) => at(dirfd, path, () => sys('chown', getString(path), uid, gid)),
	SYS_symlinkat: (target: number, dirfd: number, path: number) => at(dirfd, path, () => sys('symlink', getString(target), getString(path))),

	/** The mask is not kept anywhere, so this reports the usual one and takes no notice of a new one */
	SYS_umask: () => 0o022n,

	// Limits, which nothing here enforces
	SYS_getrlimit: () => 0n,
	SYS_setrlimit: () => 0n,
	SYS_prlimit64: () => 0n,

	/*
	 * `setjmp` and `longjmp`, which are not syscalls: a wasm module cannot save and restore a stack, so
	 * WALI imports them from its host. Its own host does not implement them either — `setjmp` reports
	 * that there is nothing saved and `longjmp` gives up — so this does the same rather than pretend.
	 */
	setjmp: () => {
		missing.add('setjmp');
		return 0;
	},
	sigsetjmp: () => {
		missing.add('sigsetjmp');
		return 0;
	},
	longjmp: () => {
		missing.add('longjmp');
		return void syscall_raw('exit', 1);
	},

	SYS_faccessat2: (dirfd: number, path: number, mode: number) => at(dirfd, path, () => sys('access', getString(path), mode)),
	/** Process groups are not a thing here, so every process is its own leader */
	SYS_getpgid: () => sys('getpid'),
	SYS_getsid: () => sys('getpid'),
	SYS_setpgid: () => 0n,
	SYS_setsid: () => sys('getpid'),
} satisfies WebAssembly.ModuleImports;

/** What a module asked for and did not get, so a program that misbehaves says why once */
export const missing = new Set<string>();

/**
 * The `wali` imports for one module.
 */
function link(module: WebAssembly.Module): WebAssembly.ModuleImports {
	const calls = wali as unknown as Record<string, WebAssembly.ImportValue>;
	const linked: Record<string, WebAssembly.ImportValue> = Object.create(null);

	for (const { module: from, name } of WebAssembly.Module.imports(module)) {
		if (from != 'wali') continue;
		linked[name] = calls[name] ?? not_implemented(name);
	}

	return linked;
}

/** Every WALI syscall answers with an `i64`, so one that is not here can say so in the same shape */
function not_implemented(name: string): () => bigint {
	return () => {
		if (!missing.has(name) && tracing) syscall_raw('write', 2, encodeUTF8(`wali: ${name}: not implemented\n`), -1);
		missing.add(name);
		return -BigInt(Errno.ENOSYS);
	};
}

/** Write a `struct timespec` from milliseconds */
function timespec(ptr: number, ms: number): bigint {
	if (!ptr) return 0n;
	sync();
	view.setBigInt64(ptr, BigInt(Math.floor(ms / 1000)), true);
	view.setBigInt64(ptr + 8, BigInt(Math.round((ms % 1000) * 1e6)), true);
	return 0n;
}

/**
 * A syscall whose answer is a run of bytes, copied out to a pointer that says how much room it has.
 * A size of 0 asks only how big the answer would be, which is what `getxattr` is called for first.
 */
function sized<K extends keyof Syscalls>(name: K, ptr: number, size: number, ...args: Parameters<Syscalls[K]>): bigint {
	const value = syscall_raw(name, ...args);
	if (value < 0 || !size) return BigInt(value);
	if (value > size) return -BigInt(Errno.ERANGE);
	return BigInt(give(ptr, size));
}

/** A syscall whose answer is a structure left in the region, which is copied to a pointer as it is */
function filled_at<K extends keyof Syscalls>(name: K, ptr: number, ...args: Parameters<Syscalls[K]>): bigint {
	const value = syscall_raw(name, ...args);
	if (value < 0) return BigInt(value);
	give(ptr);
	return 0n;
}

/**
 * The `*at` calls, which the kernel has no equivalent of.
 * Relative to the working directory is the same thing as the plain call; relative to some other
 * descriptor is not, and saying so is better than resolving it against the wrong directory.
 */
function at(dirfd: number, path: number, call: () => bigint): bigint {
	if (dirfd != AT_FDCWD && !getString(path).startsWith('/')) return -BigInt(Errno.ENOSYS);
	return call();
}

/**
 * What to hand the kernel for an `ioctl` that carries a structure in.
 *
 * The syscall takes a value rather than a pointer, so these are read out of linear memory here.
 * Anything that only answers, or answers with a number, has nothing to pass along.
 */
function ioctl_argument(request: Ioctl, ptr: number): unknown {
	if (request == Ioctl.TCFLSH) return ptr;

	if (!ptr) return undefined;
	sync();

	switch (request) {
		case Ioctl.TCSETS:
		case Ioctl.TCSETSW:
		case Ioctl.TCSETSF:
			return read_termios(struct_at(TermiosAbi, ptr));
		case Ioctl.TIOCSWINSZ: {
			const size = struct_at(Winsize, ptr);
			return { rows: size.row, cols: size.col };
		}
		case Ioctl.TIOCSPGRP:
			return view.getInt32(ptr, true);
		default:
			return undefined;
	}
}

const POLLIN = 1,
	POLLPRI = 2,
	POLLOUT = 4;

function duration(ptr: number, per_ms: number): number {
	if (!ptr) return -1;
	sync();
	return Number(view.getBigInt64(ptr, true)) * 1000 + Number(view.getBigInt64(ptr + 8, true)) / per_ms;
}

/** `pipe` fills in an `int[2]`, which the kernel leaves in the region as two `int32`s */
function pipe_fds(ptr: number, flags: number): bigint {
	const value = syscall_raw('pipe', flags);
	if (value < 0) return BigInt(value);

	const region = returned();
	const answer = new DataView(region.buffer, region.byteOffset);

	sync();
	view.setInt32(ptr, answer.getInt32(0, true), true);
	view.setInt32(ptr + 4, answer.getInt32(4, true), true);

	return 0n;
}

function write_timeval(ptr: number, ms: number): void {
	sync();
	view.setBigInt64(ptr, BigInt(Math.floor(ms / 1000)), true);
	view.setBigInt64(ptr + 8, BigInt(Math.round((ms % 1000) * 1000)), true);
}

/** `struct pollfd` is `{ int fd; short events; short revents; }`, so 8 bytes with the answer at 6 */
function poll_fds(ptr: number, nfds: number, timeout: number): bigint {
	sync();

	const fds = [];
	for (let i = 0; i < nfds; i++) fds.push({ fd: view.getInt32(ptr + i * 8, true), events: view.getUint16(ptr + i * 8 + 4, true) });

	const value = syscall_raw('poll', fds, timeout);
	if (value < 0) return BigInt(value);

	const region = returned();
	const answer = new DataView(region.buffer, region.byteOffset);

	sync();
	for (let i = 0; i < nfds; i++) view.setUint16(ptr + i * 8 + 6, answer.getUint16(i * 2, true), true);

	return BigInt(value);
}

/**
 * `select`, which is `poll` with the descriptors in bitmaps rather than a list.
 * The sets are both the question and the answer, which is why it is said to destroy its arguments.
 */
function select_fds(nfds: number, readfds: number, writefds: number, exceptfds: number, timeout: number): bigint {
	sync();

	const sets = [readfds, writefds, exceptfds];
	const wants = [POLLIN, POLLOUT, POLLPRI];

	const events = new Map<number, number>();
	for (const [i, set] of sets.entries()) {
		if (!set) continue;
		for (let fd = 0; fd < nfds; fd++) {
			if (bytes[set + (fd >> 3)] & (1 << (fd & 7))) events.set(fd, (events.get(fd) ?? 0) | wants[i]);
		}
	}

	const fds = [...events].map(([fd, events]) => ({ fd, events }));
	const value = syscall_raw('poll', fds, timeout);
	if (value < 0) return BigInt(value);

	const region = returned();
	const answer = new DataView(region.buffer, region.byteOffset);

	sync();
	for (const set of sets) if (set) bytes.fill(0, set, set + Math.ceil(nfds / 8));

	let ready = 0;
	fds.forEach(({ fd }, i) => {
		const mask = answer.getUint16(i * 2, true);
		for (const [s, set] of sets.entries()) {
			if (!set || !(mask & wants[s])) continue;
			bytes[set + (fd >> 3)] |= 1 << (fd & 7);
			ready++;
		}
	});

	return BigInt(ready);
}

/** The `struct iovec` array at a pointer. Its members are pointers, so it is 8 bytes, not 16. */
function iovecs(ptr: number, count: number): { base: number; length: number }[] {
	sync();
	const parts = [];
	for (let i = 0; i < count; i++) {
		parts.push({ base: view.getUint32(ptr + i * 8, true), length: view.getUint32(ptr + i * 8 + 4, true) });
	}
	return parts;
}

/**
 * Load a WALI module and run it.
 *
 * This comes back only if the program returns from `main` without exiting, since `__proc_exit` is a
 * call to `exit` and the kernel tears the thread down there.
 */
export async function run(source: BufferSource): Promise<number> {
	const module = await WebAssembly.compile(source);
	const instance = await WebAssembly.instantiate(module, { wali: link(module) });
	const exports = instance.exports as { memory: WebAssembly.Memory; _start: () => void };

	memory = exports.memory;
	tracing = !!environ().WALI_TRACE;
	sync();

	// Mappings start after the memory the module came up with, which is where WALI's host puts them
	mmapBase = bytes.byteLength;
	mmapLength = 0;

	exports._start();
	return 0;
}
