// SPDX-License-Identifier: LGPL-3.0-or-later
import { boundContexts, FileSystem, Sync } from '@zenfs/core';
import type { InodeLike } from '@zenfs/core';
import { withErrno } from 'kerium';

/**
 * @todo
 */
export class ProcFS extends Sync(FileSystem) {
	public constructor() {
		super(0x9fa0, 'procfs');
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
		throw withErrno('ENOENT');
	}

	unlinkSync(): void {
		throw withErrno('ENOENT');
	}

	rmdirSync(): void {
		throw withErrno('ENOENT');
	}

	mkdirSync(): InodeLike {
		throw withErrno('ENOENT');
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
