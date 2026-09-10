// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import { kernel_kobj, sysfs_create_mount_point } from '../kobject.js';
import { parse_bool, parse_number } from '../param.js';
import { KernelFS, type KFSDir } from './kernfs.js';

/** `/sys/kernel/debug`, the empty directory this is mounted over */
sysfs_create_mount_point(kernel_kobj, 'debug');

export interface DebugRef<T> {
	value: T;
}

export function ref<T extends object, K extends keyof T>(object: T, key: K): DebugRef<T[K]> {
	return {
		get value(): T[K] {
			return object[key];
		},
		set value(value: T[K]) {
			object[key] = value;
		},
	};
}

/**
 * What a file in debugfs does when it is read or written, i.e. `struct file_operations`.
 */
export interface DebugFileOps {
	read?: () => string | Uint8Array;
	write?: (value: string) => void;
}

/**
 * The root, before the binding for `debugfsRoot` has been initialized.
 * @internal
 */
let debugfsRoot: DebugDir;

/**
 * Something in debugfs. Unlike sysfs, entries are not tied to kobjects:
 * whoever creates one holds onto it and hands it back to `debugfs_remove`.
 */
export abstract class DebugEntry {
	/** The permissions on this entry, without a file type */
	public abstract mode: number;

	/** Only the root has none */
	public readonly parent?: DebugDir;

	public constructor(
		public name: string,
		parent?: DebugDir
	) {
		this.parent = parent ?? debugfsRoot;
		if (this.parent?.children.has(name)) throw withErrno('EEXIST');
		this.parent?.children.set(name, this);
	}

	/** The path of this entry, relative to the root of debugfs */
	public get path(): string {
		if (!this.parent) return '/';
		const parent = this.parent.path;
		return (parent == '/' ? '' : parent) + '/' + this.name;
	}

	/** Take this entry out of debugfs. This is `debugfs_remove`. */
	public dispose(): void {
		if (this.parent?.children.get(this.name) === this) this.parent.children.delete(this.name);
	}

	public [Symbol.dispose](): void {
		this.dispose();
	}

	public rename(name: string): void {
		if (!this.parent) throw withErrno('EINVAL');
		if (this.parent.children.has(name)) throw withErrno('EEXIST');

		this.parent.children.delete(this.name);
		this.name = name;
		this.parent.children.set(name, this);
	}
}

export class DebugDir extends DebugEntry implements KFSDir<DebugFile, DebugLink> {
	public mode: number = 0o755;

	public readonly children = new Map<string, DebugEntry>();

	public lookup(name: string) {
		return this.children.get(name) as DebugDir | DebugFile | DebugLink;
	}

	public keys(): Iterable<string> {
		return this.children.keys();
	}

	/** `debugfs_remove` takes everything underneath with it */
	public override dispose(): void {
		for (const child of [...this.children.values()]) child.dispose();
		this.children.clear();
		super.dispose();
	}
}

export class DebugLink extends DebugEntry {
	public mode: number = 0o777;

	public constructor(
		name: string,
		parent: DebugDir | undefined,
		public target: string
	) {
		super(name, parent);
	}

	public get contents(): string {
		return this.target;
	}
}

export class DebugFile extends DebugEntry {
	/** These come straight from the operations the file was made with */
	public show?: () => string | Uint8Array;
	public store?: (value: string) => void;

	public constructor(
		name: string,
		parent: DebugDir | undefined,
		public mode: number,
		public readonly ops: DebugFileOps
	) {
		super(name, parent);
		this.show = ops.read;
		this.store = ops.write;
	}
}

/**
 * The root of debugfs. Entries created without a parent end up here.
 * @internal
 */
debugfsRoot = new DebugDir('');
debugfsRoot.mode = 0o700;

/**
 * A file holding a single value, i.e. what `DEFINE_DEBUGFS_ATTRIBUTE` makes.
 * The mode decides which of the two halves the file actually gets.
 */
function attribute<T>(
	name: string,
	mode: number,
	parent: DebugDir | undefined,
	value: DebugRef<T>,
	format: (value: T) => string,
	parse: (text: string) => T
): DebugFile {
	return new DebugFile(name, parent ?? debugfsRoot, mode, {
		read: mode & 0o444 ? () => format(value.value) : undefined,
		write: mode & 0o222 ? (text: string) => void (value.value = parse(text)) : undefined,
	});
}

function decimal(value: number | bigint): string {
	return value + '\n';
}

/** `0x%0*llx\n`, padded to the width of the type */
function hex(digits: number): (value: number | bigint) => string {
	return value => '0x' + value.toString(16).padStart(digits, '0') + '\n';
}

/** Storing to a `u8`, `u16` or `u32` truncates, the same way assigning through the pointer would */
function unsigned(bits: number): (text: string) => number {
	return text => {
		const value = parse_number(text);
		return bits < 32 ? value & ((1 << bits) - 1) : value >>> 0;
	};
}

/** `kstrtoull` with base 0, i.e. decimal unless it is prefixed */
function unsigned_64(text: string): bigint {
	const trimmed = text.trim();
	try {
		return BigInt.asUintN(64, BigInt(/^0[0-7]+$/.test(trimmed) ? '0o' + trimmed.slice(1) : trimmed));
	} catch {
		throw withErrno('EINVAL');
	}
}

export function debugfs_create_u8(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<number>): DebugFile {
	return attribute(name, mode, parent, value, decimal, unsigned(8));
}

export function debugfs_create_u16(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<number>): DebugFile {
	return attribute(name, mode, parent, value, decimal, unsigned(16));
}

export function debugfs_create_u32(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<number>): DebugFile {
	return attribute(name, mode, parent, value, decimal, unsigned(32));
}

export function debugfs_create_u64(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<bigint>): DebugFile {
	return attribute(name, mode, parent, value, decimal, unsigned_64);
}

export function debugfs_create_ulong(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<number>): DebugFile {
	return attribute(name, mode, parent, value, decimal, text => {
		const value = Math.trunc(parse_number(text));
		if (value < 0 || !Number.isSafeInteger(value)) throw withErrno('EINVAL');
		return value;
	});
}

/** Like a `u32`, except it is signed */
export function debugfs_create_atomic_t(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<number>): DebugFile {
	return attribute(name, mode, parent, value, decimal, text => Math.trunc(parse_number(text)) | 0);
}

export function debugfs_create_x8(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<number>): DebugFile {
	return attribute(name, mode, parent, value, hex(2), unsigned(8));
}

export function debugfs_create_x16(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<number>): DebugFile {
	return attribute(name, mode, parent, value, hex(4), unsigned(16));
}

export function debugfs_create_x32(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<number>): DebugFile {
	return attribute(name, mode, parent, value, hex(8), unsigned(32));
}

export function debugfs_create_x64(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<bigint>): DebugFile {
	return attribute(name, mode, parent, value, hex(16), unsigned_64);
}

export function debugfs_create_bool(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<boolean>): DebugFile {
	return attribute(name, mode, parent, value, value => (value ? 'Y\n' : 'N\n'), parse_bool);
}

export function debugfs_create_str(name: string, mode: number, parent: DebugDir | undefined, value: DebugRef<string>): DebugFile {
	return attribute(
		name,
		mode,
		parent,
		value,
		value => value + '\n',
		text => text.replace(/\n$/, '')
	);
}

/** Raw bytes, i.e. `struct debugfs_blob_wrapper` */
export interface DebugBlob {
	data: Uint8Array;
}

/** Like Linux's, this is read-only however generous the mode is */
export function debugfs_create_blob(name: string, mode: number, parent: DebugDir | undefined, blob: DebugBlob): DebugFile {
	return new DebugFile(name, parent ?? debugfsRoot, mode, { read: () => blob.data });
}

/** `struct debugfs_u32_array`, printed space separated on one line */
export interface DebugU32Array {
	array: ArrayLike<number>;
}

export function debugfs_create_u32_array(name: string, mode: number, parent: DebugDir | undefined, array: DebugU32Array): DebugFile {
	return new DebugFile(name, parent ?? debugfsRoot, mode, {
		read: () => (array.array.length ? Array.from(array.array).join(' ') + '\n' : ''),
	});
}

export interface DebugFSOptions {
	/** The permissions on the root, i.e. debugfs' `mode` mount option. */
	mode?: number;
}

/**
 * Somewhere for a driver to put whatever it wants to be able to look at, with no promises about
 * what is there or what shape it is in. Nothing here is API: it exists to be poked at by a person.
 * @see https://www.kernel.org/doc/html/latest/filesystems/debugfs.html
 */
export class DebugFS extends KernelFS<DebugDir, DebugFile, DebugLink> {
	public constructor(options: DebugFSOptions = {}) {
		super(0x64626720, 'debugfs');
		if (options.mode !== undefined) debugfsRoot.mode = options.mode;
	}

	protected lookup(path: string): DebugDir | DebugFile | DebugLink | null {
		let current: DebugDir | DebugFile | DebugLink = debugfsRoot;

		for (const part of path.split('/').filter(p => p)) {
			if (!(current instanceof DebugDir)) throw withErrno('ENOTDIR');

			const next = current.lookup(part);
			if (!next) return null;
			current = next;
		}

		return current;
	}

	protected is_dir(entry: DebugDir | DebugFile | DebugLink): entry is DebugDir {
		return entry instanceof DebugDir;
	}

	protected is_link(entry: DebugDir | DebugFile | DebugLink): entry is DebugLink {
		return entry instanceof DebugLink;
	}
}
