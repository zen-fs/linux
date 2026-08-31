// SPDX-License-Identifier: LGPL-3.0-or-later
import { assignWithDefaults, pick } from 'utilium';
import type { Device, DeviceAttribute } from '../../device.js';
import type { Attribute } from '../../kobject.js';
import { KObject } from '../../kobject.js';

export interface ClassAttribute extends Attribute {}

/** `/sys/class` */
const class_kobj = new KObject('class');

interface ClassInit {
	class_attrs?: Record<string, ClassAttribute>;
	dev_attrs?: Record<string, DeviceAttribute>;
	/** The name devices of this class get under `/dev` */
	devnode?: (device: Device) => string | undefined;
}

/**
 * A device class, i.e. `/sys/class/<name>`.
 * Devices with a class are linked into it, and live in `/sys/devices/virtual/<name>`
 * unless they have a parent.
 */
export class Class extends KObject {
	readonly class_attrs!: Record<string, ClassAttribute>;
	readonly dev_attrs!: Record<string, DeviceAttribute>;

	devnode?: (device: Device) => string | undefined;

	constructor(name: string, init: ClassInit = {}) {
		super(name, class_kobj);

		assignWithDefaults(this as ClassInit, pick(init, 'class_attrs', 'dev_attrs', 'devnode'), { class_attrs: {}, dev_attrs: {} });

		for (const [attr_name, attr] of Object.entries(this.class_attrs)) this.children.set(attr_name, { ...attr, name: attr_name });
	}

	/** @todo pm? */
}
