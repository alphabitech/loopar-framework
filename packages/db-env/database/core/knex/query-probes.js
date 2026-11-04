'use strict';

/**
 * Query probes — a process-wide way to observe every SQL statement any
 * tenant connection runs, without the observer knowing about connections.
 *
 *   const remove = addQueryProbe({
 *     onQuery(query) {},            // knex 'query'          { sql, bindings, method, __knexQueryUid }
 *     onResponse(response, query) {},// knex 'query-response'
 *     onError(error, query) {},     // knex 'query-error'
 *   });
 *
 * Every knex instance assigned to a Core (`this.knex = knex(...)`) is wired
 * once to a dispatcher that fans events out to the probes registered at the
 * time of the event, so probes added after a tenant connected still see its
 * queries. Knex emits these events in the caller's async context (the
 * request's AsyncLocalStorage store is live in the listener), transactions
 * included.
 *
 * A probe must never throw into the query path: failures are swallowed.
 */

const probes = new Set();
const WIRED = Symbol('loopar.queryProbes');

export function addQueryProbe(probe) {
  if (!probe || typeof probe !== 'object') throw new TypeError('addQueryProbe expects an object');
  probes.add(probe);
  return () => probes.delete(probe);
}

function dispatch(method, ...args) {
  if (probes.size === 0) return;
  for (const probe of probes) {
    const fn = probe[method];
    if (typeof fn !== 'function') continue;
    try { fn.apply(probe, args); } catch { /* observers never break queries */ }
  }
}

export function wireQueryProbes(knexInstance) {
  if (!knexInstance || typeof knexInstance.on !== 'function' || knexInstance[WIRED]) return knexInstance;
  knexInstance[WIRED] = true;
  knexInstance.on('query', (query) => dispatch('onQuery', query));
  knexInstance.on('query-response', (response, query) => dispatch('onResponse', response, query));
  knexInstance.on('query-error', (error, query) => dispatch('onError', error, query));
  return knexInstance;
}
