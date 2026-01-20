// SPDX-License-Identifier: LGPL-3.0-or-later
/* eslint-disable @typescript-eslint/no-duplicate-enum-values */
export enum IoResourceFlag {
	/*
	 * IO resources have these defined flags.
	 *
	 * PCI devices expose these flags to userspace in the "resource" sysfs file,
	 * so don't move them.
	 */
	/** Bus-specific bits */
	BITS = 0x000000ff,

	/** Resource type */
	TYPE_BITS = 0x00001f00,
	/** PCI/ISA I/O ports */
	IO = 0x00000100,
	MEM = 0x00000200,
	/** Register offsets */
	REG = 0x00000300,
	IRQ = 0x00000400,
	DMA = 0x00000800,
	BUS = 0x00001000,

	/** No side effects */
	PREFETCH = 0x00002000,
	READONLY = 0x00004000,
	CACHEABLE = 0x00008000,
	RANGELENGTH = 0x00010000,
	SHADOWABLE = 0x00020000,

	/** size indicates alignment */
	SIZEALIGN = 0x00040000,
	/** start field is alignment */
	STARTALIGN = 0x00080000,

	MEM_64 = 0x00100000,
	/** forwarded by bridge */
	WINDOW = 0x00200000,
	/** Resource is software muxed */
	MUXED = 0x00400000,

	/** Resource extended types */
	EXT_TYPE_BITS = 0x01000000,
	/** System RAM (modifier) */
	SYSRAM = 0x01000000,

	/* SYSRAM specific bits. */
	/** Always detected via a driver. */
	SYSRAM_DRIVER_MANAGED = 0x02000000,
	/** Resource can be merged. */
	SYSRAM_MERGEABLE = 0x04000000,

	/** Userland may not map this resource */
	EXCLUSIVE = 0x08000000,

	DISABLED = 0x10000000,
	/** No address assigned yet */
	UNSET = 0x20000000,
	AUTO = 0x40000000,
	/** Driver has marked this resource busy */
	BUSY = 0x80000000,

	/* I/O resource extended types */
	SYSTEM_RAM = MEM | SYSRAM,

	/* PnP IRQ specific bits (BITS) */
	IRQ_HIGHEDGE = 1 << 0,
	IRQ_LOWEDGE = 1 << 1,
	IRQ_HIGHLEVEL = 1 << 2,
	IRQ_LOWLEVEL = 1 << 3,
	IRQ_SHAREABLE = 1 << 4,
	IRQ_OPTIONAL = 1 << 5,
	IRQ_WAKECAPABLE = 1 << 6,

	/* PnP DMA specific bits (BITS) */
	DMA_TYPE_MASK = 3 << 0,
	DMA_8BIT = 0 << 0,
	DMA_8AND16BIT = 1 << 0,
	DMA_16BIT = 2 << 0,

	DMA_MASTER = 1 << 2,
	DMA_BYTE = 1 << 3,
	DMA_WORD = 1 << 4,

	DMA_SPEED_MASK = 3 << 6,
	DMA_COMPATIBLE = 0 << 6,
	DMA_TYPEA = 1 << 6,
	DMA_TYPEB = 2 << 6,
	DMA_TYPEF = 3 << 6,

	/* PnP memory I/O specific bits (BITS) */
	/** dup: READONLY */
	MEM_WRITEABLE = 1 << 0,
	/** dup: CACHEABLE */
	MEM_CACHEABLE = 1 << 1,
	/** dup: RANGELENGTH */
	MEM_RANGELENGTH = 1 << 2,
	MEM_TYPE_MASK = 3 << 3,
	MEM_8BIT = 0 << 3,
	MEM_16BIT = 1 << 3,
	MEM_8AND16BIT = 2 << 3,
	MEM_32BIT = 3 << 3,
	/** dup: SHADOWABLE */
	MEM_SHADOWABLE = 1 << 5,
	MEM_EXPANSIONROM = 1 << 6,
	MEM_NONPOSTED = 1 << 7,

	/* PnP I/O specific bits (BITS) */
	IO_16BIT_ADDR = 1 << 0,
	IO_FIXED = 1 << 1,
	IO_SPARSE = 1 << 2,

	/* PCI ROM control bits (BITS) */
	/** ROM is enabled, same as PCI_ROM_ADDRESS_ENABLE */
	ROM_ENABLE = 1 << 0,
	/** Use RAM image, not ROM BAR */
	ROM_SHADOW = 1 << 1,

	/* PCI control bits.  Shares BITS with above PCI ROM.  */
	/** Do not move resource */
	PCI_FIXED = 1 << 4,
	/** BAR Equivalent Indicator */
	PCI_EA_BEI = 1 << 5,
}

/*
 * I/O Resource Descriptors
 *
 * Descriptors are used by walk_iomem_res_desc() and region_intersects()
 * for searching a specific resource range in the iomem table.  Assign
 * a new descriptor when a resource range supports the search interfaces.
 * Otherwise, resource.desc must be set to IORES_DESC_NONE (0).
 */
export enum IoResourceDesc {
	NONE = 0,
	CRASH_KERNEL = 1,
	ACPI_TABLES = 2,
	ACPI_NV_STORAGE = 3,
	PERSISTENT_MEMORY = 4,
	PERSISTENT_MEMORY_LEGACY = 5,
	DEVICE_PRIVATE_MEMORY = 6,
	RESERVED = 7,
	SOFT_RESERVED = 8,
	CXL = 9,
}

export interface Resource {
	start: bigint;
	end: bigint;
	readonly name?: string;
	flags: number;
	desc: IoResourceDesc;
	parent?: Resource;
	children: Resource[];
}
