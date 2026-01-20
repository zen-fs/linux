// SPDX-License-Identifier: LGPL-3.0-or-later
import { KObject } from '../../kobject.js';
import { cpu_dev_init } from './cpu.js';
import { memory_dev_init } from './memory.js';
import { node_dev_init } from './node.js';
import { platform_bus_init } from './platform.js';

export function driver_init() {
	// @todo
	// devtmpfs_init();

	// devices init
	const devices = new KObject('devices', null);
	const dev_kobj = new KObject('dev', null);
	new KObject('block', dev_kobj);
	new KObject('char', dev_kobj);

	// buses init

	new KObject('system', devices);

	// classes init
	new KObject('class', null);

	// firmware init
	new KObject('firmware', null);

	// hypervisor init
	new KObject('hypervisor', null);

	platform_bus_init();
	memory_dev_init();
	node_dev_init();
	cpu_dev_init();
}
