// SPDX-License-Identifier: LGPL-3.0-or-later
import { Device } from '../../device.js';
import { BusType } from './bus.js';
import { get_cpu_device } from './cpu.js';

let node_bus: BusType;

const nodes: Device[] = [];

export function register_cpu_under_node(cpu_id: number, node_id: number) {
	const cpu = get_cpu_device(cpu_id);
	const node = nodes[node_id];

	if (!cpu || !node) return;

	/* @todo implement `sysfs_create_link`
	sysfs_create_link(node, cpu, cpu.name);
	sysfs_create_link(cpu, node, node.name);
	*/
}

export function node_dev_init() {
	node_bus = new BusType('node');
	node_bus.dev_name = 'node';

	// note we don't have a `Node` class or multiple nodes because this isn't exposed.
	nodes[0] = new Device({ bus: node_bus, id: 0 });
	for (let n = 1; n < navigator.hardwareConcurrency; n++) register_cpu_under_node(n, 0);
}
