// SPDX-License-Identifier: LGPL-3.0-or-later
import type { CreationOptions, InodeLike } from '@zenfs/core';
import { FileSystem, Inode, Sync } from '@zenfs/core';
import { S_IFDIR, S_IFLNK, S_IFREG } from '@zenfs/core/constants';
import { withErrno } from 'kerium';
import { _throw, decodeUTF8, encodeUTF8 } from 'utilium';

/** A directory, e.g. a `KObject` in sysfs */
export interface KFSDir<File extends KFSFile = KFSFile, Link extends KFSLink = KFSLink> {
	/** Permissions, without a file type */
	readonly mode: number;
	lookup(name: string): KFSDir<File, Link> | File | Link | undefined;
	keys(): Iterable<string>;
}

export interface KFSFile {
	readonly mode: number;
	show?(): string | Uint8Array;
	store?(value: string): void;
}

export interface KFSLink {
	readonly mode: number;
	readonly contents: string;
}

/** What every one of the kernel's pseudo file systems does the same way. */
export abstract class KernelFS<Dir extends KFSDir<File, Link>, File extends KFSFile, Link extends KFSLink> extends Sync(FileSystem) {
	protected readonly initTime = Date.now();

	protected _nextIno = 1;

	protected _inodes = new Map<string, Inode>();

	constructor(
		type: number,
		name: string,
		/** If set, statSync will get the actual file size */
		protected readonly enableFileSize: boolean = false
	) {
		super(type, name);
	}

	/**
	 * Resolve a path to a node.
	 * @returns `null` or `undefined` when nothing is there
	 * @throws ENOTDIR when part of `path` is used as a directory but isn't one
	 */
	protected abstract lookup(path: string): Dir | File | Link | undefined | null;

	protected abstract is_dir(node: Dir | File | Link): node is Dir;
	protected abstract is_link(node: Dir | File | Link): node is Link;

	/**
	 * Resolve a path to a node.
	 * @throws ENOENT when nothing is there, ENOTDIR when part of the path isn't a directory
	 */
	protected _lookup(path: string): Dir | File | Link {
		const entry = this.lookup(path);
		if (!entry) throw withErrno('ENOENT');
		return entry;
	}

	/**
	 * Take what was written to a node.
	 * @throws EIO when there is nothing behind the file to take it
	 */
	protected store(node: Dir | File | Link, value: string): void {
		if (this.is_link(node)) throw withErrno('EPERM');

		const file = node as File;
		if (!file.store) throw withErrno('EIO');
		file.store(value);
	}

	/**
	 * The inode for a path, made the first time it is asked for and kept so that the times and the
	 * inode number stay put across calls.
	 */
	protected _getInode(path: string, node: Dir | File | Link): Inode {
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
			mode: (this.is_dir(node) ? S_IFDIR : this.is_link(node) ? S_IFLNK : S_IFREG) | node.mode,
		});

		this._inodes.set(path, inode);
		return inode;
	}

	/** Forget the inode for `path`, and for everything that was under it */
	protected _forget(path: string): void {
		for (const known of this._inodes.keys()) if (known == path || known.startsWith(path + '/')) this._inodes.delete(known);
	}

	public statSync(path: string): InodeLike {
		const node = this._lookup(path);
		const inode = this._getInode(path, node);
		if (!this.is_dir(node) && this.enableFileSize) inode.size = this.is_link(node) ? node.contents.length : (node.show?.().length ?? 0);
		return inode;
	}

	public touchSync(path: string, metadata: Partial<InodeLike>): void {
		this._getInode(path, this._lookup(path)).update(metadata);
	}

	public readdirSync(path: string): string[] {
		const node = this._lookup(path);
		if (!this.is_dir(node)) throw withErrno('ENOTDIR');
		return Array.from(node.keys());
	}

	public readSync(path: string, buffer: Uint8Array, start: number, end: number): void {
		const node = this._lookup(path);
		if (this.is_dir(node)) throw withErrno('EISDIR');

		const data = this.is_link(node) ? node.contents : node.show ? (node.show() ?? '') : _throw(withErrno('EIO'));
		const encoded = (typeof data == 'string' ? encodeUTF8(data) : data).subarray(start, end);
		buffer.set(encoded.subarray(0, buffer.byteLength));
	}

	public writeSync(path: string, buffer: Uint8Array, offset: number): void {
		const node = this._lookup(path);
		if (this.is_dir(node)) throw withErrno('EISDIR');
		if (offset) throw withErrno('EINVAL');

		this.store(node, decodeUTF8(buffer));
	}

	public syncSync(): void {
		return;
	}

	public renameSync(): void {
		throw withErrno('EPERM');
	}

	public linkSync(): void {
		throw withErrno('EPERM');
	}

	public createFileSync(_path: string, _options: CreationOptions): InodeLike {
		throw withErrno('EACCES');
	}

	public unlinkSync(_path: string): void {
		throw withErrno('EPERM');
	}

	public mkdirSync(_path: string, _options: CreationOptions): InodeLike {
		throw withErrno('EPERM');
	}

	public rmdirSync(_path: string): void {
		throw withErrno('EPERM');
	}
}
