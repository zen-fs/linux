// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Device } from '../../device.js';
import type { DeviceDriver } from './driver.js';
import type { Resource } from '../../resources.js';
import { BusType } from './bus.js';

interface PlatformDeviceId {
	name: string;
}

interface PlatformDevice extends Device {
	driver: PlatformDriver;
	parent: PlatformDevice | null;

	readonly name: string;
	id: number;
	idAuto: boolean;
	resources: Resource[];
	id_entry: PlatformDeviceId;
	/**
	 * Driver name to force a match.
	 * @internal
	 */
	driver_override?: string;
}

interface PlatformDriver extends DeviceDriver<PlatformDevice> {
	id_table?: PlatformDeviceId[];
	prevent_deferred_probe?: boolean;
	/*
	 * For most device drivers, no need to care about this flag as long as
	 * all DMAs are handled through the kernel DMA API. For some special
	 * ones, for example VFIO drivers, they know how to manage the DMA
	 * themselves and set this flag so that the IOMMU layer will allow them
	 * to setup and manage their own I/O address space.
	 */
	driver_managed_dma?: boolean;
}

function platform_match(dev: PlatformDevice, drv: PlatformDriver): boolean {
	if (dev.driver_override) return dev.driver_override === drv.name;

	if (drv.id_table)
		for (const id of drv.id_table)
			if (id.name === dev.name) {
				dev.id_entry = id;
				return true;
			}

	return dev.name == drv.name;
}

function platform_remove(dev: PlatformDevice): void {
	const drv = dev.driver;
	if (drv.remove) drv.remove(dev);
}

function platform_shutdown(dev: PlatformDevice): void {
	if (!dev.driver) return;

	const drv = dev.driver;
	if (drv.shutdown) drv.shutdown(dev);
}

export function platform_bus_init() {
	const platform_bus_type = new BusType<PlatformDevice, PlatformDriver>('platform');
	platform_bus_type.match = platform_match;
	platform_bus_type.remove = platform_remove;
	platform_bus_type.shutdown = platform_shutdown;
}
