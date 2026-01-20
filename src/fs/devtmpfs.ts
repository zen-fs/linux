// SPDX-License-Identifier: LGPL-3.0-or-later
import { InMemoryStore, StoreFS } from '@zenfs/core';

/**
 * A temporary file system that manages and interfaces with devices
 * @todo
 */
export class DevTmpFS extends StoreFS<InMemoryStore> {
	public constructor() {
		// Please don't store your temporary files in /dev.
		// If you do, you'll have up to 16 MiB
		super(new InMemoryStore(0x1000000, 'devtmpfs'));
	}
}
