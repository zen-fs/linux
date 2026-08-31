// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import type { Device, DeviceAttribute } from '../../device.js';
import type { Attribute } from '../../kobject.js';
import { KObject } from '../../kobject.js';
import type { Module } from '../../module.js';
import type { BusType } from './bus.js';
import { module_add_driver, module_remove_driver } from './module.js';

export interface DriverAttribute extends Attribute {}

export interface DeviceDriver<TDevice extends Device = Device> {
	readonly name: string;
	readonly bus: BusType;

	/** The module this driver is part of. Built-in drivers don't have one. */
	owner?: Module;
	/** Used for built-in modules */
	readonly mod_name?: string;

	/**
	 * `/sys/bus/<bus>/drivers/<name>`, set by `driver_register`.
	 * @internal
	 */
	kobject?: KObject;

	disableSysfsBind?: boolean;

	readonly attrs: Record<string, DriverAttribute>;
	readonly dev_attrs: Record<string, DeviceAttribute>;

	probe?(device: TDevice): boolean;

	remove?(device: TDevice): void;
	shutdown?(dev: TDevice): void;

	suspend?(device: TDevice): void;
	resume?(device: TDevice): void;

	/** @todo pm? */
}

/**
 * Add a driver to its bus, creating `/sys/bus/<bus>/drivers/<name>`.
 * @throws EEXIST if a driver with the same name is already registered on the bus
 */
export function driver_register(drv: DeviceDriver): void {
	if (drv.kobject) throw withErrno('EEXIST');

	const drivers = drv.bus.children.get('drivers');
	if (!(drivers instanceof KObject)) throw withErrno('ENODEV');
	if (drivers.lookup(drv.name)) throw withErrno('EEXIST');

	const kobject = new KObject(drv.name, drivers);
	kobject.add_uevent_attr();

	for (const [name, attr] of Object.entries(drv.attrs)) kobject.children.set(name, { ...attr, name });

	drv.kobject = kobject;
	module_add_driver(drv);
}

/** Undo `driver_register` */
export function driver_unregister(drv: DeviceDriver): void {
	if (!drv.kobject) return;

	module_remove_driver(drv);
	drv.kobject.dispose();
	delete drv.kobject;
}
