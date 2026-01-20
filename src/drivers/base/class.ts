// SPDX-License-Identifier: LGPL-3.0-or-later
import type { DeviceAttribute } from '../../device.js';
import type { Attribute } from '../../kobject.js';

export interface ClassAttribute extends Attribute<[Class]> {}

export interface Class {
	readonly name: string;

	readonly class_attrs: Record<string, ClassAttribute>;
	readonly dev_attrs: Record<string, DeviceAttribute>;

	/** @todo pm? */
}
