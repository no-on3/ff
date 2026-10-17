import { DefaultNamingStrategy, NamingStrategyInterface } from 'typeorm';

/** `minInstances` → `min_instances`, `responseTimeP95` → `response_time_p95`, `HTMLParser` → `html_parser`. */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z0-9])/g, '$1_$2')
    .toLowerCase();
}

/**
 * snake_case names in the database, camelCase properties in TypeScript and in
 * the API's JSON (client-readiness plan, P-01). A name given explicitly in an
 * entity (`@Column({ name })`, `@JoinColumn({ name })`) is used as written.
 */
export class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
  tableName(className: string, customName: string | undefined): string {
    return customName ?? snakeCase(className);
  }

  columnName(propertyName: string, customName: string | undefined, embeddedPrefixes: string[]): string {
    const prefix = embeddedPrefixes.length > 0 ? `${snakeCase(embeddedPrefixes.join('_'))}_` : '';
    return prefix + (customName ?? snakeCase(propertyName));
  }

  relationName(propertyName: string): string {
    return snakeCase(propertyName);
  }

  joinColumnName(relationName: string, referencedColumnName: string): string {
    return snakeCase(`${relationName}_${referencedColumnName}`);
  }

  joinTableName(firstTableName: string, secondTableName: string, firstPropertyName: string): string {
    return snakeCase(`${firstTableName}_${firstPropertyName.replace(/\./g, '_')}_${secondTableName}`);
  }

  joinTableColumnName(tableName: string, propertyName: string, columnName?: string): string {
    return snakeCase(`${tableName}_${columnName ?? propertyName}`);
  }
}
