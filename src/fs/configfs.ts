// SPDX-License-Identifier: LGPL-3.0-or-later
import { FileSystem, Sync } from '@zenfs/core';
import type { InodeLike } from '@zenfs/core';
import { withErrno } from 'kerium';

/**
 * @see https://www.kernel.org/doc/html/latest/filesystems/configfs.html
 * @todo
 */
export class ConfigFS extends Sync(FileSystem) {
	public constructor() {
		super(0x62656570, 'configfs');
	}

	renameSync(oldPath: string, newPath: string): void {
		throw withErrno('ENOSYS');
	}

	statSync(path: string): InodeLike {
		throw withErrno('ENOSYS');
	}

	touchSync(path: string, metadata: Partial<InodeLike>): void {
		throw withErrno('ENOSYS');
	}

	createFileSync(): InodeLike {
		throw withErrno('ENOSYS');
	}

	unlinkSync(): void {
		throw withErrno('ENOSYS');
	}

	rmdirSync(): void {
		throw withErrno('ENOSYS');
	}

	mkdirSync(): InodeLike {
		throw withErrno('ENOSYS');
	}

	readdirSync(path: string): string[] {
		throw withErrno('ENOENT');
	}

	linkSync(): void {
		throw withErrno('ENOENT');
	}

	syncSync(): void {
		throw withErrno('ENOSYS');
	}

	readSync(path: string, buffer: Uint8Array, start: number, end: number): void {
		throw withErrno('ENOSYS');
	}

	writeSync(path: string, buffer: Uint8Array, offset: number): void {
		throw withErrno('ENOSYS');
	}
}
