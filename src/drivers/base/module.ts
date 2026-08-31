// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Module } from '../../module.js';
import { find_module } from '../../module.js';
import { sysfs_create_link, sysfs_remove_link } from '../../kobject.js';
import type { DeviceDriver } from './driver.js';

/**
 * The name a driver is linked as in `/sys/module/<module>/drivers`.
 */
function driver_link_name(drv: DeviceDriver): string {
	return drv.bus.name + ':' + drv.name;
}

/**
 * Resolve the module a driver belongs to, which is either the one it was registered with
 * or the built-in one named by `mod_name`.
 */
function module_of(drv: DeviceDriver): Module | null {
	return drv.owner ?? (drv.mod_name ? find_module(drv.mod_name) : null);
}

/**
 * Link a driver and the module that owns it together:
 * `/sys/module/<module>/drivers/<bus>:<driver>` and `/sys/bus/<bus>/drivers/<driver>/module`.
 */
export function module_add_driver(drv: DeviceDriver): void {
	const mod = module_of(drv);
	if (!mod || !drv.kobject) return;

	sysfs_create_link(drv.kobject, mod.kobject, 'module');
	sysfs_create_link(mod.kobject.drivers, drv.kobject, driver_link_name(drv));
}

/** Undo `module_add_driver` */
export function module_remove_driver(drv: DeviceDriver): void {
	const mod = module_of(drv);
	if (!mod) return;

	if (drv.kobject) sysfs_remove_link(drv.kobject, 'module');
	sysfs_remove_link(mod.kobject.drivers, driver_link_name(drv));
}
