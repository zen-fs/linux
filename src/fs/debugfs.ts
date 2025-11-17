import { FileSystem, Sync } from '@zenfs/core';
import type { InodeLike } from '@zenfs/core';
import { withErrno } from 'kerium';

/**
 * @see https://www.kernel.org/doc/html/latest/filesystems/debugfs.html
 * @todo
 */
export class DebugFS extends Sync(FileSystem) {
	public constructor() {
		super(0x64626720, 'debugfs');
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
		throw withErrno('ENOSYS');
	}

	linkSync(): void {
		throw withErrno('ENOSYS');
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
