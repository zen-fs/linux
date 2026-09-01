// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import * as block_dev from '../../block_dev.js';
import { sectorSize } from '../../block_dev.js';
import { Device } from '../../device.js';
import { Module } from '../../module.js';
import type { PlatformDevice } from '../base/platform.js';
import { PlatformDriver } from '../base/platform.js';
import { WebStorageDisk, diskMinors } from './disk.js';

const globals = ['localStorage', 'sessionStorage'] as const;

/** Look for a Storage and make sure it actually works. */
function probe_global(global: string): Storage | undefined {
	try {
		const area = (globalThis as Record<string, any>)[global] as Storage | undefined;
		if (!area) return;

		const key = '__zenfs_probe__';
		area.setItem(key, '');
		area.removeItem(key);

		return area;
	} catch {
		return;
	}
}

/** The disks the driver created, in the order the areas are listed */
export const disks: WebStorageDisk[] = [];

let major = 0;

/** The driver, created when the module is loaded since the platform bus does not exist before then. */
export let web_storage_driver: PlatformDriver | undefined;

/** The device standing in for the Web Storage API itself, like a controller the disks hang off */
export let web_storage_device: PlatformDevice | undefined;

function probe(device: PlatformDevice): boolean {
	const capacity_kib = web_storage.param<number>('size')!;
	const chunk_kib = web_storage.param<number>('chunk')!;
	const prefix = web_storage.param<string>('prefix')!;

	if (capacity_kib <= 0 || chunk_kib <= 0) throw withErrno('EINVAL', 'webstorage: size and chunk must be positive');

	try {
		for (const [index, globalName] of globals.entries()) {
			const area = probe_global(globalName);
			if (!area) continue;

			const disk = new WebStorageDisk(area, globalName, {
				major,
				first_minor: index * diskMinors,
				capacity: Math.floor((capacity_kib * 1024) / sectorSize),
				chunk_size: chunk_kib * 1024,
				prefix,
				owner: web_storage,
				parent: device,
			});

			disk.add();
			disks.push(disk);
		}
	} catch (e) {
		remove();
		throw e;
	}

	return disks.length > 0;
}

function remove(): void {
	for (const disk of disks.splice(0)) disk.del();
}

/** Block devices backed by the Web Storage API */
export const web_storage: Module = new Module({
	name: 'webstorage',
	description: 'Block devices backed by the Web Storage API',
	license: 'LGPL-3.0-or-later',
	params: {
		/** How big each disk is, in KiB. Read when the driver probes. */
		size: { value: 1024 },
		/** How much of a disk each key holds, in KiB. Changing this invalidates anything already stored. */
		chunk: { value: 4 },
		/** What the driver's keys start with, so it doesn't tread on anything else using the area */
		prefix: { value: 'zenfs.' },
	},
	init() {
		major = block_dev.register(0, 'webstorage');

		try {
			web_storage_driver = new PlatformDriver({ name: 'webstorage', probe, remove });
			web_storage_driver.register();

			web_storage_device = new Device({ name: 'webstorage', bus: web_storage_driver.bus }) as PlatformDevice;

			if (globals.some(globalName => probe_global(globalName))) web_storage_device.register();
		} catch (e) {
			web_storage_driver?.unregister();
			web_storage_driver = undefined;
			web_storage_device = undefined;
			block_dev.unregister(major, 'webstorage');
			throw e;
		}
	},

	exit() {
		web_storage_device?.unregister();
		web_storage_driver?.unregister();
		web_storage_device = undefined;
		web_storage_driver = undefined;
		block_dev.unregister(major, 'webstorage');
		major = 0;
	},
});
