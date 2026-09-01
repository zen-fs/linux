// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import { Device } from '../../device.js';
import type { DeviceFile, FileOperations } from '../../fs/char_dev.js';
import * as char_dev from '../../fs/char_dev.js';
import { Class } from '../base/class.js';

export const memMajor = 1;

/** `crypto.getRandomValues` will not fill more than this at once */
const random_chunk_size = 0x10000;

const random_ops: FileOperations = {
	read(file, buffer, start, end) {
		const data = buffer.subarray(0, end - start);
		for (let i = 0; i < data.byteLength; i += random_chunk_size) {
			// `crypto.getRandomValues` doesn't accept views of a `SharedArrayBuffer`, but it never sees one here
			crypto.getRandomValues(data.subarray(i, Math.min(i + random_chunk_size, data.byteLength)) as Uint8Array<ArrayBuffer>);
		}
	},
	write() {},
};

interface MemDevice {
	name: string;
	ops: FileOperations;
	mode?: number;
}

/**
 * The memory devices, by minor.
 * @see `<linux>/Documentation/admin-guide/devices.txt`.
 */
const dev_list: Record<number, MemDevice> = {
	// There is no way to report a short read, so a read leaves the buffer alone rather than zeroing it.
	// Since the node's size is 0, nothing reads past the end anyway.
	3: { name: 'null', ops: { read() {}, write() {} }, mode: 0o666 },
	5: {
		name: 'zero',
		ops: {
			read(file, buffer, start, end) {
				buffer.fill(0, 0, end - start);
			},
			write() {},
		},
		mode: 0o666,
	},
	7: {
		name: 'full',
		ops: {
			read(file, buffer, start, end) {
				buffer.fill(0, 0, end - start);
			},
			write() {
				throw withErrno('ENOSPC');
			},
		},
		mode: 0o666,
	},
	8: { name: 'random', ops: random_ops, mode: 0o666 },
	9: { name: 'urandom', ops: random_ops, mode: 0o666 },
};

/**
 * All of these share one major, so the real driver is picked using the minor.
 * Linux does this in `memory_open` since it only gets to swap a file's operations once, when it is opened.
 * We have no such hook, so every operation looks the device up.
 */
function mem_dev(file: DeviceFile): FileOperations {
	const dev = dev_list[file.devt.minor];
	if (!dev) throw withErrno('ENXIO');
	return dev.ops;
}

const memory_ops: FileOperations = {
	open: file => mem_dev(file).open?.(file),
	release: file => mem_dev(file).release?.(file),
	sync: file => mem_dev(file).sync?.(file),
	read(file, buffer, start, end) {
		const { read } = mem_dev(file);
		if (!read) throw withErrno('EINVAL');
		read(file, buffer, start, end);
	},
	write(file, buffer, offset) {
		const { write } = mem_dev(file);
		if (!write) throw withErrno('EINVAL');
		write(file, buffer, offset);
	},
};

/** `/sys/class/mem` */
export const mem_class = new Class('mem', {
	dev_node: device => ({ mode: device.dev_t && dev_list[device.dev_t.minor]?.mode }),
});

/**
 * Register the memory devices, i.e. `/dev/{null,zero,full,random,urandom}`.
 */
export function char_dev_init(): void {
	char_dev.register(memMajor, 'mem', memory_ops);

	for (const [minor, dev] of Object.entries(dev_list)) {
		new Device({ name: dev.name, class: mem_class, dev_t: { major: memMajor, minor: +minor } }).register();
	}
}
