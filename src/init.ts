import { driver_init } from './drivers/base/init.js';
import { char_dev_init } from './drivers/char/mem.js';
import { kobj_init } from './index.js';
import { DevTmpFS } from './fs/devtmpfs.js';
import { ProcFS } from './fs/procfs.js';
import { SysFS } from './fs/sysfs.js';
import { ConfigFS } from './fs/configfs.js';
import { DebugFS } from './fs/debugfs.js';
import { configure, InMemory } from '@zenfs/core';

export async function init() {
	kobj_init();

	driver_init();

	// Linux does this from its own initcall, after the driver core is up
	// @todo implement initcall (init callbacks)?
	char_dev_init();

	await configure({
		mounts: {
			'/dev': new DevTmpFS(),
			'/proc': new ProcFS(),
			'/sys': new SysFS(),
			'/sys/kernel/config': new ConfigFS(),
			'/sys/kernel/debug': new DebugFS(),
			'/tmp': InMemory,
			'/run': InMemory,
		},
	});
}
