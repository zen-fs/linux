// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import type { DevNode, DevT, DeviceType } from './device.js';
import { Device, format_dev_t, toDev } from './device.js';
import { Class } from './drivers/base/class.js';
import type { DeviceFile, FileOperations } from './fs/char_dev.js';
import { KObject, sysfs_create_link, sysfs_remove_link } from './kobject.js';
import type { Module } from './module.js';
import { assignWithDefaults, pick } from 'utilium';

export const blockDevMajorMax = 512;

/** How many partitions a disk can have */
export const diskMaxParts = 256;

/** Sizes in the block layer are always counted in sectors this big */
export const sectorSize = 512;

/**
 * Reserved majors, i.e. `major_names`. This is the "Block devices:" half of `/proc/devices`.
 * Unlike character devices, a whole major is reserved at a time.
 */
const major_names = new Map<number, string>();

/**
 * The name registered for a major, if any.
 * @internal
 */
export function name(major: number): string | undefined {
	return major_names.get(major);
}

/**
 * Every reserved major, for `/proc/devices`.
 * @internal
 */
export function regions(): [major: number, name: string][] {
	return [...major_names].sort(([a], [b]) => a - b);
}

/**
 * Reserve a major for block devices.
 * @param major 0 to allocate one dynamically, counting down from 254
 * @returns the major that ended up being used
 */
export function register(major: number, devName: string): number {
	if (!major) {
		for (major = 254; major > 0 && major_names.has(major); major--);
		if (!major) throw withErrno('EBUSY', `Failed to get a major for "${devName}"`);
	}

	if (major >= blockDevMajorMax) throw withErrno('EINVAL', `Major ${major} is greater than the maximum (${blockDevMajorMax - 1})`);

	if (major_names.has(major)) throw withErrno('EBUSY', `Major ${major} is already registered to "${major_names.get(major)}"`);

	major_names.set(major, devName);
	return major;
}

/**
 * Release a major reserved with `register`.
 */
export function unregister(major: number, devName: string): void {
	if (major_names.get(major) != devName) throw withErrno('EINVAL', `Major ${major} is not registered to "${devName}"`);
	major_names.delete(major);
}

/**
 * The operations a block device driver provides, like Linux's `struct block_device_operations`.
 *
 * Linux moves data with `submit_bio` rather than reads and writes, since everything goes through the page cache.
 * We have no page cache to speak of, so these look like a character device's except that offsets are
 * always relative to the whole disk, since partitions are remapped before they get here.
 */
export interface BlockDeviceOperations {
	open?: (file: DeviceFile) => void;
	release?: (file: DeviceFile) => void;
	read?: (file: DeviceFile, buffer: Uint8Array, start: number, end: number) => void;
	write?: (file: DeviceFile, buffer: Uint8Array, offset: number) => void;
	sync?: (file: DeviceFile) => void;
	dev_node?: (disk: GenDisk) => DevNode | undefined;
}

/** `/sys/block`, which holds a link to every whole disk. Partitions are only in `/sys/class/block`. */
export const block_kobj = new KObject('block');

/** `/sys/class/block` */
export const block_class = new Class('block');

/** The block device a `Device` belongs to, for attributes and hooks that only get the device */
const dev_of = new WeakMap<Device, BlockDevice>();

export const disk_type: DeviceType = {
	name: 'disk',
	dev_attrs: {},
	dev_node(device) {
		const dev = dev_of.get(device);
		return dev && dev.disk.ops.dev_node?.(dev.disk);
	},
	uevent(device, env) {
		const dev = dev_of.get(device);
		if (dev) env.DISKSEQ = String(dev.disk.diskseq);
	},
};

export const part_type: DeviceType = {
	name: 'partition',
	dev_attrs: {},
	dev_node: disk_type.dev_node,
	uevent(device, env) {
		const dev = dev_of.get(device);
		if (!dev) return;
		env.DISKSEQ = String(dev.disk.diskseq);
		env.PARTN = String(dev.part_no);
	},
};

/**
 * Maps device numbers to block devices.
 *
 * Linux keeps these as inodes in an internal file system and looks them up with
 * `ilookup(blockdev_superblock, dev)`; the effect is the same.
 */
const dev_map = new Map<number, BlockDevice>();

/**
 * Find the block device a device number refers to, like `blkdev_get_no_open`.
 */
export function lookup(dev_t: DevT): BlockDevice | undefined {
	return dev_map.get(toDev(dev_t));
}

/**
 * A whole disk or one of its partitions, i.e. `struct block_device`.
 *
 * Every one of these has a device number of its own, so it gets a node under `/dev`
 * and shows up in `/sys/class/block`.
 */
export class BlockDevice {
	/** Only set while the block device is added */
	public device?: Device;

	public constructor(
		public readonly disk: GenDisk,
		public readonly part_no: number,
		/** Where this starts on the disk, in sectors */
		public start: number,
		/** How long this is, in sectors */
		public nr_sectors: number
	) {}

	public get dev_t(): DevT {
		return { major: this.disk.major, minor: this.disk.first_minor + this.part_no };
	}

	/**
	 * What this is called, like Linux's `disk_name`.
	 * A `p` is inserted before the partition number when the disk's name already ends in a digit,
	 * so a partition of `nvme0n1` is `nvme0n1p1` rather than `nvme0n11`.
	 */
	public get name(): string {
		if (!this.part_no) return this.disk.name;
		return this.disk.name + (/\d$/.test(this.disk.name) ? 'p' : '') + this.part_no;
	}

	/** Whether this can be written to */
	public get read_only(): boolean {
		return !!this.disk.read_only;
	}

	/**
	 * Everything the block layer does before handing an operation to the driver:
	 * offsets are made relative to the whole disk and clamped to this device's range,
	 * which is what keeps a write to a partition inside it. Linux does this in `blk_partition_remap`.
	 */
	public readonly ops: FileOperations = {
		open: file => this.disk.ops.open?.(file),
		release: file => this.disk.ops.release?.(file),
		sync: file => this.disk.ops.sync?.(file),

		read: (file, buffer, start, end) => {
			const { read } = this.disk.ops;
			if (!read) throw withErrno('EINVAL');

			const base = this.start * sectorSize;
			const limit = this.nr_sectors * sectorSize;

			// Past the end of the device, so there is nothing to read
			if (start >= limit) return;

			read(file, buffer, base + start, base + Math.min(end, limit));
		},

		write: (file, buffer, offset) => {
			const { write } = this.disk.ops;
			if (!write) throw withErrno('EINVAL');
			if (this.read_only) throw withErrno('EROFS');

			const limit = this.nr_sectors * sectorSize;
			if (offset >= limit) throw withErrno('ENOSPC');

			// A write that runs off the end is cut short rather than spilling into the next partition
			const data = buffer.subarray(0, limit - offset);

			write(file, data, this.start * sectorSize + offset);
		},
	};

	/**
	 * The attributes this gets in sysfs. Sizes are all in sectors.
	 */
	protected attrs(): Device['attrs'] {
		const attrs: Device['attrs'] = {
			size: { mode: 0o444, show: () => this.nr_sectors + '\n' },
			ro: { mode: 0o444, show: () => +this.read_only + '\n' },
		};

		if (this.part_no) {
			attrs.partition = { mode: 0o444, show: () => this.part_no + '\n' };
			attrs.start = { mode: 0o444, show: () => this.start + '\n' };
			return attrs;
		}

		const { disk } = this;

		attrs.range = { mode: 0o444, show: () => disk.minors + '\n' };
		attrs.ext_range = { mode: 0o444, show: () => (disk.no_part ? 1 : diskMaxParts) + '\n' };
		attrs.removable = { mode: 0o444, show: () => +!!disk.removable + '\n' };
		attrs.hidden = { mode: 0o444, show: () => +!!disk.hidden + '\n' };
		attrs.diskseq = { mode: 0o444, show: () => disk.diskseq + '\n' };

		return attrs;
	}

	/**
	 * Add this to sysfs and `/dev`.
	 * @throws EBUSY if something already has this device number
	 * @internal
	 */
	public register(): void {
		const dev = toDev(this.dev_t);
		if (dev_map.has(dev)) throw withErrno('EBUSY', `Device number ${format_dev_t(this.dev_t)} is already in use`);

		this.device = new Device({
			name: this.name,
			class: block_class,
			type: this.part_no ? part_type : disk_type,
			devt: this.dev_t,
			// A partition hangs off its disk, so it ends up at `/sys/.../<disk>/<partition>`
			parent: this.part_no ? this.disk.part0.device : this.disk.parent,
		});

		this.device.attrs = this.attrs();

		dev_map.set(dev, this);
		dev_of.set(this.device, this);

		try {
			this.device.register();
		} catch (e) {
			dev_map.delete(dev);
			delete this.device;
			throw e;
		}
	}

	/**
	 * @internal
	 */
	public unregister(): void {
		this.device?.unregister();
		delete this.device;
		dev_map.delete(toDev(this.dev_t));
	}
}

export interface GenDiskInit extends Partial<
	Pick<GenDisk, 'first_minor' | 'minors' | 'capacity' | 'removable' | 'read_only' | 'hidden' | 'no_part' | 'owner' | 'parent'>
> {
	major: number;
	/** The disk's name, which is also the name of its node under `/dev` */
	name: string;
	ops: BlockDeviceOperations;
}

let next_diskseq = 1;

/**
 * A disk, i.e. `struct gendisk`.
 *
 * Adding one publishes it as `/dev/<name>` and `/sys/block/<name>`.
 * Partitions of it get device numbers counting up from the disk's own.
 */
export class GenDisk {
	public readonly major!: number;
	public readonly name!: string;
	public readonly ops!: BlockDeviceOperations;

	/** The disk's own minor, which its partitions count up from */
	public readonly first_minor: number = 0;

	/** How many minors are reserved for the disk and its partitions. 0 means partitions are numbered elsewhere. */
	public readonly minors: number = 0;

	public removable?: boolean;
	public read_only?: boolean;

	/** Hidden disks exist but are not meant to be used directly, so udev ignores them */
	public hidden?: boolean;

	/** Whether the disk can be partitioned at all */
	public no_part?: boolean;

	public owner?: Module;

	/** The device this disk hangs off, e.g. its controller. Disks without one are virtual. */
	public parent?: Device;

	/** A number that is never reused, so a disk can be told apart from one that replaced it */
	public readonly diskseq: number = next_diskseq++;

	/** The whole disk, i.e. `part0` */
	public readonly part0: BlockDevice;

	/** Partitions, by partition number */
	public readonly parts = new Map<number, BlockDevice>();

	public constructor(init: GenDiskInit) {
		if (!init.name || !init.major) throw withErrno('EINVAL');

		assignWithDefaults(
			this as GenDiskInit,
			pick(init, 'major', 'name', 'ops', 'first_minor', 'minors', 'capacity', 'removable', 'read_only', 'hidden', 'no_part', 'owner', 'parent'),
			{
				first_minor: 0,
				minors: 0,
				removable: false,
				read_only: false,
				hidden: false,
				no_part: false,
			}
		);

		this.part0 = new BlockDevice(this, 0, 0, init.capacity ?? 0);
	}

	/** How big the disk is, in sectors */
	public get capacity(): number {
		return this.part0.nr_sectors;
	}

	public set capacity(sectors: number) {
		this.part0.nr_sectors = sectors;
	}

	/** Whether the disk is currently in sysfs */
	public get added(): boolean {
		return !!this.part0.device;
	}

	/**
	 * Publish the disk, i.e. `add_disk`.
	 * @throws EBUSY if the disk is already added, or something has its device number
	 */
	public add(): void {
		if (this.added) throw withErrno('EBUSY');

		this.part0.register();
		sysfs_create_link(block_kobj, this.part0.device!.kobject!, this.name);
	}

	/**
	 * Remove the disk and every partition of it, i.e. `del_gendisk`.
	 */
	public del(): void {
		if (!this.added) return;

		for (const part_no of [...this.parts.keys()]) this.del_partition(part_no);

		sysfs_remove_link(block_kobj, this.name);
		this.part0.unregister();
	}

	/**
	 * Add a partition of the disk.
	 * @param start where the partition starts, in sectors
	 * @param count how long the partition is, in sectors
	 * @throws EINVAL if the disk can't be partitioned, or the partition doesn't fit on it
	 * @throws EBUSY if there is already a partition with this number
	 */
	public add_partition(part_no: number, start: number, count: number): BlockDevice {
		if (!this.added) throw withErrno('ENXIO');
		if (this.no_part) throw withErrno('EINVAL', `${this.name} can not be partitioned`);
		if (part_no < 1 || part_no >= diskMaxParts) throw withErrno('EINVAL', `Partition number ${part_no} is out of range`);
		if (this.minors && part_no >= this.minors) throw withErrno('EINVAL', `${this.name} only has room for ${this.minors - 1} partitions`);
		if (this.parts.has(part_no)) throw withErrno('EBUSY');
		if (start < 0 || count < 0 || start + count > this.capacity) throw withErrno('EINVAL', 'Partition does not fit on the disk');

		for (const part of this.parts.values()) {
			if (part.start + part.nr_sectors > start && part.start < start + count)
				throw withErrno('EBUSY', `Partition ${part_no} overlaps partition ${part.part_no}`);
		}

		const part = new BlockDevice(this, part_no, start, count);
		part.register();
		this.parts.set(part_no, part);
		return part;
	}

	/**
	 * Remove a partition. Does nothing if there isn't one with this number.
	 */
	public del_partition(part_no: number): void {
		const part = this.parts.get(part_no);
		if (!part) return;

		part.unregister();
		this.parts.delete(part_no);
	}

	public [Symbol.dispose](): void {
		this.del();
	}
}
