// SPDX-License-Identifier: LGPL-3.0-or-later
import { Device } from '../../device.js';
import { BusType } from './bus.js';

let cpu_bus: BusType;

const cpu_devices: CPU[] = [];

class CPU extends Device {
	node_id: number = 0;

	constructor(num: number) {
		super({ bus: cpu_bus, id: num });
		cpu_devices[num] = this;
	}
}

export function get_cpu_device(cpu: number): CPU | null {
	return cpu_devices[cpu] || null;
}

export function cpu_dev_init() {
	cpu_bus = new BusType('cpu');
	cpu_bus.dev_name = 'cpu';
	for (let n = 0; n < navigator.hardwareConcurrency; n++) new CPU(n);
}
