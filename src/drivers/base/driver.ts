// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import { pick } from 'utilium';
import type { Device, DeviceAttribute } from '../../device.js';
import type { Attribute } from '../../kobject.js';
import { KObject, sysfs_create_link, sysfs_remove_link } from '../../kobject.js';
import { find_module, type Module } from '../../module.js';
import type { DeviceTreeKind } from '../of/device_tree.js';
import type { BusType } from './bus.js';

export interface DriverAttribute extends Attribute {}

export interface DeviceDriverInit<TDevice extends Device = Device> {
	name: string;
	bus: BusType;

	/** The module this driver is part of. Built-in drivers don't have one. */
	owner?: Module;
	/** Used for built-in modules */
	mod_name?: string;

	/** Don't add the `bind` and `unbind` attributes */
	disableSysfsBind?: boolean;

	/**
	 * The device tree node kinds this driver handles, i.e. `driver->of_match_table`.
	 * A kind is our equivalent of `compatible`.
	 */
	of_match_table?: readonly DeviceTreeKind[];

	attrs?: Record<string, DriverAttribute>;
	dev_attrs?: Record<string, DeviceAttribute>;

	probe?: (device: TDevice) => boolean;

	remove?: (device: TDevice) => void;
	shutdown?: (device: TDevice) => void;

	suspend?: (device: TDevice) => void;
	resume?: (device: TDevice) => void;
}

export class DeviceDriver<TDevice extends Device = Device> {
	public readonly name!: string;
	public readonly bus!: BusType;

	/** The module this driver is part of. Built-in drivers don't have one. */
	public owner?: Module;
	/** Used for built-in modules */
	public readonly mod_name?: string;

	/**
	 * `/sys/bus/<bus>/drivers/<name>`, set by `register`.
	 * @internal
	 */
	public kobject?: KObject;

	/** Don't add the `bind` and `unbind` attributes */
	public disableSysfsBind?: boolean;

	/** The device tree node kinds this driver handles, i.e. `driver->of_match_table` */
	public readonly of_match_table?: readonly DeviceTreeKind[];

	public readonly attrs: Record<string, DriverAttribute>;
	public readonly dev_attrs: Record<string, DeviceAttribute>;

	constructor(init: DeviceDriverInit<TDevice>) {
		if (!init.name || !init.bus) throw withErrno('EINVAL');

		Object.assign(this, pick(init, 'name', 'bus', 'owner', 'mod_name', 'disableSysfsBind', 'of_match_table'));

		this.attrs = init.attrs ?? {};
		this.dev_attrs = init.dev_attrs ?? {};

		if (init.probe) this.probe = init.probe;
		if (init.remove) this.remove = init.remove;
		if (init.shutdown) this.shutdown = init.shutdown;
		if (init.suspend) this.suspend = init.suspend;
		if (init.resume) this.resume = init.resume;
	}

	probe?(device: TDevice): boolean;

	remove?(device: TDevice): void;
	shutdown?(device: TDevice): void;

	suspend?(device: TDevice): void;
	resume?(device: TDevice): void;

	/** @todo pm? */

	/**
	 * Whether this driver can handle `device`, according to the bus they share.
	 * A bus without a `match` accepts every device on it, like Linux.
	 */
	matches(device: Device): boolean {
		if (!device.bus || device.bus !== this.bus) return false;
		return this.bus.match ? this.bus.match(device, this) : true;
	}

	/**
	 * The name this driver is linked as in `/sys/module/<module>/drivers`.
	 */
	protected get link_name(): string {
		return this.bus.name + ':' + this.name;
	}

	/**
	 * The module this driver belongs to, which is either the one it was registered with or the built-in one named by `mod_name`.
	 */
	protected get module(): Module | null {
		return this.owner ?? (this.mod_name ? find_module(this.mod_name) : null);
	}

	/**
	 * Add the driver to its bus, creating `/sys/bus/<bus>/drivers/<name>`,
	 * then offer it every unbound device on the bus.
	 * @throws EEXIST if the driver is already registered, or the bus already has one by that name
	 */
	register(): void {
		if (this.kobject) throw withErrno('EEXIST');
		if (this.bus.drivers_kobj.lookup(this.name)) throw withErrno('EEXIST');

		const kobject = new KObject(this.name, this.bus.drivers_kobj);
		kobject.add_uevent_attr();

		for (const [name, attr] of Object.entries({ ...this.bus.drv_attrs, ...this.attrs })) kobject.children.set(name, { ...attr, name });

		if (!this.disableSysfsBind) {
			kobject.create_attribute('bind', null, (_, name) => this.bind(name));
			kobject.create_attribute('unbind', null, (_, name) => this.unbind(name));
		}

		this.kobject = kobject;
		this.bus.drivers.add(this);

		if (this.module) {
			// `/sys/module/<module>/drivers/<bus>:<driver>` and `/sys/bus/<bus>/drivers/<driver>/module`
			sysfs_create_link(this.kobject, this.module.kobject, 'module');
			sysfs_create_link(this.module.kobject.drivers, this.kobject, this.link_name);
		}

		this.attach();
	}

	/** Undo `register`, unbinding every device the driver is bound to */
	unregister(): void {
		if (!this.kobject) return;

		for (const device of [...this.bus.devices]) {
			if (device.driver === this) device.release_driver();
		}

		if (this.module) {
			if (this.kobject) sysfs_remove_link(this.kobject, 'module');
			sysfs_remove_link(this.module.kobject.drivers, this.link_name);
		}

		this.bus.drivers.delete(this);
		this.kobject.dispose();
		delete this.kobject;
	}

	/**
	 * Offer every unbound device on the bus to this driver.
	 */
	attach(): void {
		for (const device of this.bus.devices) {
			if (device.driver || !this.matches(device)) continue;
			device.try_bind(this);
		}
	}

	/**
	 * Bind the device named `name` to this driver. Backs the `bind` attribute.
	 * @throws ENODEV if there is no such device on the bus, or the bus doesn't match it
	 * @throws EBUSY if the device already has a driver
	 */
	bind(name: string): void {
		const device = this.bus.find_device(name.trim());
		if (!device) throw withErrno('ENODEV');
		if (device.driver) throw withErrno('EBUSY');
		if (!this.matches(device)) throw withErrno('ENODEV');
		device.try_bind(this);
	}

	/**
	 * Unbind the device named `name` from this driver. Backs the `unbind` attribute.
	 * @throws ENODEV if there is no such device on the bus, or it isn't bound to this driver
	 */
	unbind(name: string): void {
		const device = this.bus.find_device(name.trim());
		if (!device || device.driver !== this) throw withErrno('ENODEV');
		device.release_driver();
	}
}
