// SPDX-License-Identifier: LGPL-3.0-or-later
import { assignWithDefaults, pick } from 'utilium';
import type { DevNode, Device, DeviceAttribute } from '../../device.js';
import type { Attribute } from '../../kobject.js';
import { KObject } from '../../kobject.js';

export interface ClassAttribute extends Attribute {}

/** `/sys/class` */
const class_kobj = new KObject('class');

interface ClassInit {
	class_attrs?: Record<string, ClassAttribute>;
	dev_attrs?: Record<string, DeviceAttribute>;
	/** The name and mode devices of this class get under `/dev` @see Device.dev_node */
	dev_node?: (device: Device) => DevNode | undefined;
}

/**
 * A device class, i.e. `/sys/class/<name>`.
 * Devices with a class are linked into it, and live in `/sys/devices/virtual/<name>`
 * unless they have a parent.
 */
export class Class extends KObject {
	readonly class_attrs!: Record<string, ClassAttribute>;
	readonly dev_attrs!: Record<string, DeviceAttribute>;

	dev_node?: (device: Device) => DevNode | undefined;

	constructor(name: string, init: ClassInit = {}) {
		super(name, class_kobj);

		assignWithDefaults(this as ClassInit, pick(init, 'class_attrs', 'dev_attrs', 'dev_node'), { class_attrs: {}, dev_attrs: {} });

		for (const [attr_name, attr] of Object.entries(this.class_attrs)) this.children.set(attr_name, { ...attr, name: attr_name });
	}

	/** @todo pm? */
}
