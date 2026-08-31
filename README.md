# ZenFS Backends and Emulation of Linux

> [!CAUTION]
> This is still being developed. Most APIs will likely change a lot or have not been implemented yet.

This package serves as a best-effort emulation of Linux-specific behavior for ZenFS.

## Kernel modules

The foundational part of `@zenfs/linux` is it's kernel module API.

Modules are loaded with `init` and unloaded with `dispose`. Unlike Linux, both are
async, since a module may need to do something asynchronous before it is ready. While `init` runs,
the module is in the `init` state (Linux calls this `COMING`).

```ts
import { Module } from '@zenfs/linux';

const mod = new Module({
	name: 'example',
	version: '1.0.0',
	license: 'GPL',
	params: {
		debug: { value: false, changed: value => console.log('debug is now', value) },
	},
	init() {
		if (this.param('debug')) console.log('loading');
	},
	exit() {
		// clean up
	},
});

await mod.init();

await mod.dispose();
```

Modules can depend on each other using their `use` method, which takes a reference on the target and adds
a link in its `holders` directory. A module that is still referenced can't be unloaded without
forcing, which taints it with `F`.

## Filesystems

The following filesystems are (will be) provided:

- sysfs (`/sys`)
- debugfs (`/sys/kernel/debug`)
- configfs (`/sys/kernel/config`)
- procfs (`/proc`)
- devtmpfs (`/dev`)
