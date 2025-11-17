import { withErrno } from 'kerium';
import { kobj_create_attribute, KObject } from './kobject.js';

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
