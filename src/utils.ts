import fs from "fs";
import path from "path";

/*
 * Use the node.js `fs` module to read the content of a file
 * Handles cases where:
 * - the file does not exist
 * - the file is not a valid file
 **/
export function readFileSync(path: string, encoding: BufferEncoding = "utf8"): string {
  // First, check the file
  fs.stat(path, (error: NodeJS.ErrnoException | null, stats: fs.Stats) => {
    if (error) {
      throw new Error(`checking on ${path}. ${error.code}: ${error.errno}`);
    } else if (!stats.isFile()) {
      throw new Error(`config file ${path} is not a file`);
    }
  });

  // Then, read its content
  return fs.readFileSync(path, { encoding });
}

export const sleepms = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ValuesOf<T> = T[keyof T];

// Adapated and translated from from: https://github.com/junosuarez/find-root
export function findPackageRoot(start: string | string[]): string {
  if (typeof start === 'string') {
    if (!start.endsWith(path.sep)) {
      start += path.sep;
    }
    start = start.split(path.sep);
  }

  if (start.length === 0) {
    throw new Error('package.json not found in path');
  }

  start.pop();
  const dir = start.join(path.sep);

  if (fs.existsSync(path.join(dir, 'package.json'))) {
    return dir;
  }

  return findPackageRoot(start);
}

/**
 * Reviver and Replacer
 * --------------------
 * These can be passed to JSON.stringify and JSON.parse, respectively, to support more types.
 *
 * Additional types supported:
 * - Buffer
 *
 * Currently, these are only used for operation inputs.
 * TODO: Use in other contexts where we perform serialization and deserialization.
 */

const JSON_DATE_VALUE_PREFIX = 'date:'
interface SerializedBuffer {
  type: 'Buffer';
  data: number[];
}

//https://www.typescriptlang.org/docs/handbook/2/functions.html#declaring-this-in-a-function
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function DBOSReplacer(this: any, key: string, value: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
  const actualValue = this[key];
  if (actualValue instanceof Date) {
    return `${JSON_DATE_VALUE_PREFIX}${actualValue.getTime()}`;
    // return `${JSON_DATE_VALUE_PREFIX}${actualValue.toUTCString()}`;
  }
  return value;
}

export function DBOSReviver(_key: string, value: unknown): unknown {
  const candidate = value as SerializedBuffer;
  if (candidate && 'type' in candidate && candidate.type === 'Buffer' && Array.isArray(candidate.data)) {
    return Buffer.from(candidate.data);
  }
  if (typeof value === 'string' && value.startsWith(JSON_DATE_VALUE_PREFIX)) {
    return new Date(parseInt(value.slice(JSON_DATE_VALUE_PREFIX.length)))
    //return new Date(Date.parse(value.slice(JSON_DATE_VALUE_PREFIX.length)))
  }
  return value;
}

export function exhaustiveCheckGuard(_: never): never {
  throw new Error('Exaustive matching is not applied');
}
