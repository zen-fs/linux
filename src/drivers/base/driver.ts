// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Attribute } from '../../kobject.js';
import type { BusType } from './bus.js';
import type { Module } from '../../module.js';
import type { Device, DeviceAttribute } from '../../device.js';

export interface DriverAttribute extends Attribute {}

export interface DeviceDriver<TDevice extends Device = Device> {
	readonly name: string;
	readonly bus: BusType;

	owner: Module;
	/** Used for built-in modules */
	readonly mod_name?: string;

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
