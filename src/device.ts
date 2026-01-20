// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import type { BusType } from './drivers/base/bus.js';
import type { Class } from './drivers/base/class.js';
import type { DeviceDriver } from './drivers/base/driver.js';
import type { Attribute } from './kobject.js';
import { KObject } from './kobject.js';
import type { DevicePowerInfo } from './power.js';

export interface DeviceAttribute extends Attribute<[Device]> {}

export interface SubsystemInterface {
	readonly name: string;
	readonly bus: BusType;

	onAdd?(device: Device): void;
	onRemove?(device: Device): void;
}

export interface DeviceType {
	readonly name: string;
	readonly dev_attrs: Record<string, DeviceAttribute>;

	/** @todo pm? */
}

interface DeviceInit extends Partial<Pick<Device, 'name' | 'parent' | 'id' | 'bus' | 'driver'>> {}

export class Device extends KObject {
	parent?: Device | null;
	id?: number;

	bus!: BusType;
	driver?: DeviceDriver;
	type?: DeviceType;
	class?: Class;

	attrs: Record<string, DeviceAttribute> = {};

	power: Partial<DevicePowerInfo> = {};

	removable?: 'unknown' | 'removable' | 'fixed';

	constructor(init: DeviceInit) {
		if (init.bus?.dev_name && init.id) init.name ||= init.bus.dev_name + init.id;

		if (!init.name) throw withErrno('EINVAL');

		super(init.name, init.parent);
	}
}
