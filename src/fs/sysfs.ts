// SPDX-License-Identifier: LGPL-3.0-or-later
import type { InodeLike } from '@zenfs/core';
import { FileSystem, Inode, Sync } from '@zenfs/core';
import { S_IFDIR, S_IFLNK, S_IFREG } from '@zenfs/core/constants';
import { withErrno } from 'kerium';
import type { KEntry } from '../kobject.js';
import { KLink, KObject, sysfs_lookup } from '../kobject.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The contents of an entry, or `null` when it doesn't have any (i.e. it is a directory).
 */
function contents_of(entry: KEntry): string | null {
	if (entry instanceof KObject) return null;
	if (entry instanceof KLink) return entry.contents;
	return entry.show?.() ?? '';
}

export class SysFS extends Sync(FileSystem) {
	protected readonly initTime = Date.now();

	protected _nextIno = 1;

	protected _inodes = new Map<string, Inode>();

	public constructor() {
		super(0x62656572, 'sysfs');
	}

	renameSync(): void {
		throw withErrno('EPERM');
	}

	protected _lookup(path: string): KEntry {
		const entry = sysfs_lookup(path);
		if (!entry) throw withErrno('ENOENT');
		return entry;
	}

	private _getInode(path: string, obj: KEntry): Inode {
		let inode = this._inodes.get(path);
		if (inode) return inode;

		inode = new Inode({
			ino: this._nextIno++,
			data: this._nextIno++,
			atimeMs: this.initTime,
			mtimeMs: this.initTime,
			ctimeMs: this.initTime,
			birthtimeMs: this.initTime,
			size: 4096,
			mode: obj instanceof KObject ? S_IFDIR | 0o555 : obj instanceof KLink ? S_IFLNK | 0o777 : S_IFREG | obj.mode,
		});

		this._inodes.set(path, inode);
		return inode;
	}

	statSync(path: string): InodeLike {
		const node = this._lookup(path);
		const inode = this._getInode(path, node);
		const contents = contents_of(node);
		if (contents !== null) inode.size = encoder.encode(contents).byteLength;

		return inode;
	}

	touchSync(path: string, metadata: Partial<InodeLike>): void {
		this._getInode(path, this._lookup(path)).update(metadata);
	}

	createFileSync(): InodeLike {
		throw withErrno('EACCES');
	}

	unlinkSync(): void {
		throw withErrno('EPERM');
	}

	rmdirSync(): void {
		throw withErrno('EPERM');
	}

	mkdirSync(): InodeLike {
		throw withErrno('EPERM');
	}

	readdirSync(path: string): string[] {
		const obj = this._lookup(path);
		if (!(obj instanceof KObject)) throw withErrno('ENOTDIR');
		return Array.from(obj.keys());
	}

	linkSync(): void {
		throw withErrno('EPERM');
	}

	syncSync(): void {
		return;
	}

	readSync(path: string, buffer: Uint8Array, start: number, end: number): void {
		const node = this._lookup(path);
		if (node instanceof KObject) throw withErrno('EISDIR');
		if (!(node instanceof KLink) && !node.show) throw withErrno('EIO');

		const data = encoder.encode(contents_of(node)!).subarray(start, end);
		buffer.set(data.subarray(0, buffer.byteLength));
	}

	writeSync(path: string, buffer: Uint8Array, offset: number): void {
		const node = this._lookup(path);
		if (node instanceof KObject) throw withErrno('EISDIR');
		if (node instanceof KLink) throw withErrno('EPERM');
		if (!node.store) throw withErrno('EIO');

		if (offset) throw withErrno('EINVAL');

		node.store(decoder.decode(buffer));
	}
}
