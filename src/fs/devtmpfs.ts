// SPDX-License-Identifier: LGPL-3.0-or-later
import type { InodeLike } from '@zenfs/core';
import { InMemoryStore, InodeFlags, StoreFS, isBlockDevice, isCharacterDevice } from '@zenfs/core';
import type { IoctlContext } from '@zenfs/core/internal/ioctl.js';
import { S_IFBLK, S_IFCHR } from '@zenfs/core/constants';
import { dirname } from '@zenfs/core/path';
import { withErrno } from 'kerium';
import type { Device, DevT } from '../device.js';
import { is_block_dev, toDev, fromDev } from '../device.js';
import * as block_dev from '../block_dev.js';
import * as char_dev from './char_dev.js';

/**
 * A file a device driver is operating on.
 */
export interface DeviceFile {
	/** The path of the file, relative to the root of the file system it is on */
	readonly path: string;
	readonly inode: InodeLike;
	/** The device number of the node, i.e. `inode.rdev` */
	readonly devt: DevT;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DeviceIoctl = (context: IoctlContext, file: DeviceFile, ...args: any[]) => any;

/**
 * The operations a device driver provides, like Linux's `struct file_operations`.
 *
 * @privateRemarks
 * `open` and `release` are never called right now since `@zenfs/core` has no hook for opening a file.
 * They are here so drivers can be written against the interface they may eventually get.
 */
export interface FileOperations {
	open?: (file: DeviceFile) => void;
	release?: (file: DeviceFile) => void;
	// There is no way to report a short read, since `FileSystem.read` doesn't have one either.
	read?: (file: DeviceFile, buffer: Uint8Array, start: number, end: number) => void;
	write?: (file: DeviceFile, buffer: Uint8Array, offset: number) => void;
	sync?: (file: DeviceFile) => void;
	ioctl?: Record<number, DeviceIoctl>;
}

/**
 * The devtmpfs nodes are created in, like Linux's `mnt`.
 */
export let devtmpfs: DevTmpFS | undefined;

/**
 * Devices that should have a node.
 */
export const device_nodes = new Set<Device>();

/**
 * A temporary file system that manages and interfaces with devices
 */
export class DevTmpFS extends StoreFS<InMemoryStore> {
	public constructor() {
		// Please don't store your temporary files in /dev.
		// If you do, you'll have up to 16 MiB
		const store = new InMemoryStore(0x1000000, 'devtmpfs');
		Object.assign(store, { name: 'devtmpfs' });
		super(store);
	}

	public async ready(): Promise<void> {
		await super.ready();
		this._mount();
	}

	public readySync(): void {
		super.readySync();
		this._mount();
	}

	/** Take over as *the* devtmpfs and create nodes for devices registered before we existed */
	protected _mount(): void {
		if (devtmpfs && devtmpfs !== this) throw withErrno('EPERM', 'devtmpfs already exists');
		devtmpfs = this;
		for (const device of device_nodes) this.create_node(device);
	}

	/**
	 * Create a device node, like `mknod`.
	 * @param rdev The device number
	 */
	public mknodSync(path: string, mode: number, rdev: number): InodeLike {
		if (!(mode & S_IFCHR) && !(mode & S_IFBLK)) throw withErrno('EINVAL');
		return this.commitNewSync(path, { mode, rdev, uid: 0, gid: 0, flags: InodeFlags.Private }, new Uint8Array());
	}

	/** `mkdir -p` for the parents of a node in a subdirectory */
	protected _create_path(path: string): void {
		const parts = path.split('/').filter(p => p);

		for (let i = 0, dir = ''; i < parts.length; i++) {
			dir += '/' + parts[i];
			if (!this.existsSync(dir)) this.mkdirSync(dir, { mode: 0o755, uid: 0, gid: 0 });
		}
	}

	/** Remove the directories a node was in, as long as they are empty */
	protected _delete_path(path: string): void {
		for (let dir = path; dir != '/'; dir = dirname(dir)) {
			if (this.readdirSync(dir).length) return;
			this.rmdirSync(dir);
		}
	}

	/**
	 * @internal
	 */
	public create_node(device: Device): void {
		if (!device.dev_t) return;

		const { name, mode } = device.dev_node();
		const path = '/' + name;

		this._create_path(dirname(path));
		this.mknodSync(path, (mode || 0o600) | (is_block_dev(device) ? S_IFBLK : S_IFCHR), toDev(device.dev_t));
	}

	/**
	 * Only remove a node if it is one we created and it still refers to this device,
	 * so a node someone replaced is left alone. This is Linux's `dev_mynode`.
	 * @internal
	 */
	public delete_node(device: Device): void {
		if (!device.dev_t) return;

		const path = '/' + device.dev_node().name;

		let inode: InodeLike;
		try {
			inode = this.statSync(path);
		} catch {
			return;
		}

		if (!(inode.flags! & InodeFlags.Private)) return;
		if (is_block_dev(device) ? !isBlockDevice(inode) : !isCharacterDevice(inode)) return;
		if (inode.rdev != toDev(device.dev_t)) return;

		this.unlinkSync(path);
		if (path.lastIndexOf('/') > 0) this._delete_path(dirname(path));
	}

	/**
	 * The driver handling the node at `path`, if it is a device node.
	 * @param inode The node's inode, for callers that already have an authoritative one
	 * @throws ENXIO when nothing has claimed the node's device number
	 */
	protected _device(path: string, inode: InodeLike = this.statSync(path)): (DeviceFile & { ops: FileOperations }) | undefined {
		if (!isCharacterDevice(inode) && !isBlockDevice(inode)) return;

		const devt = fromDev(inode.rdev);

		const dev = isCharacterDevice(inode) ? char_dev.lookup(devt) : block_dev.lookup(devt);
		if (!dev) throw withErrno('ENXIO');

		return { path, inode, devt, ops: dev.ops };
	}

	public readSync(path: string, buffer: Uint8Array, start: number, end: number): void {
		const file = this._device(path);
		if (!file) return super.readSync(path, buffer, start, end);

		if (!file.ops.read) throw withErrno('EINVAL');
		file.ops.read(file, buffer, start, end);
	}

	public async read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void> {
		const file = this._device(path);
		if (!file) return await super.read(path, buffer, start, end);

		if (!file.ops.read) throw withErrno('EINVAL');
		file.ops.read(file, buffer, start, end);
	}

	public writeSync(path: string, buffer: Uint8Array, offset: number): void {
		const file = this._device(path);
		if (!file) return super.writeSync(path, buffer, offset);

		if (!file.ops.write) throw withErrno('EINVAL');
		file.ops.write(file, buffer, offset);
	}

	public async write(path: string, buffer: Uint8Array, offset: number): Promise<void> {
		const file = this._device(path);
		if (!file) return await super.write(path, buffer, offset);

		if (!file.ops.write) throw withErrno('EINVAL');
		file.ops.write(file, buffer, offset);
	}

	public ioctlSync(context: IoctlContext, command: number, ...args: unknown[]): unknown {
		const file = this._device(context.path, context.inode);
		const op = file?.ops.ioctl?.[command];
		return op ? op(context, file, ...args) : super.ioctlSync(context, command, ...args);
	}

	public async ioctl(context: IoctlContext, command: number, ...args: unknown[]): Promise<unknown> {
		const file = this._device(context.path, context.inode);
		const op = file?.ops.ioctl?.[command];
		return op ? await op(context, file, ...args) : await super.ioctl(context, command, ...args);
	}
}
