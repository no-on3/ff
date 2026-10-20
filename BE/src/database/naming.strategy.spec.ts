import { SnakeNamingStrategy, snakeCase } from './naming.strategy';

describe('snakeCase', () => {
  it.each([
    ['id', 'id'],
    ['userId', 'user_id'],
    ['minInstances', 'min_instances'],
    ['scaleToZero', 'scale_to_zero'],
    ['responseTimeP95', 'response_time_p95'],
    ['createdAt', 'created_at'],
    ['userID', 'user_id'],
    ['HTMLParser', 'html_parser'],
    ['FunctionInvocation', 'function_invocation'],
    ['already_snake', 'already_snake'],
  ])('%s → %s', (input, expected) => {
    expect(snakeCase(input)).toBe(expected);
  });
});

describe('SnakeNamingStrategy', () => {
  const strategy = new SnakeNamingStrategy();

  it('derives a table name from the class name, unless the entity names its table', () => {
    expect(strategy.tableName('FunctionInvocation', undefined)).toBe('function_invocation');
    expect(strategy.tableName('Function', 'functions')).toBe('functions');
  });

  it('derives a column name from the property, and keeps an explicit name as written', () => {
    expect(strategy.columnName('memoryUsed', undefined, [])).toBe('memory_used');
    expect(strategy.columnName('memoryUsed', 'peakMemory', [])).toBe('peakMemory');
  });

  it('prefixes the columns of embedded entities', () => {
    expect(strategy.columnName('gbSeconds', undefined, ['usage', 'freeTier'])).toBe('usage_free_tier_gb_seconds');
  });

  it('names join columns, join tables and their columns in snake_case', () => {
    expect(strategy.joinColumnName('function', 'id')).toBe('function_id');
    expect(strategy.joinColumnName('createdBy', 'id')).toBe('created_by_id');
    expect(strategy.joinTableName('accounts', 'users', 'members')).toBe('accounts_members_users');
    expect(strategy.joinTableColumnName('accounts', 'id')).toBe('accounts_id');
    expect(strategy.joinTableColumnName('accounts', 'id', 'accountId')).toBe('accounts_account_id');
  });
});
