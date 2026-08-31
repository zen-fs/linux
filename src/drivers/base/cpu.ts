// SPDX-License-Identifier: LGPL-3.0-or-later
import { Device } from '../../device.js';
import { sysfs_create_link } from '../../kobject.js';
import { BusType } from './bus.js';
import { get_node_device } from './node.js';

let cpu_bus: BusType;

const cpu_devices: CPU[] = [];

export class CPU extends Device {
	node_id: number = 0;

	constructor(num: number) {
		super({ bus: cpu_bus, id: num });
		cpu_devices[num] = this;
	}

	/**
	 * Cross-link a CPU and the node it belongs to.
	 * Does nothing if either one isn't registered yet.
	 */
	register_under_node(node_id: number) {
		const node = get_node_device(node_id);

		if (!this?.kobject || !node?.kobject) return;

		sysfs_create_link(node.kobject, this.kobject, this.name);
		sysfs_create_link(this.kobject, node.kobject, node.name);
	}
}

export function get_cpu_device(cpu: number): CPU | null {
	return cpu_devices[cpu] || null;
}

/**
 * Set up `/sys/bus/cpu` and a device under `/sys/devices/system/cpu` for each CPU.
 */
export function cpu_dev_init() {
	cpu_bus = new BusType('cpu');
	cpu_bus.dev_name = 'cpu';
	cpu_bus.subsys_system_register();

	for (let n = 0; n < navigator.hardwareConcurrency; n++) {
		const cpu = new CPU(n);
		cpu.register();
		cpu.register_under_node(0);
	}
}
