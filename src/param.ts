import { withErrno } from 'kerium/error';

export function parse_bool(text: string): boolean {
	switch (text[0]) {
		case 'e': // enable
		case 'E':
		case 'y': // yes
		case 'Y':
		case 't': // true
		case 'T':
		case '1':
			return true;
		case 'd': // disable
		case 'D':
		case 'n': // no
		case 'N':
		case 'f': // false
		case 'F':
		case '0':
			return false;
		case 'o':
		case 'O':
			switch (text[1]) {
				case 'n':
				case 'N':
					return true;
				case 'f':
				case 'F':
					return false;
			}
	}

	throw withErrno('EINVAL');
}

export function parse_number(text: string): number {
	text = text.trim();

	const sign = text[0] == '-' ? -1 : 1;
	if (text[0] == '-' || text[0] == '+') text = text.slice(1);
	if (text[0] === '0' && text.length > 1 && text[1] !== 'x' && text[1] !== 'X') text = '0o' + text.slice(1);

	const value = Number(text);
	if (!Number.isFinite(value)) throw withErrno('EINVAL');
	return sign * value;
}

interface ParamTypes {
	string: string;
	number: number;
	boolean: boolean;
}

export type ParamType = keyof ParamTypes & string;

/** The kinds of values a kernel parameter can hold */
export type ParamValue = ParamTypes[ParamType];

export function parse_param<T extends ParamType>(type: T, text: string): ParamTypes[T] {
	type RV = ParamTypes[T];
	switch (type) {
		case 'string':
			return text as RV;
		case 'boolean':
			return parse_bool(text) as RV;
		case 'number':
			return parse_number(text) as RV;
		default:
			throw withErrno('EINVAL');
	}
}

export type ParamValueToType<V extends ParamValue> = keyof {
	[K in ParamType as ParamTypes[K] extends V ? K : never]: 0;
};
