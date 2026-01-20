// SPDX-License-Identifier: LGPL-3.0-or-later
import type { InodeLike } from '@zenfs/core';
import { FileSystem, Inode, Sync } from '@zenfs/core';
import { S_IFDIR, S_IFREG } from '@zenfs/core/constants';
import { withErrno } from 'kerium';
import { find_kobj_or_attr, KObject, sysfs_root, type Attribute } from '../kobject.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * @todo
 */
export class SysFS extends Sync(FileSystem) {
	protected readonly initTime = Date.now();

	protected readonly _rootInode = new Inode({ mode: S_IFDIR | 0o555 });

	protected _nextIno = 1;

	protected _inodes = new Map<string, Inode>([['/', this._rootInode]]);

	public constructor() {
		super(0x62656572, 'sysfs');
	}

	renameSync(): void {
		throw withErrno('EPERM');
	}

	private _getInode(path: string, obj: KObject | Attribute): Inode {
		const is_kobj = obj instanceof KObject;
		let inode = this._inodes.get(path);
		if (inode) return inode;
		inode = new Inode();
		inode.ino = this._nextIno++;
		inode.mode = is_kobj ? S_IFDIR | 0o555 : S_IFREG | obj.mode;
		if (is_kobj) inode.size = 4096;
		this._inodes.set(path, inode);
		return inode;
	}

	/**
	 * @todo
	 */
	statSync(path: string): InodeLike {
		if (path === '/') return this._rootInode;
		const node = find_kobj_or_attr(path);
		if (!node) throw withErrno('ENOENT');
		const is_kobj = node instanceof KObject;

		const inode = this._getInode(path, node);

		if (!is_kobj && node.show) {
			inode.size = encoder.encode(node?.show?.() || '').byteLength;
		}

		return inode;
	}

	/**
	 * @todo
	 */
	touchSync(path: string, metadata: Partial<InodeLike>): void {
		if (path === '/') {
			this._rootInode.update(metadata);
			return;
		}
		const node = find_kobj_or_attr(path);
		if (!node) throw withErrno('ENOENT');
		const inode = this._getInode(path, node);
		inode.update(metadata);
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
		if (path === '/') return Array.from(sysfs_root.keys());
		const obj = find_kobj_or_attr(path);
		if (!(obj instanceof KObject)) throw withErrno('ENOTDIR');
		return [...obj.children.keys(), ...obj.attributes.keys()];
	}

	linkSync(): void {
		throw withErrno('EPERM');
	}

	syncSync(): void {
		return;
	}

	/**
	 * @todo
	 */
	readSync(path: string, buffer: Uint8Array, start: number, end: number): void {
		if (path === '/') throw withErrno('EISDIR');
		const node = find_kobj_or_attr(path);
		if (!node) throw withErrno('ENOENT');
		if (node instanceof KObject) throw withErrno('EISDIR');
		if (!node.show) throw withErrno('EIO');
		encoder.encodeInto(node.show(), buffer.subarray(start, end));
	}

	/**
	 * @todo
	 */
	writeSync(path: string, buffer: Uint8Array, offset: number): void {
		if (path === '/') throw withErrno('EISDIR');
		const node = find_kobj_or_attr(path);
		if (!node) throw withErrno('ENOENT');
		if (node instanceof KObject) throw withErrno('EISDIR');
		if (!node.store) throw withErrno('EIO');
		node.store(decoder.decode(buffer.subarray(offset)));
	}
}
