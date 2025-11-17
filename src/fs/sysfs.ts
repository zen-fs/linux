import { FileSystem, Sync } from '@zenfs/core';
import type { InodeLike } from '@zenfs/core';
import { withErrno } from 'kerium';
import { kobj_find, KObject } from '../kobject.js';

/**
 * @todo
 */
export class SysFS extends Sync(FileSystem) {
	protected readonly initTime = Date.now();

	public constructor() {
		super(0x62656572, 'sysfs');
	}

	renameSync(): void {
		throw withErrno('EACCES');
	}

	/**
	 * @todo
	 */
	statSync(path: string): InodeLike {
		const node = kobj_find(path);
		if (!node) throw withErrno('ENOENT');
		throw withErrno('ENOSYS');
	}

	/**
	 * @todo
	 */
	touchSync(path: string, metadata: Partial<InodeLike>): void {
		return;
	}

	createFileSync(): InodeLike {
		throw withErrno('EACCES');
	}

	unlinkSync(): void {
		throw withErrno('EACCES');
	}

	rmdirSync(): void {
		throw withErrno('EACCES');
	}

	mkdirSync(): InodeLike {
		throw withErrno('EACCES');
	}

	readdirSync(path: string): string[] {
		const obj = kobj_find(path);
		if (!(obj instanceof KObject)) throw withErrno('ENOTDIR');
		return [...obj.children.keys(), ...obj.attributes.keys()];
	}

	linkSync(): void {
		throw withErrno('EACCES');
	}

	/**
	 * @todo
	 */
	syncSync(): void {
		throw withErrno('ENOSYS');
	}

	/**
	 * @todo
	 */
	readSync(path: string, buffer: Uint8Array, start: number, end: number): void {
		throw withErrno('ENOSYS');
	}

	/**
	 * @todo
	 */
	writeSync(path: string, buffer: Uint8Array, offset: number): void {
		throw withErrno('ENOSYS');
	}
}
