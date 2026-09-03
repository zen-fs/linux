// These types are missing and cause TS errors if omitted
// This file will not be included in the build

declare module '@babel/traverse' {
	export interface Visitor {
		[key: string]: unknown;
	}
}

declare module '@babel/generator' {
	export interface GeneratorOptions {
		[key: string]: unknown;
	}
}
