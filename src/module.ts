import { KObject } from './kobject.js';

type StringLike = { toString(): string };

/** @todo async? */
interface ModuleAttribute {
	name: string;
	/**
	 * @default 0o444 (r--r--r--)
	 */
	mode?: number;
	setup?(): void;
	dispose?(): void;
	show?(): StringLike;
	store?(value: StringLike): void;
}

interface KernelParam {
	name: string;
	module: Module;
	ops: {
		get(this: KernelParam): string;
		set(this: KernelParam, value: string): void;
	};
}

class ModuleKObject extends KObject {
	drivers = new KObject('drivers', this);
	parameters = new KObject('parameters', this);

	constructor(public module: Module) {
		super(module.name, modules_kobj);
	}
}

interface Module {
	state: 'live' | 'init' | 'exit' | 'unformed';
	name: string;
	kobject: ModuleKObject;
}

const modules_kobj = new KObject('module', null);
