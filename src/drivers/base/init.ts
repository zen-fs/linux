// SPDX-License-Identifier: LGPL-3.0-or-later
import './base.js';
import './class.js';
import { cpu_dev_init } from './cpu.js';
import { memory_dev_init } from './memory.js';
import { node_dev_init } from './node.js';
import { platform_bus_init } from './platform.js';

export function driver_init() {
	platform_bus_init();
	memory_dev_init();
	node_dev_init();
	cpu_dev_init();
}
