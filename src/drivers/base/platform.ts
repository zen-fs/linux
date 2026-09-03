// SPDX-License-Identifier: LGPL-3.0-or-later
import { pick } from 'utilium';
import { Device } from '../../device.js';
import type { Resource } from '../../resources.js';
import { of_match_device } from '../of/device_tree.js';
import { BusType } from './bus.js';
import { DeviceDriver, type DeviceDriverInit } from './driver.js';

export interface PlatformDeviceId {
	name: string;
}

export interface PlatformDevice extends Device {
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

export interface PlatformDriverInit extends Omit<DeviceDriverInit<PlatformDevice>, 'bus'> {
	/** @default platform_bus_type */
	bus?: BusType;
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

export class PlatformDriver extends DeviceDriver<PlatformDevice> {
	id_table?: PlatformDeviceId[];
	prevent_deferred_probe?: boolean;
	driver_managed_dma?: boolean;

	constructor(init: PlatformDriverInit) {
		super({ ...init, bus: init.bus ?? platform_bus_type });
		Object.assign(this, pick(init, 'id_table', 'prevent_deferred_probe', 'driver_managed_dma'));
	}
}

function platform_match(dev: PlatformDevice, drv: PlatformDriver): boolean {
	if (dev.driver_override) return dev.driver_override === drv.name;

	if (of_match_device(drv.of_match_table, dev)) return true;

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

/** `/sys/bus/platform`, set up by `platform_bus_init` */
export let platform_bus_type: BusType<PlatformDevice, PlatformDriver>;

/** `/sys/devices/platform`, which platform devices without a parent go under */
export let platform_bus: Device;

export function platform_bus_init() {
	platform_bus_type = new BusType<PlatformDevice, PlatformDriver>('platform');
	platform_bus_type.match = platform_match;
	platform_bus_type.remove = platform_remove;
	platform_bus_type.shutdown = platform_shutdown;

	platform_bus = new Device({ name: 'platform' });
	platform_bus.register();
	platform_bus_type.dev_root = platform_bus;
}
