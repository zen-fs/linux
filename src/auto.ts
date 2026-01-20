// SPDX-License-Identifier: LGPL-3.0-or-later
import { DevTmpFS } from './fs/devtmpfs.js';
import { ProcFS } from './fs/procfs.js';
import { SysFS } from './fs/sysfs.js';
import { ConfigFS } from './fs/configfs.js';
import { DebugFS } from './fs/debugfs.js';
import { configure, InMemory } from '@zenfs/core';

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
