// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import { kobj_create_attribute, KObject } from './kobject.js';

export interface DevicePowerInfo {
	can_wakeup: boolean;
	async_suspend: boolean;
	in_dpm_list: boolean;
	is_prepared: boolean;
	is_suspended: boolean;
	is_noirq_suspended: boolean;
	is_late_suspended: boolean;
	no_pm: boolean;
	early_init: boolean;
	direct_complete: boolean;
}

const power_kobj = new KObject('power', null);

let async_enabled = false;

kobj_create_attribute(
	power_kobj,
	'async',
	() => (async_enabled ? '1' : '0'),
	(_, val) => {
		const v = parseInt(val);
		if (Number.isNaN(v)) throw withErrno('EINVAL');
		async_enabled = !!v;
	}
);

const suspend_kobj = new KObject('suspend_stats', power_kobj);
