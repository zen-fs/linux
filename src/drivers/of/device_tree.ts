// SPDX-License-Identifier: LGPL-3.0-or-later
import { err } from 'kerium/log';
import { Device } from '../../device.js';
import { KObject } from '../../kobject.js';
import type { PlatformDevice } from '../base/platform.js';
import { platform_bus_type } from '../base/platform.js';
import type { AttachXTermOptions, XTermLike } from '../tty/xterm.js';

/**
 * What the "BIOS" can hand the kernel, keyed by the kind of node.
 * A driver adds to this by augmenting the interface, and matches on the key with `of_match_table`.
 */
export interface DeviceTreeType {
	xterm: { terminal: XTermLike; options?: AttachXTermOptions };
}

/** The kinds of node that can be described, i.e. what `compatible` holds on Linux */
export type DeviceTreeKind = keyof DeviceTreeType;

export type DeviceTreeNode = {
	[T in DeviceTreeKind]: {
		kind: T;
		/** What the device is called under `/sys/devices/platform`. One is made up when there isn't one. */
		id?: string;
	} & DeviceTreeType[T];
}[DeviceTreeKind];

const device_tree: DeviceTreeNode[] = [];

/** The device each node was turned into, so a node can be taken back out */
const node_devices = new WeakMap<DeviceTreeNode, PlatformDevice>();

/** Whether the platform bus is up, so a node can become a device the moment it is described */
let populated = false;

/** How many of each kind have been named, for making up ids */
const kind_ids = new Map<DeviceTreeKind, number>();

/**
 * Work out what a node's device is called, i.e. `of_device_make_bus_id`.
 * Linux builds these out of `reg` addresses; nothing here has an address, so they are counted off.
 */
function of_device_make_bus_id(node: DeviceTreeNode): string {
	if (node.id) return node.id;

	const id = kind_ids.get(node.kind) ?? 0;
	kind_ids.set(node.kind, id + 1);
	return `${node.kind}.${id}`;
}

/** Whether a driver's `of_match_table` covers a device's node, i.e. `of_match_device` */
export function of_match_device(matches: readonly DeviceTreeKind[] | undefined, device: Device): DeviceTreeKind | undefined {
	if (!device.of_node) return;
	return matches?.find(kind => kind === device.of_node!.kind);
}

/**
 * Turn one node into a platform device and register it, i.e. `of_platform_device_create`.
 * Registering is what looks for a driver, so a node described after boot binds right away.
 */
export function of_platform_device_create(node: DeviceTreeNode): PlatformDevice {
	const existing = node_devices.get(node);
	if (existing) return existing;

	const device = new Device({ name: of_device_make_bus_id(node), bus: platform_bus_type, of_node: node }) as PlatformDevice;

	node_devices.set(node, device);

	try {
		device.register();
	} catch (e) {
		node_devices.delete(node);
		err(`of: could not add ${device.name}: ` + String(e));
		throw e;
	}

	// `/sys/devices/platform/<name>/of_node`, which is how userspace sees what the BIOS said
	const of_node_kobj = new KObject('of_node', device.kobject);
	of_node_kobj.create_attribute('name', () => device.name + '\n');
	of_node_kobj.create_attribute('compatible', () => node.kind + '\n');

	return device;
}

/** Describe hardware to the kernel. This is the whole point of the device tree */
export function define_device_tree(...tree: DeviceTreeNode[]): void {
	for (const node of tree) {
		device_tree.push(node);
		if (populated) of_platform_device_create(node);
	}
}

/** Take nodes back out, unbinding and unregistering their devices, i.e. `of_platform_depopulate` */
export function undefine_device_tree(...tree: DeviceTreeNode[]): void {
	for (const node of tree) {
		node_devices.get(node)?.unregister();
		node_devices.delete(node);

		const index = device_tree.indexOf(node);
		if (index >= 0) device_tree.splice(index, 1);
	}
}

/** Turn everything the BIOS described into platform devices, i.e. `of_platform_populate` */
export function of_platform_populate(): void {
	populated = true;
	for (const node of device_tree) of_platform_device_create(node);
}
