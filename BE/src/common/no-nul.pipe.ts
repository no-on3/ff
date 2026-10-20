import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import 'reflect-metadata';

const ANY_JSON = 'ff:any-json';

/**
 * Marks a request property that is passed on whole, any JSON at all, so NoNulPipe leaves it alone: an
 * invocation's input, which the function gets as sent, and which the history stores with U+FFFD in place of a
 * NUL (functions/history.ts).
 */
export const AnyJson = (): PropertyDecorator => (target, key) => Reflect.defineMetadata(ANY_JSON, true, target, key);

/**
 * Refuses text with a NUL character (U+0000) in a request's body, query or route parameters, in a string or an
 * object's key, at any depth: PostgreSQL stores none in text or jsonb, so it would fail at the database, and
 * the caller would get a 500 for their own input. A 400 names each place, as the ValidationPipe it runs after
 * names each property.
 */
@Injectable()
export class NoNulPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body' && metadata.type !== 'query' && metadata.type !== 'param') return value;
    const prototype = (metadata.metatype as { prototype?: object } | undefined)?.prototype;
    const passedOn = (key: string) => prototype !== undefined && Reflect.getMetadata(ANY_JSON, prototype, key) === true;
    const found: string[] = [];
    const walk = (node: unknown, path: string, depth: number): void => {
      if (typeof node === 'string') {
        if (node.includes('\u0000')) found.push(`${path || metadata.data || metadata.type} must not contain the NUL character (U+0000)`);
      } else if (node !== null && typeof node === 'object' && depth < 64) {
        for (const [key, child] of Object.entries(node)) {
          const at = Array.isArray(node) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
          if (key.includes('\u0000')) found.push(`${path || metadata.type} has a key with the NUL character (U+0000)`);
          if (depth === 0 && passedOn(key)) continue;
          walk(child, at, depth + 1);
        }
      }
    };
    walk(value, metadata.data ?? '', 0);
    if (found.length > 0) throw new BadRequestException(found);
    return value;
  }
}
