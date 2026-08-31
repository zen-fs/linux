// SPDX-License-Identifier: LGPL-3.0-or-later
import { KObject } from '../../kobject.js';

/** `/sys/devices` */
export const devices_kobj = new KObject('devices');

/** `/sys/devices/system`, the root for system subsystems like `cpu` and `node` */
export const system_kobj = new KObject('system', devices_kobj);

/** `/sys/devices/virtual`, where class devices without a parent live */
export const virtual_kobj = new KObject('virtual', devices_kobj);

/** `/sys/dev` */
export const dev_kobj = new KObject('dev');

/** `/sys/dev/block` */
export const dev_block_kobj = new KObject('block', dev_kobj);

/** `/sys/dev/char` */
export const dev_char_kobj = new KObject('char', dev_kobj);
