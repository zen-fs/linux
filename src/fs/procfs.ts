// SPDX-License-Identifier: LGPL-3.0-or-later
import type { FSContext, InodeLike } from '@zenfs/core';
import { _version, boundContexts, defaultContext, FileSystem, Inode, Sync } from '@zenfs/core';
import { S_IFDIR, S_IFLNK, S_IFREG } from '@zenfs/core/constants';
import { withErrno } from 'kerium';
import * as block_dev from './block_dev.js';
import { sectorSize } from './block_dev.js';
import { initConfig } from '../init.js';
import { modules } from '../module.js';
import { current, processes } from '../process.js';
import * as char_dev from './char_dev.js';
import $pkg from '../../package.json' with { type: 'json' };

/** A file in procfs. Unlike sysfs attributes, most of these are generated wholesale when read. */
export interface ProcFile {
	/** @default 0o444 */
	mode: number;
	show(): string;
	store?(value: string): void;
}

/**
 * A symbolic link in procfs, e.g. `/proc/self` or `/proc/<pid>/cwd`.
 * The target is worked out when the link is read, since what it points at can change.
 */
export class ProcLink {
	public readonly mode = 0o777;
	public constructor(public readonly target: () => string) {}
}

/**
 * A directory in procfs, i.e. `struct proc_dir_entry` for a directory.
 */
export class ProcDir {
	public readonly mode: number = 0o555;
	public readonly children = new Map<string, ProcEntry>();

	public constructor(entries: Record<string, ProcEntry> = {}) {
		for (const [name, entry] of Object.entries(entries)) this.children.set(name, entry);
	}

	public lookup(name: string): ProcEntry | undefined {
		return this.children.get(name);
	}

	public keys(): Iterable<string> {
		return this.children.keys();
	}
}

export type ProcEntry = ProcDir | ProcLink | ProcFile;

/** Shorthand for a read-only generated file */
function file(show: () => string, mode: number = 0o444): ProcFile {
	return { mode, show };
}

/** Every context that currently exists, i.e. the process table. */
function contexts(): FSContext[] {
	return [defaultContext, ...boundContexts.values()].sort((a, b) => a.id - b.id);
}

function context(id: number): FSContext | undefined {
	return id === defaultContext.id ? defaultContext : boundContexts.get(id);
}

/**
 * The mount table, shared by `/proc/mounts` and `/proc/<pid>/mounts`.
 * The "device" column is the file system's label when it has one, since nothing here is backed by a real device.
 */
function show_mounts(ctx: FSContext): string {
	let text = '';

	for (const [path, fs] of ctx.mounts) {
		const options = [fs.attributes.has('no_write') ? 'ro' : 'rw'];
		if (fs.attributes.has('no_atime')) options.push('noatime');
		if (fs.attributes.has('sync')) options.push('sync');

		text += `${fs.label || fs.name} ${path} ${fs.name} ${options.join(',')} 0 0\n`;
	}

	return text;
}

/** `/proc/<pid>/fd`, a link per open descriptor */
class FdDir extends ProcDir {
	public constructor(protected readonly ctx: FSContext) {
		super();
	}

	public lookup(name: string): ProcEntry | undefined {
		const handle = this.ctx.descriptors.get(Number(name));
		if (!handle || !/^\d+$/.test(name)) return;

		return new ProcLink(() => handle.path);
	}

	public keys(): Iterable<string> {
		return [...this.ctx.descriptors.keys()].map(String);
	}
}

/** `/proc/<pid>/fdinfo`, the position and flags of each open descriptor */
class FdInfoDir extends ProcDir {
	public constructor(protected readonly ctx: FSContext) {
		super();
	}

	public lookup(name: string): ProcEntry | undefined {
		const handle = this.ctx.descriptors.get(Number(name));
		if (!handle || !/^\d+$/.test(name)) return;

		return file(() => `pos:\t${handle.position}\nflags:\t0${handle.flag.toString(8)}\nino:\t${handle.inode.ino}\n`);
	}

	public keys(): Iterable<string> {
		return [...this.ctx.descriptors.keys()].map(String);
	}
}

/**
 * `/proc/<pid>/status`.
 * Fields that don't mean anything for a context are still emitted, so the format is the one tools expect.
 */
function show_status(ctx: FSContext): string {
	const { uid, gid, euid, egid, suid, sgid, groups } = ctx.credentials;

	return (
		`Name:\t${processes.get(ctx.id)?.comm || 'context'}\n` +
		`State:\tR (running)\n` +
		`Tgid:\t${ctx.id}\n` +
		`Pid:\t${ctx.id}\n` +
		`PPid:\t${ctx.parent?.id ?? 0}\n` +
		`TracerPid:\t0\n` +
		// Linux prints real, effective, saved, and file system IDs. We have no separate file system ID.
		`Uid:\t${uid}\t${euid}\t${suid}\t${euid}\n` +
		`Gid:\t${gid}\t${egid}\t${sgid}\t${egid}\n` +
		`FDSize:\t${ctx.descriptors.size}\n` +
		`Groups:\t${groups.map(id => id + ' ').join('')}\n` +
		`Threads:\t1\n`
	);
}

/** `/proc/<pid>`, generated for a context rather than stored */
class ContextDir extends ProcDir {
	public constructor(ctx: FSContext) {
		const proc = () => processes.get(ctx.id);

		super({
			cwd: new ProcLink(() => ctx.pwd),
			root: new ProcLink(() => ctx.root),
			exe: new ProcLink(() => proc()?.exe ?? ''),
			fd: new FdDir(ctx),
			fdinfo: new FdInfoDir(ctx),
			status: file(() => show_status(ctx)),
			mounts: file(() => show_mounts(ctx)),
			comm: file(() => (proc()?.comm || 'context') + '\n'),
			cmdline: file(() => proc()?.argv.join('\0') ?? ''),
			environ: file(() =>
				Object.entries(proc()?.env ?? {})
					.map(([key, value]) => `${key}=${value}\0`)
					.join('')
			),
		});
	}
}

/** `/proc/devices`, which lists reserved device numbers rather than devices */
function show_devices(): string {
	let text = 'Character devices:\n';
	for (const [major, name] of char_dev.regions()) text += `${String(major).padStart(3)} ${name}\n`;

	text += '\nBlock devices:\n';
	for (const [major, name] of block_dev.regions()) text += `${String(major).padStart(3)} ${name}\n`;

	return text;
}

/** `/proc/partitions`, every block device and how big it is in 1 KiB blocks */
function show_partitions(): string {
	let text = 'major minor  #blocks  name\n\n';

	for (const dev of block_dev.devices()) {
		const { major, minor } = dev.dev_t;
		const blocks = Math.floor((dev.nr_sectors * sectorSize) / 1024);
		text += `${String(major).padStart(4)}  ${String(minor).padStart(7)} ${String(blocks).padStart(10)} ${dev.name}\n`;
	}

	return text;
}

/**
 * `/proc/modules`.
 * Linux prints the size in bytes and the load address; neither means anything here, so both are 0.
 */
function show_modules(): string {
	let text = '';

	for (const mod of modules.values()) {
		const holders = mod.holders.size ? [...mod.holders].map(m => m.name).join(',') + ',' : '-';
		const state = mod.state == 'live' ? 'Live' : mod.state == 'init' ? 'Loading' : 'Unloading';
		const taint = mod.flags ? ` (${mod.flags})` : '';

		text += `${mod.name} 0 ${mod.refcnt} ${holders} ${state} 0x0000000000000000${taint}\n`;
	}

	return text;
}

/**
 * `/proc/filesystems`.
 */
function show_filesystems(ctx: FSContext): string {
	const types = new Set<string>();
	for (const fs of ctx.mounts.values()) types.add(fs.name);

	return [...types]
		.sort()
		.map(name => `nodev\t${name}\n`)
		.join('');
}

/** When procfs was first loaded, which is as close to a boot time as we have */
const boot = performance.now();

function show_uptime(): string {
	const up = (performance.now() - boot) / 1000;
	// The second number is idle time across every CPU. Nothing here does work, so all of it is idle.
	return `${up.toFixed(2)} ${(up * (navigator.hardwareConcurrency || 1)).toFixed(2)}\n`;
}

/** The context of whoever is asking, which is what `/proc/self` points at. */
function self(): FSContext {
	return current?.context ?? defaultContext;
}

/**
 * `/proc`.
 *
 * Contexts are looked up on demand, so a context bound after procfs was mounted still shows up.
 */
class ProcRoot extends ProcDir {
	public lookup(name: string): ProcEntry | undefined {
		if (!/^\d+$/.test(name)) return super.lookup(name);

		const ctx = context(Number(name));
		return ctx && new ContextDir(ctx);
	}

	public keys(): Iterable<string> {
		return [...contexts().map(ctx => String(ctx.id)), ...super.keys()];
	}
}

/**
 * The root of procfs.
 * @internal
 */
export const proc_root: ProcRoot = new ProcRoot({
	self: new ProcLink(() => String(self().id)),
	cmdline: file(() => initConfig._saved + '\n'),
	devices: file(show_devices),
	filesystems: file(() => show_filesystems(self())),
	modules: file(show_modules),
	mounts: file(() => show_mounts(self())),
	partitions: file(show_partitions),
	uptime: file(show_uptime),
	version: file(() => `ZenFS (@zenfs/linux) version ${$pkg.version} (core ${_version})\n`),
});

/**
 * Resolve a path in procfs.
 * @returns `null` if nothing exists at `path`
 * @throws ENOTDIR when part of `path` is used as a directory but isn't one
 */
export function proc_lookup(path: string): ProcEntry | null {
	let current: ProcEntry = proc_root;

	for (const part of path.split('/').filter(p => p)) {
		if (current instanceof ProcLink) {
			const target: string = current.target();
			const resolved: ProcEntry | undefined = target.startsWith('/') ? undefined : proc_root.lookup(target);
			if (!resolved) throw withErrno('ENOTDIR');
			current = resolved;
		}

		if (!(current instanceof ProcDir)) throw withErrno('ENOTDIR');

		const next = current.lookup(part);
		if (!next) return null;
		current = next;
	}

	return current;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The contents of an entry, or `null` when it doesn't have any (i.e. it is a directory) */
function contents_of(entry: ProcEntry): string | null {
	if (entry instanceof ProcDir) return null;
	if (entry instanceof ProcLink) return entry.target();
	return entry.show();
}

/**
 * A view of ZenFS' contexts and of the kernel emulation, laid out the way Linux lays out `/proc`.
 * @see https://www.kernel.org/doc/html/latest/filesystems/proc.html
 */
export class ProcFS extends Sync(FileSystem) {
	protected readonly initTime = Date.now();

	protected _nextIno = 1;

	protected _inodes = new Map<string, Inode>();

	public constructor() {
		super(0x9fa0, 'proc');
	}

	protected _lookup(path: string): ProcEntry {
		const entry = proc_lookup(path);
		if (!entry) throw withErrno('ENOENT');
		return entry;
	}

	private _getInode(path: string, entry: ProcEntry): Inode {
		let inode = this._inodes.get(path);
		if (inode) return inode;

		inode = new Inode({
			ino: this._nextIno++,
			data: this._nextIno++,
			atimeMs: this.initTime,
			mtimeMs: this.initTime,
			ctimeMs: this.initTime,
			birthtimeMs: this.initTime,
			size: 0,
			nlink: 1,
			mode: (entry instanceof ProcDir ? S_IFDIR : entry instanceof ProcLink ? S_IFLNK : S_IFREG) | entry.mode,
		});

		this._inodes.set(path, inode);
		return inode;
	}

	public renameSync(): void {
		throw withErrno('EPERM');
	}

	public statSync(path: string): InodeLike {
		const entry = this._lookup(path);
		const inode = this._getInode(path, entry);

		const contents = contents_of(entry);
		inode.size = contents === null ? 0 : encoder.encode(contents).byteLength;

		return inode;
	}

	public touchSync(path: string, metadata: Partial<InodeLike>): void {
		this._getInode(path, this._lookup(path)).update(metadata);
	}

	public createFileSync(): InodeLike {
		throw withErrno('EACCES');
	}

	public unlinkSync(): void {
		throw withErrno('EPERM');
	}

	public rmdirSync(): void {
		throw withErrno('EPERM');
	}

	public mkdirSync(): InodeLike {
		throw withErrno('EPERM');
	}

	public readdirSync(path: string): string[] {
		const entry = this._lookup(path);
		if (!(entry instanceof ProcDir)) throw withErrno('ENOTDIR');
		return Array.from(entry.keys());
	}

	public linkSync(): void {
		throw withErrno('EPERM');
	}

	public syncSync(): void {
		return;
	}

	public readSync(path: string, buffer: Uint8Array, start: number, end: number): void {
		const entry = this._lookup(path);

		const contents = contents_of(entry);
		if (contents === null) throw withErrno('EISDIR');

		const data = encoder.encode(contents).subarray(start, end);
		buffer.set(data.subarray(0, buffer.byteLength));
	}

	public writeSync(path: string, buffer: Uint8Array, offset: number): void {
		const entry = this._lookup(path);

		if (entry instanceof ProcDir) throw withErrno('EISDIR');
		if (entry instanceof ProcLink) throw withErrno('EPERM');
		if (!entry.store) throw withErrno('EACCES');
		if (offset) throw withErrno('EINVAL');

		entry.store(decoder.decode(buffer));
	}
}
