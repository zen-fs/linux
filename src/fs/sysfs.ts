// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Attribute, KEntry } from '../kobject.js';
import { KLink, KObject, sysfs_lookup } from '../kobject.js';
import { KernelFS } from './kernfs.js';

export class SysFS extends KernelFS<KObject, Attribute, KLink> {
	public constructor() {
		super(0x62656572, 'sysfs');
	}

	protected lookup = sysfs_lookup;

	protected is_dir(entry: KEntry): entry is KObject {
		return entry instanceof KObject;
	}

	protected is_link(entry: KEntry): entry is KLink {
		return entry instanceof KLink;
	}
}
