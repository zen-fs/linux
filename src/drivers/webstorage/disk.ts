// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import { decodeASCII, encodeASCII, pick } from 'utilium';
import type { GenDiskInit } from '../../fs/block_dev.js';
import { GenDisk } from '../../fs/block_dev.js';

/** How many minors each disk gets, so it has room for 15 partitions */
export const diskMinors = 16;

export interface WebStorageDiskInit extends Pick<GenDiskInit, 'major' | 'first_minor' | 'capacity' | 'owner' | 'parent'> {
	chunk_size: number;
	prefix: string;
}

/** A disk backed by a Storage instance */
export class WebStorageDisk extends GenDisk {
	/** How many bytes of the disk each key holds */
	public readonly chunk_size!: number;

	/** What every one of this disk's keys starts with */
	public readonly prefix!: string;

	public constructor(
		public readonly storage: Storage,
		name: string,
		init: WebStorageDiskInit
	) {
		super({
			...pick(init, 'major', 'first_minor', 'capacity', 'owner', 'parent'),
			name,
			minors: diskMinors,
			ops: {
				read: (file, buffer, start, end) => this.read(buffer, start, end),
				write: (file, buffer, offset) => this.write(buffer, offset),
			},
		});

		Object.assign(this, pick(init, 'chunk_size', 'prefix'));

		this.attrs = {
			global: { mode: 0o444, show: () => this.name + '\n' },
			chunk_size: { mode: 0o444, show: () => this.chunk_size + '\n' },
			key_prefix: { mode: 0o444, show: () => this.prefix + '\n' },
			used: { mode: 0o444, show: () => this.used + '\n' },
		};
	}

	protected key(index: number): string {
		return this.prefix + index;
	}

	/** How many keys the disk is currently using, and how many bytes they hold */
	public get used(): number {
		let used = 0;
		for (let i = 0; i < this.storage.length; i++) {
			const key = this.storage.key(i);
			if (key?.startsWith(this.prefix)) used += this.storage.getItem(key)!.length;
		}
		return used;
	}

	/** The contents of a chunk, or nothing when it has never been written */
	protected get_chunk(index: number): Uint8Array | undefined {
		const text = this.storage.getItem(this.key(index));
		if (text === null) return;

		const data = encodeASCII(text);
		if (data.byteLength == this.chunk_size) return data;

		const fixed = new Uint8Array(this.chunk_size);
		fixed.set(data.subarray(0, this.chunk_size));
		return fixed;
	}

	/** Store a chunk, dropping the key entirely when there is nothing left in it */
	protected set_chunk(index: number, data: Uint8Array): void {
		const key = this.key(index);

		if (data.every(byte => !byte)) {
			this.storage.removeItem(key);
			return;
		}

		try {
			this.storage.setItem(key, decodeASCII(data));
		} catch (e: any) {
			throw e instanceof Error && (e.name == 'QuotaExceededError' || e.name == 'NS_ERROR_DOM_QUOTA_REACHED')
				? withErrno('ENOSPC', `${this.name} is full`)
				: withErrno('EIO', `${this.name}: ${e}`);
		}
	}

	public read(buffer: Uint8Array, start: number, end: number): void {
		const length = Math.min(end - start, buffer.byteLength);

		for (let pos = start; pos < start + length;) {
			const index = Math.floor(pos / this.chunk_size);
			const within = pos - index * this.chunk_size;
			const count = Math.min(this.chunk_size - within, start + length - pos);

			const chunk = this.get_chunk(index);
			if (chunk) buffer.set(chunk.subarray(within, within + count), pos - start);
			else buffer.fill(0, pos - start, pos - start + count);

			pos += count;
		}
	}

	public write(buffer: Uint8Array, offset: number): void {
		for (let done = 0; done < buffer.byteLength;) {
			const pos = offset + done;
			const index = Math.floor(pos / this.chunk_size);
			const within = pos - index * this.chunk_size;
			const count = Math.min(this.chunk_size - within, buffer.byteLength - done);

			const chunk = this.get_chunk(index) ?? new Uint8Array(this.chunk_size);
			chunk.set(buffer.subarray(done, done + count), within);
			this.set_chunk(index, chunk);

			done += count;
		}
	}

	public clear(): void {
		const keys: string[] = [];
		for (let i = 0; i < this.storage.length; i++) {
			const key = this.storage.key(i);
			if (key?.startsWith(this.prefix)) keys.push(key);
		}
		for (const key of keys) this.storage.removeItem(key);
	}
}
