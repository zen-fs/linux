// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Device, DeviceAttribute } from '../../device.js';
import type { DeviceDriver, DriverAttribute } from './driver.js';
import { KObject, type Attribute } from '../../kobject.js';
import { S_IWUSR } from '@zenfs/core/constants';

const kobj_bus = new KObject('bus', null);

export interface BusAttribute extends Attribute {}

export class BusType<TDevice extends Device = Device, TDriver extends DeviceDriver<TDevice> = DeviceDriver<TDevice>> extends KObject {
	dev_name?: string;
	readonly bus_attrs: Record<string, BusAttribute> = {};
	readonly dev_attrs: Record<string, DeviceAttribute> = {};
	readonly drv_attrs: Record<string, DriverAttribute> = {};

	constructor(name: string) {
		super(name, kobj_bus);

		new KObject('devices', this);
		new KObject('drivers', this);

		this.children.set('uevent', {
			mode: S_IWUSR,
			store(value: string) {},
		} satisfies BusAttribute);
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
