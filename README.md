# ZenFS Backends and Emulation of Linux

> [!CAUTION]
> This is still being prototyped. Most APIs will likely change a lot or have not been implemented yet.

This package serves as a best-effort emulation of Linux-specific behavior for ZenFS.

## Kernel modules

The foundational part of `@zenfs/linux` is it's kernel module API.

## Filesystems

The following filesystems are (will be) provided:

- sysfs (`/sys`)
- debugfs (`/sys/kernel/debug`)
- configfs (`/sys/kernel/config`)
- procfs (`/proc`)
- devtmpfs (`/dev`)
