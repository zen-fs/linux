// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The file system syscalls.
 *
 * These sit on the VFS rather than on the Node emulation: a descriptor is a kernel `Handle` and what
 * comes back is an inode, not a `Stats`. Turning any of it into `node:fs` is userspace's job.
 */
import type { FSContext, InodeLike } from '@zenfs/core';
import { fs } from '@zenfs/core';
import { O_DIRECTORY, O_NONBLOCK } from '@zenfs/core/constants';
import type { Handle } from '@zenfs/core/vfs/file';
import { dupFD, fromFD, toFD } from '@zenfs/core/vfs/file';
import { ioctlSync } from '@zenfs/core/vfs/ioctl';
import * as vfs from '@zenfs/core/vfs/sync';
import { Ioctl, Stat, TermiosAbi, Whence, Winsize, write_dirents, write_stat, write_termios } from '@zenfs/linux/uapi/abi';
import type { Termios, WinSize } from '../drivers/tty/index.js';
import { withErrno } from 'kerium';
import { encodeUTF8 } from 'utilium';
import type { Process } from '../process.js';
import { processes } from '../process.js';
import { wait_event, wait_event_any } from '../wait.js';
import type { DeviceFileWithOps } from '../fs/devtmpfs.js';
import { DevTmpFS, EPOLLIN, EPOLLOUT } from '../fs/devtmpfs.js';
import { define_syscall, thread_of } from './table.js';

/** Leave a `struct stat` in the region, which is where `stat` and friends put their answer */
function give_stat(proc: Process, inode: InodeLike): number {
	const { region } = thread_of(proc);
	region.fill(0, 0, Stat.size);

	const stat = new Stat(region.buffer, region.byteOffset);
	write_stat(stat, {
		dev: 0,
		rdev: 0,
		blksize: 4096,
		blocks: Math.ceil(inode.size / 512),
		ino: inode.ino,
		nlink: inode.nlink,
		mode: inode.mode,
		uid: inode.uid,
		gid: inode.gid,
		size: inode.size,
		atimeMs: inode.atimeMs,
		mtimeMs: inode.mtimeMs,
		ctimeMs: inode.ctimeMs,
		birthtimeMs: inode.birthtimeMs,
	});

	return thread_of(proc).filled(Stat.size);
}

define_syscall('open', (proc, path, flags, mode) => {
	const handle = vfs.open(proc.context, path, { flag: flags, mode, allowDirectory: !!(flags & O_DIRECTORY) });
	return toFD(handle, proc.context);
});

define_syscall('close', (proc, fd) => fs.closeSync.call(proc.context, fd));

/** The device a descriptor is on, when it is on one */
function device_of(handle: Handle): DeviceFileWithOps | undefined {
	const fs = handle.fs;
	return fs instanceof DevTmpFS ? fs._device(handle.internalPath) : undefined;
}

/**
 * What a device is ready for, i.e. the mask `f_op->poll` gives back.
 * Anything without a `poll` is always ready, since a file always has an answer.
 */
function poll(file: DeviceFileWithOps | undefined): number {
	return file?.ops.poll?.(file) ?? EPOLLIN | EPOLLOUT;
}

define_syscall('read', async (proc, fd, count, position) => {
	const handle = fromFD(proc.context, fd);
	const device = device_of(handle);
	const queue = device?.ops.poll_wait?.(device);

	// A device with nothing to give sleeps until it has some, the way `n_tty_read` waits on `read_wait`
	if (queue && !(poll(device) & EPOLLIN)) {
		if (handle.flag & O_NONBLOCK) throw withErrno('EAGAIN');
		await wait_event(queue, () => !!(poll(device) & EPOLLIN), proc);
	}

	const { region } = thread_of(proc);
	const into = region.subarray(0, Math.min(count, region.byteLength));

	// A terminal handing over one line is a short read, which only the device layer can report
	const length = device
		? (handle.fs as DevTmpFS).read_device(device, into, 0, into.byteLength)
		: handle.readSync(into, 0, into.byteLength, position < 0 ? undefined : position);

	return thread_of(proc).filled(length);
});

define_syscall('write', (proc, fd, data, position) =>
	fromFD(proc.context, fd).writeSync(data, 0, data.byteLength, position < 0 ? undefined : position)
);

define_syscall('lseek', (proc, fd, offset, whence) => {
	const handle = fromFD(proc.context, fd);

	switch (whence) {
		case Whence.Set:
			handle.position = offset;
			break;
		case Whence.Cur:
			handle.position += offset;
			break;
		case Whence.End:
			handle.position = handle.inode.size + offset;
			break;
		default:
			throw withErrno('EINVAL');
	}

	if (handle.position < 0) throw withErrno('EINVAL');
	return handle.position;
});

define_syscall('ftruncate', (proc, fd, length) => fromFD(proc.context, fd).truncateSync(length));
define_syscall('fsync', (proc, fd) => fromFD(proc.context, fd).syncSync());
define_syscall('fdatasync', (proc, fd) => fromFD(proc.context, fd).datasyncSync());
define_syscall('dup', (proc, fd) => dupFD(proc.context, fd));

define_syscall('dup2', (proc, oldfd, newfd) => {
	if (oldfd == newfd) return newfd;

	const handle = fromFD(proc.context, oldfd);
	if (proc.context.descriptors.has(newfd)) fs.closeSync.call(proc.context, newfd);
	proc.context.descriptors.set(newfd, handle.ref());
	return newfd;
});

/**
 * The ioctls whose answer is a structure rather than a number, i.e. the ones Linux gives an out
 * pointer. The return value can only carry a number, so these leave theirs in the region instead.
 */
const ioctl_answers: Record<number, (into: Uint8Array, value: never) => number> = {
	[Ioctl.TIOCGWINSZ]: (into, value: WinSize) => {
		into.fill(0, 0, Winsize.size);
		const size = new Winsize(into.buffer, into.byteOffset);
		size.row = value.rows;
		size.col = value.cols;
		return Winsize.size;
	},
	[Ioctl.TCGETS]: (into, value: Termios) => {
		into.fill(0, 0, TermiosAbi.size);
		write_termios(new TermiosAbi(into.buffer, into.byteOffset), value);
		return TermiosAbi.size;
	},
};

function ioctl_argument(request: Ioctl, arg: unknown): unknown {
	if (request != Ioctl.TIOCSPGRP) return arg;

	const target = processes.get(arg as number);
	if (!target) throw withErrno('ESRCH');
	return target;
}

define_syscall('ioctl', (proc, fd, request, arg) => {
	const ioctl = ioctlSync as unknown as (this: FSContext, fd: number, command: number, ...args: unknown[]) => unknown;
	const value = ioctl.call(proc.context, fd, request, ioctl_argument(request, arg));

	const answer = ioctl_answers[request];
	if (answer) return thread_of(proc).filled(answer(thread_of(proc).region, value as never));

	return typeof value == 'number' ? value : 0;
});

const POLLNVAL = 0x20;

define_syscall('poll', async (proc, fds, timeout) => {
	const entries = fds.map(({ fd, events }) => {
		try {
			const device = device_of(fromFD(proc.context, fd));
			return { events, device, queue: device?.ops.poll_wait?.(device) };
		} catch {
			return { events, invalid: true };
		}
	});

	const masks = (): number[] => entries.map(e => ('invalid' in e ? POLLNVAL : poll(e.device) & e.events));

	const ready = (): number => masks().filter(Boolean).length;

	const queues = entries.flatMap(e => ('queue' in e && e.queue ? [e.queue] : []));
	await wait_event_any(queues, () => ready() > 0, proc, timeout);

	const { region } = thread_of(proc);
	const answer = new DataView(region.buffer, region.byteOffset);
	const revents = masks();
	revents.forEach((mask, i) => answer.setUint16(i * 2, mask, true));
	thread_of(proc).filled(revents.length * 2);

	return revents.filter(Boolean).length;
});

define_syscall('stat', (proc, path) => give_stat(proc, vfs.stat.call(proc.context, path, false)));
define_syscall('lstat', (proc, path) => give_stat(proc, vfs.stat.call(proc.context, path, true)));
define_syscall('fstat', (proc, fd) => give_stat(proc, fromFD(proc.context, fd).inode));

define_syscall('getdents', (proc, fd) => {
	const entries = vfs.readdir.call(proc.context, fromFD(proc.context, fd).path);
	return thread_of(proc).filled(write_dirents(thread_of(proc).region, entries));
});

define_syscall('mkdir', (proc, path, mode) => void vfs.mkdir.call(proc.context, path, { mode }));
define_syscall('rmdir', (proc, path) => fs.rmdirSync.call(proc.context, path));
define_syscall('unlink', (proc, path) => fs.unlinkSync.call(proc.context, path));
define_syscall('rename', (proc, from, to) => vfs.rename.call(proc.context, from, to));
define_syscall('link', (proc, target, path) => vfs.link.call(proc.context, target, path));
define_syscall('symlink', (proc, target, path) => fs.symlinkSync.call(proc.context, target, path));
define_syscall('readlink', (proc, path) => thread_of(proc).put(encodeUTF8(vfs.readlink.call(proc.context, path))));
define_syscall('realpath', (proc, path) => thread_of(proc).put(encodeUTF8(fs.realpathSync.call(proc.context, path))));

define_syscall('truncate', (proc, path, length) => fs.truncateSync.call(proc.context, path, length));
define_syscall('chmod', (proc, path, mode) => fs.chmodSync.call(proc.context, path, mode));
define_syscall('fchmod', (proc, fd, mode) => fromFD(proc.context, fd).chmodSync(mode));
define_syscall('chown', (proc, path, uid, gid) => fs.chownSync.call(proc.context, path, uid, gid));
define_syscall('fchown', (proc, fd, uid, gid) => fromFD(proc.context, fd).chownSync(uid, gid));
define_syscall('utimes', (proc, path, atime, mtime) => fs.utimesSync.call(proc.context, path, atime, mtime));
define_syscall('futimes', (proc, fd, atime, mtime) => fromFD(proc.context, fd).utimesSync(atime, mtime));
define_syscall('access', (proc, path, mode) => fs.accessSync.call(proc.context, path, mode));

define_syscall('chdir', (proc, path) => proc.chdir(path));
define_syscall('getcwd', proc => thread_of(proc).put(encodeUTF8(proc.cwd)));
