// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The file system syscalls, as functions rather than a table.
 *
 * These are the raw calls: no path resolution, no descriptor bookkeeping, no Node shapes. Whatever
 * turns these into `node:fs` lives above them.
 */
import { decodeUTF8 } from 'utilium';
import type { DirentFields, Termios, Whence } from './abi.js';
import { Ioctl, read_dirents, Stat, StatFs, TermiosAbi, Winsize } from './abi.js';
import { copyOut, returned, syscall, syscall_64 } from './base.js';

export function open(path: string, flags: number, mode: number = 0o644): number {
	return syscall('open', path, flags, mode);
}

export function close(fd: number): void {
	syscall('close', fd);
}

export function pipe(flags: number = 0): [read: number, write: number] {
	syscall('pipe', flags);
	const ends = new DataView(returned.buffer, returned.byteOffset);
	return [ends.getInt32(0, true), ends.getInt32(4, true)];
}

/**
 * Read into a buffer. A buffer bigger than the return region comes back short, the way a read from a
 * pipe does, so callers loop.
 * @param position where to read from, or -1 for wherever the descriptor is
 */
export function read(fd: number, buffer: Uint8Array, position: number = -1): number {
	const length = syscall('read', fd, buffer.byteLength, position);
	buffer.set(returned.subarray(0, length));
	return length;
}

export function write(fd: number, data: Uint8Array, position: number = -1): number {
	return syscall('write', fd, data, position);
}

export function lseek(fd: number, offset: number, whence: Whence): number {
	return Number(syscall_64('lseek', fd, offset, whence));
}

export function ftruncate(fd: number, length: number = 0): void {
	syscall('ftruncate', fd, length);
}

export function fsync(fd: number): void {
	syscall('fsync', fd);
}

export function fdatasync(fd: number): void {
	syscall('fdatasync', fd);
}

export function dup(fd: number): number {
	return syscall('dup', fd);
}

export function dup2(oldfd: number, newfd: number): number {
	return syscall('dup2', oldfd, newfd);
}

/**
 * An ioctl whose answer is a number. The ones that answer with a structure have their own wrappers,
 * since the return value can't carry one.
 */
export function ioctl(fd: number, request: number, arg?: unknown): number {
	return syscall('ioctl', fd, request, arg);
}

/** `tcgetattr`, i.e. `TCGETS` */
export function tcgetattr(fd: number): Termios {
	syscall('ioctl', fd, Ioctl.TCGETS, undefined);
	return copyOut(TermiosAbi);
}

/** `tcsetattr`, i.e. `TCSETS`. Anything left out keeps the setting it had. */
export function tcsetattr(fd: number, termios: Partial<Termios>): void {
	syscall('ioctl', fd, Ioctl.TCSETS, termios);
}

/** How big the terminal is, i.e. `TIOCGWINSZ` */
export function winsize(fd: number): { row: number; col: number } {
	syscall('ioctl', fd, Ioctl.TIOCGWINSZ, undefined);
	return copyOut(Winsize);
}

export function stat(path: string): Stat {
	syscall('stat', path);
	return copyOut(Stat);
}

export function lstat(path: string): Stat {
	syscall('lstat', path);
	return copyOut(Stat);
}

export function fstat(fd: number): Stat {
	syscall('fstat', fd);
	return copyOut(Stat);
}

export function statfs(path: string): StatFs {
	syscall('statfs', path);
	return copyOut(StatFs);
}

export function fstatfs(fd: number): StatFs {
	syscall('fstatfs', fd);
	return copyOut(StatFs);
}

/** Everything left in a directory, as `linux_dirent64` records the way `getdents64` gives them */
export function getdents(fd: number): DirentFields[] {
	syscall('getdents', fd);
	return read_dirents(returned);
}

export function mkdir(path: string, mode: number = 0o777): void {
	syscall('mkdir', path, mode);
}

export function rmdir(path: string): void {
	syscall('rmdir', path);
}

export function unlink(path: string): void {
	syscall('unlink', path);
}

export function rename(from: string, to: string): void {
	syscall('rename', from, to);
}

export function link(target: string, path: string): void {
	syscall('link', target, path);
}

export function symlink(target: string, path: string): void {
	syscall('symlink', target, path);
}

export function readlink(path: string): string {
	syscall('readlink', path);
	return decodeUTF8(returned);
}

export function realpath(path: string): string {
	syscall('realpath', path);
	return decodeUTF8(returned);
}

export function getxattr(path: string, name: string, noFollow: boolean = false): Uint8Array {
	syscall('getxattr', path, name, noFollow);
	return returned.slice();
}

export function setxattr(path: string, name: string, value: Uint8Array, noFollow: boolean = false): void {
	syscall('setxattr', path, name, value, noFollow);
}

export function removexattr(path: string, name: string, noFollow: boolean = false): void {
	syscall('removexattr', path, name, noFollow);
}

export function listxattr(path: string, noFollow: boolean = false): string[] {
	syscall('listxattr', path, noFollow);
	const names = decodeUTF8(returned);
	return names ? names.split('\0') : [];
}

export function truncate(path: string, length: number = 0): void {
	syscall('truncate', path, length);
}

export function chmod(path: string, mode: number): void {
	syscall('chmod', path, mode);
}

export function fchmod(fd: number, mode: number): void {
	syscall('fchmod', fd, mode);
}

export function chown(path: string, uid: number, gid: number): void {
	syscall('chown', path, uid, gid);
}

export function fchown(fd: number, uid: number, gid: number): void {
	syscall('fchown', fd, uid, gid);
}

/** Times are in milliseconds, which is what the VFS keeps */
export function utimes(path: string, atime: number, mtime: number): void {
	syscall('utimes', path, atime, mtime);
}

export function futimes(fd: number, atime: number, mtime: number): void {
	syscall('futimes', fd, atime, mtime);
}

export function access(path: string, mode: number): void {
	syscall('access', path, mode);
}

export function chdir(path: string): void {
	syscall('chdir', path);
}

export function getcwd(): string {
	syscall('getcwd');
	return decodeUTF8(returned);
}
