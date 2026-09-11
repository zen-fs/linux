// SPDX-License-Identifier: LGPL-3.0-or-later
import type { FSContext } from '@zenfs/core';
import { boundContexts, defaultContext } from '@zenfs/core';
import { withErrno } from 'kerium';
import { cap_last, initial_capabilities } from '../capability.js';
import { initConfig } from '../init.js';
import { modules } from '../module.js';
import { current, processes } from '../process.js';
import { init_uts, set_domainname, set_hostname } from '../uts.js';
import * as block_dev from './block_dev.js';
import { sectorSize } from './block_dev.js';
import * as char_dev from './char_dev.js';
import { KernelFS } from './kernfs.js';

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

	public get contents(): string {
		return this.target();
	}
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
	const caps = processes.get(ctx.id)?.caps ?? initial_capabilities();
	const set = (value: bigint) => value.toString(16).padStart(16, '0');

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
		`CapInh:\t${set(caps.inheritable)}\n` +
		`CapPrm:\t${set(caps.permitted)}\n` +
		`CapEff:\t${set(caps.effective)}\n` +
		`CapBnd:\t${set(caps.bounding)}\n` +
		`CapAmb:\t${set(caps.ambient)}\n` +
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
	version: file(() => `${init_uts.sysname} version ${init_uts.release} (${init_uts.version})\n`),
	sys: new ProcDir({
		kernel: new ProcDir({
			cap_last_cap: file(() => cap_last + '\n'),
			ostype: file(() => init_uts.sysname + '\n'),
			osrelease: file(() => init_uts.release + '\n'),
			version: file(() => init_uts.version + '\n'),
			hostname: { mode: 0o644, show: () => init_uts.nodename + '\n', store: value => set_hostname(value.trim()) },
			domainname: { mode: 0o644, show: () => init_uts.domainname + '\n', store: value => set_domainname(value.trim()) },
		}),
	}),
});

/**
 * A view of ZenFS' contexts and of the kernel emulation, laid out the way Linux lays out `/proc`.
 * @see https://www.kernel.org/doc/html/latest/filesystems/proc.html
 */
export class ProcFS extends KernelFS<ProcDir, ProcFile, ProcLink> {
	public constructor() {
		super(0x9fa0, 'proc', true);
	}

	protected lookup(path: string): ProcEntry | null {
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

	protected is_dir(entry: ProcEntry): entry is ProcDir {
		return entry instanceof ProcDir;
	}

	protected is_link(entry: ProcEntry): entry is ProcLink {
		return entry instanceof ProcLink;
	}
}
