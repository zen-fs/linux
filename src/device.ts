// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import { _throw, pick } from 'utilium';
import type { BusType } from './drivers/base/bus.js';
import type { Class } from './drivers/base/class.js';
import type { DeviceDriver } from './drivers/base/driver.js';
import type { Attribute, UEventEnv } from './kobject.js';
import { KObject, sysfs_create_link, sysfs_remove_link } from './kobject.js';
import type { DevicePowerInfo } from './power.js';
import { dev_block_kobj, dev_char_kobj, devices_kobj, virtual_kobj } from './drivers/base/base.js';
import { device_nodes, devtmpfs } from './fs/devtmpfs.js';

export interface DeviceAttribute extends Attribute {}

export interface SubsystemInterface {
	readonly name: string;
	readonly bus: BusType;

	onAdd?(device: Device): void;
	onRemove?(device: Device): void;
}

export interface DeviceType {
	readonly name: string;
	readonly dev_attrs: Record<string, DeviceAttribute>;

	/** The name and mode devices of this type get under `/dev` @see Device.dev_node */
	dev_node?(this: void, device: Device): DevNode | undefined;

	/** Add variables to the environment of uevents for devices of this type */
	uevent?(device: Device, env: UEventEnv): void;

	/** @todo pm? */
}

export interface DevNode {
	/** A path relative to the root of devtmpfs, so it may contain `/` */
	name?: string;
	/** Permission bits. The default is `0o600`. */
	mode?: number;
}

/** How many bits of a device number are the minor */
export const minorBits = 20,
	minorMask = (1 << minorBits) - 1;

/** A device number, like Linux's `dev_t` */
export interface DevT {
	major: number;
	minor: number;
}

/** Pack a device number into a single integer */
export function toDev(devt: DevT): number {
	return (devt.major << minorBits) | devt.minor;
}

/** Unpack a device number */
export function fromDev(dev: number): DevT {
	return { major: dev >>> minorBits, minor: dev & minorMask };
}

export function format_dev_t(devt: DevT): string {
	return devt.major + ':' + devt.minor;
}

/**
 * Whether a device is a block device rather than a character device.
 */
export function is_block_dev(device: Device): boolean {
	return device.class?.name == 'block';
}

/**
 * A device's kobject, i.e. `/sys/devices/.../<name>`.
 */
export class DeviceKObject extends KObject {
	constructor(
		public readonly device: Device,
		parent: KObject
	) {
		super(device.name, parent);
	}

	uevent(env: UEventEnv): void {
		const { bus, class: cls, type, devt, driver } = this.device;

		if (bus) env.SUBSYSTEM = bus.name;
		if (cls) env.SUBSYSTEM = cls.name;
		if (type) env.DEVTYPE = type.name;
		if (driver) env.DRIVER = driver.name;
		if (devt) {
			env.MAJOR = String(devt.major);
			env.MINOR = String(devt.minor);
			const node = this.device.dev_node();
			env.DEVNAME = node.name;
			if (node.mode) env.DEVMODE = '0' + (node.mode & 0o777).toString(8);
		}
		type?.uevent?.(this.device, env);
	}
}

export interface DeviceInit extends Partial<Pick<Device, 'name' | 'parent' | 'id' | 'bus' | 'driver' | 'type' | 'class' | 'devt' | 'kobj_parent'>> {}

function class_dir(name: string, parent: KObject): KObject {
	const existing = parent.children.get(name);
	if (existing instanceof KObject) return existing;
	if (existing) throw withErrno('EEXIST');
	return new KObject(name, parent);
}

export class Device {
	public name!: string;

	public parent?: Device | null;

	public id?: number;

	public bus?: BusType;
	public driver?: DeviceDriver;
	public type?: DeviceType;
	public class?: Class;

	/** The device number. Devices with one get a `dev` attribute and a link in `/sys/dev`. */
	public devt?: DevT;

	/**
	 * Forces where the device goes in sysfs, like setting `dev->kobj.parent` before `register`.
	 * This is how a bus' root device ends up somewhere like `/sys/devices/system`.
	 */
	public kobj_parent?: KObject;

	/** `/sys/devices/.../<name>`. Only set while the device is registered. */
	public kobject?: DeviceKObject;

	public attrs: Record<string, DeviceAttribute> = {};

	public power: Partial<DevicePowerInfo> = {};

	public removable?: 'unknown' | 'removable' | 'fixed';

	constructor(init: DeviceInit) {
		if (init.bus?.dev_name && init.id !== undefined) init.name ||= init.bus.dev_name + init.id;

		if (!init.name) throw withErrno('EINVAL');

		Object.assign(this, pick(init, 'name', 'parent', 'id', 'bus', 'driver', 'type', 'class', 'devt', 'kobj_parent'));
	}

	/** Whether the device is currently in sysfs */
	get registered(): boolean {
		return !!this.kobject;
	}

	/** The device's path relative to the root of sysfs, if it is registered */
	get path(): string | undefined {
		return this.kobject?.path;
	}

	/**
	 * Work out where a device goes in sysfs.
	 */
	protected sysfs_parent(): KObject {
		if (this.kobj_parent) return this.kobj_parent;

		if (this.class) {
			if (!this.parent) return class_dir(this.class.name, virtual_kobj);

			const parent_dev_kobj = this.parent.kobject || _throw(withErrno('ENODEV'));

			return this.parent.class ? parent_dev_kobj : class_dir(this.class.name, parent_dev_kobj);
		}

		if (!this.parent && this.bus?.dev_root) return this.bus.dev_root.kobject || _throw(withErrno('ENODEV'));

		return this.parent ? this.parent.kobject || _throw(withErrno('ENODEV')) : devices_kobj;
	}

	/**
	 * Link the device up with the driver it just bound to.
	 */
	protected link_driver(): void {
		if (!this.driver || !this.kobject) return;

		if (this.driver.kobject) {
			sysfs_create_link(this.kobject, this.driver.kobject, 'driver');
			sysfs_create_link(this.driver.kobject, this.kobject, this.name);
		}

		this.kobject.notify_uevent('bind');
	}

	/**
	 * Look for a driver on the device's bus that can handle it.
	 * @returns whether the device ended up bound
	 */
	attach(): boolean {
		// Already bound, so just link it up
		if (this.driver) {
			this.link_driver();
			return true;
		}

		if (!this.bus) return false;

		for (const drv of this.bus.drivers) {
			if (!drv.matches(this)) continue;
			if (this.try_bind(drv)) return true;
		}

		return false;
	}

	/**
	 * Offer the device to a driver, binding the two if the driver's `probe` accepts it.
	 * A driver without a `probe` takes every device the bus matched for it.
	 * @returns whether the device was bound
	 */
	try_bind(drv: DeviceDriver): boolean {
		this.driver = drv;

		try {
			if (drv.probe && !drv.probe(this)) {
				delete this.driver;
				return false;
			}
		} catch (e) {
			delete this.driver;
			throw e;
		}

		this.link_driver();
		return true;
	}

	/**
	 * Bind a device to a driver without probing it.
	 * @throws EBUSY if the device is already bound
	 */
	bind_driver(drv: DeviceDriver): void {
		if (this.driver) throw withErrno('EBUSY');

		this.driver = drv;
		this.link_driver();
	}

	/**
	 * Unbind a device from its driver. Does nothing if it isn't bound.
	 */
	release_driver(): void {
		if (!this.driver) return;

		if (this.kobject) {
			sysfs_remove_link(this.kobject, 'driver');
			if (this.driver.kobject) sysfs_remove_link(this.driver.kobject, this.name);
		}

		if (this.driver.remove) this.driver.remove(this);
		else this.bus?.remove?.(this);

		delete this.driver;
		this.kobject?.notify_uevent('unbind');
	}

	/**
	 * Add a device to sysfs, link it up with its bus and class, then try to find it a driver.
	 * @throws EEXIST if the device is already registered, or something else has its name
	 */
	register(): void {
		if (this.kobject) throw withErrno('EEXIST');

		const parent = this.sysfs_parent();
		if (parent.lookup(this.name)) throw withErrno('EEXIST');

		const kobj = new DeviceKObject(this, parent);
		this.kobject = kobj;
		kobj.add_uevent_attr();

		const attrs = { ...this.bus?.dev_attrs, ...this.class?.dev_attrs, ...this.type?.dev_attrs, ...this.attrs };
		for (const [name, attr] of Object.entries(attrs)) kobj.children.set(name, { ...attr, name });

		const devt = this.devt;
		if (devt) {
			kobj.create_attribute('dev', () => format_dev_t(devt) + '\n');
			sysfs_create_link(is_block_dev(this) ? dev_block_kobj : dev_char_kobj, kobj, format_dev_t(devt));
			device_nodes.add(this);
			devtmpfs?.create_node(this);
		}

		if (this.class) {
			sysfs_create_link(kobj, this.class, 'subsystem');
			if (this.parent?.kobject && this.type?.name != 'partition') sysfs_create_link(kobj, this.parent.kobject, 'device');
			sysfs_create_link(this.class, kobj, this.name);
		}

		if (this.bus) {
			this.bus.devices.add(this);
			sysfs_create_link(this.bus.devices_kobj, kobj, this.name);
			// A class already provides `subsystem`, and there can only be one
			if (!this.class) sysfs_create_link(kobj, this.bus, 'subsystem');
		}

		kobj.notify_uevent('add');

		if (this.bus) this.attach();
	}

	/**
	 * Remove a device from sysfs, unbinding it from its driver first.
	 * Does nothing if the device isn't registered.
	 */
	unregister(): void {
		if (!this.kobject) return;

		this.release_driver();

		this.kobject.notify_uevent('remove');

		if (this.devt) {
			device_nodes.delete(this);
			devtmpfs?.delete_node(this);
			sysfs_remove_link(is_block_dev(this) ? dev_block_kobj : dev_char_kobj, format_dev_t(this.devt));
		}

		if (this.class) sysfs_remove_link(this.class, this.name);

		if (this.bus) {
			this.bus.devices.delete(this);
			sysfs_remove_link(this.bus.devices_kobj, this.name);
		}

		this.kobject.dispose();
		delete this.kobject;
	}

	/**
	 * Work out the name and mode a device's node under `/dev` should have.
	 * @returns a `mode` of 0 when nothing set one
	 * @internal
	 */
	dev_node(): { name: string; mode: number } {
		let node: DevNode | undefined = this.type?.dev_node?.(this);
		let mode = node?.mode ?? 0;

		if (!node?.name) {
			node = this.class?.dev_node?.(this);
			mode = node?.mode ?? mode;
		}

		return { name: node?.name ?? this.name.replaceAll('!', '/'), mode };
	}
}
