// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import type { DevT } from '../device.js';
import { format_dev_t, minorMask } from '../device.js';
import type { Module } from '../module.js';
import type { FileOperations } from './devtmpfs.js';

export const charDevMajorMax = 512;

const charDevMajorDynEnd = 234,
	charDevMajorDynExtStart = 511,
	charDevMajorDynExtEnd = 384;

/** A region of device numbers reserved with `register_region`, i.e. `struct char_device_struct` */
interface CharDevRegion {
	minorBase: number;
	minorCount: number;
	name: string;
}

/** Reserved device numbers, keyed by major. This is what `/proc/devices` shows. */
const char_devs = new Map<number, CharDevRegion[]>();

/**
 * The name registered for a device number, if any.
 * @internal
 */
export function name(devt: DevT): string | undefined {
	for (const region of char_devs.get(devt.major) ?? []) {
		if (devt.minor >= region.minorBase && devt.minor < region.minorBase + region.minorCount) return region.name;
	}
}

/**
 * Every reserved region, for `/proc/devices`.
 * @internal
 */
export function regions(): [major: number, name: string][] {
	const entries: [number, string][] = [];
	for (const [major, regions] of char_devs) for (const region of regions) entries.push([major, region.name]);
	return entries.sort(([a], [b]) => a - b);
}

function find_dynamic_major(): number {
	for (let major = 254; major >= charDevMajorDynEnd; major--) if (!char_devs.has(major)) return major;

	for (let major = charDevMajorDynExtStart; major >= charDevMajorDynExtEnd; major--) if (!char_devs.has(major)) return major;

	throw withErrno('EBUSY');
}

/**
 * Reserve `minorCount` device numbers starting at `major:minorBase`.
 * A `major` of 0 means one is allocated dynamically.
 * Note this only reserves the numbers.
 * @returns the major that ended up being used
 */
function __register_region(major: number, minorBase: number, minorCount: number, name: string): number {
	if (major >= charDevMajorMax) throw withErrno('EINVAL', `Major ${major} is greater than the maximum (${charDevMajorMax - 1})`);

	if (minorCount > minorMask + 1 - minorBase) throw withErrno('EINVAL', `Minor range ${minorBase}-${minorBase + minorCount - 1} is out of range`);

	if (!major) major = find_dynamic_major();

	const regions = char_devs.get(major) ?? [];

	for (const region of regions) {
		if (region.minorBase + region.minorCount > minorBase && region.minorBase < minorBase + minorCount) throw withErrno('EBUSY');
	}

	regions.push({ minorBase, minorCount, name });
	regions.sort((a, b) => a.minorBase - b.minorBase);
	char_devs.set(major, regions);

	return major;
}

/**
 * Reserve `count` device numbers starting at `devt`.
 * @see alloc_region for when you don't care which numbers you get
 */
export function register_region(devt: DevT, count: number, name: string): void {
	for (let major = devt.major, left = count, minorBase = devt.minor; left > 0; major++, minorBase = 0) {
		const minorCount = Math.min(left, minorMask + 1 - minorBase);
		__register_region(major, minorBase, minorCount, name);
		left -= minorCount;
	}
}

/**
 * Reserve `count` device numbers with a dynamically allocated major.
 * @returns the first device number of the range
 */
export function alloc_region(minorBase: number, count: number, name: string): DevT {
	return { major: __register_region(0, minorBase, count, name), minor: minorBase };
}

/**
 * Release device numbers reserved with `register_region` or `alloc_region`.
 */
export function unregister_region(devt: DevT, count: number): void {
	for (let major = devt.major, left = count, minorBase = devt.minor; left > 0; major++, minorBase = 0) {
		const minorCount = Math.min(left, minorMask + 1 - minorBase);

		const regions = char_devs.get(major);
		const i = regions?.findIndex(region => region.minorBase == minorBase && region.minorCount == minorCount) ?? -1;
		if (regions && i != -1) {
			regions.splice(i, 1);
			if (!regions.length) char_devs.delete(major);
		}

		left -= minorCount;
	}
}

/** A range of device numbers that `cdev` is responsible for */
interface CDevRange {
	minorBase: number;
	count: number;
	dev: CharDevice;
}

/** Maps device numbers to the driver that handles them, like Linux's `cdev_map` */
const dev_map = new Map<number, CDevRange[]>();

/**
 * A character device driver, i.e. `struct cdev`.
 */
export class CharDevice {
	/** The first device number this is responsible for. Only set while the device is added. */
	public devt?: DevT;

	/** How many device numbers this is responsible for */
	public count: number = 0;

	public constructor(
		public ops: FileOperations,
		public owner?: Module
	) {}

	/**
	 * Publish this device's operations for `count` device numbers starting at `dev`.
	 * @throws EBUSY if any of the numbers already have a driver
	 */
	public add(dev: DevT, count: number): void {
		if (this.devt) throw withErrno('EBUSY');

		const ranges = dev_map.get(dev.major) ?? [];

		for (const range of ranges) {
			if (range.minorBase + range.count > dev.minor && range.minorBase < dev.minor + count) throw withErrno('EBUSY');
		}

		ranges.push({ minorBase: dev.minor, count, dev: this });
		ranges.sort((a, b) => a.minorBase - b.minorBase);
		dev_map.set(dev.major, ranges);

		this.devt = dev;
		this.count = count;
	}

	/** Stop handling device numbers. Nodes referring to them will fail to open with ENXIO. */
	public del(): void {
		if (!this.devt) return;

		const ranges = dev_map.get(this.devt.major);
		if (ranges) {
			const i = ranges.findIndex(range => range.dev === this);
			if (i != -1) ranges.splice(i, 1);
			if (!ranges.length) dev_map.delete(this.devt.major);
		}

		delete this.devt;
		this.count = 0;
	}

	public [Symbol.dispose](): void {
		this.del();
	}
}

/**
 * Find the driver responsible for a device number, like `kobj_lookup(cdev_map, ...)`.
 */
export function lookup(devt: DevT): CharDevice | undefined {
	for (const range of dev_map.get(devt.major) ?? []) {
		if (devt.minor >= range.minorBase && devt.minor < range.minorBase + range.count) return range.dev;
	}
}

/**
 * Reserve a major and publish `ops` for all 256 of its minors at once.
 * @param major 0 to allocate one dynamically
 * @returns the major that ended up being used
 */
export function register(major: number, name: string, ops: FileOperations): number {
	major = __register_region(major, 0, 256, name);

	try {
		new CharDevice(ops).add({ major, minor: 0 }, 256);
	} catch (e) {
		unregister_region({ major, minor: 0 }, 256);
		throw e;
	}

	return major;
}

/**
 * Undo `register`.
 */
export function unregister(major: number, devName: string): void {
	const devt: DevT = { major, minor: 0 };

	if (name(devt) != devName) throw withErrno('EINVAL', `Major ${format_dev_t(devt)} is not registered to "${devName}"`);

	lookup(devt)?.del();
	unregister_region(devt, 256);
}
