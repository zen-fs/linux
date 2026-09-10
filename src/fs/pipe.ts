// SPDX-License-Identifier: LGPL-3.0-or-later
import type { FSContext, InodeLike } from '@zenfs/core';
import { InMemoryStore, StoreFS } from '@zenfs/core';
import { O_RDONLY, O_WRONLY, S_IFIFO } from '@zenfs/core/constants';
import { Handle, toFD } from '@zenfs/core/vfs/file';
import { cacheOf } from '@zenfs/core/vfs/vcache';
import { withErrno } from 'kerium';
import { processes } from '../process.js';
import { WaitQueue } from '../wait.js';
import type { DeviceFile, DeviceFileWithOps, FileOperations } from './devtmpfs.js';
import { EPOLLIN, EPOLLOUT } from './devtmpfs.js';

/** How much a pipe holds before a write has to wait. Linux's default is sixteen pages. */
export const pipeCapacity = 65536;

/** One pipe, i.e. `struct pipe_inode_info` */
class Pipe {
	/** What has been written and not yet read */
	protected buffer = new Uint8Array(0);

	/** Whatever is sleeping on the pipe, at either end */
	public readonly wait = new WaitQueue();

	public constructor(public readonly id: number) {}

	public get readable(): number {
		return this.buffer.byteLength;
	}

	public get writable(): number {
		return pipeCapacity - this.buffer.byteLength;
	}

	/** @returns how much came out, which is short when there is less than was asked for */
	public take(into: Uint8Array): number {
		const length = Math.min(into.byteLength, this.buffer.byteLength);
		into.set(this.buffer.subarray(0, length));
		this.buffer = this.buffer.slice(length);

		// A reader taking data is what makes room for a writer
		this.wait.wake_up();
		return length;
	}

	/** @returns how much went in, which is short when the pipe filled up */
	public put(data: Uint8Array): number {
		const length = Math.min(data.byteLength, this.writable);
		if (!length) return 0;

		const grown = new Uint8Array(this.buffer.byteLength + length);
		grown.set(this.buffer);
		grown.set(data.subarray(0, length), this.buffer.byteLength);
		this.buffer = grown;

		this.wait.wake_up();
		return length;
	}
}

/** Which end of which pipe a file on {@link PipeFS} is */
interface End {
	pipe: Pipe;
	write: boolean;
}

/** The read end of pipe 3 is `/3.r` and the write end `/3.w`, so the two ends are separate files */
function path_of(id: number, write: boolean): string {
	return `/${id}.${write ? 'w' : 'r'}`;
}

/**
 * The file system pipes live on, which is never mounted.
 * There is one, the way there is one `pipe_mnt`.
 */
export class PipeFS extends StoreFS<InMemoryStore> {
	protected readonly pipes = new Map<number, Pipe>();

	protected next = 1;

	public constructor() {
		const store = new InMemoryStore(0x1000000, 'pipefs');
		Object.assign(store, { name: 'pipefs' });
		super(store);
		this.readySync();
	}

	/** Make a pipe and the two files that are its ends */
	public create(): { pipe: Pipe; read: InodeLike; write: InodeLike } {
		const pipe = new Pipe(this.next++);
		this.pipes.set(pipe.id, pipe);

		const mode = S_IFIFO | 0o600;
		return {
			pipe,
			read: this.createFileSync(path_of(pipe.id, false), { mode, uid: 0, gid: 0 }),
			write: this.createFileSync(path_of(pipe.id, true), { mode, uid: 0, gid: 0 }),
		};
	}

	/** @internal */
	public _end(path: string): End | undefined {
		const match = /^\/(\d+)\.([rw])$/.exec(path);
		if (!match) return;

		const pipe = this.pipes.get(Number(match[1]));
		return pipe && { pipe, write: match[2] == 'w' };
	}

	/**
	 * The operations for a pipe end, in the shape the syscalls already look for on a device node.
	 * @internal
	 */
	public _device(path: string, inode: InodeLike = this.statSync(path)): DeviceFileWithOps | undefined {
		const end = this._end(path);
		if (!end) return;

		return { path, inode, devt: { major: 0, minor: end.pipe.id }, ops: pipe_ops };
	}

	/** The same call {@link readSync} makes, with the count a short read needs to report @internal */
	public read_device(file: DeviceFileWithOps, buffer: Uint8Array, start: number, end: number): number {
		return pipe_ops.read!(file, buffer, start, end) ?? 0;
	}

	/** @internal */
	public write_device(file: DeviceFileWithOps, buffer: Uint8Array, offset: number): number {
		return pipe_ops.write!(file, buffer, offset) ?? buffer.byteLength;
	}

	public override readSync(path: string, buffer: Uint8Array, start: number, end: number): void {
		const file = this._device(path);
		if (!file) return super.readSync(path, buffer, start, end);
		pipe_ops.read!(file, buffer, start, end);
	}

	public override writeSync(path: string, buffer: Uint8Array, offset: number): void {
		const file = this._device(path);
		if (!file) return super.writeSync(path, buffer, offset);
		pipe_ops.write!(file, buffer, offset);
	}
}

export const pipefs = new PipeFS();

/** How many descriptors anywhere still refer to one end of a pipe */
function open_ends(path: string): number {
	let count = 0;

	for (const proc of processes.values()) {
		for (const handle of proc.context.descriptors.values()) {
			if (handle.fs === pipefs && handle.internalPath == path) count++;
		}
	}

	return count;
}

/** The other end of the pipe a path belongs to */
function opposite(path: string): string {
	return path.endsWith('.w') ? path.slice(0, -1) + 'r' : path.slice(0, -1) + 'w';
}

function end_of(file: DeviceFile): End {
	const end = pipefs._end(file.path);
	if (!end) throw withErrno('EBADF');
	return end;
}

/**
 * What a pipe does, i.e. `pipefifo_fops`.
 */
const pipe_ops: FileOperations = {
	read(file, buffer, start, end) {
		return end_of(file).pipe.take(buffer.subarray(start, end));
	},
	write(file, buffer) {
		// Nothing left to read it, so the write is pointless and Linux says so rather than buffering
		if (!open_ends(opposite(file.path))) throw withErrno('EPIPE');
		return end_of(file).pipe.put(buffer);
	},
	poll(file) {
		const { pipe, write } = end_of(file);

		if (write) return pipe.writable || !open_ends(opposite(file.path)) ? EPOLLOUT : 0;
		return pipe.readable || !open_ends(opposite(file.path)) ? EPOLLIN : 0;
	},
	poll_wait: file => end_of(file).pipe.wait,
};

/**
 * Make a pipe.
 * @param flags what both descriptors are opened with, e.g. `O_NONBLOCK`
 * @returns the read end and then the write end, the way `pipe` fills in its array
 */
export function create_pipe($: FSContext, flags: number = 0): [read: number, write: number] {
	const { pipe, read, write } = pipefs.create();

	const name = `pipe:[${pipe.id}]`;

	return [
		toFD(new Handle($, name, path_of(pipe.id, false), O_RDONLY | flags, cacheOf(pipefs).ref(path_of(pipe.id, false), read)), $),
		toFD(new Handle($, name, path_of(pipe.id, true), O_WRONLY | flags, cacheOf(pipefs).ref(path_of(pipe.id, true), write)), $),
	];
}
