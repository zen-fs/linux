// SPDX-License-Identifier: LGPL-3.0-or-later
import { Device } from '../../device.js';
import { BusType } from './bus.js';

let node_bus: BusType;

const nodes: Device[] = [];

export function get_node_device(node: number): Device | null {
	return nodes[node] || null;
}

/**
 * Set up `/sys/bus/node` and `/sys/devices/system/node/node0`.
 */
export function node_dev_init() {
	node_bus = new BusType('node');
	node_bus.dev_name = 'node';
	node_bus.subsys_system_register();

	// note we don't have a `Node` class or multiple nodes because this isn't exposed.
	nodes[0] = new Device({ bus: node_bus, id: 0 });
	nodes[0].register();
}
