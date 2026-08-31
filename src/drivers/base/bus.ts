// SPDX-License-Identifier: LGPL-3.0-or-later
import type { DeviceAttribute } from '../../device.js';
import { Device } from '../../device.js';
import { KObject, type Attribute } from '../../kobject.js';
import { system_kobj } from './base.js';
import type { DeviceDriver, DriverAttribute } from './driver.js';

/** `/sys/bus` */
const kobj_bus = new KObject('bus');

export interface BusAttribute extends Attribute {}

export class BusType<TDevice extends Device = Device, TDriver extends DeviceDriver<TDevice> = DeviceDriver<TDevice>> extends KObject {
	dev_name?: string;

	/** `/sys/bus/<name>/devices`, which has a link for every device on the bus */
	readonly devices_kobj: KObject = new KObject('devices', this);

	/** `/sys/bus/<name>/drivers` */
	readonly drivers_kobj: KObject = new KObject('drivers', this);

	readonly devices = new Set<Device>();

	readonly drivers = new Set<DeviceDriver>();

	/**
	 * The device this bus' devices go under when they have no parent,
	 * for example `/sys/devices/system/cpu`.
	 * @see subsys_system_register
	 */
	dev_root?: Device;

	/**
	 * Register a bus as a system subsystem, which gives it a root device at `/sys/devices/system/<name>` that its devices go under.
	 */
	subsys_system_register(): Device {
		this.dev_root = new Device({ name: this.name, kobj_parent: system_kobj });
		this.dev_root.register();
		return this.dev_root;
	}

	readonly bus_attrs: Record<string, BusAttribute> = {};
	readonly dev_attrs: Record<string, DeviceAttribute> = {};
	readonly drv_attrs: Record<string, DriverAttribute> = {};

	constructor(name: string) {
		super(name, kobj_bus);
		this.add_uevent_attr();
	}

	/** Find a device on this bus by name */
	find_device(name: string): Device | null {
		for (const device of this.devices) if (device.name === name) return device;
		return null;
	}

	/** Find a driver registered on this bus by name */
	find_driver(name: string): DeviceDriver | null {
		for (const driver of this.drivers) if (driver.name === name) return driver;
		return null;
	}

	/**
	 * @returns whether a device or driver can be handled by this bus.
	 * @throws When it can't be determined that the driver supports the device.
	 */
	match?(device: TDevice, driver: Readonly<TDriver>): boolean;

	remove?(device: TDevice): void;

	shutdown?(device: TDevice): void;

	/** Called to put a device back online */
	online?(device: TDevice): void;

	/** Called to put a device offline */
	offline?(device: TDevice): void;

	/** Called when a device wants to go to sleep */
	suspend?(device: TDevice): void;

	/** Called when a device wants to resume from sleep */
	resume?(device: TDevice): void;

	/** @todo pm? */
}
