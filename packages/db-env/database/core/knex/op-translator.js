'use strict';

/**
 * Apply a condition object to a Knex QueryBuilder.
 *
 * @param {import('knex').Knex.QueryBuilder} qb
 * @param {object} condition
 * @returns {import('knex').Knex.QueryBuilder}
 */
export function applyCondition(qb, condition) {
  if (!condition || typeof condition !== 'object') return qb;
  if (Array.isArray(condition))                    return qb;

  // 1. Logical operators at the top level (Op.and / Op.or / Op.not).
  for (const sym of Object.getOwnPropertySymbols(condition)) {
    const desc  = sym.description;
    const value = condition[sym];

    switch (desc) {
      case 'and':
        for (const sub of value) qb.andWhere(b => applyCondition(b, sub));
        break;
      case 'or':
        for (const sub of value) qb.orWhere(b => applyCondition(b, sub));
        break;
      case 'not':
        qb.whereNot(b => applyCondition(b, value));
        break;
    }
  }

  // 2. String-keyed entries — column-scoped clauses.
  for (const [field, value] of Object.entries(condition)) {
    applyFieldClause(qb, field, value);
  }

  return qb;
}

function applyFieldClause(qb, field, value) {
  // null / undefined → IS NULL
  if (value === null || value === undefined) {
    qb.whereNull(field);
    return;
  }

  // Bare array → whereIn (common shorthand: { id: [1,2,3] })
  if (Array.isArray(value)) {
    if (value.length === 0) qb.whereRaw('1 = 0');
    else qb.whereIn(field, value);
    return;
  }

  // Date / primitive → equality
  if (value instanceof Date || typeof value !== 'object') {
    qb.where(field, value);
    return;
  }

  // Operator-form object: { [Op.in]: [...], ... }
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length === 0) {
    // Plain object as value — almost certainly a bug in caller, but degrade
    // gracefully by serializing. Loopar already JSON.stringifies these on
    // write via getParseData, so equality on the raw string is consistent.
    qb.where(field, JSON.stringify(value));
    return;
  }

  for (const sym of symbols) {
    applyOperator(qb, field, sym.description, value[sym]);
  }
}

function applyOperator(qb, field, desc, operand) {
  switch (desc) {
    // Comparison
    // `= NULL` / `!= NULL` match nothing in SQL: null means IS [NOT] NULL.
    case 'eq': operand === null ? qb.whereNull(field) : qb.where(field, '=', operand); return;
    case 'ne': operand === null ? qb.whereNotNull(field) : qb.where(field, '!=', operand); return;
    case 'gt': qb.where(field, '>', operand); return;
    case 'gte': qb.where(field, '>=', operand); return;
    case 'lt': qb.where(field, '<', operand); return;
    case 'lte': qb.where(field, '<=', operand); return;

    // Pattern matching
    case 'like': qb.where(field, 'like', operand); return;
    case 'notLike': qb.where(field, 'not like', operand); return;
    case 'iLike': qb.where(field, 'ilike', operand); return;
    case 'notILike': qb.where(field, 'not ilike', operand); return;

    // Membership
    case 'in':
      if (Array.isArray(operand) && operand.length === 0) qb.whereRaw('1 = 0');
      else qb.whereIn(field, operand);
      return;
    case 'notIn':
      if (Array.isArray(operand) && operand.length === 0) qb.whereRaw('1 = 1');
      else qb.whereNotIn(field, operand);
      return;

    // Null
    case 'is':
      if (operand === null) qb.whereNull(field);
      else qb.where(field, operand);
      return;
    case 'isNot':
      if (operand === null) qb.whereNotNull(field);
      else qb.where(field, '!=', operand);
      return;

    // Range
    case 'between':    qb.whereBetween(field, operand);    return;
    case 'notBetween': qb.whereNotBetween(field, operand); return;

    // Column-scoped logical OR
    //   deny: { [Op.or]: [null, 0] }
    // Means: deny IS NULL OR deny = 0.
    case 'or':
      qb.where(b => {
        for (const v of operand) {
          if (v === null) b.orWhereNull(field);
          else b.orWhere(field, v);
        }
      });
      return;

    // Column-scoped AND — rare but symmetric with above.
    case 'and':
      qb.where(b => {
        for (const v of operand) {
          if (v === null) b.andWhereNull(field);
          else b.andWhere(field, v);
        }
      });
      return;

    // Column-scoped NOT
    case 'not':
      qb.whereNot(field, operand);
      return;

    default:
      throw new Error(
        `[op-translator] Unknown operator "${desc}" on field "${field}". ` +
        `Add a case in applyOperator() or check the call site.`
      );
  }
}
