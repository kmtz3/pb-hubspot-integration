export const OPERATORS_BY_TYPE: Record<string, string[]> = {
  string:      ['EQ', 'NEQ', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY'],
  number:      ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN'],
  enumeration: ['EQ', 'NEQ', 'IN', 'NOT_IN'],
  bool:        ['EQ', 'NEQ'],
  datetime:    ['LT', 'LTE', 'GT', 'GTE', 'BETWEEN'],
};

export const OPERATOR_LABELS: Record<string, string> = {
  EQ:                  'is equal to',
  NEQ:                 'is not equal to',
  LT:                  'is less than',
  LTE:                 'is less than or equal to',
  GT:                  'is greater than',
  GTE:                 'is greater than or equal to',
  BETWEEN:             'is between',
  IN:                  'is any of',
  NOT_IN:              'is none of',
  HAS_PROPERTY:        'is known',
  NOT_HAS_PROPERTY:    'is unknown',
  CONTAINS_TOKEN:      'contains',
  NOT_CONTAINS_TOKEN:  'does not contain',
};
